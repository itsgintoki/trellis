import { test } from "node:test";
import assert from "node:assert/strict";
import { formatEvidence, SourceRegistry } from "../src/search/sources";
import { normalizeSearchUrl } from "../src/search/types";
import { extractJsonObject } from "../src/llm";
import { buildFtsQuery, extractKeywords, stripCitations } from "../src/memory/text";

test("normalizes tracking params, hashes and trailing slashes", () => {
  const normalized = normalizeSearchUrl(
    "https://www.example.com/pricing/?utm_source=newsletter&plan=pro#plans",
  );
  assert.ok(normalized);
  assert.equal(normalized, "https://www.example.com/pricing?plan=pro");
  assert.equal(normalizeSearchUrl("javascript:alert(1)"), null);
});

test("source numbers are stable and duplicate URLs reuse their number", () => {
  const registry = new SourceRegistry();
  const first = registry.register("Pricing", "https://example.com/pricing/");
  const duplicate = registry.register(
    "Pricing again",
    "https://example.com/pricing?utm_source=x",
  );
  const second = registry.register("Changelog", "https://example.com/changelog");

  assert.equal(first.n, 1);
  assert.equal(duplicate.n, 1);
  assert.equal(second.n, 2);
  assert.equal(registry.size, 2);

  const evidence = formatEvidence({
    query: "example pricing",
    provider: "Tavily",
    recencyDays: 7,
    results: [
      {
        title: "Pricing",
        url: "https://example.com/pricing",
        content: "Pro is $20 per seat.",
        published: "2026-11-04",
      },
      {
        title: "Pricing archive",
        url: "https://example.com/pricing/#archive",
        content: "It used to be $15.",
      },
      {
        title: "Changelog",
        url: "https://example.com/changelog",
        content: "A new release shipped.",
      },
    ],
    registry,
  });

  assert.match(evidence.text, /\[1\] Pricing/);
  assert.match(evidence.text, /\[2\] Changelog/);
  assert.equal(evidence.cited.length, 3);
});

test("vendor domains are promoted above third-party blogs in the evidence", () => {
  const registry = new SourceRegistry();
  const evidence = formatEvidence({
    query: "Neon launch pricing",
    provider: "Tavily",
    recencyDays: 0,
    results: [
      {
        title: "Neon Pricing 2026: A Third-Party Guide",
        url: "https://someblog.example/neon-pricing",
        content: "A blog summary of the pricing.",
      },
      {
        title: "Pricing — Neon",
        url: "https://neon.com/pricing",
        content: "The official pricing page.",
      },
    ],
    registry,
  });

  assert.match(evidence.text, /\[1\] Pricing — Neon/);
  assert.match(evidence.text, /Source priority: for pricing/);
  assert.equal(evidence.cited[0]?.url, "https://neon.com/pricing");
});

test("memory keyword extraction ignores temporal filler and stems via FTS terms", () => {
  const tokens = extractKeywords(
    "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?",
  );
  assert.ok(tokens.includes("postgres"));
  assert.ok(tokens.includes("hosting"));
  assert.ok(tokens.includes("pricing"));
  assert.ok(!tokens.includes("tuesday"));
  assert.ok(!tokens.includes("asked"));

  assert.equal(buildFtsQuery(["postgres", "hosting"]), "postgres* OR hosting*");
});

test("strips old citation numbers from recalled answers", () => {
  assert.equal(
    stripCitations("Neon costs $19 [1]. Supabase is free [2]."),
    "Neon costs $19. Supabase is free.",
  );
});

test("parses JSON from markdown fences and surrounding prose", () => {
  assert.deepEqual(extractJsonObject('```json\n{"summary":"kept"}\n```'), {
    summary: "kept",
  });
  assert.deepEqual(
    extractJsonObject('Here is the card: {"topics":["postgres"]} — done.'),
    { topics: ["postgres"] },
  );
  assert.equal(extractJsonObject("not json at all"), null);
});
