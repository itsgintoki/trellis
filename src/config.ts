import "dotenv/config";
import path from "node:path";

function validTimeZone(value: string | undefined): string {
  if (value) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value });
      return value;
    } catch {
      console.warn(`[config] Unknown TIMEZONE "${value}", falling back to the system timezone.`);
    }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export type LlmProvider = "groq" | "openai" | "custom" | "none";
export type ReasoningEffort = "low" | "medium" | "high";

export interface LlmSettings {
  provider: LlmProvider;
  apiKey: string;
  baseURL?: string;
  model: string;
  fastModel: string;
  reasoningEffort?: ReasoningEffort;
}

const OPENAI_DEFAULTS = { model: "gpt-6.1-sol", fastModel: "gpt-6-luna" };
const GROQ_DEFAULTS = { model: "openai/gpt-oss-120b", fastModel: "openai/gpt-oss-20b" };
const CUSTOM_DEFAULTS = { model: "gpt-4o-mini", fastModel: "gpt-4o-mini" };

function build(
  provider: LlmProvider,
  apiKey: string,
  baseURL: string | undefined,
  defaults: { model: string; fastModel: string },
  env: NodeJS.ProcessEnv,
): LlmSettings {
  const requested = (env.LLM_REASONING_EFFORT || "").trim().toLowerCase();
  const reasoningEffort: ReasoningEffort | undefined =
    requested === "low" || requested === "medium" || requested === "high"
      ? requested
      : provider === "groq"
        ? "low"
        : undefined;

  return {
    provider,
    apiKey,
    baseURL,
    model: env.LLM_MODEL?.trim() || defaults.model,
    fastModel: env.LLM_FAST_MODEL?.trim() || defaults.fastModel,
    reasoningEffort,
  };
}

/**
 * Provider resolution, kept pure so it can be tested without mutating process.env.
 * Precedence: explicit provider, explicit custom endpoint, Groq (free), OpenAI.
 */
export function resolveLlmSettings(env: NodeJS.ProcessEnv): LlmSettings {
  const hint = (env.LLM_PROVIDER || "").trim().toLowerCase();
  const groqKey = (env.GROQ_API_KEY || "").trim();
  const openAIKey = (env.OPENAI_API_KEY || "").trim();
  const llmKey = (env.LLM_API_KEY || "").trim();
  const customBase = (env.LLM_BASE_URL || env.OPENAI_BASE_URL || "").trim();
  const openAIBase = (env.OPENAI_BASE_URL || "").trim() || undefined;
  const groqBase = (env.GROQ_BASE_URL || "https://api.groq.com/openai/v1").trim();

  if (hint === "groq" && groqKey) {
    return build("groq", groqKey, groqBase, GROQ_DEFAULTS, env);
  }
  if (hint === "openai" && openAIKey) {
    return build("openai", openAIKey, openAIBase, OPENAI_DEFAULTS, env);
  }
  if (hint === "custom" && customBase && (llmKey || openAIKey)) {
    return build("custom", llmKey || openAIKey, customBase, CUSTOM_DEFAULTS, env);
  }

  if (customBase) {
    if (/groq\.(com|ai)/i.test(customBase)) {
      const key = llmKey || groqKey;
      if (key) return build("groq", key, customBase, GROQ_DEFAULTS, env);
    }
    if (/openai\.com/i.test(customBase)) {
      const key = llmKey || openAIKey;
      if (key) return build("openai", key, customBase, OPENAI_DEFAULTS, env);
    }
    if (llmKey) return build("custom", llmKey, customBase, CUSTOM_DEFAULTS, env);
    if (openAIKey) return build("custom", openAIKey, customBase, CUSTOM_DEFAULTS, env);
  }

  if (groqKey) return build("groq", groqKey, groqBase, GROQ_DEFAULTS, env);
  if (openAIKey) return build("openai", openAIKey, openAIBase, OPENAI_DEFAULTS, env);
  if (llmKey) return build("openai", llmKey, undefined, OPENAI_DEFAULTS, env);

  return { provider: "none", apiKey: "", baseURL: undefined, model: "", fastModel: "" };
}

const env = process.env;
const llm = resolveLlmSettings(env);
const embeddingKey = env.EMBEDDINGS_API_KEY || env.OPENAI_API_KEY || "";
const port = Number.parseInt(env.PORT || "3000", 10);

export const config = {
  port: Number.isFinite(port) ? port : 3000,
  timezone: validTimeZone(env.TIMEZONE),
  databasePath: path.resolve(env.DATABASE_PATH || "data/trellis.db"),

  llm: {
    provider: llm.provider,
    apiKey: llm.apiKey,
    baseURL: llm.baseURL,
    model: llm.model,
    fastModel: llm.fastModel,
    reasoningEffort: llm.reasoningEffort,
  },

  embeddings: {
    enabled: Boolean(embeddingKey) && env.DISABLE_EMBEDDINGS !== "1",
    apiKey: embeddingKey,
    baseURL: env.EMBEDDINGS_BASE_URL || (env.OPENAI_API_KEY ? env.OPENAI_BASE_URL : undefined),
    model: env.EMBEDDING_MODEL || "text-embedding-3-small",
  },

  search: {
    tavilyKey: (env.TAVILY_API_KEY || "").trim(),
    tavilyBaseUrl: (env.TAVILY_BASE_URL || "https://api.tavily.com").replace(/\/+$/, ""),
    timeoutMs: 14_000,
  },

  agent: {
    maxSteps: 5,
    maxSearches: 6,
    historyMessages: 14,
    temperature: 0.25,
  },
} as const;

export function describeConfig(): string {
  const model = config.llm.apiKey
    ? `${config.llm.model} (${config.llm.provider})`
    : "not configured";
  const search = config.search.tavilyKey ? "Tavily" : "DuckDuckGo fallback";
  const embeddings = config.embeddings.enabled ? "on" : "off";
  return `Model: ${model} | Search: ${search} | Embeddings: ${embeddings} | Timezone: ${config.timezone}`;
}
