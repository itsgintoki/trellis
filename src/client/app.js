import { marked } from "/vendor/marked.js";

marked.setOptions({ gfm: true, breaks: true });

const PROMPTS = [
  {
    tag: "Compare + re-check",
    text: "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?",
  },
  {
    tag: "Recall + verify",
    text: "What did I ask you on 3 November? Is your answer still correct today?",
  },
  {
    tag: "Memory → web",
    text: "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?",
  },
];

const ICONS = {
  layers:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 3l8 4.5-8 4.5-8-4.5L12 3z"/><path d="M4 12l8 4.5 8-4.5M4 16.5L12 21l8-4.5"/></svg>',
  chevron:
    '<svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>',
  traceChevron:
    '<svg class="trace-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>',
  check:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M5 12.5l4.2 4.2L19 7"/></svg>',
};

const state = {
  conversationId: null,
  title: "New conversation",
  health: null,
  conversations: [],
  streaming: false,
  controller: null,
  toastTimer: 0,
};

const els = {
  sidebar: document.getElementById("sidebar"),
  scrim: document.getElementById("scrim"),
  menuButton: document.getElementById("menuButton"),
  closeSidebar: document.getElementById("closeSidebar"),
  newChat: document.getElementById("newChat"),
  conversationList: document.getElementById("conversationList"),
  conversationTitle: document.getElementById("conversationTitle"),
  topbarSub: document.getElementById("topbarSub"),
  modelChip: document.getElementById("modelChip"),
  llmStatus: document.getElementById("llmStatus"),
  searchStatus: document.getElementById("searchStatus"),
  thread: document.getElementById("thread"),
  scroll: document.getElementById("scroll"),
  composer: document.getElementById("composer"),
  input: document.getElementById("input"),
  sendButton: document.getElementById("sendButton"),
  stopButton: document.getElementById("stopButton"),
  composerNote: document.getElementById("composerNote"),
  setupBanner: document.getElementById("setupBanner"),
  toast: document.getElementById("toast"),
};

init();

function init() {
  bindEvents();
  resizeInput();
  showEmpty();
  updateComposer();
  loadHealth();
  loadConversations();
  if (window.innerWidth > 860) els.input.focus();
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatTime(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function todayKey(date = new Date()) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function shortDay(day) {
  if (!day) return "";
  const [year, month, date] = day.split("-").map(Number);
  if (!year || !month || !date) return day;
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, date, 12)));
}

function sourceDate(value) {
  if (!value) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, date] = value.split("-").map(Number);
    return new Intl.DateTimeFormat("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(Date.UTC(year, month - 1, date, 12)));
  }
  return value;
}

function listDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  if (todayKey(date) === todayKey(now)) return formatTime(iso);
  if (todayKey(date) === todayKey(new Date(now.getTime() - 86_400_000))) return "Yesterday";
  if (now.getTime() - date.getTime() < 7 * 86_400_000) {
    return new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(date);
  }
  return shortDay(iso.slice(0, 10));
}

function groupLabel(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Earlier";
  const now = new Date();
  if (todayKey(date) === todayKey(now)) return "Today";
  if (todayKey(date) === todayKey(new Date(now.getTime() - 86_400_000))) return "Yesterday";
  if (now.getTime() - date.getTime() < 7 * 86_400_000) return "This week";
  return "Earlier";
}

function toast(message, duration = 3_600) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => els.toast.classList.remove("show"), duration);
}

function providerName() {
  return state.health?.search?.provider || "live web";
}

function setStatus(line, tone, text) {
  const dot = line.querySelector(".status-dot");
  const label = line.querySelector(".status-text");
  dot.className = `status-dot${tone ? ` ${tone}` : ""}`;
  label.textContent = text;
}

function setTitle(title, sub) {
  state.title = title;
  els.conversationTitle.textContent = title;
  els.topbarSub.textContent = sub;
  document.title = title && title !== "New conversation" ? `${title} — Trellis` : "Trellis — memory + live web";
}

