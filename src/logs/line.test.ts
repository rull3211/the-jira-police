import { describe, expect, it } from "vitest";

import { NEWS_MARK } from "../logger.ts";
import { clockOf, parseLine } from "./line.ts";

const LINE = JSON.stringify({
  q: NEWS_MARK,
  ts: "2026-09-18T06:59:23.689Z",
  level: "info",
  src: "poll",
  message: "poll.status_filter",
  statuses: ["10165"],
  restricted: true,
});

describe("parseLine", () => {
  it("reads the logger's own keys into columns and leaves the rest as fields", () => {
    const entry = parseLine(LINE);

    expect(entry).toMatchObject({
      kind: "log",
      mark: NEWS_MARK,
      level: "info",
      src: "poll",
      message: "poll.status_filter",
    });
    expect(entry.kind === "log" && entry.fields).toEqual({
      statuses: ["10165"],
      restricted: true,
    });
  });

  it("keeps a line that is not JSON at all, rather than dropping it", () => {
    // `watch/sweep.ts` writes `↳` report lines onto the same descriptor as the JSON.
    const entry = parseLine("  ↳ SSX-1 sent back, no answer yet");

    expect(entry).toEqual({ kind: "raw", text: "  ↳ SSX-1 sent back, no answer yet" });
  });

  it("keeps a stack trace, which is the line most worth not losing", () => {
    const entry = parseLine("    at createGroom (file:///src/wiring.ts:225:11)");

    expect(entry.kind).toBe("raw");
  });

  it("keeps truncated JSON rather than throwing on it", () => {
    // A line cut by a dying process starts with `{` and never parses.
    expect(parseLine('{"q":"🔧","ts":"2026-09').kind).toBe("raw");
  });

  it("treats valid JSON that is not a log record as raw", () => {
    expect(parseLine("[1,2,3]").kind).toBe("raw");
    expect(parseLine('{"hello":"world"}').kind).toBe("raw");
  });

  it("refuses a level it does not know, instead of showing a line it cannot filter", () => {
    // An unknown level has no glyph and no filter chip, so as a `log` it would be unreachable.
    expect(parseLine('{"level":"trace","src":"poll","message":"poll.x"}').kind).toBe("raw");
  });

  it("still shows a line written before `q` and `ts` existed", () => {
    const entry = parseLine('{"level":"info","src":"poll","message":"poll.done"}');

    expect(entry).toMatchObject({ kind: "log", mark: "", ts: "" });
  });

  it("keeps the original text on every entry, log or not", () => {
    expect(parseLine(LINE).text).toBe(LINE);
  });
});

describe("clockOf", () => {
  it("takes the time out of an ISO timestamp", () => {
    expect(clockOf("2026-09-18T06:59:23.689Z")).toBe("06:59:23");
  });

  it("returns a cell of the same width when there is no timestamp", () => {
    // A narrower cell here would move every column to its right, on that one line only.
    expect(clockOf("")).toHaveLength(8);
    expect(clockOf("not a date")).toHaveLength(8);
  });
});
