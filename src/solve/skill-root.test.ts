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
  // Listed rather than named (roots are uniquely suffixed) and unlocked via `removeSkillRoot`
  // rather than `rm(parent, { force: true })` — `force` suppresses "not there", not EACCES.
  for (const entry of await readdir(parent)) {
    await removeSkillRoot(join(parent, entry));
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
    // Every pass sends `/agent-solve` as its first prompt line; if this path is wrong the slash command resolves to nothing.
    const info = await stat(sourceSkillDirectory());
    expect(info.isDirectory()).toBe(true);
    await expect(readFile(join(sourceSkillDirectory(), "SKILL.md"), "utf8")).resolves.toContain(
      `name: ${SKILL_NAME}`,
    );
  });

  it("documents the capability the prompt hands the pass", async () => {
    // §8 once had passes claiming they "cannot see" other repositories while the prompt listed checkouts they could see; the heading (§0a) and section marker (§0) are the two halves that can rot apart.
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
    // SKILL.md defers the actual contracts to SOLVE_INSTRUCTIONS.md; staging only the frontmatter's entry point would leave every cross-reference dangling.
    const instructions = await readFile(
      join(skillIn(await staged()), "SOLVE_INSTRUCTIONS.md"),
      "utf8",
    );
    for (const pass of ["--recon", "--fix", "--simplify", "--review"]) {
      expect(instructions).toContain(`(\`${pass}\`)`);
    }
  });

  it("contains the skill and nothing else", async () => {
    // `--add-dir` grants write to a pass that pre-approves `Write`, so whatever is in here is writable-in-principle by the solver.
    const root = await staged();
    expect(await readdir(root)).toEqual([".claude"]);
    expect(await readdir(join(root, ".claude"))).toEqual(["skills"]);
    expect(await readdir(join(root, ".claude", "skills"))).toEqual([SKILL_NAME]);
  });

  it("leaves nothing writable, directories included", async () => {
    // Files-only would still let a `fix` pass unlink and replace the skill, since it's the directory's write bit that governs that on POSIX.
    const root = await staged();
    const dir = skillIn(root);

    expect(await writable(join(dir, "SKILL.md"))).toBe(false);
    expect(await writable(join(dir, "SOLVE_INSTRUCTIONS.md"))).toBe(false);
    expect(await writable(dir)).toBe(false);
    expect(await writable(root)).toBe(false);
  });

  it("actually refuses a write, not just the permission bit", async () => {
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
    // Without the pre-clear, the second run's `cp` hits EACCES on the first run's locked-down copy.
    await staged("SSX-1");
    await expect(staged("SSX-1")).resolves.toContain("SSX-1-skill");
  });

  it("refuses instead of throwing when it cannot stage", async () => {
    // Forced through an unwritable parent, since the source skill genuinely exists in this repository.
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
