import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { runAgent } from "./agent/agent";
import { config, describeConfig } from "./config";
import { Store } from "./db";
import { llmConfigured } from "./llm";
import { searchProviderLabel } from "./search";
import { localDay } from "./time";
import type { AgentEvent } from "./types";

const store = new Store(config.databasePath);
const app = express();

app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "DENY");
  if (!req.path.startsWith("/api/")) {
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
  }
  if (req.path.startsWith("/api/")) {
    res.setHeader("Cache-Control", "no-store");
  }
  next();
});

function titleFrom(message: string): string {
  const clean = message
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "");
  if (clean.length <= 68) return clean || "New conversation";
  const cut = clean.slice(0, 68);
  const boundary = cut.lastIndexOf(" ");
  return `${(boundary > 40 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    llm: {
      configured: llmConfigured,
      provider: config.llm.provider,
      model: config.llm.model,
    },
    search: {
      provider: searchProviderLabel(),
      tavily: Boolean(config.search.tavilyKey),
    },
    embeddings: config.embeddings.enabled,
    timezone: config.timezone,
    version: "1.0.0",
  });
});

app.get("/api/conversations", (_req, res) => {
  res.json({ conversations: store.listConversations() });
});

app.get("/api/conversations/:id", (req, res) => {
  const conversation = store.getConversation(req.params.id);
  if (!conversation) {
    res.status(404).json({ error: "Conversation not found." });
    return;
  }
  res.json({
    conversation,
    messages: store.listMessages(conversation.id),
  });
});

app.post("/api/chat", async (req: Request, res: Response) => {
  const message =
    typeof req.body?.message === "string" ? req.body.message.trim() : "";

  if (!message) {
    res.status(400).json({ error: "A message is required." });
    return;
  }
  if (message.length > 8_000) {
    res.status(413).json({ error: "Message is too long (max 8,000 characters)." });
    return;
  }
  if (!llmConfigured) {
    res.status(503).json({
      error:
        "No chat model key is configured. Copy .env.example to .env, set GROQ_API_KEY (free) or OPENAI_API_KEY, and restart.",
    });
    return;
  }

  const requestedId =
    typeof req.body?.conversationId === "string" ? req.body.conversationId : "";
  const existing = requestedId ? store.getConversation(requestedId) : null;
  const conversation = existing ?? store.createConversation(titleFrom(message));

  const now = new Date();
  const userMessage = store.addMessage({
    conversationId: conversation.id,
    role: "user",
    content: message,
    createdAt: now.toISOString(),
    createdDay: localDay(now, config.timezone),
  });
  const history = store.listMessages(conversation.id, config.agent.historyMessages + 4);

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const send = (event: AgentEvent) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  send({
    type: "start",
    conversationId: conversation.id,
    title: conversation.title,
  });

  const heartbeat = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) {
      res.write(": keep-alive\n\n");
    }
  }, 15_000);

  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });

  try {
    await runAgent({
      store,
      conversation,
      userMessage,
      history,
      emit: send,
      signal: controller.signal,
    });
  } catch (error) {
    console.error(`[chat] ${(error as Error).message}`);
    send({
      type: "error",
      message:
        error instanceof Error ? error.message : "Something went wrong. Try again.",
    });
  } finally {
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  }
});

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found." });
});

const clientDir = path.resolve(__dirname, "..", "src", "client");
const markedFile = path.resolve(
  __dirname,
  "..",
  "node_modules",
  "marked",
  "lib",
  "marked.esm.js",
);

app.get("/vendor/marked.js", (_req, res) => {
  res.sendFile(markedFile);
});
app.use(
  express.static(clientDir, {
    etag: false,
    maxAge: 0,
    setHeaders: (res) => res.setHeader("Cache-Control", "no-cache"),
  }),
);
app.get("/", (_req, res) => {
  res.sendFile(path.join(clientDir, "index.html"));
});

app.use((error: Error & { status?: number }, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  const status = error.status && error.status >= 400 ? error.status : 500;
  console.error(`[http] ${error.message}`);
  res.status(status).json({ error: status === 500 ? "Internal server error." : error.message });
});

const server = app.listen(config.port, () => {
  console.log("");
  console.log(`  Trellis  http://localhost:${config.port}`);
  console.log(`  ${describeConfig()}`);
  if (!llmConfigured) {
    console.warn(
      "  No chat key. Copy .env.example to .env and set GROQ_API_KEY (free) or OPENAI_API_KEY.",
    );
  }
  if (!config.search.tavilyKey) {
    console.warn("  TAVILY_API_KEY not set: using the DuckDuckGo fallback.");
  }
  console.log("");
});

function shutdown(signal: string): void {
  console.log(`\n[server] ${signal}, shutting down.`);
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 4_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
