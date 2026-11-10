import type { Message } from "../types";
import type { Store } from "../db";
import { completeJson, embed, llmConfigured } from "../llm";
import { extractEntities, extractKeywords, stripCitations, truncate } from "./text";

const EXTRACTION_SYSTEM = `You write compact memory cards for a chat assistant.

Return JSON only, with exactly these fields:
{"summary": "...", "topics": ["..."], "entities": ["..."]}

Rules:
- summary: 1-2 sentences, at most 60 words. Preserve concrete facts the assistant may need later: product and company names, prices, versions, dates, decisions, shortlist items, and what the user wanted. If the assistant gave an answer, preserve its key claims and numbers. No citations, no preamble.
- topics: 2-5 lowercase search keywords.
- entities: named companies, products, people, and technologies, keeping original casing. Empty array if none.
- Never invent anything not present in the exchange.`;

interface MemoryCard {
  summary: string;
  topics: string[];
  entities: string[];
}

function stringList(value: unknown, limit: number, maxLength = 60): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const clean = item.trim();
    if (!clean) continue;
    result.push(truncate(clean, maxLength));
    if (result.length >= limit) break;
  }
  return result;
}

async function buildCard(question: string, answer: string): Promise<MemoryCard> {
  const fallback: MemoryCard = {
    summary: truncate(answer || question, 320),
    topics: extractKeywords(`${question} ${answer}`, 5),
    entities: extractEntities(`${question} ${answer}`, 8),
  };

  const data = await completeJson({
    system: EXTRACTION_SYSTEM,
    user: `USER MESSAGE:\n${truncate(question, 4000)}\n\nASSISTANT REPLY:\n${truncate(answer, 6000)}`,
  });
  if (!data) return fallback;

  const summary =
    typeof data.summary === "string" && data.summary.trim()
      ? truncate(data.summary.trim(), 700)
      : fallback.summary;
  const topics = stringList(data.topics, 6);
  const entities = stringList(data.entities, 10);

  return {
    summary,
    topics: topics.length ? topics : fallback.topics,
    entities: entities.length ? entities : fallback.entities,
  };
}

async function extractAndStore(input: {
  store: Store;
  conversationId: string;
  userMessage: Message;
  assistantMessage: Message;
}): Promise<void> {
  const question = input.userMessage.content.trim();
  const answer = stripCitations(input.assistantMessage.content).trim();
  if (!question || !answer || question.length + answer.length < 30) return;

  const card = await buildCard(question, answer);
  const embeddingText = `${question}\n${card.summary}\n${card.topics.join(", ")}`;
  const embedding = (await embed([embeddingText]))?.[0] ?? null;

  input.store.addMemory({
    conversationId: input.conversationId,
    userMessageId: input.userMessage.id,
    assistantMessageId: input.assistantMessage.id,
    question: truncate(question, 1500),
    answer: truncate(answer, 4000),
    summary: card.summary,
    topics: card.topics,
    entities: card.entities,
    sources: input.assistantMessage.sources,
    embedding,
    createdAt: input.assistantMessage.createdAt,
    createdDay: input.assistantMessage.createdDay,
  });
}

let queue: Promise<void> = Promise.resolve();

/**
 * Runs after the response is sent. Memory is a convenience, never a
 * reason to make the user wait.
 */
export function scheduleMemoryExtraction(input: {
  store: Store;
  conversationId: string;
  userMessage: Message;
  assistantMessage: Message;
}): void {
  if (!llmConfigured) return;
  queue = queue
    .then(() => extractAndStore(input))
    .catch((error) => {
      console.warn(`[memory] Extraction failed: ${(error as Error).message}`);
    });
}
