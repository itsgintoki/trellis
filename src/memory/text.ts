const STOPWORDS = new Set(
  `a about above after again against all also am an and any are as at be because been before being below
  between both but by can could did do does doing done down during each few for from further had has have
  having he her here hers herself him himself his how i if in into is it its itself just me more most my
  myself no nor not now of off on once only or other our ours ourselves out over own same she should so
  some such than that the their theirs them themselves then there these they this those through to too
  under until up very was we were what when where which while who whom why will with would you your
  yours yourself yourselves
  ask asked asking answer answered chat chatted conversation discuss discussed know remember tell told
  said say saying talk talked talking think thought recall remind question
  change changed changes changing still correct today yesterday tomorrow since ago current currently
  latest new big anything something thing things please thanks thank ok okay hey hello hi
  last next this week weeks month months year years day days monday tuesday wednesday thursday friday
  saturday sunday january february march april may june july august september october november december`
    .split(/\s+/)
    .filter(Boolean),
);

export function extractKeywords(text: string, limit = 10): string[] {
  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const match of text.toLowerCase().matchAll(/[a-z0-9][a-z0-9.+#-]*/g)) {
    const token = match[0].replace(/[.+#-]+$/, "");
    if (token.length < 3 || STOPWORDS.has(token) || seen.has(token)) continue;
    seen.add(token);
    keywords.push(token);
    if (keywords.length >= limit) break;
  }
  return keywords;
}

export function buildFtsQuery(tokens: string[]): string | null {
  const safe = tokens
    .map((token) => token.replace(/[^a-z0-9]/gi, ""))
    .filter((token) => token.length >= 3)
    .slice(0, 10);
  if (safe.length === 0) return null;
  return safe.map((token) => `${token}*`).join(" OR ");
}

export function extractEntities(text: string, limit = 8): string[] {
  const ignored = new Set(["i", "the", "a", "an", "and", "but", "if", "so", "it", "we", "you", "they"]);
  const seen = new Set<string>();
  const entities: string[] = [];
  for (const match of text.matchAll(/\b[A-Z][A-Za-z0-9.+#-]{1,}\b/g)) {
    const value = match[0];
    if (ignored.has(value.toLowerCase()) || seen.has(value)) continue;
    seen.add(value);
    entities.push(value);
    if (entities.length >= limit) break;
  }
  return entities;
}

export function truncate(text: string, max: number): string {
  const normalized = text.trim();
  if (normalized.length <= max) return normalized;
  const cut = normalized.slice(0, max);
  const boundary = cut.lastIndexOf(" ");
  return `${(boundary > max * 0.6 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}

export function stripCitations(text: string): string {
  return text.replace(/\s?\[\d{1,2}\](?=[\s.,;:!?)]|$)/g, "").replace(/[ \t]{2,}/g, " ");
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function isRecallQuestion(text: string): boolean {
  return /\b(what did (i|we)|remind me|last time|when we (talked|spoke|discussed)|earlier|previous|before)\b/i.test(
    text,
  );
}
