/**
 * `pnpm start` is a shell pipeline in `package.json`, and three of its pieces are load-bearing in
 * ways that no run fails on.
 *
 * Removing any one of them leaves the suite green, the types clean and `docs:check` at 8/8 — the
 * damage is a viewer that stops taking keystrokes, arguments delivered to the wrong process, or
 * half the levels missing, none of which a test that never spawns the pipeline can notice. So the
 * pipeline is read as text here, the way `logger-call-sites.test.ts` reads the tree.
 *
 * What this cannot see: whether the pipeline actually works. It asserts that the three pieces are
 * present and on the correct side of the `|`, not that `sh` still interprets them as intended —
 * nothing in vitest can hand a child process a pty, and without one the keystroke path that
 * `</dev/null` protects cannot be exercised at all. That half is verified by hand.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const manifest: { readonly scripts: Record<string, string> } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { readonly scripts: Record<string, string> };

const start = manifest.scripts.start ?? "";

/** The daemon's half of `start` — everything left of the pipe into the viewer. */
const producer = start.split("|")[0] ?? "";

describe("pnpm start", () => {
  it("runs the daemon into the viewer", () => {
    expect(producer).toContain("src/index.ts");
    expect(start).toMatch(/\|\s*node src\/cli\/logs\.ts/);
  });

  it("keeps the terminal off the daemon's stdin", () => {
    // Node restores the saved termios when a process holding a tty on fd 0 exits, so without this
    // the daemon's exit silently drops the viewer out of raw mode and every later keystroke is lost.
    expect(producer).toContain("</dev/null");
  });

  it("gives the daemon stderr too, since warn and error are written there", () => {
    expect(producer).toContain("2>&1");
  });

  it("puts pnpm's trailing arguments on the daemon, not on the viewer", () => {
    // pnpm appends script arguments to the end of the string, which is the viewer's side of the
    // pipe; `sh -c '… "$@" …' --` moves them back and parks the `--` in `$0`.
    expect(producer).toContain('"$@"');
    expect(start.trimEnd()).toMatch(/--$/);
  });
});

describe("pnpm start:daemon", () => {
  it("stays headless, so cron and CI have a form that needs no terminal", () => {
    const daemon = manifest.scripts["start:daemon"] ?? "";
    expect(daemon).toContain("src/index.ts");
    expect(daemon).not.toContain("logs.ts");
    expect(daemon).not.toContain("|");
  });
});

describe("the viewer's no-terminal refusal", () => {
  it("names commands that exist", () => {
    // The same claim `logs/preflight.ts` is held to, for the recipe in the file that cannot be
    // reached by a test: a refusal that names a script nobody can run is worse than no refusal.
    const source = readFileSync(new URL("./cli/logs.ts", import.meta.url), "utf8");
    // Ends on a word character, or a name at the end of a sentence takes the full stop with it.
    const suggested = [...source.matchAll(/pnpm ([\w:]*\w)/g)].map((match) => match[1]);

    expect(suggested.length).toBeGreaterThan(0);
    for (const script of suggested) {
      expect(Object.keys(manifest.scripts)).toContain(script);
    }
  });
});
