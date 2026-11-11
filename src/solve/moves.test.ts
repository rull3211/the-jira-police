import { describe, expect, it } from "vitest";

import type { NameStatus } from "./diff-gate.ts";
import {
  type PlannedMove,
  applyMoves,
  movePath,
  moveRefusals,
  moveViolations,
  resolveMoves,
} from "./moves.ts";
import type { CommandResult, CommandRunner } from "./worktree.ts";

const WORKTREE = "/worktrees/SSX-4204";
const NUL = "\u0000";
const OK: CommandResult = { exitCode: 0, stdout: "", stderr: "", timedOut: false };

describe("movePath", () => {
  it("reads a path as git will, with the worktree prefix a model adds removed", () => {
    expect(movePath(`${WORKTREE}/src/a.tsx`, WORKTREE)).toBe("src/a.tsx");
    expect(movePath("./src//a.tsx", WORKTREE)).toBe("src/a.tsx");
  });

  it("is null for a path that leaves the worktree", () => {
    expect(movePath("../other/a.tsx", WORKTREE)).toBeNull();
    expect(movePath("/etc/passwd", WORKTREE)).toBeNull();
  });
});

const move = (from: string, to: string): PlannedMove => ({ from, to });

const nameStatus = (status: string, path: string, from: string | null = null): NameStatus => ({
  status,
  score: status === "R" ? 100 : null,
  path,
  from,
});

describe("moveRefusals", () => {
  it("refuses nothing in a set of renames that touch ordinary files once each", () => {
    expect(
      moveRefusals([move("src/a.tsx", "src/a.ts"), move("src/b.tsx", "src/b.ts")], WORKTREE),
    ).toEqual([]);
  });

  it("refuses a move with an end outside the worktree", () => {
    expect(moveRefusals([move("src/a.tsx", "../a.ts")], WORKTREE)).toEqual([
      expect.stringContaining("not a move between two paths inside the worktree"),
    ]);
  });

  it("refuses a move onto itself, including one that only differs by spelling", () => {
    expect(moveRefusals([move("src/a.tsx", "./src/a.tsx")], WORKTREE)).toEqual([
      expect.stringContaining("moves a file onto itself"),
    ]);
  });

  it("holds both ends to the plan's path rules, so a refused file can neither be reached nor renamed", () => {
    expect(moveRefusals([move("ci.yml", ".github/workflows/ci.yml")], WORKTREE)).toEqual([
      expect.stringContaining(".github/workflows/ci.yml: GitHub config"),
    ]);
    expect(moveRefusals([move("package.json", "package.old.json")], WORKTREE)).toEqual([
      expect.stringContaining("package.json: the harness reads"),
    ]);
  });

  it("refuses a moved pom.xml, which no content-free move can make a dependency bump", () => {
    expect(moveRefusals([move("pom.xml", "build/pom.xml")], WORKTREE)).not.toEqual([]);
  });

  it("refuses two moves sharing a source, a destination, or a chain or swap between them", () => {
    for (const moves of [
      [move("a.ts", "b.ts"), move("a.ts", "c.ts")],
      [move("a.ts", "c.ts"), move("b.ts", "c.ts")],
      [move("a.ts", "b.ts"), move("b.ts", "c.ts")],
      [move("a.ts", "b.ts"), move("b.ts", "a.ts")],
    ]) {
      expect(moveRefusals(moves, WORKTREE)).toEqual(
        expect.arrayContaining([expect.stringContaining("an end of more than one move")]),
      );
    }
  });
});

describe("resolveMoves", () => {
  it("gives the moves as git will act on them", () => {
    expect(resolveMoves([{ from: `${WORKTREE}/src/a.tsx`, to: "./src/a.ts" }], WORKTREE)).toEqual([
      { from: "src/a.tsx", to: "src/a.ts" },
    ]);
  });

  it("is null when any move would be refused", () => {
    expect(resolveMoves([{ from: "a.ts", to: "a.ts" }], WORKTREE)).toBeNull();
  });
});

