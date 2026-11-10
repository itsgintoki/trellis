process.env.DISABLE_EMBEDDINGS = "1";

const { Store } = require("../src/db") as typeof import("../src/db");
const { recallMemories } = require("../src/memory/retrieval") as typeof import("../src/memory/retrieval");

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Store as StoreType } from "../src/db";

const NOW = new Date("2026-11-10T14:54:00.000Z");
const IST = "Asia/Calcutta";

function seedExchange(
  store: StoreType,
  input: {
    conversationId: string;
    day: string;
    createdAt: string;
    question: string;
    answer: string;
    summary: string;
    topics: string[];
    withMemory?: boolean;
  },
) {
  const user = store.addMessage({
    conversationId: input.conversationId,
    role: "user",
    content: input.question,
    createdAt: input.createdAt,
    createdDay: input.day,
  });
  const assistant = store.addMessage({
    conversationId: input.conversationId,
    role: "assistant",
    content: input.answer,
    createdAt: new Date(new Date(input.createdAt).getTime() + 30_000).toISOString(),
    createdDay: input.day,
  });

  if (input.withMemory !== false) {
    store.addMemory({
      conversationId: input.conversationId,
      userMessageId: user.id,
      assistantMessageId: assistant.id,
      question: input.question,
      answer: input.answer,
      summary: input.summary,
      topics: input.topics,
      entities: [],
      sources: [],
      embedding: null,
      createdAt: assistant.createdAt,
      createdDay: input.day,
    });
  }

  return { user, assistant };
}

function freshStore() {
  return new Store(":memory:");
}

test("date recall finds the right day and ranks the matching topic first", async () => {
  const store = freshStore();
  const conversation = store.createConversation("Hosting research");

  seedExchange(store, {
    conversationId: conversation.id,
    day: "2026-11-03",
    createdAt: "2026-11-03T10:00:00.000Z",
    question: "Which Postgres host should I use for a side project?",
    answer: "Start with Neon's free tier. Supabase is also worth a look.",
    summary: "Compared Postgres hosts; recommended Neon's free tier, with Supabase as an alternative.",
    topics: ["postgres", "hosting", "neon"],
  });

  const other = store.createConversation("CRM shortlist");
  seedExchange(store, {
    conversationId: other.id,
    day: "2026-11-05",
    createdAt: "2026-11-05T09:00:00.000Z",
    question: "Shortlist CRM tools for a small sales team.",
    answer: "Look at Pipedrive, HubSpot, and Close.",
    summary: "Shortlisted Pipedrive, HubSpot, and Close for a small sales team.",
    topics: ["crm", "sales", "pipedrive"],
  });

  const byDate = await recallMemories(store, "What did I ask you on 3 November?", {
    now: NOW,
    timezone: IST,
  });
  assert.equal(byDate.temporal?.startDay, "2026-11-03");
  assert.equal(byDate.memories.length, 1);
  assert.match(byDate.memories[0]!.question, /Postgres host/);

  const byTopic = await recallMemories(
    store,
    "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?",
    { now: NOW, timezone: IST },
  );
  assert.equal(byTopic.memories[0]?.date, "2026-11-03");
  assert.match(byTopic.memories[0]!.question, /Postgres/);
});

test("raw messages are recalled even before memory extraction has run", async () => {
  const store = freshStore();
  const conversation = store.createConversation("Raw recall");

  seedExchange(store, {
    conversationId: conversation.id,
    day: "2026-11-03",
    createdAt: "2026-11-03T11:00:00.000Z",
    question: "What did we decide about the launch date?",
    answer: "We agreed to launch on 14 December.",
    summary: "",
    topics: [],
    withMemory: false,
  });

  const result = await recallMemories(store, "What did I ask you on 3 November?", {
    now: NOW,
    timezone: IST,
  });
  assert.equal(result.temporal?.startDay, "2026-11-03");
  assert.equal(result.memories.length, 1);
  assert.match(result.memories[0]!.question, /launch date/);
  assert.match(result.memories[0]!.answer, /14 December/);
});

test("a general question containing 'right now' does not trigger date recall", async () => {
  const store = freshStore();
  const result = await recallMemories(store, "What does Neon cost right now?", {
    now: NOW,
    timezone: IST,
  });
  assert.equal(result.temporal, null);
  assert.equal(result.note, undefined);
});

