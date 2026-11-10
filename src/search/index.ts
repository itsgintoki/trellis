import { config } from "../config";
import { abortableTimeout } from "../llm";
import { duckDuckGoSearch } from "./ddg";
import { tavilySearch } from "./tavily";
import { SearchError, type SearchOptions, type SearchResponse } from "./types";

const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 120;

const cache = new Map<string, { at: number; value: SearchResponse }>();
const inFlight = new Map<string, Promise<SearchResponse>>();

export interface WebSearchResult extends SearchResponse {
  cached: boolean;
}

function pruneCache(): void {
  if (cache.size <= MAX_CACHE_ENTRIES) return;
  const excess = cache.size - MAX_CACHE_ENTRIES;
  let removed = 0;
  for (const key of cache.keys()) {
    cache.delete(key);
    if (++removed >= excess) break;
  }
}

async function runSearch(query: string, options: SearchOptions): Promise<SearchResponse> {
  const signal = abortableTimeout(config.search.timeoutMs, options.signal);

  if (config.search.tavilyKey) {
    try {
      return await tavilySearch(query, options, signal);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      console.warn(`[search] Tavily failed, trying DuckDuckGo: ${(error as Error).message}`);
      try {
        return await duckDuckGoSearch(query, options, signal);
      } catch (fallbackError) {
        throw new SearchError(
          `Search failed. Tavily: ${(error as Error).message}. DuckDuckGo: ${(fallbackError as Error).message}`,
        );
      }
    }
  }

  return duckDuckGoSearch(query, options, signal);
}

export async function webSearch(
  query: string,
  options: SearchOptions = {},
): Promise<WebSearchResult> {
  const normalizedQuery = query.replace(/\s+/g, " ").trim().slice(0, 400);
  if (normalizedQuery.length < 2) {
    throw new SearchError("The search query is too short.");
  }

  const recencyDays = Math.max(0, Math.min(Math.round(options.recencyDays ?? 0), 3650));
  const maxResults = Math.max(1, Math.min(options.maxResults ?? 3, 8));
  const cacheKey = `${normalizedQuery.toLowerCase()}|${recencyDays}|${maxResults}`;

  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return { ...cached.value, cached: true };
  }

  const pending = inFlight.get(cacheKey);
  if (pending) {
    return { ...(await pending), cached: false };
  }

  const promise = runSearch(normalizedQuery, { ...options, recencyDays, maxResults }).finally(() => {
    inFlight.delete(cacheKey);
  });
  inFlight.set(cacheKey, promise);

  const value = await promise;
  cache.set(cacheKey, { at: Date.now(), value });
  pruneCache();
  return { ...value, cached: false };
}

export function searchProviderLabel(): string {
  return config.search.tavilyKey ? "Tavily" : "DuckDuckGo fallback";
}