function scrollToBottom(force = false) {
  const distance = els.scroll.scrollHeight - els.scroll.scrollTop - els.scroll.clientHeight;
  if (force || distance < 220) {
    els.scroll.scrollTop = els.scroll.scrollHeight;
  }
}

function resizeInput() {
  els.input.style.height = "auto";
  els.input.style.height = `${Math.min(els.input.scrollHeight, 200)}px`;
}

/* ------------------------------------------------------------------ */
/* Markdown, sanitising, citations                                     */
/* ------------------------------------------------------------------ */

const ALLOWED_TAGS = new Set([
  "A", "P", "BR", "STRONG", "B", "EM", "I", "U", "S", "DEL", "MARK", "SUP", "SUB",
  "UL", "OL", "LI", "CODE", "PRE", "BLOCKQUOTE", "H1", "H2", "H3", "H4", "H5", "H6",
  "HR", "TABLE", "THEAD", "TBODY", "TFOOT", "TR", "TH", "TD", "SPAN", "DIV",
]);

const DROP_TAGS = new Set([
  "SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "LINK", "META", "FORM", "INPUT",
  "BUTTON", "TEXTAREA", "SELECT", "OPTION", "SVG", "MATH", "VIDEO", "AUDIO", "SOURCE",
  "TRACK", "CANVAS", "IMG", "MAP", "AREA",
]);

function sanitize(html) {
  const template = document.createElement("template");
  template.innerHTML = html;
  cleanFragment(template.content);
  return template.content;
}

function cleanFragment(root) {
  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) continue;
    if (node.nodeType !== Node.ELEMENT_NODE) {
      node.remove();
      continue;
    }

    const tag = node.tagName.toUpperCase();
    if (DROP_TAGS.has(tag)) {
      node.remove();
      continue;
    }

    if (!ALLOWED_TAGS.has(tag)) {
      const fragment = document.createDocumentFragment();
      while (node.firstChild) fragment.appendChild(node.firstChild);
      cleanFragment(fragment);
      node.replaceWith(fragment);
      continue;
    }

    for (const attribute of Array.from(node.attributes)) {
      const name = attribute.name.toLowerCase();
      if (tag === "A" && (name === "href" || name === "title")) continue;
      node.removeAttribute(attribute.name);
    }

    if (tag === "A") {
      const href = node.getAttribute("href") || "";
      if (!/^https?:\/\//i.test(href)) {
        node.removeAttribute("href");
      } else {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer");
      }
    }

    cleanFragment(node);
  }
}

function decorateCitations(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !/\[\d{1,2}\]/.test(node.nodeValue)) {
        return NodeFilter.FILTER_REJECT;
      }
      const parent = node.parentElement;
      if (parent && parent.closest("a, code, pre")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);

  for (const node of nodes) {
    const parts = node.nodeValue.split(/(\[\d{1,2}\])/g);
    const fragment = document.createDocumentFragment();
    for (const part of parts) {
      const match = /^\[(\d{1,2})\]$/.exec(part);
      if (match) {
        const cite = el("span", "cite", part);
        cite.dataset.source = match[1];
        cite.title = `Source ${match[1]}`;
        fragment.appendChild(cite);
      } else if (part) {
        fragment.appendChild(document.createTextNode(part));
      }
    }
    node.parentNode.replaceChild(fragment, node);
  }
}

function renderMarkdown(text, streaming) {
  try {
    const fragment = sanitize(String(marked.parse(text || "")));
    decorateCitations(fragment);
    if (streaming) {
      const caret = el("span", "caret");
      const blocks = fragment.querySelectorAll("p, li, h1, h2, h3, h4, h5, h6");
      if (blocks.length > 0) blocks[blocks.length - 1].appendChild(caret);
      else fragment.appendChild(caret);
    }
    return fragment;
  } catch {
    const fragment = document.createDocumentFragment();
    fragment.appendChild(document.createTextNode(text || ""));
    if (streaming) fragment.appendChild(el("span", "caret"));
    return fragment;
  }
}

/* ------------------------------------------------------------------ */
/* Health and conversation list                                        */
/* ------------------------------------------------------------------ */

