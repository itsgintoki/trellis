import type {
  ChatCompletionMessageParam,
  ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions";
import { config } from "../config";
import type { Store } from "../db";
import { llm, llmConfigured } from "../llm";
import { scheduleMemoryExtraction } from "../memory/extract";
import { renderMemoryBlock } from "../memory/format";
import { recallMemories } from "../memory/retrieval";
import { truncate } from "../memory/text";
import { webSearch } from "../search";
import { formatEvidence, SourceRegistry, WEB_SEARCH_TOOL } from "../search/sources";
import type {
  AgentEvent,
  Conversation,
  Message,
  RecallResult,
  StoredMetadata,
  ToolTraceEntry,
} from "../types";
import { localDay } from "../time";
import { buildSystemPrompt } from "./prompt";

interface RunAgentInput {
  store: Store;
  conversation: Conversation;
  userMessage: Message;
  history: Message[];
  emit: (event: AgentEvent) => void;
  signal: AbortSignal;
}

interface StreamedToolCall {
  id: string;
  name: string;
  arguments: string;
}

interface CompletionResult {
  content: string;
  toolCalls: StreamedToolCall[];
}

function buildHistory(
  history: Message[],
  current: Message,
): ChatCompletionMessageParam[] {
  const usable = history.filter((message) => message.content.trim().length > 0);
  let window = usable.slice(-config.agent.historyMessages);

  while (
    window.length > 1 &&
    window.reduce((total, message) => total + message.content.length, 0) > 9_000
  ) {
    window = window.slice(1);
  }
  if (window[0]?.role === "assistant") window = window.slice(1);

  const messages: ChatCompletionMessageParam[] = window.map((message) =>
    message.role === "user"
      ? { role: "user", content: message.content }
      : { role: "assistant", content: message.content },
  );

  if (window[window.length - 1]?.id !== current.id) {
    messages.push({ role: "user", content: current.content });
  }
  return messages;
}

async function streamCompletion(
  messages: ChatCompletionMessageParam[],
  options: {
    signal: AbortSignal;
    onDelta: (text: string) => void;
    toolChoice?: "auto" | "none";
  },
): Promise<CompletionResult> {
  const base = {
    model: config.llm.model,
    messages,
    tools: [WEB_SEARCH_TOOL],
    tool_choice: options.toolChoice ?? "auto",
    stream: true as const,
    ...(config.llm.reasoningEffort ? { reasoning_effort: config.llm.reasoningEffort } : {}),
  };

  let stream;
  try {
    stream = await llm.chat.completions.create(
      { ...base, temperature: config.agent.temperature },
      { signal: options.signal },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/temperature|reasoning_effort|unsupported|not supported|invalid parameter/i.test(message)) {
      throw error;
    }
    const retry = { ...base };
    delete (retry as { reasoning_effort?: string }).reasoning_effort;
    stream = await llm.chat.completions.create(retry, { signal: options.signal });
  }

  let content = "";
  const calls = new Map<number, StreamedToolCall>();

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta;
    if (!delta) continue;

    if (delta.content) {
      content += delta.content;
      options.onDelta(delta.content);
    }

    for (const part of delta.tool_calls ?? []) {
      const index = part.index ?? calls.size;
      const call = calls.get(index) ?? { id: "", name: "", arguments: "" };
      if (part.id) call.id = part.id;
      if (part.function?.name) call.name += part.function.name;
      if (part.function?.arguments) call.arguments += part.function.arguments;
      calls.set(index, call);
    }
  }

  return {
    content,
    toolCalls: [...calls.values()]
      .filter((call) => call.name)
      .map((call, index) => ({
        ...call,
        id: call.id || `call_${index}_${crypto.randomUUID().slice(0, 8)}`,
      })),
  };
}

function parseSearchArgs(raw: string): {
  query: string;
  recencyDays: number;
  maxResults: number;
} {
  let parsed: Record<string, unknown> = {};
  try {
    const value = JSON.parse(raw || "{}");
    if (value && typeof value === "object" && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>;
    }
  } catch {
    parsed = {};
  }

  const query = typeof parsed.query === "string" ? parsed.query.trim() : "";
  const recency =
    typeof parsed.recency_days === "number" && Number.isFinite(parsed.recency_days)
      ? Math.max(0, Math.min(Math.round(parsed.recency_days), 3650))
      : 0;
  const maxResults =
    typeof parsed.max_results === "number" && Number.isFinite(parsed.max_results)
      ? Math.max(1, Math.min(Math.round(parsed.max_results), 8))
      : 3;

  return { query, recencyDays: recency, maxResults };
}

