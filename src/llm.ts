import OpenAI from "openai";
import { config } from "./config";

export const llmConfigured = Boolean(config.llm.apiKey);

export const llm = new OpenAI({
  apiKey: config.llm.apiKey || "missing-key",
  baseURL: config.llm.baseURL,
  timeout: 60_000,
  maxRetries: 1,
});

const embeddingClient = config.embeddings.enabled
  ? new OpenAI({
      apiKey: config.embeddings.apiKey || "missing-key",
      baseURL: config.embeddings.baseURL,
      timeout: 10_000,
      maxRetries: 0,
    })
  : null;

let embeddingsDisabled = false;
let warnedAboutEmbeddings = false;

export function abortableTimeout(ms: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function embed(
  texts: string[],
  signal?: AbortSignal,
  timeoutMs = 3_000,
): Promise<number[][] | null> {
  if (!embeddingClient || embeddingsDisabled || texts.length === 0) return null;
  try {
    const response = await embeddingClient.embeddings.create(
      { model: config.embeddings.model, input: texts },
      { signal: abortableTimeout(timeoutMs, signal) },
    );
    return response.data.map((item) => item.embedding);
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    const transient =
      name === "TimeoutError" || name === "AbortError" || name === "APIUserAbortError";
    if (!transient) {
      if (!warnedAboutEmbeddings) {
        warnedAboutEmbeddings = true;
        console.warn(
          `[embeddings] Unavailable (${(error as Error).message}). Continuing with keyword + date recall.`,
        );
      }
      embeddingsDisabled = true;
    }
    return null;
  }
}

export function extractJsonObject(text: string): Record<string, unknown> | null {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const value = JSON.parse(cleaned.slice(start, end + 1));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export async function completeJson(options: {
  system: string;
  user: string;
  model?: string;
  signal?: AbortSignal;
}): Promise<Record<string, unknown> | null> {
  const request = {
    model: options.model || config.llm.fastModel,
    temperature: 0.2,
    ...(config.llm.reasoningEffort ? { reasoning_effort: config.llm.reasoningEffort } : {}),
    messages: [
      { role: "system" as const, content: options.system },
      { role: "user" as const, content: options.user },
    ],
    response_format: { type: "json_object" as const },
  };

  let response;
  try {
    response = await llm.chat.completions.create(request, {
      signal: abortableTimeout(20_000, options.signal),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      !/response_format|json_object|temperature|unsupported|not supported|invalid parameter/i.test(
        message,
      )
    ) {
      return null;
    }
    try {
      response = await llm.chat.completions.create(
        {
          model: request.model,
          messages: request.messages,
        },
        { signal: abortableTimeout(20_000, options.signal) },
      );
    } catch {
      return null;
    }
  }

  const content = response.choices[0]?.message?.content;
  return content ? extractJsonObject(content) : null;
}
