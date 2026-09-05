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
 * ## Two toolchains, chosen by the base
 *
 * Node (`package.json`) and Maven (`pom.xml`). The base decides which applies.
 * A base carrying both is refused rather than resolved — see ARCHITECTURE.md
 * §15 for that argument and for why Maven has no install step, no typecheck
 * step, no lint step, and exactly one flag.
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
 * Package managers this service will execute, and the install each needs.
 *
 * An allowlist because this value decides which binary runs. `packageManager`
 * in a manifest is a string like `pnpm@11.20.0`; treating the part before the
 * `@` as a command name without checking it against a fixed set would make
 * "what do we execute" a property of a file, which is the wrong place for it.
 *
 * These are the arguments only. The command in front of them comes from
 * `invocationOf`, because it depends on whether a version was declared.
 */
const PACKAGE_MANAGERS: Record<string, readonly string[]> = {
  pnpm: ["install", "--frozen-lockfile"],
  npm: ["ci"],
  yarn: ["install", "--immutable"],
};

const DEFAULT_PACKAGE_MANAGER = "pnpm";

/**
 * Versions this service will hand to corepack. **Plain semver and nothing else.**
 *
 * This is the guard that makes honouring the declared version safe rather than
 * merely useful, and it is narrow on purpose. Corepack resolves far more than
 * version numbers: `pnpm@https://example.com/x.tgz` is valid input to it and
 * means "download this tarball and execute it". The manifest is a file in a
 * repository a solve run has already been allowed to check out, so a value that
 * reaches corepack unvalidated is arbitrary code execution sourced from the
 * thing being verified.
 *
 * Ranges and dist-tags (`^9`, `latest`) are refused as well as URLs, for a
 * different reason: they are not reproducible. The point of reading the field
 * at all is to run the exact toolchain the repository pins, and a range makes
 * "which pnpm ran" a fact about the day rather than about the manifest.
 *
 * The optional `+sha…` suffix is corepack's integrity hash and is allowed
 * precisely because it narrows what can be fetched.
 */
const PACKAGE_MANAGER_VERSION = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+sha\d+\.[0-9a-f]+)?$/;

export interface PackageManager {
  readonly name: string;
  /** `null` means the manifest declared no version, so `PATH` decides. */
  readonly version: string | null;
}

/**
 * How to invoke this package manager: the argv prefix, and nothing after it.
 *
 * A declared version goes through `corepack`, which is Node's own shim for
 * exactly this and is why the version does not have to be installed first. No
 * declared version means the bare name, resolved from `PATH` — see
 * `versionNote` for why that case is reported rather than silently accepted.
 */
export function invocationOf(manager: PackageManager): readonly string[] {
  return manager.version === null
    ? [manager.name]
    : ["corepack", `${manager.name}@${manager.version}`];
}

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

/** Which build system the base declares. Never inferred from file contents. */
export type Toolchain = "node" | "maven";

/** The manifest that selects each toolchain, read from the base ref. */
const MANIFESTS: Record<Toolchain, string> = {
  node: "package.json",
  maven: "pom.xml",
};

/** Maven, as a PATH-resolved name. The repo's own `mvnw` is never executed. */
const MAVEN = "mvn";

/**
 * One manifest's presence in the base tree.
 *
 * `absent` and `unreadable` are separate because they lead to different
 * refusals: no recognised manifest is a fact about the repository, while a read
 * that timed out is a fact about this machine. Only the timeout can be told
 * apart mechanically — `git show` exits non-zero both for a path that is not in
 * the tree and for a ref that does not exist, so a wrong base ref reads as both
 * manifests absent, and that refusal names the ref for exactly this reason.
 */
type Shown =
  | { readonly kind: "found"; readonly raw: string }
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable" };

export interface Step {
  readonly name: StepName;
  readonly argv: readonly string[];
  /**
   * Charged the install budget rather than the step budget.
   *
   * True when the step resolves its own dependencies, so its first run on a
   * machine is dominated by downloading rather than by the work being measured.
   */
  readonly cold: boolean;
}