async function executeSearch(
  call: StreamedToolCall,
  registry: SourceRegistry,
  emit: (event: AgentEvent) => void,
  signal: AbortSignal,
): Promise<{ message: ChatCompletionToolMessageParam; trace: ToolTraceEntry }> {
  const { query, recencyDays, maxResults } = parseSearchArgs(call.arguments);

  if (!query) {
    emit({ type: "tool_start", id: call.id, query: "" });
    const error = "web_search needs a non-empty query.";
    emit({ type: "tool_result", id: call.id, query: "", results: 0, error });
    return {
      message: {
        role: "tool",
        tool_call_id: call.id,
        content: `Search failed: ${error} Try again with a focused query.`,
      },
      trace: { query: "", results: 0, error },
    };
  }

  emit({ type: "tool_start", id: call.id, query });

  try {
    const response = await webSearch(query, { recencyDays, maxResults, signal });
    const evidence = formatEvidence({
      query,
      provider: response.provider,
      recencyDays: response.recencyDays,
      results: response.results,
      registry,
    });
    emit({
      type: "tool_result",
      id: call.id,
      query,
      results: response.results.length,
      provider: response.provider,
    });
    return {
      message: { role: "tool", tool_call_id: call.id, content: evidence.text },
      trace: {
        query,
        results: response.results.length,
        provider: response.provider,
      },
    };
  } catch (error) {
    if (signal.aborted) throw error;
    const detail = (error as Error).message;
    emit({ type: "tool_result", id: call.id, query, results: 0, error: detail });
    return {
      message: {
        role: "tool",
        tool_call_id: call.id,
        content: `Search failed for "${query}": ${detail}\nTell the user you could not verify this on the web and answer only with what you know.`,
      },
      trace: { query, results: 0, error: detail },
    };
  }
}

function friendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/api key|401|unauthorized|incorrect api key|missing-key/i.test(message)) {
    return "The model API key is missing or invalid. Add GROQ_API_KEY (free) or OPENAI_API_KEY to .env and restart.";
  }
  if (/429|rate limit/i.test(message)) {
    return "The model is rate-limited right now. Wait a moment and try again.";
  }
  if (/timeout|timed out|ETIMEDOUT/i.test(message)) {
    return "The model took too long to respond. Try again.";
  }
  return `The model request failed: ${message.slice(0, 280)}`;
}

function isToolValidationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /tool call validation|did not match schema|additionalproperties|missing properties/i.test(
    message,
  );
}

function isRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /429|rate limit|too many requests/i.test(message);
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Aborted"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Aborted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function streamWithRateLimitRetry(
  messages: ChatCompletionMessageParam[],
  options: {
    signal: AbortSignal;
    onDelta: (text: string) => void;
    toolChoice?: "auto" | "none";
  },
  emit: (event: AgentEvent) => void,
): Promise<CompletionResult> {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await streamCompletion(messages, options);
    } catch (error) {
      if (!isRateLimitError(error) || attempt === maxAttempts) throw error;
      const seconds = 20;
      emit({
        type: "status",
        message: `The free model tier is rate-limited. Retrying in ${seconds}s (attempt ${attempt + 1}/${maxAttempts})…`,
      });
      await wait(seconds * 1_000, options.signal);
    }
  }
  throw new Error("Rate-limit retry loop exhausted");
}

