import { describe, expect, it } from "vitest";

import {
  type AuditRecord,
  type Entry,
  MAX_ENTRY_CHARS,
  MAX_MAJOR_ENTRIES,
  MAX_TIMELINE_ENTRIES,
  applyEvent,
  newRecord,
} from "./audit.ts";
import { MAX_CHILD_BLOCKS, renderBump, renderRecord } from "./render.ts";

const NOW = new Date("2026-09-28T13:58:00Z");
const URL = "https://example.atlassian.net/browse/SSX-1";

function texts(blocks: readonly object[]): string[] {
  return (
    JSON.stringify(blocks)
      .match(/"text":"(?:[^"\\]|\\.)*"/gu)
      ?.map((match) => JSON.parse(match.slice(7)) as string) ?? []
  );
}

interface Container {
  readonly type: string;
  readonly title: { readonly text: string };
  readonly rich_text_title: {
    readonly elements: readonly { readonly elements: readonly Record<string, unknown>[] }[];
  };
  readonly is_collapsible: boolean;
  readonly default_collapsed: boolean;
  readonly child_blocks: readonly object[];
}

function container(record: AuditRecord): Container {
  const { blocks } = renderRecord(record);
  expect(blocks).toHaveLength(1);
  return blocks[0] as Container;
}

function full(long = "word ".repeat(MAX_ENTRY_CHARS)): AuditRecord {
  let record = newRecord("SSX-1", "x".repeat(400), URL);
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

  it("escapes a record hand-edited through the property API, down to its icons and timestamps", () => {
    // Anyone who can edit the ticket can write `jira-police.slack`; parseRecord checks only its shape.
    const forged: Entry = { at: "Sep 28 2026 (x><!channel>)", icon: "<!here>", text: "t" };
    const record: AuditRecord = {
      ...newRecord("SSX-1", "summary", URL),
      major: [forged],
      timeline: [forged],
    };

    const rendered = renderRecord(record);
    const bump = renderBump(record, forged);

    for (const text of [...texts(rendered.blocks), rendered.text, bump.text]) {
      expect(text).not.toMatch(
        /<(?:!(?!date\^\d+\^\{date_short_pretty\} \{time\}\|[\dT:.Z-]+>)|@)/u,
      );
    }
  });

  it("stays inside Slack's limits with every cap full and every entry at its longest", () => {
    // `<` escapes to four characters, the longest any entry can render.
    for (const record of [full(), full("<".repeat(MAX_ENTRY_CHARS))]) {
      const card = container(record);

      expect(card.child_blocks.length).toBeLessThanOrEqual(MAX_CHILD_BLOCKS);
      expect(card.title.text.length).toBeLessThanOrEqual(150);
      for (const text of texts(card.child_blocks)) {
        expect(text.length).toBeLessThanOrEqual(3000);
      }
    }
  });

  it("says how many entries the caps dropped, and how many the container had no room for", () => {
    expect(JSON.stringify(renderRecord(full()).blocks)).toContain("6 earlier entries not shown");

    // Every entry drawn, major or timeline, carries exactly one date token.
    const crowded = texts(container(full("<".repeat(MAX_ENTRY_CHARS))).child_blocks).join("\n");
    const hidden = Number(/… (\d+) earlier entries not shown/u.exec(crowded)?.[1]);
    const shown = crowded.match(/<!date\^/gu)?.length ?? 0;
    expect(hidden).toBeGreaterThan(6);
    expect(shown + hidden).toBe(MAX_MAJOR_ENTRIES + MAX_TIMELINE_ENTRIES + 6);
  });

  it("collapses to the title, and makes the title the ticket's link", () => {
    const card = container(newRecord("SSX-1", "Cache", URL));

    expect(card).toMatchObject({
      type: "container",
      title: { text: "SSX-1 · Cache" },
      is_collapsible: true,
      default_collapsed: true,
    });
    expect(card.rich_text_title.elements[0]?.elements[0]).toEqual({
      type: "link",
      url: URL,
      text: "SSX-1 · Cache",
      style: { bold: true },
    });
  });

  it("broadcasts a major entry as one line naming the ticket, escaped like the card", () => {
    const record = applyEvent(newRecord("SSX-1", "<!channel>", URL), { kind: "pr-ready" }, NOW);

    const bump = renderBump(record, record.major[0] ?? { at: "", icon: "", text: "" });

    expect(bump.text).toBe(`👀 *PR ready for review* — <${URL}|SSX-1 · &lt;!channel&gt;>`);
  });

  it("mentions only what is a Slack user ID, so a forged list cannot ping the channel", () => {
    const record = applyEvent(newRecord("SSX-1", "t", URL), { kind: "pr-ready" }, NOW);

    const bump = renderBump(record, record.major[0] ?? { at: "", icon: "", text: "" }, [
      "U0ME",
      "<!channel>",
      "U0ME>|x",
      "here",
    ]);

    expect(bump.text).toBe(`👀 *PR ready for review* — <${URL}|SSX-1 · t> <@U0ME>`);
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

  it("draws a ticket triaged before its thread from the labels, and a PR a round sent back as not ready", () => {
    let record = newRecord("SSX-1", "summary", URL);
    record = applyEvent(
      record,
      {
        kind: "observed",
        pr: { url: "https://github.com/o/r/pull/7", number: 7, draft: false },
        triage: { dor: "pass", solvable: true },
      },
      NOW,
    );
    record = applyEvent(record, { kind: "pr-reworking" }, NOW);

    const fields = texts(renderRecord(record).blocks);
    expect(fields).toContain("*Triage*\n✅ DoR passed · solvable · from the ticket's labels");
    expect(fields).toContain("*Work*\n✅ implemented and verified");
    expect(fields).toContain("*PR*\n<https://github.com/o/r/pull/7|#7> back with the bot");
  });

  it("renders a stored URL as a link only when it cannot break out of one", () => {
    const safe = renderRecord(newRecord("SSX-1", "summary", URL));
    const tampered = renderRecord(newRecord("SSX-1", "summary", "https://x.test|<!channel>"));

    expect(JSON.stringify(safe.blocks)).toContain(`<${URL}|SSX-1>`);
    expect(JSON.stringify(tampered.blocks)).not.toContain("https://x.test|");
    expect(JSON.stringify(tampered.blocks)).not.toContain('"type":"link"');
  });
});
