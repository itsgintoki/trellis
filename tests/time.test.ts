import { test } from "node:test";
import assert from "node:assert/strict";
import { localDay, resolveTemporal } from "../src/time";

const NOW = new Date("2026-11-10T14:54:00.000Z");
const IST = "Asia/Calcutta";

test("localDay respects the configured timezone at a day boundary", () => {
  const instant = new Date("2026-11-11T02:00:00.000Z");
  assert.equal(localDay(instant, "America/New_York"), "2026-11-10");
  assert.equal(localDay(instant, "UTC"), "2026-11-11");
  assert.equal(localDay(instant, "Asia/Calcutta"), "2026-11-11");
});

test("resolves a bare month/day in the past", () => {
  const result = resolveTemporal("What did I ask you on 3 November?", NOW, IST);
  assert.ok(result);
  assert.equal(result.startDay, "2026-11-03");
  assert.equal(result.endDay, "2026-11-03");
  assert.equal(result.grain, "day");
});

test("resolves 'last Tuesday' against a Tuesday reference", () => {
  const result = resolveTemporal(
    "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?",
    NOW,
    IST,
  );
  assert.ok(result);
  assert.equal(result.startDay, "2026-11-03");
});

test("resolves a bare weekday to the most recent past occurrence", () => {
  const result = resolveTemporal(
    "On Monday we shortlisted 5 CRM tools for a 20-person sales team.",
    NOW,
    IST,
  );
  assert.ok(result);
  assert.equal(result.startDay, "2026-11-09");
});

test("does not get distracted by a second date in the same message", () => {
  const result = resolveTemporal(
    "On 3 November you recommended a host. Is your answer still correct today?",
    NOW,
    IST,
  );
  assert.ok(result);
  assert.equal(result.startDay, "2026-11-03");
});

test("expands 'last week' to a full Monday-Sunday window", () => {
  const result = resolveTemporal("What did we discuss last week?", NOW, IST);
  assert.ok(result);
  assert.equal(result.grain, "week");
  assert.equal(result.startDay, "2026-11-02");
  assert.equal(result.endDay, "2026-11-08");
});

test("keeps an explicit year and respects 'next'", () => {
  const explicit = resolveTemporal("What changed on 3 November 2025?", NOW, IST);
  assert.ok(explicit);
  assert.equal(explicit.startDay, "2025-11-03");

  const next = resolveTemporal("What is happening next Monday?", NOW, IST);
  assert.ok(next);
  assert.equal(next.startDay, "2026-11-16");
});

test("returns null when there is no date reference", () => {
  assert.equal(resolveTemporal("Tell me about Postgres hosting.", NOW, IST), null);
});