export interface VerificationPlan {
  /** `null` when the toolchain has no separate install phase. */
  readonly install: readonly string[] | null;
  readonly steps: readonly Step[];
  readonly toolchain: Toolchain;
  /** Appended to a refusal so it says which toolchain produced it. */
  readonly note: string;
}

/**
 * What to append to an install refusal about where the toolchain came from.
 *
 * An undeclared version is not an error — most repositories do not pin one, and
 * refusing them all would mean verifying nothing. But it is the single most
 * likely explanation for an install that dies on a repository whose own CI is
 * green, so the refusal says so instead of leaving a package manager's stack
 * trace to be interpreted. The first time this mattered, the diagnosis took
 * four runs and a detour through someone else's `package.json`.
 */
export function versionNote(manager: PackageManager): string {
  return manager.version === null
    ? ` — note the manifest pins no \`packageManager\` version, so this ran whichever ${manager.name} is on PATH; if the repository's CI pins one, that mismatch is the first thing to check`
    : ` — using the declared ${manager.name}@${manager.version}`;
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

/**
 * The declared package manager and version, or the default. Never unvetted.
 *
 * The version used to be parsed and thrown away, which made "which pnpm runs" a
 * property of whatever was on `PATH` on the day. That is how the first real
 * solve run died: the pilot repository's lockfile was written by pnpm 9 and the
 * machine had pnpm 11, which no longer reads the `pnpm.overrides` block the
 * lockfile was generated from, so install refused and no verdict was reached.
 */
export function packageManagerOf(raw: string): PackageManager | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const declared = (parsed as { packageManager?: unknown } | null)?.packageManager;
  if (declared === undefined) {
    return { name: DEFAULT_PACKAGE_MANAGER, version: null };
  }
  if (typeof declared !== "string") {
    return null;
  }
  // The *first* `@`, which is what `name@version` means. Being straight about
  // this one: switching it to `lastIndexOf` kills no test and cannot while the
  // other two checks hold, because every string the two readings disagree about
  // puts an `@` in the name half and no allowlisted name contains one. So it is
  // a backstop against a future edit loosening the allowlist, not active
  // defence — recorded as such rather than dressed up, same as the whole-string
  // ref check in `worktree.ts`.
  const at = declared.indexOf("@");
  const name = at === -1 ? declared : declared.slice(0, at);
  const version = at === -1 ? null : declared.slice(at + 1);
  // `Object.hasOwn` and not `in`. `in` walks the prototype chain, so a manifest
  // declaring `constructor@1` or `toString@1` would satisfy `name in
  // PACKAGE_MANAGERS` and be treated as an allowed package manager — an
  // allowlist that admits three names it was never given.
  if (!Object.hasOwn(PACKAGE_MANAGERS, name)) {
    return null;
  }
  if (version !== null && !PACKAGE_MANAGER_VERSION.test(version)) {
    return null;
  }
  return { name, version };
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

  const show = async (path: string): Promise<Shown> => {
    const shown = await runner.run(["git", "-C", repoPath, "show", `${baseRef}:${path}`], {
      cwd: repoPath,
      timeoutMs: stepTimeoutMs,
    });
    if (shown.timedOut) {
      return { kind: "unreadable" };
    }
    return shown.exitCode === 0 ? { kind: "found", raw: shown.stdout } : { kind: "absent" };
  };

  const node = await show(MANIFESTS.node);
  const maven = await show(MANIFESTS.maven);

  if (node.kind === "unreadable" || maven.kind === "unreadable") {
    return {
      outcome: "refused",
      reason: `could not read the base manifests at ${baseRef} — the read timed out, which is a fact about this machine and not about the change`,
    };
  }

  // Both is a contradiction, not a preference. Two build systems disagree about
  // what passing means here, and whichever were checked first would win — which
  // would make the verdict a property of this function's line order.
  if (node.kind === "found" && maven.kind === "found") {
    return {
      outcome: "refused",
      reason: `the base has both ${MANIFESTS.node} and ${MANIFESTS.maven} — two toolchains define what passing means here, and choosing one would be a guess`,
    };
  }
  if (node.kind === "found") {
    return nodePlan(node.raw);
  }
  if (maven.kind === "found") {
    return await mavenPlan(runner, maven.raw, request);
  }
  return {
    outcome: "refused",
    reason: `could not read ${MANIFESTS.node} or ${MANIFESTS.maven} at ${baseRef} — either this repository's build is one this service does not recognise, or the base ref is wrong, and \`git show\` reports both the same way`,
  };
}

