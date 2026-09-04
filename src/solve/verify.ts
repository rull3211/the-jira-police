/**
 * Mechanical verification of a solve run.
 *
 * The model is never asked whether the tests passed. This module runs them and
 * reads exit codes, because "did it work" is the one question the thing being
 * judged must not answer about itself.
 *
 * ## Discovery comes from the base, and that is not enough on its own
 *
 * The vault records no test or build command, so the commands have to be
 * discovered from the repository. They are read from `git show <base>:package.json`
 * — the pristine manifest — never from the worktree, so that a run which edited
 * `package.json` cannot change which commands are considered proof.
 *
 * Discovery from the base is necessary and **insufficient**, which is worth
 * being blunt about because it is easy to stop at. Knowing the base said
 * `"test": "vitest run"` does not help if the command executes in a worktree
 * where `package.json` now says something else: the package manager reads the
 * manifest on disk, not the one we consulted. So there are two halves, and both
 * are here:
 *
 *   1. discover from the base (`discoverPlan`), and
 *   2. refuse to run at all unless the files that define passing are still
 *      byte-identical to the base (`unverifiableChanges`).
 *
 * The second half shares `VERIFICATION_PATHS` with the diff gate on purpose.
 * The diff gate refuses such a diff *after* the fact; this refuses to produce a
 * verdict about it at all. Two mechanisms, one list — and if the list grows, it
 * grows for both.
 *
 * ## Known limitation, deliberately not solved here
 *
 * If the base itself is already failing lint or typecheck, every run on that
 * repository fails verification through no fault of the solver. Proving that
 * would mean verifying the base too, doubling the runtime of every solve. The
 * cheaper mitigation is to keep the per-step results, which the caller reports,
 * so a step that fails identically on every ticket is visible as the repository
 * problem it is rather than looking like a run of bad luck.
 */

import { logger } from "../logger.ts";
import { VERIFICATION_PATHS } from "./diff-gate.ts";
import type { CommandRunner } from "./worktree.ts";

/**
 * Package managers this service will execute, and the invocation each needs.
 *
 * An allowlist because this value decides which binary runs. `packageManager`
 * in a manifest is a string like `pnpm@11.20.0`; treating the part before the
 * `@` as a command name without checking it against a fixed set would make
 * "what do we execute" a property of a file, which is the wrong place for it.
 */
const PACKAGE_MANAGERS: Record<string, readonly string[]> = {
  pnpm: ["pnpm", "install", "--frozen-lockfile"],
  npm: ["npm", "ci"],
  yarn: ["yarn", "install", "--immutable"],
};

const DEFAULT_PACKAGE_MANAGER = "pnpm";

/**
 * Steps, cheapest first, and the script names each will accept.
 *
 * The names are literals from this table, never keys read out of the manifest.
 * That distinction is the reason nothing here needs to sanitise a script name:
 * the only strings that can become arguments are the ones written below.
 *
 * `test` is required. The other two run when the repository has them — absence
 * is a repository that does not typecheck or lint, not a run that skipped it.
 */
const STEPS = [
  { name: "typecheck", scripts: ["check-types", "typecheck"] },
  { name: "lint", scripts: ["lint"] },
  { name: "test", scripts: ["test"] },
] as const;

export type StepName = (typeof STEPS)[number]["name"];

export interface Step {
  readonly name: StepName;
  readonly argv: readonly string[];
}

export interface VerificationPlan {
  /** Fresh worktrees have no `node_modules`, so this always runs first. */
  readonly install: readonly string[];
  readonly steps: readonly Step[];
}

export interface StepResult {
  readonly name: StepName | "install";
  readonly passed: boolean;
  readonly exitCode: number;
  readonly timedOut: boolean;
  /** Tail of the output, for the artifact. Bounded; this ends up in a report. */
  readonly output: string;
}

export type PlanResult =
  | { readonly outcome: "planned"; readonly plan: VerificationPlan }
  | { readonly outcome: "refused"; readonly reason: string };

