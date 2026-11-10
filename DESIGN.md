# Design

## The bet

Look at the three test questions. Two are not really search questions:

- *"What did I ask you on 3 November? Is your answer still correct today?"*
- *"Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"*

They are **memory plus verification**. The agent has to know what was said, when, and what has changed since. The third — five CRM tools from Monday — adds a small research sweep on top of the same baseline.

Search is commodity. Temporal state is the hard part. So the central decision is:

> **Memory is a read path, not a tool.**

The model's only tool is `web_search`, exactly as specified. Before every turn, the server retrieves dated memories and puts them in context. This is faster than a tool round-trip, deterministic, and removes the failure mode where the model forgets to consult its memory. It also means the tool contract stays honest: there really is one tool.

The second decision is that the system should be **honest before it is impressive**. No record on 3 November means "I don't have that conversation", not a plausible reconstruction. A weak search means "I couldn't confirm this", not a confident price. The evaluation is about trust as much as recall.

## A turn, end to end

1. `POST /api/chat` is accepted and the user message is persisted with a UTC timestamp and a local calendar day.
2. Recall runs before the model:
   - the first date-like phrase is resolved in the user's timezone (`chrono-node`, with the UTC offset recomputed for the parsed date so DST does not shift the day);
   - raw exchanges and extracted memory cards from that day are fetched;
   - FTS5 keyword matches and optional embedding matches are fetched in parallel;
   - signals are fused into at most five dated excerpts.
3. The prompt is assembled: system policy + dated memory block + the last 14 turns + the current message.
4. The model streams. If it calls `web_search`, queries run in parallel, results become globally numbered evidence, and the loop continues. Hard caps: 5 model steps and 6 searches. If a cap is hit, the loop forces a final answer with `tool_choice: "none"`.
5. Deltas and tool events stream to the browser over SSE. The assistant message is saved with its sources, tool trace, and recall metadata.
6. In the background, a fast model writes a memory card and (if configured) an embedding. This never blocks the reply.

The first token arrives after recall + one model call. Memory extraction, titles, and embeddings are all off the critical path.

## Memory

### Two representations, on purpose

- **Raw transcripts** are the source of truth: exact questions, exact answers, exact timestamps. They are never lossy.
- **Memory cards** are a derived index: a one-sentence summary, topics, entities, old sources, and an embedding. They make retrieval cheap and preserve prices, product names, and decisions in a compact form.

This matters for the brief's timing. If a user asks a follow-up immediately after a reply, extraction may not have finished. Date queries still hit the raw messages directly. On dateless follow-ups, recent raw exchanges are also scored lexically, so a brand-new conversation can recall a topic while its card is still being written.

### Date resolution

`src/time.ts` resolves the first date-like expression against "now" in the configured timezone. Two details matter:

- **DST:** chrono takes a numeric offset, not an IANA zone. I parse once, compute the offset at the parsed instant, and re-parse while keeping "now" as the reference. This avoids both the wrong day at a DST boundary and the much worse bug of re-resolving "last Tuesday" relative to last Tuesday.
- **Recall bias:** recall questions are about the past. A bare "Monday" or "3 November" that resolves into the future is nudged back a week or a year. "next Monday" is left alone.

The UI shows the resolved reference ("No matching memory · 3 Nov") so a wrong parse is visible rather than silently authoritative.

### Retrieval and ranking

A pure vector search is the wrong tool here. "What did I ask on 3 November?" has no semantic content to embed; it has a date. "Has Postgres pricing changed?" has topic words and a date. So retrieval uses a date prior plus two lexical/semantic signals:

| Signal | What it catches | Weight |
| --- | --- | --- |
| Exact date window | "on 3 November", "last Tuesday", "last week" | dominant (+10 cards, +8 raw) |
| FTS5 (porter stem) | product names, topic words, entities | `2.5 / (60 + rank)` |
| Embeddings (optional) | paraphrase: "hosting" vs "managed database" | `similarity × 1.5` |
| Token overlap + recency | tie-breaks within a date | small |

The date filter dominates because it reflects intent. Keyword and semantic scores rank the candidates inside that window. If the exact day has nothing, query the query topically before widening; widening by ±2 days only happens when the exact window is empty, and the note says explicitly that the exchanges are from other dates. If there is no date and the user says "what did I ask you earlier?", the system falls back to the most recent earlier conversations and labels that too.

