import { test } from "node:test";
import assert from "node:assert/strict";

process.env.TAVILY_API_KEY = "tvly-test-key";

const { tavilySearch } = require("../src/search/tavily") as typeof import("../src/search/tavily");
const { duckDuckGoSearch } = require("../src/search/ddg") as typeof import("../src/search/ddg");

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("Tavily request uses Bearer auth, maps recency, and parses dated results", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedInit = init;
    return new Response(
      JSON.stringify({
        results: [
          {
            title: "Managed Postgres pricing",
            url: "https://neon.com/pricing?utm_source=newsletter",
            content: "Neon's entry tier is $19 per month.",
            raw_content:
              "Skip to content. Home. Plans and pricing. The Launch plan costs $19 per month and includes 10 GB of storage. Scale starts at $69 per month.",
            score: 0.91,
            published_date: "Mon, 03 Nov 2026 00:00:00 GMT",
          },
          {
            title: "Duplicate with tracking",
            url: "https://neon.com/pricing/?utm_campaign=x",
            content: "Duplicate",
          },
          {
            title: "Supabase pricing",
            url: "https://supabase.com/pricing",
            content: "Free tier plus a $25 Pro plan.",
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  const response = await tavilySearch(
    "Neon Postgres pricing",
    { recencyDays: 7 },
    AbortSignal.timeout(2_000),
  );

  assert.equal(capturedUrl, "https://api.tavily.com/search");
  const headers = capturedInit?.headers as Record<string, string>;
  assert.match(headers.Authorization, /^Bearer /);

  const body = JSON.parse(String(capturedInit?.body));
  assert.equal(body.time_range, "week");
  assert.equal(body.search_depth, "advanced");
  assert.equal(body.include_raw_content, true);

  assert.equal(response.provider, "Tavily");
  assert.equal(response.results.length, 2);
  assert.equal(response.results[0]?.url, "https://neon.com/pricing");
  assert.equal(response.results[0]?.published, "2026-11-03");
  assert.match(response.results[0]?.content || "", /\$19/);
});

test("vendor pricing pages keep the page start so plan headers are not lost", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        results: [
          {
            title: "Pricing & Fees | Supabase",
            url: "https://supabase.com/pricing",
            content:
              "100,000 monthly active users ... Team $599 / month ... SOC2 & ISO 27001",
            raw_content:
              "Pricing & Fees. Free $0/month. Pro From $25/month. Team From $599/month. Enterprise Custom.",
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;

  const response = await tavilySearch(
    "Supabase pricing site:supabase.com",
    {},
    AbortSignal.timeout(2_000),
  );

  assert.match(response.results[0]?.content || "", /Pro From \$25/);
  assert.match(response.results[0]?.content || "", /Team From \$599/);
});

test("Tavily surfaces HTTP failures instead of returning empty evidence", async () => {
  globalThis.fetch = (async () =>
    new Response("bad key", { status: 401 })) as typeof fetch;

  await assert.rejects(
    () =>
      tavilySearch("anything", {}, AbortSignal.timeout(2_000)),
    /Tavily returned 401/,
  );
});

test("DuckDuckGo fallback unwraps redirects, skips ads, and extracts snippets", async () => {
  const html = `
    <html><body>
      <div class="result results_links web-result">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpricing&amp;rut=abc">Example pricing</a>
        <a class="result__snippet">Pro is <b>$20</b> per seat.</a>
      </div>
      <div class="result result--ad">
        <a class="result__a" href="https://ads.example.com/buy">An ad</a>
        <a class="result__snippet">Ignore me.</a>
      </div>
      <div class="result results_links">
        <a class="result__a" href="https://second.example/post">Second result</a>
        <a class="result__snippet">A second snippet.</a>
      </div>
    </body></html>`;

  globalThis.fetch = (async () =>
    new Response(html, {
      status: 200,
      headers: { "Content-Type": "text/html" },
    })) as typeof fetch;

  const response = await duckDuckGoSearch("postgres pricing", {}, AbortSignal.timeout(2_000));

  assert.equal(response.provider, "DuckDuckGo");
  assert.equal(response.results.length, 2);
  assert.equal(response.results[0]?.url, "https://example.com/pricing");
  assert.equal(response.results[0]?.title, "Example pricing");
  assert.match(response.results[0]?.content || "", /\$20/);
  assert.equal(response.results[1]?.url, "https://second.example/post");
});

test("DuckDuckGo reports bot blocking clearly", async () => {
  globalThis.fetch = (async () =>
    new Response("<html><body>Anomaly detected. Please solve the CAPTCHA.</body></html>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    })) as typeof fetch;

  await assert.rejects(
    () => duckDuckGoSearch("anything", {}, AbortSignal.timeout(2_000)),
    /DuckDuckGo blocked the request/,
  );
});