describe("applyMoves", () => {
  function runner(reply: (argv: readonly string[]) => Partial<CommandResult>): {
    readonly commands: CommandRunner;
    readonly calls: (readonly string[])[];
  } {
    const calls: (readonly string[])[] = [];
    return {
      calls,
      commands: {
        run: (argv) => {
          calls.push([...argv]);
          return Promise.resolve({ ...OK, ...reply(argv) });
        },
      },
    };
  }
  const tracked = (argv: readonly string[]): Partial<CommandResult> =>
    argv.includes("ls-files") ? { stdout: `${argv.at(-1) ?? ""}${NUL}` } : {};

  it("checks each source and moves it, in order, with every path after a --", async () => {
    const { commands, calls } = runner(tracked);
    const moves = [
      { from: "src/a.tsx", to: "src/a.ts" },
      { from: "-x.tsx", to: "-x.ts" },
    ];

    const result = await applyMoves(commands, WORKTREE, moves, 1000);

    expect(result).toEqual({ outcome: "moved", moves });
    expect(calls).toEqual([
      ["git", "--literal-pathspecs", "-C", WORKTREE, "ls-files", "-z", "--", "src/a.tsx"],
      ["git", "-C", WORKTREE, "mv", "--", "src/a.tsx", "src/a.ts"],
      ["git", "--literal-pathspecs", "-C", WORKTREE, "ls-files", "-z", "--", "-x.tsx"],
      ["git", "-C", WORKTREE, "mv", "--", "-x.tsx", "-x.ts"],
    ]);
  });

  it("refuses a source git does not list as exactly that one file: a directory, or untracked", async () => {
    for (const listed of ["", `src/a.tsx/inner.ts${NUL}`, `src/a.tsx${NUL}src/a.tsx.bak${NUL}`]) {
      const { commands, calls } = runner((argv) =>
        argv.includes("ls-files") ? { stdout: listed } : {},
      );

      const result = await applyMoves(
        commands,
        WORKTREE,
        [{ from: "src/a.tsx", to: "src/a.ts" }],
        1000,
      );

      expect(result).toMatchObject({ outcome: "refused", done: 0 });
      expect(calls.some((argv) => argv.includes("mv"))).toBe(false);
    }
  });

  it("stops at the first refusal, in git's own words, and says how many moves it made", async () => {
    const { commands, calls } = runner((argv) =>
      argv.includes("mv") && argv.includes("src/b.tsx")
        ? { exitCode: 128, stderr: "fatal: destination exists, source=src/b.tsx" }
        : tracked(argv),
    );
    const moves = [
      { from: "src/a.tsx", to: "src/a.ts" },
      { from: "src/b.tsx", to: "src/b.ts" },
      { from: "src/c.tsx", to: "src/c.ts" },
    ];

    const result = await applyMoves(commands, WORKTREE, moves, 1000);

    expect(result).toEqual({
      outcome: "refused",
      reason:
        "src/b.tsx → src/b.ts: git mv refused — exit 128: fatal: destination exists, source=src/b.tsx",
      done: 1,
    });
    expect(calls.some((argv) => argv.includes("src/c.tsx"))).toBe(false);
  });
});

describe("moveViolations", () => {
  const moved = move("src/a.tsx", "src/a.ts");

  it("finds nothing wrong with a rename, or with a deletion and an addition git did not pair", () => {
    expect(moveViolations([moved], [nameStatus("R", "src/a.ts", "src/a.tsx")])).toEqual([]);
    expect(
      moveViolations([moved], [nameStatus("D", "src/a.tsx"), nameStatus("A", "src/a.ts")]),
    ).toEqual([]);
  });

  it("names a moved file that is back at its old path", () => {
    expect(
      moveViolations([moved], [nameStatus("A", "src/a.ts"), nameStatus("M", "src/a.tsx")]),
    ).toEqual([
      expect.stringMatching(
        /^src\/a\.tsx: the harness moved this file to src\/a\.ts, and it is back/u,
      ),
    ]);
  });

  it("names a moved file that is no longer at its new path", () => {
    expect(moveViolations([moved], [nameStatus("D", "src/a.tsx")])).toEqual([
      expect.stringMatching(/^src\/a\.ts: the harness moved src\/a\.tsx here/u),
    ]);
  });
});