export type VerificationResult =
  /** Every step ran and passed. The only outcome that may become a PR. */
  | { readonly outcome: "passed"; readonly steps: readonly StepResult[] }
  /** A step ran and did not pass. A verdict about the code. */
  | { readonly outcome: "failed"; readonly steps: readonly StepResult[]; readonly reason: string }
  /** No verdict was reached. Not a statement about the code at all. */
  | { readonly outcome: "refused"; readonly reason: string };

export interface VerifyRequest {
  readonly repoPath: string;
  readonly worktreePath: string;
  readonly baseRef: string;
  readonly stepTimeoutMs: number;
  readonly installTimeoutMs: number;
}

const MAX_OUTPUT = 4000;

/**
 * The `-z` record separator, as an escape rather than the byte itself.
 *
 * Written this way so the file stays plain text: a literal NUL in source makes
 * `grep` treat the whole file as binary and go quiet, which is a bad property
 * for the one module whose reason to exist is being auditable. The `\u0000`
 * form rather than `\0` because `\0` followed by a digit is an octal escape and
 * a syntax error in a strict-mode module.
 */
const NUL = "\u0000";

function tail(result: { stdout: string; stderr: string }): string {
  const combined = `${result.stdout}\n${result.stderr}`.trim();
  return combined.length <= MAX_OUTPUT ? combined : combined.slice(-MAX_OUTPUT);
}

/**
 * The manifest's `scripts` map, or `null` if this is not a manifest we can read.
 *
 * Everything unexpected collapses to `null` and the caller refuses. A manifest
 * that fails to parse is not a repository without tests; it is a repository
 * this cannot make a statement about, and those must not produce the same
 * outcome.
 */
function scriptsOf(raw: string): Record<string, string> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const scripts = (parsed as { scripts?: unknown }).scripts;
  if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) {
    return null;
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(scripts)) {
    if (typeof value === "string") {
      out[key] = value;
    }
  }
  return out;
}

/** The declared package manager, or the default. Never an unvetted name. */
export function packageManagerOf(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const declared = (parsed as { packageManager?: unknown } | null)?.packageManager;
  if (declared === undefined) {
    return DEFAULT_PACKAGE_MANAGER;
  }
  if (typeof declared !== "string") {
    return null;
  }
  const name = declared.split("@")[0] ?? "";
  // `Object.hasOwn` and not `in`. `in` walks the prototype chain, so a manifest
  // declaring `constructor@1` or `toString@1` would satisfy `name in
  // PACKAGE_MANAGERS` and be treated as an allowed package manager — an
  // allowlist that admits three names it was never given.
  return Object.hasOwn(PACKAGE_MANAGERS, name) ? name : null;
}

/**
 * Reads the commands out of the pristine manifest.
 *
 * `git show <base>:package.json` and not the worktree's copy — the whole point.
 * The base ref is the same one the worktree was cut from, so these are the
 * commands the repository defined before the run touched anything.
 */
export async function discoverPlan(
  runner: CommandRunner,
  request: Pick<VerifyRequest, "repoPath" | "baseRef" | "stepTimeoutMs">,
): Promise<PlanResult> {
  const { repoPath, baseRef, stepTimeoutMs } = request;

  const shown = await runner.run(["git", "-C", repoPath, "show", `${baseRef}:package.json`], {
    cwd: repoPath,
    timeoutMs: stepTimeoutMs,
  });
  if (shown.timedOut || shown.exitCode !== 0) {
    return { outcome: "refused", reason: `could not read ${baseRef}:package.json` };
  }

  const scripts = scriptsOf(shown.stdout);
  if (scripts === null) {
    return {
      outcome: "refused",
      reason:
        "the base manifest could not be parsed — that is a repository this cannot make a statement about, not one without tests",
    };
  }

  const manager = packageManagerOf(shown.stdout);
  if (manager === null) {
    return {
      outcome: "refused",
      reason: "the base manifest declares a package manager this service will not execute",
    };
  }

  const steps: Step[] = [];
  for (const step of STEPS) {
    const found = step.scripts.find((name) => Object.hasOwn(scripts, name));
    if (found !== undefined) {
      steps.push({ name: step.name, argv: [manager, "run", found] });
    }
  }

  if (!steps.some((step) => step.name === "test")) {
    return {
      outcome: "refused",
      reason:
        "the base manifest defines no test script — with nothing to verify against, a passing run and an untested one are indistinguishable",
    };
  }

  return {
    outcome: "planned",
    plan: { install: PACKAGE_MANAGERS[manager] ?? [], steps },
  };
}

