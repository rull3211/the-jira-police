import { describe, expect, it } from "vitest";

import { NEWS_MARK } from "../logger.ts";
import { displayWidth } from "./glyphs.ts";
import { parseLine } from "./line.ts";
import type { LogEntry } from "./line.ts";
import { clip, formatFields, formatLog, render } from "./render.ts";
import type { ViewerState } from "./state.ts";
import { initialState, reduce } from "./state.ts";

const ESC = "\u001B";

/**
 * What the operator actually sees, with the colour codes taken back out.
 *
 * Scanned rather than matched by a pattern: a regex holding a literal control character is what
 * `no-control-regex` exists to stop, and every sequence the viewer emits ends in `m`.
 */
function plain(line: string): string {
  let out = "";
  let index = 0;
  while (index < line.length) {
    if (line[index] === ESC && line[index + 1] === "[") {
      const end = line.indexOf("m", index);
      index = end === -1 ? line.length : end + 1;
      continue;
    }
    out += line[index];
    index += 1;
  }
  return out;
}

const line = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    q: NEWS_MARK,
    ts: "2026-09-18T06:59:23.689Z",
    level: "info",
    src: "poll",
    message: "poll.done",
    ...over,
  });

function stateWith(texts: readonly string[], rows = 12, columns = 100): ViewerState {
  return texts.reduce<ViewerState>(
    (state, text) => reduce(state, { kind: "line", text }),
    initialState(rows, columns),
  );
}

describe("formatLog", () => {
  it("puts the source in a fixed column, whatever its length", () => {
    // The columns are the reason `src` was added; a source that moved them would undo that.
    const short = formatLog(parseLine(line({ src: "adf" })) as LogEntry);
    const long = formatLog(parseLine(line({ src: "attach-stage" })) as LogEntry);

    expect(plain(short).indexOf("poll.done")).toBe(plain(long).indexOf("poll.done"));
  });

  it("cuts a source too long for its column rather than letting it push the message", () => {
    const wide = formatLog(parseLine(line({ src: "a-very-long-source-name" })) as LogEntry);
    const normal = formatLog(parseLine(line({ src: "poll" })) as LogEntry);

    expect(plain(wide).indexOf("poll.done")).toBe(plain(normal).indexOf("poll.done"));
  });

  it("keeps the message column aligned across levels, since every glyph is the same width", () => {
    const at = (level: string): number =>
      plain(formatLog(parseLine(line({ level })) as LogEntry)).indexOf("poll.done");

    expect(at("debug")).toBe(at("info"));
    expect(at("warn")).toBe(at("error"));
    expect(at("debug")).toBe(at("error"));
  });

  it("holds the column when a line has no mark", () => {
    const marked = formatLog(parseLine(line()) as LogEntry);
    const unmarked = formatLog(
      parseLine('{"level":"info","src":"poll","message":"poll.done"}') as LogEntry,
    );

    expect(plain(marked).indexOf("poll.done")).toBe(plain(unmarked).indexOf("poll.done"));
  });
});

describe("formatFields", () => {
  it("writes scalars bare and anything else as compact JSON", () => {
    expect(formatFields({ found: 0, restricted: true, jql: "project = SSX" })).toBe(
      "found=0 restricted=true jql=project = SSX",
    );
    expect(formatFields({ statuses: ["a", "b"] })).toBe('statuses=["a","b"]');
  });

  it("renders an undefined value rather than dropping the key", () => {
    // A key that vanished would read as a field the logger never wrote.
    expect(formatFields({ error: undefined })).toBe("error=?");
  });

  it("is empty when there are no fields, so nothing trails the message", () => {
    expect(formatFields({})).toBe("");
  });
});

describe("clip", () => {
  it("counts printable columns and not escape codes", () => {
    // Counting the codes would cut a coloured line well before the edge of the window.
    expect(plain(clip("\u001B[1mabcdef\u001B[0m", 3))).toBe("abc");
  });

  it("never cuts through a wide glyph", () => {
    expect(displayWidth(plain(clip("ab🔵", 3)))).toBeLessThanOrEqual(3);
    expect(plain(clip("ab🔵", 3))).toBe("ab");
  });

  it("leaves a line that already fits alone", () => {
    expect(clip("abc", 10)).toBe("abc");
  });
});

describe("render", () => {
  it("returns exactly one string per row of the window", () => {
    const screen = render(stateWith([line(), line()], 12, 100));

    expect(screen).toHaveLength(12);
  });

  it("keeps every row inside the window's width", () => {
    const wide = stateWith([line({ message: "poll.done", note: "x".repeat(400) })], 10, 40);

    for (const row of render(wide)) {
      expect(`${String(displayWidth(plain(row)) <= 40)} ${plain(row)}`).toContain("true");
    }
  });

  it("does not move the filter row when a filter is toggled off", () => {
    // Brackets rather than colour alone: `[1🔍]` and ` 1🔍 ` are the same width by construction.
    const before = stateWith([line()]);
    const after = reduce(before, { kind: "key", key: "2" });

    expect(displayWidth(plain(render(after)[1] ?? ""))).toBe(
      displayWidth(plain(render(before)[1] ?? "")),
    );
  });

  it("says which filters are on without relying on colour", () => {
    const state = reduce(stateWith([line()]), { kind: "key", key: "2" });
    const row = plain(render(state)[1] ?? "");

    expect(row).toContain("[1🔍]");
    expect(row).toContain(" 2🔵 ");
  });

  it("shows a raw line verbatim rather than dressed as a record", () => {
    const screen = render(stateWith(["  ↳ SSX-1 sent back, no answer yet"], 10, 100));

    expect(screen.map(plain).join("\n")).toContain("↳ SSX-1 sent back, no answer yet");
  });

  it("names the sources it has seen, each with its key", () => {
    const row = plain(render(stateWith([line({ src: "poll" }), line({ src: "jira" })]))[2] ?? "");

    expect(row).toContain("a poll");
    expect(row).toContain("b jira");
  });

  it("says so before any source has been seen, rather than drawing an empty row", () => {
    expect(plain(render(initialState(10, 80))[2] ?? "")).toContain("no source seen yet");
  });

  it("reports how many lines are shown against how many arrived", () => {
    const state = reduce(stateWith([line({ level: "info" }), line({ level: "warn" })]), {
      kind: "key",
      key: "2",
    });

    expect(plain(render(state)[0] ?? "")).toContain("1/2 lines");
  });

  it("says when the feed has closed, so a finished replay does not look like a stall", () => {
    const state = reduce(stateWith([line()]), { kind: "end" });

    expect(plain(render(state)[0] ?? "")).toContain("feed closed");
  });

  it("keeps the whole key list on screen at 80 columns, the narrowest terminal worth having", () => {
    // The row is clipped rather than wrapped, so a footer one character too long loses the last
    // key silently — and the key it loses is the filter hint, which is the row's whole purpose.
    const footer = plain(render(initialState(10, 80)).at(-1) ?? "");

    expect(footer).toContain("digits+letters filter");
  });

  it("shows the newest line while following", () => {
    const texts = Array.from({ length: 40 }, (_, i) => line({ message: `poll.n${String(i)}` }));
    const screen = render(stateWith(texts, 12, 100))
      .map(plain)
      .join("\n");

    expect(screen).toContain("poll.n39");
    expect(screen).not.toContain("poll.n0 ");
  });
});
