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

  it("sends a reader after a live daemon to pnpm start, not to a pipe they assemble themselves", () => {
    // Hand-assembling `<daemon> | pnpm logs` is the obvious repair for "nothing is piped in", and
    // getting it right needs two redirections most people would not guess: `2>&1` so warnings and
    // errors are not printed over the screen, and stdin off the terminal so the daemon's exit does
    // not reset the termios and kill the keyboard. `pnpm start` is that pipeline, already correct.
    const said = refusal({ stdinIsTerminal: true }) ?? "";

    expect(said).toContain("pnpm start runs the daemon and");
    expect(said).toContain("pnpm start:daemon --for 10m > run.ndjson 2>&1");
  });

  it("names capture commands that exist", () => {
    // The recipe named `pnpm poll:once`, then `pnpm start`; both were true when written and one
    // stopped being a headless daemon without the string noticing. Check each suggestion against
    // package.json rather than trusting it.
    const said = refusal({ stdinIsTerminal: true }) ?? "";
    const manifest: { readonly scripts: Record<string, string> } = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { readonly scripts: Record<string, string> };

    const suggested = [...said.matchAll(/pnpm ([\w:]+)/g)].map((match) => match[1]);

    expect(suggested.length).toBeGreaterThan(0);
    for (const script of suggested) {
      expect(Object.keys(manifest.scripts)).toContain(script);
    }
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
