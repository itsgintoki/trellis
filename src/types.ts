export type Role = "user" | "assistant";

export interface Source {
  n: number;
  title: string;
  url: string;
  domain: string;
  published?: string;
}

export interface Message {
  id: string;
  conversationId: string;
  role: Role;
  content: string;
  sources: Source[];
  metadata: Record<string, unknown>;
  createdAt: string;
  createdDay: string;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationSummary extends Conversation {
  messageCount: number;
  lastMessageAt: string | null;
}

export interface Memory {
  id: string;
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

export interface RecalledMemory {
  id: string;
  conversationId: string;
  date: string;
  question: string;
  answer: string;
  summary: string;
  topics: string[];
  entities: string[];
  sources: Source[];
  score: number;
}

export interface TemporalReference {
  label: string;
  startDay: string;
  endDay: string;
  grain: "day" | "week" | "month";
}

export interface RecallResult {
  memories: RecalledMemory[];
  temporal: TemporalReference | null;
  note?: string;
}

export interface ToolTraceEntry {
  query: string;
  results: number;
  provider?: string;
  error?: string;
}

export interface StoredMetadata {
  recalled?: Array<{ date: string; question: string; topics: string[] }>;
  recallNote?: string;
  recallReference?: { label: string; startDay: string; endDay: string };
  toolTrace?: ToolTraceEntry[];
  elapsedMs?: number;
  interrupted?: boolean;
  error?: string;
}

export type AgentEvent =
  | { type: "start"; conversationId: string; title: string }
  | {
      type: "memory";
      memories: Array<{ date: string; question: string; topics: string[] }>;
      note?: string;
      reference?: { label: string; startDay: string; endDay: string };
    }
  | { type: "tool_start"; id: string; query: string }
  | {
      type: "tool_result";
      id: string;
      query: string;
      results: number;
      provider?: string;
      error?: string;
    }
  | { type: "delta"; text: string }
  | { type: "status"; message: string }
  | {
      type: "done";
      conversationId: string;
      message: Message;
      title: string;
    }
  | { type: "error"; message: string };