async function loadHealth() {
  try {
    const response = await fetch("/api/health", { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error("Health check failed");
    const health = await response.json();
    state.health = health;

    if (health.llm?.configured) {
      setStatus(els.llmStatus, "ok", health.llm.model || "model ready");
      els.modelChip.textContent = health.llm.provider
        ? `${health.llm.provider} · ${health.llm.model}`
        : health.llm.model;
      els.modelChip.title = `${health.llm.provider || "provider"} · ${health.llm.model}`;
    } else {
      setStatus(els.llmStatus, "bad", "Model not configured");
      els.modelChip.textContent = "no model";
    }

    if (health.search?.tavily) {
      setStatus(els.searchStatus, "ok", health.search.provider || "Tavily");
    } else {
      setStatus(els.searchStatus, "warn", health.search?.provider || "DuckDuckGo fallback");
    }

    els.setupBanner.hidden = Boolean(health.llm?.configured);
    els.topbarSub.textContent = `Memory on · ${providerName()}`;
    updateComposer();
  } catch {
    setStatus(els.llmStatus, "bad", "Server unreachable");
    setStatus(els.searchStatus, "bad", "Server unreachable");
    els.modelChip.textContent = "offline";
    els.setupBanner.hidden = false;
  }
}

async function loadConversations() {
  try {
    const response = await fetch("/api/conversations", { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error("Could not load conversations");
    const data = await response.json();
    state.conversations = Array.isArray(data.conversations) ? data.conversations : [];
    renderConversations();
  } catch {
    els.conversationList.replaceChildren(
      el("div", "conversation-empty", "Could not load history."),
    );
  }
}

function renderConversations() {
  els.conversationList.replaceChildren();

  if (state.conversations.length === 0) {
    els.conversationList.appendChild(
      el("div", "conversation-empty", "Your conversations will appear here."),
    );
    return;
  }

  const order = ["Today", "Yesterday", "This week", "Earlier"];
  const groups = new Map(order.map((label) => [label, []]));

  for (const conversation of state.conversations) {
    const label = groupLabel(conversation.updatedAt || conversation.createdAt);
    groups.get(label).push(conversation);
  }

  for (const label of order) {
    const items = groups.get(label);
    if (!items.length) continue;

    const group = el("div", "conversation-group");
    group.appendChild(el("div", "conversation-group-label", label));

    for (const conversation of items) {
      const button = el(
        "button",
        `conversation-item${conversation.id === state.conversationId ? " active" : ""}`,
      );
      button.type = "button";
      button.title = conversation.title;
      button.appendChild(el("span", "conversation-item-title", conversation.title));
      button.appendChild(
        el("span", "conversation-item-time", listDate(conversation.updatedAt)),
      );
      button.addEventListener("click", () => openConversation(conversation.id));
      group.appendChild(button);
    }

    els.conversationList.appendChild(group);
  }
}

/* ------------------------------------------------------------------ */
/* Empty state and whole-thread rendering                              */
/* ------------------------------------------------------------------ */

function showEmpty() {
  state.conversationId = null;
  state.messages = [];
  setTitle("New conversation", `Memory on · ${providerName()}`);

  const section = el("section", "empty");
  section.appendChild(el("p", "empty-eyebrow", "Memory + live web"));
  const heading = el("h2");
  heading.append("Ask. Recall.", document.createElement("br"), "Re-check.");
  section.appendChild(heading);
  section.appendChild(
    el(
      "p",
      "empty-lede",
      "A research assistant that remembers our past conversations — and goes back to the web when facts might have moved.",
    ),
  );

  const suggestions = el("div", "suggestions");
  for (const prompt of PROMPTS) {
    const button = el("button", "suggestion");
    button.type = "button";
    button.appendChild(el("span", "suggestion-tag", prompt.tag));
    button.appendChild(el("span", "suggestion-text", prompt.text));
    button.addEventListener("click", () => {
      els.input.value = prompt.text;
      resizeInput();
      updateComposer();
      els.input.focus();
    });
    suggestions.appendChild(button);
  }
  section.appendChild(suggestions);
  section.appendChild(
    el(
      "p",
      "empty-foot",
      "Those three questions are what memory is for. They work best after we have talked; ask anything else and I will check the web when it matters.",
    ),
  );

  els.thread.replaceChildren(section);
  renderConversations();
  els.scroll.scrollTop = 0;
}

function renderThread() {
  els.thread.replaceChildren();

  if (state.messages.length === 0) {
    showEmpty();
    return;
  }

  for (const message of state.messages) {
    els.thread.appendChild(renderMessage(message));
  }
  requestAnimationFrame(() => scrollToBottom(true));
}

function renderMessage(message) {
  if (message.role === "user") {
    const root = el("div", "message message-user");
    root.appendChild(el("div", "user-label", "You"));
    root.appendChild(el("div", "user-bubble", message.content));
    return root;
  }

  const view = createAssistantView({ message });
  return view.el;
}

async function openConversation(id) {
  if (!id) return;
  if (state.streaming) stopStreaming();
  closeSidebar();
  els.thread.replaceChildren(el("div", "thread-loading", "Loading conversation…"));
  els.conversationTitle.textContent = "Loading…";
  els.topbarSub.textContent = "";

  try {
    const response = await fetch(`/api/conversations/${encodeURIComponent(id)}`, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "Could not load this conversation.");
    }
    const data = await response.json();
    state.conversationId = data.conversation.id;
    state.messages = data.messages || [];
    setTitle(data.conversation.title, `Memory on · ${providerName()}`);
    renderThread();
    renderConversations();
  } catch (error) {
    toast(error.message || "Could not load this conversation.");
    showEmpty();
  }
}

/* ------------------------------------------------------------------ */
/* Assistant message view                                              */
/* ------------------------------------------------------------------ */

function createAssistantView(options = {}) {
  const { message = null, live = false } = options;
  const root = el("article", "message message-assistant");

  const head = el("div", "assistant-head");
  const mark = el("span", "assistant-mark", "✳");
  mark.setAttribute("aria-hidden", "true");
  const name = el("span", "assistant-name", "Trellis");
  const time = el("span", "assistant-time", message ? formatTime(message.createdAt) : "");
  head.append(mark, name, time);
  let streamDot = null;
  if (live) {
    streamDot = el("span", "stream-dot");
    head.appendChild(streamDot);
  }
  root.appendChild(head);

  const memoryWrap = el("div", "recall-wrap");
  memoryWrap.hidden = true;
  root.appendChild(memoryWrap);

  const traceWrap = el("div", "trace-wrap");
  traceWrap.hidden = true;
  const traceHead = el("button", "trace-head");
  traceHead.type = "button";
  traceHead.setAttribute("aria-expanded", "true");
  traceHead.innerHTML = `<span class="trace-bullet"></span><span class="trace-title">Searching the web</span><span class="trace-count"></span>${ICONS.traceChevron}`;
  const traceList = el("div", "trace-list");
  traceWrap.append(traceHead, traceList);
  root.appendChild(traceWrap);

  const thinking = el("div", "thinking-line");
  thinking.hidden = true;
  thinking.innerHTML =
    '<span class="thinking-dots"><i></i><i></i><i></i></span><span class="thinking-text">Thinking</span>';
  root.appendChild(thinking);

  const content = el("div", "assistant-content");
  root.appendChild(content);

  const footer = el("div", "assistant-footer");
  root.appendChild(footer);

  let contentText = message?.content || "";
  let streaming = live;
  let memoryRendered = false;
  let traceRendered = false;
  let rafId = 0;
  let lastRender = 0;
  let running = 0;
  let toolCount = 0;
  let toolsStopped = false;
  const toolRows = new Map();

  traceHead.addEventListener("click", () => {
    const expanded = traceHead.getAttribute("aria-expanded") === "true";
    traceHead.setAttribute("aria-expanded", String(!expanded));
    traceWrap.classList.toggle("collapsed", expanded);
  });

  function setThinking(text, force = false) {
    if (!live) return;
    if (contentText.trim() && !force) {
      thinking.hidden = true;
      return;
    }
    thinking.querySelector(".thinking-text").textContent = text;
    thinking.hidden = false;
  }

  function setStatus(text) {
    setThinking(text, true);
  }

  function render(force = false) {
    const now = performance.now();
    if (!force && now - lastRender < 55) {
      if (!rafId) {
        rafId = requestAnimationFrame(() => {
          rafId = 0;
          render(true);
        });
      }
      return;
    }
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    lastRender = now;

    const distanceBefore =
      els.scroll.scrollHeight - els.scroll.scrollTop - els.scroll.clientHeight;
    content.replaceChildren(renderMarkdown(contentText, streaming));
    content.hidden = contentText.length === 0;
    if (live && distanceBefore < 260) scrollToBottom(true);
  }

  function ensureTrace() {
    if (!traceRendered) {
      traceRendered = true;
      traceWrap.hidden = false;
    }
    traceHead.setAttribute("aria-expanded", "true");
    traceWrap.classList.remove("collapsed");
  }

  function updateTraceHead() {
    const bullet = traceHead.querySelector(".trace-bullet");
    const title = traceHead.querySelector(".trace-title");
    const count = traceHead.querySelector(".trace-count");
    const failed = [...toolRows.values()].some((entry) => entry.error);

    if (running > 0) {
      bullet.className = "trace-bullet running";
      title.textContent = "Searching the web";
    } else if (toolCount > 0) {
      bullet.className = `trace-bullet ${failed ? "error" : "done"}`;
      title.textContent = toolsStopped
        ? "Search stopped"
        : failed && running === 0 && toolRows.size === 1
          ? "Search failed"
          : "Searched the web";
    } else {
      bullet.className = "trace-bullet";
      title.textContent = "Searching the web";
    }

    count.textContent = toolCount > 0 ? `${toolCount} ${toolCount === 1 ? "query" : "queries"}` : "";
  }

  function collapseTrace() {
    if (traceWrap.hidden) return;
    traceWrap.classList.add("collapsed");
    traceHead.setAttribute("aria-expanded", "false");
  }

  function addMemory(memories = [], note = "", reference = null) {
    if (memoryRendered) return;
    const list = Array.isArray(memories) ? memories : [];
    if (list.length === 0 && !note && !reference) return;
    memoryRendered = true;
    memoryWrap.hidden = false;

    const chip = el("button", "recall-chip");
    chip.type = "button";
    chip.setAttribute("aria-expanded", "false");
    if (list.length === 0) chip.classList.add("empty");
    chip.insertAdjacentHTML("afterbegin", ICONS.layers);

    const label = el(
      "span",
      "",
      list.length > 0
        ? `Recalled ${list.length} moment${list.length === 1 ? "" : "s"}`
        : "No matching memory",
    );
    chip.appendChild(label);

    const days = [
      ...new Set(
        list.length > 0
          ? list.map((memory) => memory.date)
          : reference
            ? [reference.startDay, reference.endDay]
            : [],
      ),
    ].filter(Boolean);
    if (days.length > 0) {
      chip.appendChild(el("span", "recall-dates", days.slice(0, 3).map(shortDay).join(" · ")));
    }
    chip.insertAdjacentHTML("beforeend", ICONS.chevron);

    const panel = el("div", "recall-panel");
    panel.hidden = true;

    for (const memory of list) {
      const item = el("div", "recall-item");
      item.appendChild(el("span", "recall-item-date", shortDay(memory.date)));
      item.appendChild(el("p", "recall-item-question", memory.question));
      panel.appendChild(item);
    }
    if (note) panel.appendChild(el("p", "recall-note", note));

    chip.addEventListener("click", () => {
      const willOpen = panel.hidden;
      panel.hidden = !willOpen;
      chip.setAttribute("aria-expanded", String(willOpen));
    });

    memoryWrap.append(chip, panel);
  }

  function addToolStart(id, query) {
    ensureTrace();
    thinking.hidden = true;
    if (toolRows.has(id)) return;

    const row = el("div", "trace-query");
    const bullet = el("span", "trace-bullet running");
    const q = el("span", "trace-q", query || "Invalid search call");
    const result = el("span", "trace-res", "");
    row.append(bullet, q, result);
    traceList.appendChild(row);
    toolRows.set(id, { row, bullet, result, error: false });
    running += 1;
    toolCount += 1;
    updateTraceHead();
  }

  function addToolResult(event) {
    const entry = toolRows.get(event.id);
    if (!entry) return;

    if (event.error) {
      entry.error = true;
      entry.row.classList.add("error");
      entry.bullet.className = "trace-bullet error";
      entry.result.textContent = "failed";
    } else {
      entry.bullet.className = "trace-bullet done";
      entry.result.textContent = `${event.results} ${event.results === 1 ? "result" : "results"}${
        event.provider ? ` · ${event.provider}` : ""
      }`;
    }

    running = Math.max(0, running - 1);
    updateTraceHead();
    if (running === 0) setThinking("Reading sources…");
  }

  function renderStaticTrace(entries) {
    ensureTrace();
    for (const entry of entries || []) {
      const row = el("div", `trace-query${entry.error ? " error" : ""}`);
      const bullet = el("span", `trace-bullet ${entry.error ? "error" : "done"}`);
      const q = el("span", "trace-q", entry.query || "Search");
      const result = el(
        "span",
        "trace-res",
        entry.error
          ? "failed"
          : `${entry.results} ${entry.results === 1 ? "result" : "results"}`,
      );
      row.append(bullet, q, result);
      traceList.appendChild(row);
      toolRows.set(`static-${toolCount}`, { row, bullet, result, error: Boolean(entry.error) });
      toolCount += 1;
    }
    updateTraceHead();
  }

  function addSources(sources) {
    if (!Array.isArray(sources) || sources.length === 0) return;
    if (footer.querySelector(".sources")) return;

    const cited = new Set(
      [...contentText.matchAll(/\[(\d{1,2})\]/g)].map((match) => match[1]),
    );

    const block = el("div", "sources");
    block.appendChild(el("div", "sources-head", `Sources · ${sources.length}`));
    const list = el("div", `source-list${cited.size ? " has-citations" : ""}`);

    for (const source of sources) {
      const card = el("a", "source-card");
      card.href = source.url;
      card.target = "_blank";
      card.rel = "noopener noreferrer";
      card.dataset.source = String(source.n);
      if (cited.has(String(source.n))) card.classList.add("cited");

      card.appendChild(el("span", "source-number", String(source.n)));
      const body = el("span", "source-body");
      body.appendChild(el("span", "source-title", source.title));
      body.appendChild(
        el(
          "span",
          "source-meta",
          [source.domain, sourceDate(source.published)].filter(Boolean).join(" · "),
        ),
      );
      card.appendChild(body);
      list.appendChild(card);
    }

    block.appendChild(list);
    footer.appendChild(block);
  }

  function addNote(text) {
    footer.appendChild(el("p", "interrupted-note", text));
  }

  function markUnresolvedCitations(sources = []) {
    const available = new Set(
      (Array.isArray(sources) ? sources : []).map((source) => String(source.n)),
    );
    for (const cite of content.querySelectorAll(".cite")) {
      if (available.has(cite.dataset.source)) {
        cite.classList.remove("unresolved");
        cite.title = `Source ${cite.dataset.source}`;
      } else {
        cite.classList.add("unresolved");
        cite.title = "Source not captured";
      }
    }
  }

  function freezeRunningTools() {
    if (running === 0) return;
    for (const entry of toolRows.values()) {
      if (entry.bullet.classList.contains("running")) {
        entry.bullet.className = "trace-bullet error";
        entry.result.textContent = "stopped";
        entry.error = true;
      }
    }
    running = 0;
    toolsStopped = true;
    updateTraceHead();
  }

  function stopStreamingVisuals() {
    freezeRunningTools();
    streaming = false;
    thinking.hidden = true;
    if (streamDot) streamDot.hidden = true;
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    render(true);
  }

  function setError(text) {
    stopStreamingVisuals();
    let note = footer.querySelector(".error-note");
    if (!note) {
      note = el("div", "error-note");
      footer.appendChild(note);
    }
    note.textContent = text;
    if (live) scrollToBottom(false);
  }

  function finalize(finalMessage) {
    if (finalMessage.content) contentText = finalMessage.content;
    stopStreamingVisuals();
    render(true);
    if (finalMessage.createdAt) time.textContent = formatTime(finalMessage.createdAt);
    time.hidden = false;

    const metadata = finalMessage.metadata || {};
    if (
      !memoryRendered &&
      ((metadata.recalled && metadata.recalled.length > 0) ||
        metadata.recallNote ||
        metadata.recallReference)
    ) {
      addMemory(metadata.recalled, metadata.recallNote, metadata.recallReference);
    }

    addSources(finalMessage.sources);
    markUnresolvedCitations(finalMessage.sources);
    if (metadata.interrupted && !footer.querySelector(".error-note")) {
      addNote(metadata.error === "Stopped by user" ? "Stopped." : "Response interrupted.");
    }
    collapseTrace();
    if (live) scrollToBottom(false);
  }

  function markStopped() {
    stopStreamingVisuals();
    if (!footer.querySelector(".error-note")) addNote("Stopped.");
    collapseTrace();
  }

  function markIncomplete() {
    stopStreamingVisuals();
    if (!footer.querySelector(".error-note") && contentText.trim()) {
      addNote("The response ended early.");
    } else if (!contentText.trim() && !footer.querySelector(".error-note")) {
      setError("The response ended before an answer arrived. Try again.");
    }
    collapseTrace();
  }

  if (message) {
    const metadata = message.metadata || {};
    if (
      (metadata.recalled && metadata.recalled.length > 0) ||
      metadata.recallNote ||
      metadata.recallReference
    ) {
      addMemory(metadata.recalled, metadata.recallNote, metadata.recallReference);
    }
    if (metadata.toolTrace && metadata.toolTrace.length > 0) {
      renderStaticTrace(metadata.toolTrace);
    }
    render(true);
    addSources(message.sources);
    markUnresolvedCitations(message.sources);
    if (metadata.interrupted && !footer.querySelector(".error-note")) {
      addNote(metadata.error === "Stopped by user" ? "Stopped." : "Response interrupted.");
    }
    if (metadata.toolTrace && metadata.toolTrace.length > 0) collapseTrace();
  } else {
    setThinking("Thinking");
  }

  return {
    el: root,
    append(text) {
      contentText += text;
      thinking.hidden = true;
      render(false);
    },
    addMemory,
    addToolStart,
    addToolResult,
    setStatus,
    setError,
    finalize,
    markStopped,
    markIncomplete,
  };
}

/* ------------------------------------------------------------------ */
/* Sending and streaming                                               */
/* ------------------------------------------------------------------ */

function updateComposer() {
  const configured = state.health ? Boolean(state.health.llm?.configured) : true;
  const empty = !els.input.value.trim();

  els.sendButton.hidden = state.streaming;
  els.stopButton.hidden = !state.streaming;
  els.sendButton.disabled = empty || !configured;
  els.composerNote.textContent = !configured
    ? "Model not configured"
    : state.streaming
      ? "Trellis is working…"
      : "Enter to send";
}

function setStreaming(value) {
  state.streaming = value;
  updateComposer();
}

async function sendMessage(raw) {
  const text = raw.trim();
  if (!text || state.streaming) return;

  if (state.health && !state.health.llm?.configured) {
    els.setupBanner.hidden = false;
    toast("Add GROQ_API_KEY (free) or OPENAI_API_KEY to .env and restart.");
    return;
  }

  const emptyState = els.thread.querySelector(".empty");
  if (emptyState) els.thread.replaceChildren();

  const user = el("div", "message message-user");
  user.appendChild(el("div", "user-label", "You"));
  user.appendChild(el("div", "user-bubble", text));
  els.thread.appendChild(user);

  const view = createAssistantView({ live: true });
  els.thread.appendChild(view.el);

  els.input.value = "";
  resizeInput();
  setStreaming(true);
  scrollToBottom(true);

  const controller = new AbortController();
  state.controller = controller;
  let sawDone = false;

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({
        conversationId: state.conversationId,
        message: text,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `Request failed (${response.status}).`);
    }
    if (!response.body) throw new Error("This browser cannot read the response stream.");

    sawDone = await consumeStream(response.body, view);
    if (!sawDone) view.markIncomplete();
  } catch (error) {
    if (error.name === "AbortError") {
      view.markStopped();
    } else {
      view.setError(error.message || "Something went wrong.");
    }
  } finally {
    state.controller = null;
    setStreaming(false);
    loadConversations();
    els.input.focus();
    scrollToBottom(false);
  }
}

async function consumeStream(body, view) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawDone = false;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");

    while (boundary !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      for (const line of block.split("\n")) {
        const trimmed = line.replace(/\r$/, "");
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload) continue;

        let event;
        try {
          event = JSON.parse(payload);
        } catch {
          continue;
        }

        if (handleAgentEvent(event, view)) sawDone = true;
      }

      if (sawDone) {
        await reader.cancel().catch(() => {});
        return true;
      }
      boundary = buffer.indexOf("\n\n");
    }
  }

  return sawDone;
}

