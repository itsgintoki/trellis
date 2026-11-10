import { config } from "../config";
import { extractKeywords, truncate } from "../memory/text";
import {
  cleanTitle,
  normalizePublishedDate,
  normalizeSearchUrl,
  SearchError,
  type SearchOptions,
  type SearchResponse,
  type SearchResult,
} from "./types";

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  raw_content?: string | null;
  score?: number;
  published_date?: string;
}

function timeRangeFor(days: number): "day" | "week" | "month" | "year" | undefined {
  if (days <= 0) return undefined;
  if (days <= 1) return "day";
  if (days <= 7) return "week";
  if (days <= 31) return "month";
  if (days <= 365) return "year";
  return undefined;
}

function cleanPage(raw: string): string {
  return raw
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function pageExcerpt(raw: string, query: string, max = 450): string {
  const clean = cleanPage(raw);
  if (!clean) return "";
  if (clean.length <= max) return clean;

  const terms = extractKeywords(query, 8);
  if (terms.length === 0) return truncate(clean, max);

  const sentences = clean.split(/(?<=[.!?])\s+|\n+/).filter(Boolean);
  let best = "";
  let bestScore = -1;
  for (let index = 0; index < sentences.length; index++) {
    const window = sentences.slice(index, index + 5).join(" ");
    const lowered = window.toLowerCase();
    const score = terms.reduce((total, term) => total + (lowered.includes(term) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      best = window;
    }
    if (bestScore === terms.length) break;
  }
  return truncate(best || clean, max);
}

export async function tavilySearch(
  query: string,
  options: SearchOptions,
  signal: AbortSignal,
): Promise<SearchResponse> {
  const recencyDays = Math.max(0, Math.min(options.recencyDays ?? 0, 3650));
  const maxResults = Math.max(1, Math.min(options.maxResults ?? 3, 8));

  const body: Record<string, unknown> = {
    query,
    search_depth: "advanced",
    topic: "general",
    max_results: maxResults,
    include_answer: false,
    include_images: false,
    include_raw_content: true,
  };
  const timeRange = timeRangeFor(recencyDays);
  if (timeRange) body.time_range = timeRange;

  let response: Response;
  try {
    response = await fetch(`${config.search.tavilyBaseUrl}/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.search.tavilyKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    throw new SearchError(`Tavily request failed: ${(error as Error).message}`);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new SearchError(`Tavily returned ${response.status}${detail ? `: ${detail.slice(0, 180)}` : ""}`);
  }

  const data = (await response.json()) as { results?: TavilyResult[] };
  if (!Array.isArray(data.results)) {
    throw new SearchError("Tavily returned an unexpected response.");
  }

  const seen = new Set<string>();
  const results: SearchResult[] = [];
  const queryTerms = extractKeywords(query, 8);

  for (const item of data.results) {
    if (!item.url || !item.title) continue;
    const url = normalizeSearchUrl(item.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);

    const summary = (item.content || "").trim();
    const raw = typeof item.raw_content === "string" ? item.raw_content : "";
    let host = "";
    try {
      host = new URL(url).hostname.replace(/^www\./, "").replace(/\./g, "");
    } catch {
      host = "";
    }
    const vendorMatch = queryTerms.some(
      (term) => term.length >= 3 && host.includes(term),
    );

    let content = summary;
    if (raw) {
      if (vendorMatch) {
        // A vendor pricing page must include its plan headers. Tavily's snippet
        // sometimes starts mid-table, which can make Team look like Pro.
        content = truncate(cleanPage(raw), 1_800);
      } else {
        const page = pageExcerpt(raw, query, 450);
        if (page && !summary.includes(page.slice(0, 120))) {
          content = content ? `${content}\n\nPage excerpt: ${page}` : page;
        }
      }
    }

    results.push({
      title: cleanTitle(item.title, url),
      url,
      content: truncate(content, vendorMatch ? 2_000 : 1_000),
      published: normalizePublishedDate(item.published_date),
      score: typeof item.score === "number" ? item.score : undefined,
    });
  }

  return { query, results, provider: "Tavily", recencyDays };
}
