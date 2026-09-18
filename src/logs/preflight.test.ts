import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { refusal } from "./preflight.ts";

describe("refusal", () => {
  it("lets the viewer run when something is piped in", () => {
    expect(refusal({ stdinIsTerminal: false })).toBeUndefined();
  });

  it("refuses when stdin is the terminal, rather than drawing a screen nothing can fill", () => {
    // Measured under a pty before this existed: an empty viewer reading `0/0 lines`, and `q` never
    // reached it — stdin and /dev/tty were the same device, so the line reader ate the keystroke.
    expect(refusal({ stdinIsTerminal: true })).toBeDefined();
  });

  it("says how to get lines into it, not only that there are none", () => {
    // A refusal that names no working command sends the operator back to the README, and the
    // README is what they had already read to find `pnpm logs`.
    expect(refusal({ stdinIsTerminal: true })).toContain("pnpm logs < run.ndjson");
  });

  it("warns off the direct pipe in the same breath, since that is the next thing tried", () => {
    // `pnpm start | pnpm logs` is the obvious repair for "nothing is piped in", and it kills the
    // daemon on EPIPE the moment the viewer quits.
    const said = refusal({ stdinIsTerminal: true }) ?? "";

    expect(said).toContain("tail -f run.ndjson | pnpm logs");
    expect(said).toContain("kills the daemon");
  });

  it("is asked by the shell, and asked before the terminal is opened", () => {
    // The function above being right is half of it. Nothing in vitest can hand a child process a
    // pty, so the wiring is checked as source text: a refusal decided after the alternate screen
    // is entered is one the operator never reads, because it is drawn on a surface that vanishes.
    const shell = readFileSync(new URL("../cli/logs.ts", import.meta.url), "utf8");
    const asked = shell.indexOf("refusal({");
    const opened = shell.indexOf("openTerminal()", shell.indexOf("function main"));

    expect(asked).toBeGreaterThan(-1);
    expect(asked).toBeLessThan(opened);
  });
});
