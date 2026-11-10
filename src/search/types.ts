export interface SearchResult {
  title: string;
  url: string;
  content: string;
  published?: string;
  score?: number;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  provider: string;
  recencyDays: number;
}

export interface SearchOptions {
  recencyDays?: number;
  maxResults?: number;
  signal?: AbortSignal;
}

export class SearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchError";
  }
}

export function normalizeSearchUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    for (const key of [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "gclid",
      "fbclid",
      "ref",
    ]) {
      url.searchParams.delete(key);
    }
    if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
      url.pathname = url.pathname.slice(0, -1);
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function cleanTitle(title: string, url: string): string {
  const clean = title.replace(/\s+/g, " ").trim();
  if (clean) return clean;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function normalizePublishedDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
  return value.trim().slice(0, 40);
}
