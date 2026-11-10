import type { RecallResult } from "../types";
import { formatDayLong, formatNow, daysBetween, localDay } from "../time";
import { stripCitations, truncate } from "./text";

const MAX_BLOCK_CHARS = 7_500;

export function renderMemoryBlock(
  recall: RecallResult,
  now: Date,
  timezone: string,
): string | null {
  if (recall.memories.length === 0 && !recall.temporal) return null;

  const lines: string[] = [
    "## MEMORY FROM EARLIER CONVERSATIONS",
    `The current time is ${formatNow(now, timezone)}.`,
  ];

  if (recall.temporal) {
    const range =
      recall.temporal.grain === "day"
        ? formatDayLong(recall.temporal.startDay)
        : `${formatDayLong(recall.temporal.startDay)} through ${formatDayLong(recall.temporal.endDay)}`;
    lines.push(`The user's reference "${recall.temporal.label}" resolves to ${range}.`);
  }

  if (recall.note) {
    lines.push(`Note: ${recall.note}`);
    if (recall.temporal && recall.memories.length > 0) {
      lines.push(
        "If the user asked about a specific date, be explicit that any records shown are from other dates.",
      );
    }
  }

  if (recall.memories.length === 0) {
    lines.push(
      "No matching past exchange exists. Say plainly that you do not have that conversation. Never invent a memory.",
    );
    return lines.join("\n");
  }

  lines.push(
    "These are excerpts from real earlier conversations with this user, most relevant first. Treat them as your own recollection. Numbers in these old replies were stripped: do not reuse them as citations.",
  );

  for (const memory of recall.memories) {
    const age = Math.max(0, daysBetween(memory.date, localDay(now, timezone)));
    const ageLabel = age === 0 ? "today" : age === 1 ? "yesterday" : `${age} days ago`;
    lines.push("");
    lines.push(`### ${formatDayLong(memory.date)} (${ageLabel})`);
    lines.push(`User asked: "${truncate(memory.question, 700)}"`);
    if (memory.summary && memory.summary !== memory.answer) {
      lines.push(`Memory summary: ${truncate(memory.summary, 360)}`);
    }
    if (memory.answer) {
      lines.push(`You answered: "${truncate(stripCitations(memory.answer), 950)}"`);
    } else {
      lines.push("You did not record an answer to this message.");
    }
    if (memory.topics.length > 0) {
      lines.push(`Topics: ${memory.topics.join(", ")}`);
    }
    if (memory.sources.length > 0) {
      const sources = memory.sources
        .slice(0, 3)
        .map((source) => `${source.title} (${source.domain})`)
        .join("; ");
      lines.push(`Sources you cited at the time: ${sources}`);
    }
  }

  lines.push("");
  lines.push(
    "Use this memory naturally. If the user asks what they asked, quote their question. If they ask whether an old answer is still correct, search the web for the current facts and compare against this baseline. Do not claim these old citations are current sources.",
  );

  const block = lines.join("\n");
  return block.length > MAX_BLOCK_CHARS ? `${block.slice(0, MAX_BLOCK_CHARS)}\n[memory truncated]` : block;
}