export async function runAgent(input: RunAgentInput): Promise<void> {
  if (!llmConfigured) {
    throw new Error("No model API key is configured. Add OPENAI_API_KEY to .env and restart.");
  }

  const startedAt = Date.now();
  const now = new Date();

  let recall: RecallResult = { memories: [], temporal: null };
  try {
    recall = await recallMemories(input.store, input.userMessage.content, {
      now,
      timezone: config.timezone,
      conversationId: input.conversation.id,
      currentMessageId: input.userMessage.id,
      signal: input.signal,
    });
  } catch (error) {
    if (input.signal.aborted) return;
    console.warn(`[memory] Recall failed: ${(error as Error).message}`);
  }

  const recalledForUi = recall.memories.map((memory) => ({
    date: memory.date,
    question: truncate(memory.question, 180),
    topics: memory.topics.slice(0, 4),
  }));
  const recallReference = recall.temporal
    ? {
        label: recall.temporal.label,
        startDay: recall.temporal.startDay,
        endDay: recall.temporal.endDay,
      }
    : undefined;

  if (recalledForUi.length > 0 || recall.temporal || recall.note) {
    input.emit({
      type: "memory",
      memories: recalledForUi,
      note: recall.note,
      reference: recallReference,
    });
  }

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: buildSystemPrompt(now, config.timezone) },
  ];
  const memoryBlock = renderMemoryBlock(recall, now, config.timezone);
  if (memoryBlock) messages.push({ role: "system", content: memoryBlock });
  messages.push(...buildHistory(input.history, input.userMessage));

  const registry = new SourceRegistry();
  const toolTrace: ToolTraceEntry[] = [];
  let answer = "";
  let searches = 0;
  let lastStepUsedTools = false;

  const onDelta = (text: string) => {
    answer += text;
    input.emit({ type: "delta", text });
  };

  const persist = (content: string, metadata: StoredMetadata, finishedAt: Date): Message => {
    const cited = new Set(
      [...content.matchAll(/\[(\d{1,2})\]/g)].map((match) => Number(match[1])),
    );
    const allSources = registry.all();
    const sources =
      cited.size > 0
        ? allSources.filter((source) => cited.has(source.n)).slice(0, 12)
        : allSources.slice(0, 6);

    return input.store.addMessage({
      conversationId: input.conversation.id,
      role: "assistant",
      content,
      sources,
      metadata: {
        ...metadata,
        recalled: recalledForUi,
        recallNote: recall.note,
        recallReference,
        toolTrace,
        elapsedMs: Date.now() - startedAt,
      },
      createdAt: finishedAt.toISOString(),
      createdDay: localDay(finishedAt, config.timezone),
    });
  };

  try {
    for (let step = 0; step < config.agent.maxSteps; step++) {
      lastStepUsedTools = false;

      let completion: CompletionResult;
      try {
        completion = await streamWithRateLimitRetry(
          messages,
          {
            signal: input.signal,
            onDelta,
          },
          input.emit,
        );
      } catch (error) {
        if (!isToolValidationError(error)) throw error;

        console.warn(`[agent] Invalid tool call from the model: ${(error as Error).message}`);
        messages.push({
          role: "system",
          content:
            toolTrace.length > 0
              ? "Your last tool call was invalid. Do not call tools again. Answer the user using the evidence you already have. If it is insufficient, say what you could not verify."
              : "Your last tool call was invalid. The only web_search fields are query, recency_days, and max_results. Do not send cursor, id, or other fields. Make one valid call with a query string, or answer without tools.",
        });
        completion = await streamWithRateLimitRetry(
          messages,
          {
            signal: input.signal,
            onDelta,
            toolChoice: toolTrace.length > 0 ? "none" : "auto",
          },
          input.emit,
        );
      }

      if (completion.toolCalls.length === 0) break;
      lastStepUsedTools = true;

      const remaining = Math.max(0, config.agent.maxSearches - searches);
      const allowed = completion.toolCalls.slice(0, remaining);
      const blocked = completion.toolCalls.slice(remaining);

      messages.push({
        role: "assistant",
        content: completion.content || null,
        tool_calls: completion.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        })),
      });

      const results = await Promise.all(
        allowed.map((call) => executeSearch(call, registry, input.emit, input.signal)),
      );
      for (const result of results) {
        messages.push(result.message);
        toolTrace.push(result.trace);
      }

      for (const call of blocked) {
        const { query } = parseSearchArgs(call.arguments);
        const error = "Search budget reached.";
        input.emit({ type: "tool_result", id: call.id, query, results: 0, error });
        toolTrace.push({ query, results: 0, error });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content:
            "Search budget reached. Answer now with the evidence you already have; do not request more searches.",
        });
      }

      searches += allowed.length;
    }

    if (lastStepUsedTools || !answer.trim()) {
      messages.push({
        role: "system",
        content:
          "Stop searching. Answer the user now using the evidence above. Do not call tools.",
      });
      await streamWithRateLimitRetry(
        messages,
        {
          signal: input.signal,
          onDelta,
          toolChoice: "none",
        },
        input.emit,
      );
    }

    const finalText = answer.trim();
    if (!finalText) {
      throw new Error("The model returned an empty answer.");
    }

    const finishedAt = new Date();
    const assistant = persist(finalText, {}, finishedAt);
    scheduleMemoryExtraction({
      store: input.store,
      conversationId: input.conversation.id,
      userMessage: input.userMessage,
      assistantMessage: assistant,
    });
    input.emit({
      type: "done",
      conversationId: input.conversation.id,
      message: assistant,
      title: input.conversation.title,
    });
    console.log(
      `[chat] conversation=${input.conversation.id.slice(0, 8)} searches=${searches} ms=${Date.now() - startedAt}`,
    );
  } catch (error) {
    const aborted = input.signal.aborted;
    const detail = error instanceof Error ? error.message : String(error);

    if (answer.trim()) {
      const finishedAt = new Date();
      const assistant = persist(
        answer.trim(),
        { interrupted: true, error: aborted ? "Stopped by user" : detail },
        finishedAt,
      );
      if (!aborted) {
        input.emit({ type: "error", message: friendlyError(error) });
      }
      input.emit({
        type: "done",
        conversationId: input.conversation.id,
        message: assistant,
        title: input.conversation.title,
      });
      return;
    }

    if (aborted) return;
    throw new Error(friendlyError(error));
  }
}
