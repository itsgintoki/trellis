import * as cheerio from "cheerio";
import {
  cleanTitle,
  normalizeSearchUrl,
  SearchError,
  type SearchOptions,
  type SearchResponse,
  type SearchResult,
} from "./types";

function unwrapDuckDuckGoUrl(href: string): string | null {
  let candidate = href;
  if (candidate.startsWith("//")) candidate = `https:${candidate}`;
  try {
    const url = new URL(candidate);
    const target = url.searchParams.get("uddg");
    if (target && /duckduckgo\.com$/i.test(url.hostname)) return decodeURIComponent(target);
    return candidate;
  } catch {
    return null;
  }
}

export async function duckDuckGoSearch(
  query: string,
  options: SearchOptions,
  signal: AbortSignal,
): Promise<SearchResponse> {
  const maxResults = Math.max(1, Math.min(options.maxResults ?? 3, 8));
  let response: Response;
  try {
    response = await fetch("https://html.duckduckgo.com/html/", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
        Accept: "text/html,application/xhtml+xml",
      },
      body: new URLSearchParams({ q: query, kl: "us-en" }).toString(),
      signal,
    });
  } catch (error) {
    throw new SearchError(`DuckDuckGo request failed: ${(error as Error).message}`);
  }

  if (!response.ok) {
    throw new SearchError(`DuckDuckGo returned ${response.status}.`);
  }

  const html = await response.text();
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const results: SearchResult[] = [];

  $(".result").each((_, element) => {
    if (results.length >= maxResults) return;
    if ($(element).hasClass("result--ad")) return;
    const link = $(element).find("a.result__a").first();
    const href = link.attr("href");
    if (!href) return;
    const unwrapped = unwrapDuckDuckGoUrl(href);
    const url = unwrapped ? normalizeSearchUrl(unwrapped) : null;
    if (!url || seen.has(url)) return;
    seen.add(url);
    const title = cleanTitle(link.text(), url);
    const snippet = $(element).find(".result__snippet").first().text().replace(/\s+/g, " ").trim();
    results.push({
      title,
      url,
      content: snippet || "No snippet available.",
    });
  });

  if (results.length === 0 && /anomaly|captcha|unusual traffic/i.test(html)) {
    throw new SearchError(
      "DuckDuckGo blocked the request. Add TAVILY_API_KEY to .env for reliable web search.",
    );
  }

  return {
    query,
    results,
    provider: "DuckDuckGo",
    recencyDays: Math.max(0, options.recencyDays ?? 0),
  };
}
