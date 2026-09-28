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
  retitle,
} from "./audit.ts";

const NOW = new Date("2026-09-28T13:58:00Z");
const BASE = newRecord(
  "SSX-1",
  "Cache blir ikke tømt",
  "https://example.atlassian.net/browse/SSX-1",
);

/** Keyed by kind, so an event added to the union and left out here fails to compile. */
const EVERY_EVENT: Record<
  AuditEvent["kind"],
  { event: AuditEvent; bucket: "major" | "timeline" | "none" }
> = {
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
  observed: { event: observed(7, false), bucket: "timeline" },
  "pr-ready": { event: { kind: "pr-ready" }, bucket: "major" },
  "pr-reworking": { event: { kind: "pr-reworking" }, bucket: "none" },
  "pr-ended": { event: { kind: "pr-ended", state: "merged" }, bucket: "major" },
  crashed: {
    event: { kind: "crashed", where: "fix pass", message: "error_max_structured_output_retries" },
    bucket: "major",
  },
};

function observed(
  number: number,
  draft: boolean,
  triage: { dor: "pass" | "gaps" | null; solvable: boolean } | null = {
    dor: "pass",
    solvable: true,
  },
): AuditEvent {
  return {
    kind: "observed",
    pr: { url: `https://github.com/o/r/pull/${String(number)}`, number, draft },
    triage,
  };
}

describe("applyEvent", () => {
  it.each(Object.entries(EVERY_EVENT))("files %s where it belongs", (_kind, { event, bucket }) => {
    const next = applyEvent(BASE, event, NOW);

    expect(next.major.length + next.timeline.length).toBe(bucket === "none" ? 0 : 1);
    if (bucket !== "none") {
      expect((bucket === "major" ? next.major : next.timeline)[0]?.at).toBe(NOW.toISOString());
    }
  });

  it("fills in a record started mid-life from what a review look saw, and writes nothing the second time", () => {
    const seen = applyEvent(BASE, observed(7, false), NOW);

    expect(seen.triage).toEqual({ kind: "labelled", dor: "pass", solvable: true });
    expect(seen.work).toEqual({ kind: "verified" });
    expect(seen.pr).toEqual({ url: "https://github.com/o/r/pull/7", number: 7, state: "ready" });
    expect(seen.timeline.map((entry) => entry.text)).toEqual(["PR #7 found"]);
    expect(applyEvent(seen, observed(7, false), NOW)).toBe(seen);
  });

  it("never overwrites a triage verdict or a work state the record already holds", () => {
    let record: AuditRecord = applyEvent(BASE, EVERY_EVENT["triage-verdict"].event, NOW);
    record = applyEvent(record, EVERY_EVENT["pass-started"].event, NOW);

    const seen = applyEvent(record, observed(7, true, { dor: "gaps", solvable: false }), NOW);

    expect(seen.triage).toBe(record.triage);
    expect(seen.work).toEqual({ kind: "solving", pass: "fix" });
  });

  it("logs a PR ready once per handover, and again only after it was sent back", () => {
    let record: AuditRecord = applyEvent(BASE, EVERY_EVENT["triage-verdict"].event, NOW);
    record = applyEvent(record, { kind: "verified" }, NOW);
    record = applyEvent(record, EVERY_EVENT["pr-opened"].event, NOW);
    record = applyEvent(record, { kind: "pr-ready" }, NOW);
    const handedOver = record;

    // Every later look at a PR already out of draft answers `ready` again.
    record = applyEvent(record, { kind: "pr-ready" }, NOW);
    record = applyEvent(record, observed(7, false), NOW);
    expect(record).toBe(handedOver);

    // A round that pushed: out of draft on GitHub, back with the bot on the board.
    record = applyEvent(record, { kind: "pr-reworking" }, NOW);
    expect(record.pr?.state).toBe("reworking");
    expect(applyEvent(record, observed(7, false), NOW).pr?.state).toBe("reworking");
    record = applyEvent(record, { kind: "pr-ready" }, NOW);

    // A person drafting it.
    record = applyEvent(record, observed(7, true), NOW);
    expect(record.pr?.state).toBe("draft");
    record = applyEvent(record, { kind: "pr-ready" }, NOW);

    expect(record.major.map((entry) => entry.text).slice(1)).toEqual([
      "PR opened — #7 fix(cache): evict",
      "PR ready for review",
      "PR ready for review",
      "PR ready for review",
    ]);
  });

  it("logs a PR's ending once however many looks see it ended", () => {
    const opened = applyEvent(BASE, EVERY_EVENT["pr-opened"].event, NOW);
    const merged = applyEvent(opened, { kind: "pr-ended", state: "merged" }, NOW);

    expect(applyEvent(merged, { kind: "pr-ended", state: "merged" }, NOW)).toBe(merged);
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

  it("stops calling a ticket crashed once something else happens, and keeps the crash as history", () => {
    const crashed = applyEvent(BASE, EVERY_EVENT.crashed.event, NOW);
    const retried = applyEvent(crashed, EVERY_EVENT["triage-verdict"].event, NOW);

    expect(crashed.crash).not.toBeNull();
    expect(retried.crash).toBeNull();
    expect(retried.major.map((entry) => entry.icon)).toEqual(["💥", "🔍"]);
  });

  it("folds a crash identical to the current one into it, so a failure met every tick is one entry", () => {
    const once = applyEvent(BASE, EVERY_EVENT.crashed.event, NOW);
    const again = applyEvent(once, EVERY_EVENT.crashed.event, NOW);

    expect(again).toBe(once);
    expect(
      applyEvent(once, { kind: "crashed", where: "fix pass", message: "another" }, NOW).major,
    ).toHaveLength(2);
  });

  it("keeps the newest entries at the caps, and counts what it dropped", () => {
    let record: AuditRecord = BASE;
    for (let index = 0; index < MAX_TIMELINE_ENTRIES + 5; index += 1) {
      record = applyEvent(record, { kind: "review-round", text: `round ${String(index)}` }, NOW);
    }
    for (let index = 0; index < MAX_MAJOR_ENTRIES + 2; index += 1) {
      record = applyEvent(
        record,
        { kind: "crashed", where: "review", message: String(index) },
        NOW,
      );
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

describe("retitle", () => {
  it("returns the record itself for the title it already holds, however long, so a tick writes nothing", () => {
    const long = `${"ord ".repeat(100)}\nslutt`;
    const titled = retitle(BASE, long, BASE.url);

    expect(titled.summary).not.toContain("\n");
    expect(retitle(titled, long, BASE.url)).toBe(titled);
    expect(retitle(BASE, "Cache blir ikke tømt", BASE.url)).toBe(BASE);
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