/**
 * Maven's plan: one step, cold, and only after proving Maven exists.
 *
 * The `mvn -v` probe is the point of this being separate. Without it an absent
 * Maven makes the test step exit non-zero, which is reported as `failed` — the
 * harness's own missing dependency, printed as a verdict about the model's code.
 */
async function mavenPlan(
  runner: CommandRunner,
  raw: string,
  request: Pick<VerifyRequest, "repoPath" | "baseRef" | "stepTimeoutMs">,
): Promise<PlanResult> {
  // The same rule the Node manifest gets: unreadable is not the same as
  // untested, so it refuses rather than proceeding.
  if (!raw.includes("<project")) {
    return {
      outcome: "refused",
      reason: `the base ${MANIFESTS.maven} does not look like a POM — that is a repository this cannot make a statement about, not one without tests`,
    };
  }

  const probed = await runner.run([MAVEN, "-v"], {
    cwd: request.repoPath,
    timeoutMs: request.stepTimeoutMs,
  });
  if (probed.timedOut || probed.exitCode !== 0) {
    return {
      outcome: "refused",
      reason: `no working ${MAVEN} on PATH, so a Java build cannot be verified here — this is the harness missing a tool, not the change being wrong`,
    };
  }

  return {
    outcome: "planned",
    plan: {
      install: null,
      steps: [{ name: "test", argv: [MAVEN, "-B", "test"], cold: true }],
      toolchain: "maven",
      note: ` — using ${MAVEN} from PATH; the repository's own wrapper is deliberately not executed, so a version mismatch with its CI is the first thing to check`,
    },
  };
}

