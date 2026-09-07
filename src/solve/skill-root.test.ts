import {
  access,
  chmod,
  constants,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { READ_SCOPE_HEADING } from "./read-scope.ts";
import {
  prepareSkillRoot,
  removeSkillRoot,
  SKILL_NAME,
  sourceSkillDirectory,
} from "./skill-root.ts";

let parent: string;

beforeEach(async () => {
  parent = await mkdtemp(join(tmpdir(), "skill-root-test-"));
});

afterEach(async () => {
  // Read-only directories cannot be removed until they are unlocked, which is
  // what `removeSkillRoot` is for. Using it here means the cleanup path is
  // exercised by every test in this file, not only the two that assert on it.
  for (const key of ["SSX-1", "SSX-2"]) {
    await removeSkillRoot(join(parent, `${key}-skill`));
  }
  await rm(parent, { recursive: true, force: true });
});

/** Stages the skill, or fails the test with the refusal's own sentence. */
async function staged(issueKey = "SSX-1"): Promise<string> {
  const result = await prepareSkillRoot(parent, issueKey);
  if (result.outcome !== "prepared") {
    throw new Error(result.reason);
  }
  return result.path;
}

/** The directory `--add-dir` receives, resolved to the skill inside it. */
function skillIn(root: string): string {
  return join(root, ".claude", "skills", SKILL_NAME);
}

/** Writable? Answered by the filesystem, not by inspecting a mode integer. */
async function writable(path: string): Promise<boolean> {
  try {
    await access(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

describe("sourceSkillDirectory", () => {
  it("points at a skill that is actually installed", async () => {
    // THE ONE THAT MATTERS, and the reason this module exists. Every pass sends
    // `/agent-solve` as its first prompt line; if this path is wrong the slash
    // command resolves to nothing. Probed 2026-09-04 from a directory without
    // the skill: `Unknown command: /agent-solve`. So this is the unit-test
    // shadow of a real failure that had already shipped into `buildSolveArgs`.
    const info = await stat(sourceSkillDirectory());
    expect(info.isDirectory()).toBe(true);
    await expect(readFile(join(sourceSkillDirectory(), "SKILL.md"), "utf8")).resolves.toContain(
      `name: ${SKILL_NAME}`,
    );
  });

  it("documents the capability the prompt hands the pass", async () => {
    // The prompt tells a pass to follow this contract *exactly*, so a capability
    // the prompt grants and the contract does not describe is not a gap, it is a
    // contradiction — and the contract wins, because it is the document the pass
    // was told to obey. That is not hypothetical: §8 spent a day instructing
    // passes to state plainly that they "cannot see" other repositories, while
    // the prompt above it listed the checkouts they could see.
    //
    // Two assertions for the two halves that can rot apart. The heading is how
    // §0a says which block of the prompt it is about, and it is a string literal
    // on the other side. The section marker is what SKILL.md's summary and §0's
    // inventory both point at.
    const instructions = await readFile(
      join(sourceSkillDirectory(), "SOLVE_INSTRUCTIONS.md"),
      "utf8",
    );

    expect(instructions).toContain(READ_SCOPE_HEADING);
    expect(instructions).toContain("### 0a.");
  });
});

describe("prepareSkillRoot", () => {
  it("stages the skill where Claude Code will look for it", async () => {
    // The layout is not a preference — discovery searches `<dir>/.claude/skills`.
    await expect(readFile(join(skillIn(await staged()), "SKILL.md"), "utf8")).resolves.toContain(
      `name: ${SKILL_NAME}`,
    );
  });

  it("copies the whole skill, not just its entry point", async () => {
    // SKILL.md defers the actual contracts to SOLVE_INSTRUCTIONS.md. Staging
    // only the file named in the frontmatter would give the model a document
    // whose every cross-reference is dangling. One assertion per pass, because
    // the argv is built once and all four resolve the same skill.
    const instructions = await readFile(
      join(skillIn(await staged()), "SOLVE_INSTRUCTIONS.md"),
      "utf8",
    );
    for (const pass of ["--recon", "--fix", "--simplify", "--review"]) {
      expect(instructions).toContain(`(\`${pass}\`)`);
    }
  });

  it("contains the skill and nothing else", async () => {
    // The whole point of staging rather than adding this repository. `--add-dir`
    // grants write to a pass that pre-approves `Write`, so whatever is in here
    // is writable-in-principle by the solver — the list must stay this short.
    const root = await staged();
    expect(await readdir(root)).toEqual([".claude"]);
    expect(await readdir(join(root, ".claude"))).toEqual(["skills"]);
    expect(await readdir(join(root, ".claude", "skills"))).toEqual([SKILL_NAME]);
  });

  it("leaves nothing writable, directories included", async () => {
    // THE GUARD. Files-only would still let a `fix` pass unlink the skill and
    // write its own in its place, because on POSIX it is the directory's write
    // bit that governs creating and removing entries. Asserted via access(W_OK)
    // rather than by reading st_mode, so the test measures the same thing the
    // kernel will tell the model.
    const root = await staged();
    const dir = skillIn(root);

    expect(await writable(join(dir, "SKILL.md"))).toBe(false);
    expect(await writable(join(dir, "SOLVE_INSTRUCTIONS.md"))).toBe(false);
    expect(await writable(dir)).toBe(false);
    expect(await writable(root)).toBe(false);
  });

  it("actually refuses a write, not just the permission bit", async () => {
    // The bit above says "no". This checks the filesystem agrees, which is the
    // claim `skill-root.ts` makes and the one a live probe confirmed against a
    // real model session on 2026-09-04 — both writes came back EACCES.
    const dir = skillIn(await staged());

    await expect(writeFile(join(dir, "SKILL.md"), "TAMPERED")).rejects.toThrow();
    await expect(writeFile(join(dir, "planted.md"), "TAMPERED")).rejects.toThrow();
    await expect(readFile(join(dir, "SKILL.md"), "utf8")).resolves.toContain(`name: ${SKILL_NAME}`);
  });

  it("gives two tickets two roots", async () => {
    // Shared mutable state between concurrent solves would mean one run's
    // cleanup deleting another run's skill mid-pass.
    expect(await staged("SSX-1")).not.toBe(await staged("SSX-2"));
  });

  it("replaces a read-only leftover from an interrupted run", async () => {
    // Without the pre-clear, the second run's `cp` hits EACCES on the first
    // run's locked-down copy and every subsequent solve for that ticket
    // refuses — a failure that would only appear after something crashed.
    await staged("SSX-1");
    await expect(staged("SSX-1")).resolves.toContain("SSX-1-skill");
  });

  it("refuses instead of throwing when it cannot stage", async () => {
    // A broken install should stop the run with a sentence, matching
    // `createWorktree`. Forced through an unwritable parent, since the source
    // skill genuinely exists in this repository.
    const outer = await mkdtemp(join(tmpdir(), "skill-root-locked-"));
    const locked = join(outer, "locked");
    await mkdir(locked, { recursive: true });
    await chmod(locked, 0o555);

    const result = await prepareSkillRoot(locked, "SSX-1");

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.reason).toContain("could not stage the skill");
    }

    await chmod(locked, 0o755);
    await rm(outer, { recursive: true, force: true });
  });
});

describe("removeSkillRoot", () => {
  it("removes a locked-down root", async () => {
    // `rm` cannot unlink inside a 0o555 directory, so without the unlock every
    // run would leave one of these behind for good.
    const root = await staged();

    await removeSkillRoot(root);

    await expect(stat(root)).rejects.toThrow();
  });

  it("is silent about a root that was never created", async () => {
    // It runs in a `finally`, including after a refusal that created nothing.
    // Throwing here would replace the real outcome with a cleanup error.
    await expect(removeSkillRoot(join(parent, "never-existed"))).resolves.toBeUndefined();
  });
});