/**
 * Paths changed against the base that would invalidate the verdict.
 *
 * Uses `--name-only -z` for the same reason the diff gate uses `-z`: without
 * it, git quotes and escapes unusual filenames, and a filename containing a
 * newline becomes two entries.
 */
export async function unverifiableChanges(
  runner: CommandRunner,
  request: Pick<VerifyRequest, "worktreePath" | "baseRef" | "stepTimeoutMs">,
): Promise<readonly string[] | null> {
  const { worktreePath, baseRef, stepTimeoutMs } = request;

  const diffed = await runner.run(
    ["git", "-C", worktreePath, "diff", "--name-only", "-z", baseRef, "--"],
    { cwd: worktreePath, timeoutMs: stepTimeoutMs },
  );
  if (diffed.timedOut || diffed.exitCode !== 0) {
    return null;
  }

  const paths = diffed.stdout.split(NUL).filter((path) => path !== "");
  return paths.filter((path) => VERIFICATION_PATHS.some((rule) => rule.pattern.test(path)));
}

/**
 * Runs the plan against the worktree and returns what actually happened.
 *
 * Three outcomes, and keeping `refused` apart from `failed` is the point of the
 * type. "The tests failed" is a fact about the code the run produced; "the
 * manifest was edited" or "install died" is the harness declining to have an
 * opinion. Collapsing them would let a broken harness read as a broken fix, and
 * a solver would then be judged on evidence that was never gathered.
 *
 * A timed-out step is a **failure**, not a refusal. It ran; it did not pass in
 * the time allowed; and a hang is a plausible thing for a bad fix to cause. The
 * alternative — inconclusive — is the reading that lets an infinite loop
 * through.
 */
export async function verify(
  runner: CommandRunner,
  request: VerifyRequest,
): Promise<VerificationResult> {
  const { worktreePath, stepTimeoutMs, installTimeoutMs } = request;

  const tainted = await unverifiableChanges(runner, request);
  if (tainted === null) {
    return { outcome: "refused", reason: "could not determine what the run changed" };
  }
  if (tainted.length > 0) {
    return {
      outcome: "refused",
      reason: `the run edited files that define what passing means (${tainted.join(", ")}) — any verdict produced here would be one it wrote the rules for`,
    };
  }

  const planned = await discoverPlan(runner, request);
  if (planned.outcome === "refused") {
    return planned;
  }
  const { plan } = planned;

  const results: StepResult[] = [];

  const installed = await runner.run(plan.install, {
    cwd: worktreePath,
    timeoutMs: installTimeoutMs,
  });
  results.push({
    name: "install",
    passed: !installed.timedOut && installed.exitCode === 0,
    exitCode: installed.exitCode,
    timedOut: installed.timedOut,
    output: tail(installed),
  });
  if (installed.timedOut || installed.exitCode !== 0) {
    // Not a failure: nothing was verified, so there is nothing to have failed.
    return {
      outcome: "refused",
      reason: `dependency install did not complete, so no step ran (${installed.timedOut ? "timed out" : `exit ${String(installed.exitCode)}`})`,
    };
  }

  for (const step of plan.steps) {
    const result = await runner.run(step.argv, { cwd: worktreePath, timeoutMs: stepTimeoutMs });
    const passed = !result.timedOut && result.exitCode === 0;
    results.push({
      name: step.name,
      passed,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      output: tail(result),
    });
    if (!passed) {
      logger.info("solve.verify.failed", { step: step.name, timedOut: result.timedOut });
      return {
        outcome: "failed",
        steps: results,
        reason: `${step.name} did not pass (${result.timedOut ? "timed out" : `exit ${String(result.exitCode)}`})`,
      };
    }
  }

  logger.info("solve.verify.passed", { steps: results.map((step) => step.name) });
  return { outcome: "passed", steps: results };
}
