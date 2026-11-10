import type { Source } from "../types";
import { extractKeywords, truncate } from "../memory/text";
import { normalizeSearchUrl, type SearchResult } from "./types";
import type { ChatCompletionTool } from "openai/resources/chat/completions";

const MAX_EVIDENCE_CHARS = 2_600;

export const WEB_SEARCH_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "Search the live web and return numbered evidence: titles, URLs, publication dates, and page excerpts. Use it for facts that can change (pricing, product features, releases, availability, news) and whenever the user asks whether something is still true. You may call it multiple times in parallel with different queries. Do not use it for stable knowledge or casual conversation. The only fields are query, recency_days, and max_results; never send cursor, id, or any other field.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "A focused search query, like a good researcher would type.",
        },
        recency_days: {
          type: "integer",
          description:
            "Optional. Restrict results to the last N days (1-3650). Best for news and changelogs; avoid it for official pricing/docs pages that may have no publish date.",
        },
        max_results: {
          type: "integer",
          description: "Optional. Number of results, 1-8. Default 3.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
};

export class SourceRegistry {
  private readonly sources = new Map<string, Source>();

  register(title: string, url: string, published?: string): Source {
    const normalized = normalizeSearchUrl(url) ?? url;
    const existing = this.sources.get(normalized);
    if (existing) return existing;

    let domain = "";
    try {
      domain = new URL(normalized).hostname.replace(/^www\./, "");
    } catch {
      domain = normalized;
    }

    const source: Source = {
      n: this.sources.size + 1,
      title: truncate(title.replace(/\s+/g, " ").trim() || domain, 180),
      url: normalized,
      domain,
      published,
    };
    this.sources.set(normalized, source);
    return source;
  }

  all(): Source[] {
    return [...this.sources.values()];
  }

  get size(): number {
    return this.sources.size;
  }
}

export function formatEvidence(options: {
  query: string;
  provider: string;
  recencyDays: number;
  results: SearchResult[];
  registry: SourceRegistry;
}): { text: string; cited: Source[] } {
  const { query, provider, recencyDays, results, registry } = options;

  if (results.length === 0) {
    return {
      text: `WEB SEARCH\nQuery: "${query}"\nProvider: ${provider}\nResults: none.\nNo evidence was returned. Try a different query or tell the user you could not find it.`,
      cited: [],
    };
  }

  const queryTerms = extractKeywords(query, 8);
  const ranked = results
    .map((result, index) => {
      let domain = "";
      try {
        domain = new URL(result.url).hostname.replace(/^www\./, "").replace(/\./g, "");
      } catch {
        domain = "";
      }
      const vendorMatch = queryTerms.some(
        (term) => term.length >= 3 && domain.includes(term),
      );
      return { result, index, vendorMatch };
    })
    .sort((a, b) => Number(b.vendorMatch) - Number(a.vendorMatch) || a.index - b.index);

  const lines: string[] = [
    "WEB SEARCH RESULTS",
    `Query: "${query}"`,
    `Provider: ${provider}${recencyDays > 0 ? ` (restricted to the last ${recencyDays} days)` : ""}`,
    `Results: ${results.length}. Cite specific claims with [n]. These numbers are stable for this turn.`,
    "Source priority: for pricing, releases and product facts, use the vendor's own domain first. A third-party blog is not the official page; if you use one, label it as a third-party summary.",
    "",
  ];

  const cited: Source[] = [];
  for (const { result } of ranked) {
    if (lines.join("\n").length > MAX_EVIDENCE_CHARS) break;
    const source = registry.register(result.title, result.url, result.published);
    cited.push(source);
    lines.push(`[${source.n}] ${source.title}`);
    lines.push(`URL: ${source.url}`);
    if (source.published) lines.push(`Published: ${source.published}`);
    lines.push(`Excerpt: ${result.content || "No excerpt available."}`);
    lines.push("");
  }

  return { text: lines.join("\n").trim(), cited };
}