function handleAgentEvent(event, view) {
  switch (event.type) {
    case "start":
      state.conversationId = event.conversationId;
      setTitle(event.title, `Memory on · ${providerName()}`);
      return false;
    case "memory":
      view.addMemory(event.memories, event.note, event.reference);
      return false;
    case "tool_start":
      view.addToolStart(event.id, event.query);
      return false;
    case "tool_result":
      view.addToolResult(event);
      return false;
    case "delta":
      view.append(event.text);
      return false;
    case "status":
      view.setStatus(event.message);
      return false;
    case "done":
      state.conversationId = event.conversationId;
      setTitle(event.title, `Memory on · ${providerName()}`);
      view.finalize(event.message);
      return true;
    case "error":
      view.setError(event.message || "Something went wrong.");
      return false;
    default:
      return false;
  }
}

function stopStreaming() {
  if (state.controller) {
    state.controller.abort();
  }
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

function bindEvents() {
  els.composer.addEventListener("submit", (event) => {
    event.preventDefault();
    sendMessage(els.input.value);
  });

  els.input.addEventListener("input", () => {
    resizeInput();
    updateComposer();
  });

  els.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendMessage(els.input.value);
    }
  });

  els.sendButton.addEventListener("click", (event) => {
    event.preventDefault();
    sendMessage(els.input.value);
  });

  els.stopButton.addEventListener("click", () => stopStreaming());

  els.newChat.addEventListener("click", () => {
    if (state.streaming) stopStreaming();
    closeSidebar();
    showEmpty();
    els.input.value = "";
    resizeInput();
    updateComposer();
    els.input.focus();
  });

  els.menuButton.addEventListener("click", () => {
    els.sidebar.classList.add("open");
    els.scrim.hidden = false;
  });
  els.closeSidebar.addEventListener("click", closeSidebar);
  els.scrim.addEventListener("click", closeSidebar);

  els.thread.addEventListener("click", (event) => {
    const cite = event.target.closest(".cite");
    if (!cite || cite.classList.contains("unresolved")) return;
    const number = cite.dataset.source;
    if (!/^\d{1,2}$/.test(number || "")) return;
    const owner = cite.closest(".message-assistant");
    if (!owner) return;
    const card = owner.querySelector(`.source-card[data-source="${number}"]`);
    if (!card) return;
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    card.classList.remove("flash");
    void card.offsetWidth;
    card.classList.add("flash");
    window.setTimeout(() => card.classList.remove("flash"), 1_200);
  });

  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      els.newChat.click();
    }
    if (event.key === "Escape") closeSidebar();
  });

  window.addEventListener("resize", () => {
    if (window.innerWidth > 860) closeSidebar();
  });
}

function closeSidebar() {
  els.sidebar.classList.remove("open");
  els.scrim.hidden = true;
}
