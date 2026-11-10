import { embed } from "../llm";
import type { Store } from "../db";
import type { Memory, Message, RecallResult, RecalledMemory, TemporalReference } from "../types";
import { addDays, daysBetween, daysInRange, formatDayLong, localDay, resolveTemporal } from "../time";
import {
  buildFtsQuery,
  cosineSimilarity,
  extractEntities,
  extractKeywords,
  isRecallQuestion,
  stripCitations,
  truncate,
} from "./text";

interface Candidate {
  key: string;
  memory: RecalledMemory;
  score: number;
  reasons: Set<string>;
}

interface RecallOptions {
  now?: Date;
  timezone?: string;
  conversationId?: string;
  currentMessageId?: string;
  signal?: AbortSignal;
}

function memoryToRecalled(memory: Memory): RecalledMemory {
  return {
    id: memory.id,
    conversationId: memory.conversationId,
    date: memory.createdDay,
    question: memory.question,
    answer: memory.answer,
    summary: memory.summary,
    topics: memory.topics,
    entities: memory.entities,
    sources: memory.sources,
    score: 0,
  };
}

function rawExchangeMemories(
  messages: Message[],
  excludeMessageId?: string,
): Array<{ key: string; memory: RecalledMemory }> {
  const pendingUsers = new Map<string, Message>();
  const result: Array<{ key: string; memory: RecalledMemory }> = [];

  const add = (user: Message, assistant?: Message) => {
    if (excludeMessageId && user.id === excludeMessageId) return;
    const answer = assistant?.content ?? "";
    result.push({
      key: user.id,
      memory: {
        id: user.id,
        conversationId: user.conversationId,
        date: user.createdDay,
        question: user.content,
        answer,
        summary: truncate(stripCitations(answer), 300),
        topics: extractKeywords(user.content, 4),
        entities: extractEntities(user.content, 4),
        sources: assistant?.sources ?? [],
        score: 0,
      },
    });
  };

  for (const message of messages) {
    if (message.role === "user") {
      pendingUsers.set(message.conversationId, message);
    } else {
      const user = pendingUsers.get(message.conversationId);
      if (user) {
        add(user, message);
        pendingUsers.delete(message.conversationId);
      }
    }
  }
  for (const user of pendingUsers.values()) add(user);
  return result;
}

function withinWindow(date: string, temporal: TemporalReference): boolean {
  return date >= temporal.startDay && date <= temporal.endDay;
}

function temporalDescription(temporal: TemporalReference): string {
  if (temporal.grain === "day") return formatDayLong(temporal.startDay);
  return `${formatDayLong(temporal.startDay)} to ${formatDayLong(temporal.endDay)}`;
}

async function vectorMatches(
  store: Store,
  text: string,
  signal?: AbortSignal,
): Promise<Array<{ memory: Memory; similarity: number }>> {
  const vectors = await embed([text], signal, 900);
  const query = vectors?.[0];
  if (!query) return [];
  return store
    .memoriesWithEmbeddings(800)
    .map((memory) => ({
      memory,
      similarity: memory.embedding ? cosineSimilarity(query, memory.embedding) : 0,
    }))
    .filter((entry) => entry.similarity > 0.15)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 12);
}