/** Node's plan: discovered scripts, run through the declared package manager. */
function nodePlan(raw: string): PlanResult {
  const scripts = scriptsOf(raw);
  if (scripts === null) {
    return {
      outcome: "refused",
      reason:
        "the base manifest could not be parsed — that is a repository this cannot make a statement about, not one without tests",
    };
  }

  const manager = packageManagerOf(raw);
  if (manager === null) {
    return {
      outcome: "refused",
      reason: "the base manifest declares a package manager this service will not execute",
    };
  }

  const invocation = invocationOf(manager);

  const steps: Step[] = [];
  for (const step of STEPS) {
    const found = step.scripts.find((name) => Object.hasOwn(scripts, name));
    if (found !== undefined) {
      steps.push({ name: step.name, argv: [...invocation, "run", found], cold: false });
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
    plan: {
      install: [...invocation, ...(PACKAGE_MANAGERS[manager.name] ?? [])],
      steps,
      toolchain: "node",
      note: versionNote(manager),
    },
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

export type BaseCheck =
  /** The repository's own build passes here. A later red is about the change. */
  | { readonly outcome: "usable" }
  /** It does not, and nothing has been changed yet, so nothing is to blame. */
  | {
      readonly outcome: "unusable";
      readonly reason: string;
      readonly verification: VerificationResult;
    };

/**
 * Runs the plan against the worktree **before the model has touched it**.
 *
 * Added 2026-09-05, from a run that got the verdict wrong. `verify` correctly
 * reports "a step ran and did not pass" as `failed`, and `failed` means *the
 * change is bad* — which is only true if the step would have passed without the
 * change. Nothing checked that, so the first Java solve was booked as a broken
 * fix when the truth was that this repository cannot build in a git worktree at
 * all: `git-commit-id-plugin` 4.9.10 binds to `initialize` and cannot read a
 * linked worktree's `.git`, which is a *file* (`gitdir: …`) and not a directory.
 * The build died eleven lines in, no test ran, and the model's diff was never
 * compiled, let alone evaluated. Same Maven, same JDK, same plugin: green in
 * the main checkout, red in the worktree.
 *
 * So `failed` was a statement about code nothing had read. That is the precise
 * failure the three-outcome type exists to prevent, arriving through the one
 * door it did not cover — not a mislabelled outcome, but a missing premise.
 *
 * **Both non-passing outcomes become `unusable`, and the distinction is kept
 * anyway.** A base that fails and a base that refuses lead to the same
 * decision — do not run the model — but not to the same sentence, so the whole
 * `VerificationResult` is carried out rather than a boolean.
 *
 * ## Why this is cheaper than it looks
 *
 * It runs before the model does. On a repository whose build does not work
 * here, this costs one build and saves an entire solve — strictly less than
 * the run it replaces. Only on a healthy base is it an extra pass, and there
 * the expensive half is shared: pnpm's store and Maven's `~/.m2` are warm the
 * second time, and `target/` is already populated.
 *
 * ARCHITECTURE.md §15 previously named this as a known limitation *stated
 * rather than solved*, on the grounds that it doubles the runtime of every
 * solve. That reasoning was written for Node, where the base check is install
 * plus three steps. It did not survive contact with a base that could not run
 * at all, and the trade it described — double runtime — turns out to be the
 * wrong axis: the cost is not runtime, it is that without this the verdict
 * does not mean what the type says it means.
 */
export async function verifyBase(
  runner: CommandRunner,
  request: VerifyRequest,
): Promise<BaseCheck> {
  const verification = await verify(runner, request);
  if (verification.outcome === "passed") {
    return { outcome: "usable" };
  }

  const detail = verification.reason;
  return {
    outcome: "unusable",
    verification,
    reason:
      verification.outcome === "failed"
        ? `the repository's own build does not pass in a fresh worktree, before anything was changed — ${detail}. This is a fact about the repository or this harness, not about any fix`
        : `the repository's build could not be run here at all — ${detail}`,
  };
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
 * **`failed` is only true relative to a base that passes.** `verifyBase` above
 * establishes that premise; without it this function's `failed` is an
 * unsupported claim rather than a verdict.
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

  // Skipped entirely when the toolchain has no install phase, rather than run
  // as a no-op: an "install" line in the artifact that never ran is a step a
  // reader would count as evidence.
  if (plan.install !== null) {
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
      //
      // The last of the install's own output is quoted, and it was missing here
      // until a live run went without it. The refusal said `exit 1` and named
      // the unpinned `packageManager` as a thing to check, which is a
      // hypothesis; the install had printed `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`,
      // which is the answer. `results` already held it and this branch returned
      // before anyone could read it — the output was captured and then thrown
      // away, which is the most annoying shape a diagnostic bug takes.
      const said = tail(installed);
      return {
        outcome: "refused",
        reason:
          `dependency install did not complete, so no step ran ` +
          `(${installed.timedOut ? "timed out" : `exit ${String(installed.exitCode)}`})` +
          `${plan.note}` +
          `${said === "" ? "" : ` — it said: ${said}`}`,
      };
    }
  }

  for (const step of plan.steps) {
    // A cold step resolves its own dependencies, so charging it the step budget
    // would time out the first Java build on a machine and report that as the
    // change being wrong.
    const budget = step.cold ? installTimeoutMs : stepTimeoutMs;
    const result = await runner.run(step.argv, { cwd: worktreePath, timeoutMs: budget });
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
        // The note rides on the cold step because that step is also the
        // install, so there is no install refusal to carry it. Without this,
        // Maven's "the wrapper was not executed" hint could never be printed.
        reason:
          `${step.name} did not pass (${result.timedOut ? "timed out" : `exit ${String(result.exitCode)}`})` +
          `${step.cold ? plan.note : ""}`,
      };
    }
  }

  logger.info("solve.verify.passed", { steps: results.map((step) => step.name) });
  return { outcome: "passed", steps: results };
}
