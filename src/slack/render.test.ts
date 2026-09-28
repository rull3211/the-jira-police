import { describe, expect, it } from "vitest";

import {
  type AuditRecord,
  MAX_ENTRY_CHARS,
  MAX_MAJOR_ENTRIES,
  MAX_TIMELINE_ENTRIES,
  applyEvent,
  newRecord,
} from "./audit.ts";
import { MAX_BLOCKS, renderRecord } from "./render.ts";

const NOW = new Date("2026-09-28T13:58:00Z");
const URL = "https://example.atlassian.net/browse/SSX-1";

function texts(blocks: readonly object[]): string[] {
  return (
    JSON.stringify(blocks)
      .match(/"text":"(?:[^"\\]|\\.)*"/gu)
      ?.map((match) => JSON.parse(match.slice(7)) as string) ?? []
  );
}

function full(): AuditRecord {
  let record = newRecord("SSX-1", "x".repeat(400), URL);
  const long = "word ".repeat(MAX_ENTRY_CHARS);
  for (let index = 0; index < MAX_MAJOR_ENTRIES + 3; index += 1) {
    // Distinct messages: a crash identical to the current one is folded into it, not added.
    record = applyEvent(
      record,
      { kind: "crashed", where: "fix pass", message: `${String(index)} ${long}` },
      NOW,
    );
  }
  for (let index = 0; index < MAX_TIMELINE_ENTRIES + 3; index += 1) {
    record = applyEvent(record, { kind: "review-round", text: long }, NOW);
  }
  return record;
}

describe("renderRecord", () => {
  it("escapes what a ticket or a model wrote, so no text in it can ping anyone", () => {
    let record = newRecord("SSX-1", "<!channel> look", URL);
    record = applyEvent(
      record,
      { kind: "crashed", where: "<!here>", message: "<@U123> & co" },
      NOW,
    );
    record = applyEvent(record, { kind: "review-round", text: "<!everyone>" }, NOW);

    const rendered = renderRecord(record);
    const mrkdwn = texts(rendered.blocks).filter((text) => !text.startsWith("SSX-1 · "));

    // `<!date^…>` is the renderer's own timestamp token; every other `<!` or `<@` would be a ping.
    for (const text of [...mrkdwn, rendered.text]) {
      expect(text).not.toMatch(/<(?:!(?!date\^)|@)/u);
    }
    expect(JSON.stringify(rendered.blocks)).toContain("&lt;!here&gt;");
  });

  it("stays inside Slack's limits with every cap full and every entry at its longest", () => {
    const { blocks } = renderRecord(full());

    expect(blocks.length).toBeLessThanOrEqual(MAX_BLOCKS);
    const header = blocks[0] as { text: { text: string } };
    expect(header.text.text.length).toBeLessThanOrEqual(150);
    for (const text of texts(blocks)) {
      expect(text.length).toBeLessThanOrEqual(3000);
    }
  });

  it("says how many entries the caps dropped", () => {
    expect(JSON.stringify(renderRecord(full()).blocks)).toContain("6 earlier entries not shown");
  });

  it("puts the newest timeline entry first", () => {
    let record = newRecord("SSX-1", "summary", URL);
    record = applyEvent(record, { kind: "triage-started" }, new Date("2026-09-28T10:00:00Z"));
    record = applyEvent(record, { kind: "claimed", repo: null }, new Date("2026-09-28T11:00:00Z"));

    const timeline = texts(renderRecord(record).blocks).find((text) =>
      text.startsWith("*Timeline*"),
    );
    expect(timeline?.indexOf("claimed")).toBeLessThan(timeline?.indexOf("triage started") ?? 0);
  });

  it("lets a crash outrank every other state on the card", () => {
    let record = newRecord("SSX-1", "summary", URL);
    record = applyEvent(
      record,
      { kind: "pr-opened", url: "https://github.com/o/r/pull/7", number: 7, title: "t" },
      NOW,
    );
    record = applyEvent(record, { kind: "pr-ended", state: "merged" }, NOW);
    record = applyEvent(record, { kind: "crashed", where: "review round 2", message: "boom" }, NOW);

    expect(texts(renderRecord(record).blocks)).toContain("*State*\n💥 crashed in review round 2");
  });

  it("calls a ticket nothing has happened to waiting, and says running only when something is", () => {
    const fresh = newRecord("SSX-1", "summary", URL);
    const triaging = applyEvent(fresh, { kind: "triage-started" }, NOW);
    const solving = applyEvent(triaging, { kind: "pass-started", pass: "fix" }, NOW);

    const state = (record: AuditRecord): string | undefined =>
      texts(renderRecord(record).blocks).find((text) => text.startsWith("*State*"));
    expect(state(fresh)).toBe("*State*\n⚪ waiting");
    expect(state(triaging)).toBe("*State*\n🟢 triaging");
    expect(state(solving)).toBe("*State*\n🟢 working");
  });

  it("renders a stored URL as a link only when it cannot break out of one", () => {
    const safe = renderRecord(newRecord("SSX-1", "summary", URL));
    const tampered = renderRecord(newRecord("SSX-1", "summary", "https://x.test|<!channel>"));

    expect(JSON.stringify(safe.blocks)).toContain(`<${URL}|SSX-1>`);
    expect(JSON.stringify(tampered.blocks)).not.toContain("https://x.test|");
  });
});