FTS5 also gives exact-name recall without an embedding dependency. Embeddings are optional and fail open: an API error logs once, disables them for the process, and retrieval continues lexically. A query embedding gets a 900 ms budget so semantic search cannot make a fast recall feel slow.

### Honesty

The memory block is a separate system message with real dates. It says, in effect: use this as recollection; if the user asks what they asked, quote it; if they ask whether it is still true, verify it. When no record exists, the block says so explicitly and the UI shows the miss. Old citation numbers are stripped from recalled answers, and old sources are listed by title and domain, so the model cannot accidentally present a stale `[1]` as a current source.

## Search

Tavily is the primary provider because it is built for agents: one request returns ranked results with URLs, publication dates, and cleaned page content. That content is worth more than ten blue links; the agent can find a price deep in a pricing page. I truncate each result and select the page excerpt that contains the query terms, keeping the evidence under a fixed budget. Every URL is normalized and assigned one stable number for the turn, including across parallel searches, so citations cannot drift.

DuckDuckGo's HTML endpoint is a keyless fallback. It is honest about being best-effort: if it is blocked, the tool returns an explicit error and the model is instructed to say it could not verify the claim. It is not a silent empty result.

Searches are cached for ten minutes and deduplicated in-flight. That makes repeated "is it still true?" turns cheap and keeps the tool from being a latency trap. The agent has a six-search budget, which is enough for five shortlisted tools plus one follow-up, and small enough to keep a turn bounded. Evidence is capped per tool call (~2.6k characters, top vendor-matching results first) because Groq's free GPT-OSS tier allows only 8K tokens/minute; this keeps a five-product comparison inside the window. A paid provider can afford more, but compact evidence is also better for latency. Official pricing/docs pages are searched without a recency filter; recency is for news and changelogs, where a publish date exists.

### Change detection is a prompt contract

The prompt tells the model that for "has X changed since…" questions it must:

1. open with a verdict — changed / no change I can find / partly;
2. state the baseline from memory;
3. give current facts with dates and citations;
4. name what did *not* change.

That last point is what makes a comparison useful rather than a list of search results. If the baseline is missing, the model says so and gives the current facts. The system prompt is deliberately explicit about not claiming a search it did not perform and not citing a source it did not see.

## The agent loop

I used the OpenAI-compatible SDK directly instead of LangChain or the Vercel AI SDK. The loop is the thing being evaluated, and it is about 120 lines: stream content, accumulate tool-call deltas, execute tools in parallel, append evidence, repeat. A framework would hide exactly the decisions that matter (budgets, parallel calls, forced synthesis, source numbering) behind abstractions that are harder to audit.

The chat provider is pluggable. The free path auto-configures Groq with GPT-OSS 120B — a free-tier model with local tool calling — and GPT-OSS 20B for memory cards. With an OpenAI key the defaults are GPT-6.1 Sol and Luna; any OpenAI-compatible endpoint can be configured explicitly. The loop retries without `temperature` if a reasoning model rejects it. Nothing in the architecture depends on a particular model; the tool interface is the stable contract.

The loop caps steps and searches, forces a final answer when either cap is hit, streams deltas as they arrive, and persists partial answers if the user stops or the provider fails. Search failures become tool messages the model can reason about, not exceptions that kill the response. The tool schema is the only tool in the request.

## UI

The UI is intentionally small: one screen, no client build step, plain ES modules. It is served by the same Express process. `marked` is served from `node_modules`; all rendered markdown goes through an allowlist sanitizer before it touches the DOM. Citation markers are linked to source cards, unresolved citations are visibly dimmed, tool activity is collapsed into a one-line trace after the answer, and recalled memories are an expandable chip. The point is to make the architecture legible: you can see what was remembered and what was searched, which is also how you debug a bad answer.

SSE carries typed events (`start`, `memory`, `tool_start`, `tool_result`, `delta`, `done`, `error`) so the UI can show progress without guessing. Streaming is throttled to one markdown render per frame, and scrolling sticks only when the user is already near the bottom.

## What I considered and rejected