export async function recallMemories(
  store: Store,
  text: string,
  options: RecallOptions = {},
): Promise<RecallResult> {
  const now = options.now ?? new Date();
  const timezone = options.timezone ?? "UTC";
  const today = localDay(now, timezone);
  const recallIntent = isRecallQuestion(text);
  let temporal = resolveTemporal(text, now, timezone);

  // "right now" and "today" in an ordinary question are not memory references.
  // Only treat them as recall when the user is actually asking about a past chat.
  if (
    temporal &&
    !recallIntent &&
    /^(now|today|currently|this (week|month|year))$/i.test(temporal.label.trim())
  ) {
    temporal = null;
  }

  const tokens = extractKeywords(text, 10);
  const ftsQuery = buildFtsQuery(tokens);

  const [ftsRows, vectorRows] = await Promise.all([
    Promise.resolve(ftsQuery ? store.searchMemories(ftsQuery, 12) : []),
    tokens.length > 0 || !temporal ? vectorMatches(store, text, options.signal) : Promise.resolve([]),
  ]);

  const candidates = new Map<string, Candidate>();

  const add = (
    key: string,
    memory: RecalledMemory,
    amount: number,
    reason: string,
    prefer = false,
  ) => {
    const existing = candidates.get(key);
    if (existing) {
      existing.score += amount;
      existing.reasons.add(reason);
      if (prefer && memory.summary) existing.memory = memory;
      return;
    }
    candidates.set(key, {
      key,
      memory,
      score: amount,
      reasons: new Set([reason]),
    });
  };

  const addMemory = (memory: Memory, amount: number, reason: string) => {
    add(memory.userMessageId ?? memory.id, memoryToRecalled(memory), amount, reason, true);
  };

  const addRaw = (entry: { key: string; memory: RecalledMemory }, amount: number, reason: string) => {
    add(entry.key, entry.memory, amount, reason);
  };

  const scoreOverlap = (memory: RecalledMemory): number => {
    if (tokens.length === 0) return 0;
    const haystack = `${memory.question} ${memory.summary} ${memory.answer} ${memory.topics.join(" ")}`.toLowerCase();
    return tokens.reduce((total, token) => total + (haystack.includes(token) ? 0.15 : 0), 0);
  };

  const scoreFreshness = (memory: RecalledMemory): number => {
    const age = Math.max(0, daysBetween(memory.date, today));
    return 0.15 * Math.exp(-age / 45);
  };

  let note: string | undefined;
  let outsideWindowMemories: Array<{ key: string; memory: RecalledMemory }> = [];

  if (temporal) {
    let days = daysInRange(temporal.startDay, temporal.endDay);
    let windowMemories = store.memoriesForDays(days, 30);
    let windowRaw = rawExchangeMemories(
      store.messagesForDays(days, 200),
      options.currentMessageId,
    );

    for (const memory of windowMemories) addMemory(memory, 10, "date");
    for (const entry of windowRaw) addRaw(entry, 8, "date");

    for (const [rank, memory] of ftsRows.entries()) {
      if (!withinWindow(memory.createdDay, temporal)) continue;
      addMemory(memory, 1.5 / (60 + rank + 1), "keywords");
    }
    for (const { memory, similarity } of vectorRows) {
      if (!withinWindow(memory.createdDay, temporal)) continue;
      addMemory(memory, similarity * 1.2, "semantic");
    }

    const inWindowCount = candidates.size;
    if (inWindowCount === 0 && temporal.grain === "day") {
      days = daysInRange(addDays(temporal.startDay, -2), addDays(temporal.endDay, 2));
      windowMemories = store.memoriesForDays(days, 30);
      windowRaw = rawExchangeMemories(
        store.messagesForDays(days, 200),
        options.currentMessageId,
      );

      for (const memory of windowMemories) addMemory(memory, 6, "near-date");
      for (const entry of windowRaw) addRaw(entry, 5, "near-date");

      if (candidates.size > 0) {
        note = `No conversation was recorded on ${formatDayLong(temporal.startDay)}. The nearest exchanges are shown; they are from other dates.`;
      }
    }

    if (candidates.size === 0) {
      note = `No conversation was recorded on ${temporalDescription(temporal)}.`;
    }

    if (candidates.size === 0 && tokens.length > 0) {
      outsideWindowMemories = [
        ...vectorRows
          .filter(({ memory }) => !withinWindow(memory.createdDay, temporal))
          .slice(0, 2)
          .map(({ memory }) => ({
            key: memory.userMessageId ?? memory.id,
            memory: memoryToRecalled(memory),
          })),
        ...ftsRows
          .filter((memory) => !withinWindow(memory.createdDay, temporal))
          .slice(0, 2)
          .map((memory) => ({
            key: memory.userMessageId ?? memory.id,
            memory: memoryToRecalled(memory),
          })),
      ];
      const seen = new Set<string>();
      outsideWindowMemories = outsideWindowMemories.filter((entry) => {
        if (seen.has(entry.key)) return false;
        seen.add(entry.key);
        return true;
      });
      if (outsideWindowMemories.length > 0) {
        note = `No conversation was recorded on ${temporalDescription(temporal)}. The records below are topically related but happened on other dates.`;
      }
    }
  } else {
    for (const [rank, memory] of ftsRows.entries()) {
      addMemory(memory, 2.5 / (60 + rank + 1), "keywords");
    }
    for (const { memory, similarity } of vectorRows) {
      addMemory(memory, similarity * 1.5, "semantic");
    }

    // Extraction is asynchronous. Scan recent raw exchanges too, so a brand-new
    // conversation can recall a topic before its memory card exists.
    if (tokens.length > 0) {
      const rawRecent = rawExchangeMemories(
        store.recentMessages(300),
        options.currentMessageId,
      );
      for (const entry of rawRecent) {
        const overlap = scoreOverlap(entry.memory);
        if (overlap > 0) addRaw(entry, overlap * 0.5, "recent-raw");
      }
    }

    if (candidates.size === 0 && (recallIntent || tokens.length > 0)) {
      const recent = store.recentMemories(3, options.conversationId);
      for (const [index, memory] of recent.entries()) {
        addMemory(memory, 0.4 / (index + 1), "recent");
      }
      if (recent.length > 0) {
        note = "No date was given, so these are the most recent earlier conversations.";
      }
    }
  }

  for (const candidate of candidates.values()) {
    candidate.score += scoreOverlap(candidate.memory) + scoreFreshness(candidate.memory);
  }

  const ranked = [...candidates.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((candidate) => ({ ...candidate.memory, score: candidate.score }));

  for (const entry of outsideWindowMemories.slice(0, 2)) {
    if (ranked.some((memory) => memory.id === entry.memory.id)) continue;
    if (ranked.length >= 5) break;
    ranked.push({ ...entry.memory, score: 0 });
  }

  return { memories: ranked, temporal, note };
}