test("an explicit recall question with 'today' still uses today's date", async () => {
  const store = freshStore();
  const conversation = store.createConversation("Today");
  seedExchange(store, {
    conversationId: conversation.id,
    day: "2026-11-10",
    createdAt: "2026-11-10T09:00:00.000Z",
    question: "What does Neon cost per month?",
    answer: "Neon Launch was $19 per month at the time.",
    summary: "Neon Launch was $19/mo.",
    topics: ["neon", "pricing"],
  });

  const result = await recallMemories(store, "What did I ask you today?", {
    now: NOW,
    timezone: IST,
  });
  assert.ok(result.temporal);
  assert.equal(result.temporal.startDay, "2026-11-10");
  assert.match(result.memories[0]!.question, /Neon cost/);
});

test("a dateless topical question recalls recent raw messages before extraction", async () => {
  const store = freshStore();
  const conversation = store.createConversation("Hosting");
  seedExchange(store, {
    conversationId: conversation.id,
    day: "2026-11-08",
    createdAt: "2026-11-08T09:00:00.000Z",
    question: "Which Postgres host should I use for the side project?",
    answer: "Neon's free tier is the best fit.",
    summary: "",
    topics: [],
    withMemory: false,
  });

  const result = await recallMemories(store, "Which Postgres host did we pick?", {
    now: NOW,
    timezone: IST,
  });

  assert.ok(result.memories.length > 0);
  assert.match(result.memories[0]!.question, /Postgres host/);
});

test("the in-flight question is never recalled as a past exchange", async () => {
  const store = freshStore();
  const conversation = store.createConversation("Same day");

  seedExchange(store, {
    conversationId: conversation.id,
    day: "2026-11-10",
    createdAt: "2026-11-10T09:00:00.000Z",
    question: "Which Postgres host should I use?",
    answer: "Neon's free tier is a good start.",
    summary: "Recommended Neon for Postgres hosting.",
    topics: ["postgres", "neon"],
  });

  const current = store.addMessage({
    conversationId: conversation.id,
    role: "user",
    content: "What did I ask you on 10 November?",
    createdAt: "2026-11-10T14:50:00.000Z",
    createdDay: "2026-11-10",
  });

  const result = await recallMemories(store, current.content, {
    now: NOW,
    timezone: IST,
    currentMessageId: current.id,
  });

  assert.equal(result.memories.length, 1);
  assert.match(result.memories[0]!.question, /Which Postgres host/);
  assert.ok(!result.memories.some((memory) => memory.question === current.content));
});

test("a near-date hit is clearly labelled as not being from the requested day", async () => {
  const store = freshStore();
  const conversation = store.createConversation("Nearby");
  seedExchange(store, {
    conversationId: conversation.id,
    day: "2026-11-05",
    createdAt: "2026-11-05T08:00:00.000Z",
    question: "Which managed Postgres host is cheapest?",
    answer: "Neon was the cheapest option we found.",
    summary: "Neon was the cheapest managed Postgres option.",
    topics: ["postgres", "pricing"],
  });

  const result = await recallMemories(store, "What did I ask you on 3 November?", {
    now: NOW,
    timezone: IST,
  });
  assert.equal(result.memories[0]?.date, "2026-11-05");
  assert.ok(result.note);
  assert.match(result.note!, /No conversation was recorded on Tuesday, 3 November 2026/);
});

test("an entirely missing date produces an honest note, not an invented memory", async () => {
  const store = freshStore();
  const result = await recallMemories(store, "What did I ask you on 3 November?", {
    now: NOW,
    timezone: IST,
  });
  assert.equal(result.memories.length, 0);
  assert.ok(result.note);
  assert.match(result.note!, /No conversation was recorded/);
});

test("a dateless recall question falls back to recent earlier conversations", async () => {
  const store = freshStore();
  const conversation = store.createConversation("Earlier");
  seedExchange(store, {
    conversationId: conversation.id,
    day: "2026-10-01",
    createdAt: "2026-10-01T08:00:00.000Z",
    question: "Should I use Redis or Postgres for queues?",
    answer: "Postgres is enough at your scale; Redis adds operational work.",
    summary: "Chose Postgres for queues at small scale.",
    topics: ["postgres", "queues"],
  });

  const result = await recallMemories(store, "What did I ask you earlier?", {
    now: NOW,
    timezone: IST,
    conversationId: "another-conversation",
  });
  assert.equal(result.memories.length, 1);
  assert.match(result.memories[0]!.question, /Redis or Postgres/);
  assert.match(result.note || "", /most recent earlier conversations/);
});
