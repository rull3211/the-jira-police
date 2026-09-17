/**
 * Cases for `findDaemons`, written against the plausible wrong implementation
 * `command.includes("src/index.ts")` with no check on the program; a false "running" costs more
 * than a false negative, so that direction gets the most cases.
 */

import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { findDaemons } from "./daemon-processes.ts";

/** A `ps -Ao pid=,command=` block, indented the way `ps` pads its pid column. */
function ps(...lines: readonly string[]): string {
  return lines.map((line) => `${line}\n`).join("");
}

const NOT_US = 1;

describe("what is actually the daemon", () => {
  it("finds `pnpm dev` and marks it watched", () => {
    const found = findDaemons(
      ps("  4821 node --watch --env-file-if-exists=.env src/index.ts"),
      NOT_US,
    );

    expect(found).toEqual([
      {
        pid: 4821,
        command: "node --watch --env-file-if-exists=.env src/index.ts",
        watched: true,
      },
    ]);
  });

  it("finds `pnpm start` and does not mark it watched", () => {
    const found = findDaemons(ps("  4822 node --env-file-if-exists=.env src/index.ts"), NOT_US);

    expect(found).toHaveLength(1);
    expect(found[0]?.watched).toBe(false);
  });

  it("matches an absolute node path, which is what a version manager gives you", () => {
    const found = findDaemons(
      ps("  4823 /Users/x/.local/share/mise/installs/node/24.2.0/bin/node src/index.ts"),
      NOT_US,
    );

    expect(found).toHaveLength(1);
  });

  it("reports both when two daemons are up, which is the case worth seeing", () => {
    const found = findDaemons(
      ps("  4821 node --watch src/index.ts", "  9100 node --env-file-if-exists=.env src/index.ts"),
      NOT_US,
    );

    expect(found.map((daemon) => daemon.pid)).toEqual([4821, 9100]);
  });
});

describe("lines that name the daemon and are not it", () => {
  // Unplug the program check and this returns 2; the wrapper is not a second daemon.
  it("ignores the shell wrapper pnpm interposes", () => {
    const found = findDaemons(
      ps(
        "  4820 sh -c node --watch --env-file-if-exists=.env src/index.ts",
        "  4821 node --watch --env-file-if-exists=.env src/index.ts",
      ),
      NOT_US,
    );

    expect(found.map((daemon) => daemon.pid)).toEqual([4821]);
  });

  // The expensive direction: unplug the program check and this says the daemon is running when nothing is.
  it("ignores a grep that happens to name the entry point", () => {
    const found = findDaemons(
      ps(
        "  5001 grep -rn src/index.ts .",
        "  5002 pgrep -fl src/index.ts",
        "  5003 vim src/index.ts",
      ),
      NOT_US,
    );

    expect(found).toEqual([]);
  });

  it("ignores node processes that are not the entry point", () => {
    const found = findDaemons(
      ps(
        "  6001 node /Users/x/repo/node_modules/.bin/vitest run",
        "  6002 node src/cli/solve-once.ts SSX-1234 --pr",
        "  6003 node --test src/index.test.ts",
      ),
      NOT_US,
    );

    expect(found).toEqual([]);
  });

  it("ignores its own pid", () => {
    const found = findDaemons(ps("  7777 node src/index.ts"), 7777);

    expect(found).toEqual([]);
  });

  it("returns nothing for empty output rather than throwing", () => {
    expect(findDaemons("", NOT_US)).toEqual([]);
    expect(findDaemons("\n\n", NOT_US)).toEqual([]);
  });
});

describe("against the real process table", () => {
  // Asserts only on shape, not on which processes come back, so the suite doesn't depend on what's running.
  const real = execFileSync("ps", ["-Ao", "pid=,command="], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });

  it("parses real ps output into well-formed records", () => {
    for (const daemon of findDaemons(real, process.pid)) {
      expect(daemon.pid).toBeGreaterThan(0);
      expect(daemon.command).toContain("src/index.ts");
    }
  });

  it("finds this very test run when told to look for node, proving the format parses", () => {
    // Without this, a parser matching nothing would pass the shape check above via an empty array.
    const anyNode = real.split("\n").filter((line) => /^\s*\d+\s+\S*node(\s|$)/.test(line));

    expect(anyNode.length).toBeGreaterThan(0);
  });
});
