import { describe, expect, it } from "vitest";

import { NEWS_MARK, QUIET_MARK } from "../logger.ts";
import type { Action, ViewerState } from "./state.ts";
import { MAX_ENTRIES, bodyRows, initialState, reduce, visibleEntries } from "./state.ts";

const line = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    q: NEWS_MARK,
    ts: "2026-09-18T06:59:23.689Z",
    level: "info",
    src: "poll",
    message: "poll.done",
    ...over,
  });

/** Apply a run of actions to a fresh state, which is how every case below is set up. */
function run(actions: readonly Action[], rows = 24, columns = 100): ViewerState {
  return actions.reduce<ViewerState>(
    (state, action) => reduce(state, action),
    initialState(rows, columns),
  );
}

const feed = (...texts: string[]): Action[] => texts.map((text) => ({ kind: "line", text }));
const press = (...keys: string[]): Action[] => keys.map((key) => ({ kind: "key", key }));

describe("taking lines in", () => {
  it("collects sources in the order they were first seen", () => {
    // First-seen order is what fixes a source's key; re-sorting would move keys under the operator.
    const state = run(feed(line({ src: "poll" }), line({ src: "jira" }), line({ src: "poll" })));

    expect(state.sources).toEqual(["poll", "jira"]);
  });

  it("keeps a line it could not parse, and gains no source from it", () => {
    const state = run(feed("↳ SSX-1 sent back"));

    expect(state.entries).toHaveLength(1);
    expect(state.sources).toEqual([]);
  });

  it("caps the buffer and says how many it dropped", () => {
    // A viewer that quietly forgets the start of the run is one the operator cannot trust.
    const state = run(feed(...Array.from({ length: MAX_ENTRIES + 5 }, () => line())));

    expect(state.entries).toHaveLength(MAX_ENTRIES);
    expect(state.dropped).toBe(5);
  });
});

describe("filtering", () => {
  it("narrows to the levels left on", () => {
    const state = run([
      ...feed(line({ level: "info" }), line({ level: "warn" }), line({ level: "error" })),
      ...press("2"), // switch info off
    ]);

    expect(visibleEntries(state).map((entry) => entry.kind === "log" && entry.level)).toEqual([
      "warn",
      "error",
    ]);
  });

  it("narrows on the quiet/news mark, which is the other emoji axis", () => {
    const state = run([
      ...feed(line({ q: QUIET_MARK }), line({ q: NEWS_MARK })),
      ...press("5"), // switch ⏳ off
    ]);

    expect(visibleEntries(state).map((entry) => entry.kind === "log" && entry.mark)).toEqual([
      NEWS_MARK,
    ]);
  });

  it("narrows on the source, by the key that source was handed", () => {
    const state = run([...feed(line({ src: "poll" }), line({ src: "jira" })), ...press("a")]);

    // `a` is the first pool key, so it belongs to `poll`, the first source seen.
    expect(visibleEntries(state).map((entry) => entry.kind === "log" && entry.src)).toEqual([
      "jira",
    ]);
  });

  it("combines the axes rather than replacing one with the next", () => {
    const state = run([
      ...feed(
        line({ src: "poll", level: "info" }),
        line({ src: "poll", level: "warn" }),
        line({ src: "jira", level: "warn" }),
      ),
      ...press("2", "b"), // info off, and the second source off
    ]);

    expect(visibleEntries(state)).toHaveLength(1);
  });

  it("shows everything again after clear", () => {
    const state = run([...feed(line(), line({ level: "warn" })), ...press("2", "c")]);

    expect(visibleEntries(state)).toHaveLength(2);
  });

  it("ignores a key no filter claims", () => {
    const before = run(feed(line()));
    const after = reduce(before, { kind: "key", key: "z" });

    expect(after).toBe(before);
  });
});

describe("following and scrolling", () => {
  it("follows by default, so an arriving line is the one on screen", () => {
    const state = run(feed(line(), line()));

    expect(state.follow).toBe(true);
    expect(state.scroll).toBe(0);
  });

  it("stops following when scrolled up, so an arriving line does not move the view", () => {
    const state = run([...feed(...Array.from({ length: 50 }, () => line())), ...press("k")]);

    expect(state.follow).toBe(false);
    expect(state.scroll).toBe(1);
  });

  it("holds the same line under the eye while paused and lines keep arriving", () => {
    // The line the reader stopped at must not slide upward as the buffer grows beneath it.
    const paused = run([...feed(...Array.from({ length: 50 }, () => line())), ...press("k", "k")]);
    const later = reduce(paused, { kind: "line", text: line() });

    expect(later.scroll).toBe(paused.scroll + 1);
  });

  it("resumes following on reaching the bottom, without a second key", () => {
    const state = run([...feed(...Array.from({ length: 50 }, () => line())), ...press("k", "j")]);

    expect(state.follow).toBe(true);
  });

  it("holds the view on f, and an arriving line does not hand the tail back", () => {
    // The buffer here is shorter than the window, so the offset stays clamped at 0 — which is the
    // case that used to release the hold, because 0 was read as "the reader is back at the tail".
    const held = run([...feed(line({ message: "poll.first" })), ...press("f")]);
    const later = reduce(held, { kind: "line", text: line({ message: "poll.later" }) });

    expect(held.follow).toBe(false);
    expect(later.follow).toBe(false);
  });

  it("goes back to the tail on a second f, rather than needing G as well", () => {
    const state = run([
      ...feed(...Array.from({ length: 40 }, () => line())),
      ...press("f", "k", "k", "f"),
    ]);

    expect(state.follow).toBe(true);
    expect(state.scroll).toBe(0);
  });

  it("keeps the hold through a resize, which is not the reader asking to be moved", () => {
    // `movedTo` resumes following on reaching the bottom. A hold taken at the tail sits at offset
    // 0, so routing a resize through it would hand the tail back without a keystroke.
    const held = run([...feed(line()), ...press("f")]);
    const resized = reduce(held, { kind: "resize", rows: 40, columns: 120 });

    expect(resized.follow).toBe(false);
  });

  it("cannot scroll past the first line", () => {
    const state = run([...feed(line(), line()), ...press("g", "k", "k", "k")]);

    expect(state.scroll).toBe(0);
  });

  it("clamps the offset when the window gets shorter", () => {
    // A resize that leaves `scroll` past the top would draw a screen of nothing.
    const tall = run([...feed(...Array.from({ length: 40 }, () => line())), ...press("g")]);
    const short = reduce(tall, { kind: "resize", rows: 60, columns: 80 });

    expect(short.scroll).toBeLessThanOrEqual(Math.max(0, 40 - bodyRows(short)));
  });

  it("goes to the bottom and the top on G and g", () => {
    const entries = feed(...Array.from({ length: 40 }, () => line()));

    expect(run([...entries, ...press("g")]).scroll).toBeGreaterThan(0);
    expect(run([...entries, ...press("g", "G")]).scroll).toBe(0);
  });
});

describe("closing", () => {
  it("quits on q and on escape", () => {
    expect(run(press("q")).quit).toBe(true);
    expect(run(press("escape")).quit).toBe(true);
  });

  it("stays up when the feed closes, so the last screen can still be read", () => {
    const state = run([...feed(line()), { kind: "end" }]);

    expect(state.ended).toBe(true);
    expect(state.quit).toBe(false);
  });
});
