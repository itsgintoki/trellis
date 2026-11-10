import * as chrono from "chrono-node";
import type { TemporalReference } from "./types";

const DAY_MS = 86_400_000;
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function dayFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

export function localDay(date: Date, timeZone: string): string {
  const parts = dayFormatter(timeZone).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function timezoneOffsetMinutes(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  const asUTC = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUTC - date.getTime()) / 60_000);
}

function dayToDate(day: string): Date {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date, 12));
}

function dateToDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(day: string, amount: number): string {
  return dateToDay(new Date(dayToDate(day).getTime() + amount * DAY_MS));
}

export function daysBetween(from: string, to: string): number {
  return Math.round((dayToDate(to).getTime() - dayToDate(from).getTime()) / DAY_MS);
}

export function daysInRange(startDay: string, endDay: string, cap = 120): string[] {
  const days: string[] = [];
  let cursor = startDay;
  while (cursor <= endDay && days.length < cap) {
    days.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return days;
}

export function startOfWeek(day: string): string {
  const date = dayToDate(day);
  const weekday = date.getUTCDay();
  return addDays(day, -((weekday + 6) % 7));
}

export function endOfWeek(day: string): string {
  return addDays(startOfWeek(day), 6);
}

export function startOfMonth(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

export function endOfMonth(day: string): string {
  const [year, month] = day.split("-").map(Number);
  return dateToDay(new Date(Date.UTC(year, month, 0, 12)));
}

export function formatDayLong(day: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(dayToDate(day));
}

export function formatDayShort(day: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
  }).format(dayToDate(day));
}

export function formatNow(date: Date, timeZone: string): string {
  const datePart = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
  const timePart = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).format(date);
  return `${datePart}, ${timePart}`;
}

function hasDateSignal(result: chrono.ParsedResult): boolean {
  return (
    result.start.isCertain("day") ||
    result.start.isCertain("month") ||
    result.start.isCertain("weekday") ||
    result.start.isCertain("year")
  );
}

function parseWithZone(
  text: string,
  reference: Date,
  timeZone: string,
  offsetReference: Date = reference,
): chrono.ParsedResult[] {
  const offset = timezoneOffsetMinutes(offsetReference, timeZone);
  return chrono.casual.parse(text, { instant: reference, timezone: offset }, { forwardDate: false });
}

function shiftYears(day: string, amount: number): string {
  const date = dayToDate(day);
  date.setUTCFullYear(date.getUTCFullYear() + amount);
  return dateToDay(date);
}

/**
 * Resolves the first date-like expression in a message against `now`.
 * Recall questions are about the past, so bare weekdays and month/day
 * expressions that resolve into the future are nudged backwards.
 */
export function resolveTemporal(
  text: string,
  now = new Date(),
  timeZone = "UTC",
): TemporalReference | null {
  if (!text.trim()) return null;

  let results = parseWithZone(text, now, timeZone);
  if (results.length === 0) return null;

  const result = results.find(hasDateSignal) ?? results[0]!;
  let instant = result.start.date();

  // Re-resolve near DST boundaries with the offset in effect on the parsed day,
  // while keeping `now` as the reference for relative phrases like "last Tuesday".
  results = parseWithZone(text, now, timeZone, instant);
  const refined = results.find((candidate) => candidate.text === result.text);
  if (refined) instant = refined.start.date();

  let day = localDay(instant, timeZone);
  const phrase = result.text.toLowerCase();
  const hasExplicitYear = result.start.isCertain("year");
  const futureBiasExcluded = /\b(next|tomorrow|in)\b/.test(phrase);

  if (instant.getTime() > now.getTime() && !hasExplicitYear && !futureBiasExcluded) {
    if (/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(phrase)) {
      day = addDays(day, -7);
    } else if (result.start.isCertain("day") && result.start.isCertain("month")) {
      day = shiftYears(day, -1);
    }
  }

  const lowered = text.toLowerCase();
  if (/\b(this|last|next)\s+week\b|\bweek\s+of\b/.test(lowered)) {
    return {
      label: result.text.trim(),
      startDay: startOfWeek(day),
      endDay: endOfWeek(day),
      grain: "week",
    };
  }
  if (/\b(this|last|next)\s+month\b|\bmonth\s+of\b/.test(lowered)) {
    return {
      label: result.text.trim(),
      startDay: startOfMonth(day),
      endDay: endOfMonth(day),
      grain: "month",
    };
  }

  return { label: result.text.trim(), startDay: day, endDay: day, grain: "day" };
}