- **A `recall_history` tool.** It would add a model round-trip, risk the model not using it, and break the one-tool constraint. Automatic retrieval is faster and more reliable.
- **Injecting the whole transcript.** Token-expensive and noisy; the relevant signal is a few dated exchanges, not everything.
- **A vector database (pgvector/Qdrant).** At this scale SQLite plus cosine similarity is simpler, has no extra service, and keeps raw + derived data together. If this became multi-user or millions of memories, I'd move.
- **Raw RAG only.** Summaries preserve prices and decisions; raw messages preserve exact wording. The system needs both.
- **Always searching.** It makes stable and recall questions slower and no more correct. The model decides when freshness matters.
- **Fine-tuning.** The facts change daily; retrieval is the right mechanism.
- **A multi-agent planner.** One tool does not justify the coordination cost.
- **Groq's built-in browser search as the search layer.** It couples the agent to one model provider and returns provider-shaped output. A provider-neutral `web_search` with numbered evidence keeps the agent portable and the citations controllable.
- **Scraping every result page.** Tavily already returns cleaned content; scraping all results is slow and brittle. The fallback only has snippets, and that limitation is surfaced.
- **Next.js.** One chat surface does not need a client build pipeline. A small server and a vanilla client are easier to read and run.
- **Structured price snapshots now.** This is the most promising next step, but extracting and validating structured facts from arbitrary pricing pages is its own project. The current design preserves price claims in memory summaries and re-checks them live.

## Limitations

- Single-user and local. No auth, tenancy, sync, or encryption; the SQLite file is the boundary.
- Memory extraction is lossy. Raw transcripts mitigate it for dates, but a card can miss a nuance.
- Date parsing is English-only and recall-biased. A bare weekday on a Sunday means the previous Monday. Year-only expressions are not expanded into a year window.
- Search is only as good as Tavily's index. Pricing pages can be JS-heavy, regional, or fresher than the index. The model is told to say when it cannot confirm.
- No periodic re-checking. A "watch this question" feature is the obvious next product move.
- Model behavior is prompt-dependent; there is no automated answer-quality evaluation yet. The 37 tests cover mechanics, not judgment.
- The end-to-end flow was exercised against live Groq and Tavily credentials during development; no credentials are committed. The Tavily request contract also has mocked HTTP tests.

## What I'd do with another week

1. **An eval harness with time travel.** Seed conversations at simulated dates, replay the brief's examples, and measure recall@k, answer correctness, citation validity, honest abstention, first-token latency, and searches per turn. This is the highest-leverage next step; without it, prompt changes are guesswork.
2. **Structured fact snapshots.** Extract claims like "Neon Launch = $19/mo" with source and date into a small facts table, then diff the live page against the snapshot. That turns change detection from prose comparison into evidence.
3. **Always-on embeddings + a reranker.** Embeddings on every card and query, then a cheap cross-encoder or LLM reranker over the top 20 candidates.
4. **Memory hygiene.** Dedupe near-identical cards, compact old conversations, retention controls, and a memory inspector where the user can correct or forget something.
5. **Watch mode.** Let the user "watch" a question; a scheduled job re-runs the search weekly and surfaces a diff only when something moved.
6. **Better date semantics.** Year/month ranges, ambiguous weekdays, and per-user timezones.
7. **Production shape.** Auth, Postgres + pgvector, background jobs, rate limits, tracing, and cost/latency dashboards.
8. **UI polish that earns its keep.** Source hover previews, a side-by-side "then vs now" diff for change answers, and stale-source badges.

## Verification

- 37 unit tests cover timezone-aware date resolution (including the DST re-parse bug the tests caught), exact-date recall, the raw-message fallback, in-flight self-recall, near-date honesty, dateless recall, FTS/query building, stable source numbering, provider auto-resolution (Groq/OpenAI/custom), reasoning defaults, official-page extraction, Tavily request/response parsing with mocked HTTP, DuckDuckGo redirect/ad parsing, bot-block errors, and JSON extraction.
- A live run against Groq and Tavily, plus local stubs for deterministic UI screenshots, exercised the full SSE loop, streaming tool calls, real evidence formatting, persistence, background memory extraction, and cross-session recall.
- Headless Chrome checks covered the empty state, conversation rendering, memory chips, source cards, citation jumps, the mobile drawer, and console errors (none).
- `npm run typecheck`, `npm run build`, and the compiled `npm start` were all run.
