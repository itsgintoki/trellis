import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type {
  Conversation,
  ConversationSummary,
  Memory,
  Message,
  Role,
  Source,
} from "./types";

interface ConversationRow {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

interface ConversationSummaryRow extends ConversationRow {
  message_count: number;
  last_message_at: string | null;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: Role;
  content: string;
  sources: string;
  metadata: string;
  created_at: string;
  created_day: string;
}

interface MemoryRow {
  id: string;
  conversation_id: string;
  user_message_id: string | null;
  assistant_message_id: string | null;
  question: string;
  answer: string;
  summary: string;
  topics: string;
  entities: string;
  sources: string;
  embedding: string | null;
  created_at: string;
  created_day: string;
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function mapConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    sources: parseJson<Source[]>(row.sources, []),
    metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
    createdAt: row.created_at,
    createdDay: row.created_day,
  };
}

function mapMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    userMessageId: row.user_message_id,
    assistantMessageId: row.assistant_message_id,
    question: row.question,
    answer: row.answer,
    summary: row.summary,
    topics: parseJson<string[]>(row.topics, []),
    entities: parseJson<string[]>(row.entities, []),
    sources: parseJson<Source[]>(row.sources, []),
    embedding: parseJson<number[] | null>(row.embedding, null),
    createdAt: row.created_at,
    createdDay: row.created_day,
  };
}

export interface AddMessageInput {
  conversationId: string;
  role: Role;
  content: string;
  sources?: Source[];
  metadata?: Record<string, unknown>;
  createdAt?: string;
  createdDay: string;
}

export interface AddMemoryInput {
  conversationId: string;
  userMessageId: string | null;
  assistantMessageId: string | null;
  question: string;
  answer: string;
  summary: string;
  topics: string[];
  entities: string[];
  sources: Source[];
  embedding: number[] | null;
  createdAt: string;
  createdDay: string;
}

export class Store {
  private readonly db: Database.Database;

  constructor(filePath: string) {
    if (filePath !== ":memory:") {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    }
    this.db = new Database(filePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        sources TEXT NOT NULL DEFAULT '[]',
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        created_day TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_conversation
        ON messages(conversation_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_day
        ON messages(created_day);

      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        user_message_id TEXT,
        assistant_message_id TEXT,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        summary TEXT NOT NULL,
        topics TEXT NOT NULL DEFAULT '[]',
        entities TEXT NOT NULL DEFAULT '[]',
        sources TEXT NOT NULL DEFAULT '[]',
        embedding TEXT,
        created_at TEXT NOT NULL,
        created_day TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memories_day
        ON memories(created_day);
      CREATE INDEX IF NOT EXISTS idx_memories_conversation
        ON memories(conversation_id);

      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        memory_id UNINDEXED,
        question,
        summary,
        answer,
        topics,
        entities,
        tokenize = 'porter unicode61'
      );
    `);
  }

  createConversation(title = "New conversation"): Conversation {
    const now = new Date().toISOString();
    const conversation: Conversation = {
      id: crypto.randomUUID(),
      title,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        "INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run(conversation.id, conversation.title, conversation.createdAt, conversation.updatedAt);
    return conversation;
  }

  getConversation(id: string): Conversation | null {
    const row = this.db
      .prepare("SELECT * FROM conversations WHERE id = ?")
      .get(id) as ConversationRow | undefined;
    return row ? mapConversation(row) : null;
  }

  listConversations(limit = 100): ConversationSummary[] {
    const rows = this.db
      .prepare(
        `SELECT c.*, COUNT(m.id) AS message_count, MAX(m.created_at) AS last_message_at
         FROM conversations c
         LEFT JOIN messages m ON m.conversation_id = c.id
         GROUP BY c.id
         ORDER BY c.updated_at DESC
         LIMIT ?`,
      )
      .all(limit) as ConversationSummaryRow[];
    return rows.map((row) => ({
      ...mapConversation(row),
      messageCount: row.message_count,
      lastMessageAt: row.last_message_at,
    }));
  }

  updateTitle(id: string, title: string): void {
    this.db.prepare("UPDATE conversations SET title = ? WHERE id = ?").run(title, id);
  }

  addMessage(input: AddMessageInput): Message {
    const message: Message = {
      id: crypto.randomUUID(),
      conversationId: input.conversationId,
      role: input.role,
      content: input.content,
      sources: input.sources ?? [],
      metadata: input.metadata ?? {},
      createdAt: input.createdAt ?? new Date().toISOString(),
      createdDay: input.createdDay,
    };
    const insert = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO messages
             (id, conversation_id, role, content, sources, metadata, created_at, created_day)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          message.id,
          message.conversationId,
          message.role,
          message.content,
          JSON.stringify(message.sources),
          JSON.stringify(message.metadata),
          message.createdAt,
          message.createdDay,
        );
      this.db
        .prepare("UPDATE conversations SET updated_at = ? WHERE id = ?")
        .run(message.createdAt, message.conversationId);
    });
    insert();
    return message;
  }

  countMessages(conversationId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?")
      .get(conversationId) as { count: number };
    return row.count;
  }

  listMessages(conversationId: string, limit?: number): Message[] {
    const rows = limit
      ? (this.db
          .prepare(
            `SELECT * FROM (
               SELECT * FROM messages WHERE conversation_id = ?
               ORDER BY created_at DESC LIMIT ?
             ) ORDER BY created_at ASC`,
          )
          .all(conversationId, limit) as MessageRow[])
      : (this.db
          .prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC")
          .all(conversationId) as MessageRow[]);
    return rows.map(mapMessage);
  }

  recentMessages(limit = 300): Message[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM messages ORDER BY created_at DESC LIMIT ?
         ) ORDER BY created_at ASC`,
      )
      .all(limit) as MessageRow[];
    return rows.map(mapMessage);
  }

