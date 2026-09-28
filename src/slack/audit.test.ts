import { describe, expect, it } from "vitest";

import {
  type AuditEvent,
  type AuditRecord,
  MAX_ENTRY_CHARS,
  MAX_MAJOR_ENTRIES,
  MAX_TIMELINE_ENTRIES,
  applyEvent,
  newRecord,
  parseRecord,
} from "./audit.ts";

const NOW = new Date("2026-09-28T13:58:00Z");
const BASE = newRecord(
  "SSX-1",
  "Cache blir ikke tømt",
  "https://example.atlassian.net/browse/SSX-1",
);

/** Keyed by kind, so an event added to the union and left out here fails to compile. */
const EVERY_EVENT: Record<AuditEvent["kind"], { event: AuditEvent; bucket: "major" | "timeline" }> =
  {
    "triage-started": { event: { kind: "triage-started" }, bucket: "timeline" },
    "triage-verdict": {
      event: {
        kind: "triage-verdict",
        verdict: "ready-ish",
        solvable: true,
        confidence: "high",
        posted: true,
      },
      bucket: "major",
    },
    "triage-refused": {
      event: { kind: "triage-refused", reason: "a dor:pass with placeholders" },
      bucket: "major",
    },
    claimed: { event: { kind: "claimed", repo: "buy-insurance-advisor-web" }, bucket: "timeline" },
    "pass-started": { event: { kind: "pass-started", pass: "fix" }, bucket: "timeline" },
    "pass-finished": { event: { kind: "pass-finished", pass: "fix" }, bucket: "timeline" },
    verified: { event: { kind: "verified" }, bucket: "timeline" },
    "solve-ended": {
      event: { kind: "solve-ended", outcome: "bailed", reason: "the brief was wrong" },
      bucket: "major",
    },
    "pr-opened": {
      event: {
        kind: "pr-opened",
        url: "https://github.com/o/r/pull/7",
        number: 7,
        title: "fix(cache): evict",
      },
      bucket: "major",
    },
    "review-round": {
      event: { kind: "review-round", text: "review round 2 pushed" },
      bucket: "timeline",
    },
    "pr-ready": { event: { kind: "pr-ready" }, bucket: "major" },
    "pr-ended": { event: { kind: "pr-ended", state: "merged" }, bucket: "major" },
    crashed: {
      event: { kind: "crashed", where: "fix pass", message: "error_max_structured_output_retries" },
      bucket: "major",
    },
  };

describe("applyEvent", () => {
  it.each(Object.entries(EVERY_EVENT))("files %s where it belongs", (_kind, { event, bucket }) => {
    const next = applyEvent(BASE, event, NOW);

    expect(next.major.length + next.timeline.length).toBe(1);
    expect((bucket === "major" ? next.major : next.timeline)[0]?.at).toBe(NOW.toISOString());
  });

  it("moves the status fields the message's card shows", () => {
    let record: AuditRecord = BASE;
    record = applyEvent(record, EVERY_EVENT["triage-verdict"].event, NOW);
    record = applyEvent(record, EVERY_EVENT.claimed.event, NOW);
    record = applyEvent(record, EVERY_EVENT["pass-started"].event, NOW);

    expect(record.triage).toMatchObject({ kind: "verdict", verdict: "ready-ish", solvable: true });
    expect(record.work).toEqual({ kind: "solving", pass: "fix" });
    expect(record.repo).toBe("buy-insurance-advisor-web");

    record = applyEvent(record, EVERY_EVENT["pr-opened"].event, NOW);
    record = applyEvent(record, EVERY_EVENT["pr-ready"].event, NOW);
    expect(record.pr).toEqual({ url: "https://github.com/o/r/pull/7", number: 7, state: "ready" });

    record = applyEvent(record, EVERY_EVENT.crashed.event, NOW);
    expect(record.crash).toMatchObject({ where: "fix pass" });
  });

  it("keeps the newest entries at the caps, and counts what it dropped", () => {
    let record: AuditRecord = BASE;
    for (let index = 0; index < MAX_TIMELINE_ENTRIES + 5; index += 1) {
      record = applyEvent(record, { kind: "review-round", text: `round ${String(index)}` }, NOW);
    }
    for (let index = 0; index < MAX_MAJOR_ENTRIES + 2; index += 1) {
      record = applyEvent(record, { kind: "pr-ready" }, NOW);
    }

    expect(record.timeline).toHaveLength(MAX_TIMELINE_ENTRIES);
    expect(record.timeline[0]?.text).toBe("round 5");
    expect(record.major).toHaveLength(MAX_MAJOR_ENTRIES);
    expect(record.dropped).toEqual({ major: 2, timeline: 5 });
  });

  it("bounds text from a ticket, a model or an error to one line and a length", () => {
    const next = applyEvent(
      BASE,
      { kind: "crashed", where: "fix\npass", message: `${"word ".repeat(100)}end` },
      NOW,
    );

    const text = next.major[0]?.text ?? "";
    expect(text).not.toContain("\n");
    expect(text.length).toBeLessThanOrEqual(MAX_ENTRY_CHARS + 1);
    expect(text.endsWith("…")).toBe(true);
  });
});

describe("parseRecord", () => {
  it("reads back what a JSON round trip through a property returns", () => {
    const record = applyEvent(BASE, EVERY_EVENT["pr-opened"].event, NOW);

    expect(parseRecord(JSON.parse(JSON.stringify(record)))).toEqual(record);
  });

  it.each([
    ["nothing", null],
    ["a string", "hand-edited"],
    ["a newer schema", { ...BASE, version: 2 }],
    ["a record missing its timeline", { ...BASE, timeline: undefined }],
  ])("refuses %s rather than guessing", (_name, value) => {
    expect(parseRecord(value)).toBeNull();
  });
});