  addMemory(input: AddMemoryInput): Memory {
    const memory: Memory = {
      id: crypto.randomUUID(),
      ...input,
    };
    const insert = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO memories
             (id, conversation_id, user_message_id, assistant_message_id, question, answer,
              summary, topics, entities, sources, embedding, created_at, created_day)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          memory.id,
          memory.conversationId,
          memory.userMessageId,
          memory.assistantMessageId,
          memory.question,
          memory.answer,
          memory.summary,
          JSON.stringify(memory.topics),
          JSON.stringify(memory.entities),
          JSON.stringify(memory.sources),
          memory.embedding ? JSON.stringify(memory.embedding) : null,
          memory.createdAt,
          memory.createdDay,
        );
      this.db
        .prepare(
          `INSERT INTO memories_fts (memory_id, question, summary, answer, topics, entities)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          memory.id,
          memory.question,
          memory.summary,
          memory.answer,
          memory.topics.join(" "),
          memory.entities.join(" "),
        );
    });
    insert();
    return memory;
  }

  searchMemories(ftsQuery: string, limit = 10): Memory[] {
    const rows = this.db
      .prepare(
        `SELECT m.*, bm25(memories_fts) AS rank
         FROM memories_fts
         JOIN memories m ON m.id = memories_fts.memory_id
         WHERE memories_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(ftsQuery, limit) as MemoryRow[];
    return rows.map(mapMemory);
  }

  memoriesForDays(days: string[], limit = 20): Memory[] {
    if (days.length === 0) return [];
    const placeholders = days.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT * FROM memories
         WHERE created_day IN (${placeholders})
         ORDER BY created_at ASC
         LIMIT ?`,
      )
      .all(...days, limit) as MemoryRow[];
    return rows.map(mapMemory);
  }

  messagesForDays(days: string[], limit = 200): Message[] {
    if (days.length === 0) return [];
    const placeholders = days.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE created_day IN (${placeholders})
         ORDER BY conversation_id ASC, created_at ASC
         LIMIT ?`,
      )
      .all(...days, limit) as MessageRow[];
    return rows.map(mapMessage);
  }

  memoriesWithEmbeddings(limit = 800): Memory[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memories
         WHERE embedding IS NOT NULL
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(limit) as MemoryRow[];
    return rows.map(mapMemory);
  }

  recentMemories(limit = 4, excludeConversationId?: string): Memory[] {
    const rows = excludeConversationId
      ? (this.db
          .prepare(
            `SELECT * FROM memories WHERE conversation_id != ?
             ORDER BY created_at DESC LIMIT ?`,
          )
          .all(excludeConversationId, limit) as MemoryRow[])
      : (this.db
          .prepare("SELECT * FROM memories ORDER BY created_at DESC LIMIT ?")
          .all(limit) as MemoryRow[]);
    return rows.map(mapMemory);
  }

  close(): void {
    this.db.close();
  }
}
