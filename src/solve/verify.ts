/**
 * Mechanical verification of a solve run: the model is never asked whether the tests passed, since
 * that is the one question the thing being judged must not answer about itself.
 *
 * Commands are discovered from the base manifest (`git show <base>:package.json`), never the
 * worktree, and `verify` refuses to run unless `VERIFICATION_PATHS` are unchanged from the base —
 * see architecture/solve.md §15 for why a base declaring both `package.json` and `pom.xml` is also refused.
 */

import { createLogger } from "../logger.ts";
import { VERIFICATION_PATHS } from "./diff-gate.ts";
import type { CommandRunner } from "./worktree.ts";

const log = createLogger("solve");

/** An allowlist: treating the manifest's `packageManager` name unchecked would make "what do we execute" a property of a file. */
const PACKAGE_MANAGERS: Record<string, readonly string[]> = {
  pnpm: ["install", "--frozen-lockfile"],
  npm: ["ci"],
  yarn: ["install", "--immutable"],
};

const DEFAULT_PACKAGE_MANAGER = "pnpm";

/**
 * Plain semver only: corepack accepts `pnpm@https://example.com/x.tgz` and treats it as "download
 * and execute", so an unvalidated manifest value would be arbitrary code execution. Ranges and
 * dist-tags (`^9`, `latest`) are refused too as non-reproducible; the `+sha…` suffix is allowed
 * because it only narrows what can be fetched.
 */
const PACKAGE_MANAGER_VERSION = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+sha\d+\.[0-9a-f]+)?$/;

export interface PackageManager {
  readonly name: string;
  /** `null` means the manifest declared no version, so `PATH` decides. */
  readonly version: string | null;
}

/** A declared version goes through `corepack` so it need not be installed first; otherwise the bare name resolves from `PATH`. */
export function invocationOf(manager: PackageManager): readonly string[] {
  return manager.version === null
    ? [manager.name]
    : ["corepack", `${manager.name}@${manager.version}`];
}

/** Script names are literals from this table, never keys read out of the manifest, so none need sanitising. `test` is required; the other two run only when present. */
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
 * Turns off git-commit-id's build stamping, which cannot read a linked worktree's `gitdir` line and
 * fails the build before anything compiles. Safe to send unconditionally: an unknown `-D` property
 * is inert, unlike an unknown flag. See architecture/solve.md §15 for why this is accepted despite not
 * being byte-for-byte the build CI runs.
 */
const SKIP_GIT_STAMP = "-Dmaven.gitcommitid.skip=true";

/**
 * `absent` and `unreadable` lead to different refusals: no manifest is a fact about the repository,
 * a timed-out read is a fact about this machine. Only the timeout can be told apart mechanically —
 * `git show` exits non-zero for both a missing path and a bad ref, so a wrong base ref reads as
 * both manifests absent.
 */
type Shown =
  | { readonly kind: "found"; readonly raw: string }
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable" };

export interface Step {
  readonly name: StepName;
  readonly argv: readonly string[];
  /** True when the step resolves its own dependencies, so it's charged the install budget rather than the step budget. */
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

/** An undeclared version is the single most likely explanation for an install dying on a repository whose own CI is green, so the refusal names it. */
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
  /** Tail of the output. `renderVerificationFailure` is what reads it, so a failing step's last `MAX_OUTPUT` characters are all the repair pass ever sees of why. */
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
 * The `-z` record separator, escaped rather than a literal byte — a literal NUL in source makes
 * `grep` treat the file as binary and go quiet.
 */
const NUL = "\u0000";

function tail(result: { stdout: string; stderr: string }): string {
  const combined = `${result.stdout}\n${result.stderr}`.trim();
  return combined.length <= MAX_OUTPUT ? combined : combined.slice(-MAX_OUTPUT);
}

/**
 * Everything unexpected collapses to `null` and the caller refuses — a manifest that fails to
 * parse is not a repository without tests, and those must not produce the same outcome.
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

/** The version must be honoured rather than discarded, since a lockfile written by one major version of pnpm can be unreadable by another on `PATH`. */
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
  // The *first* `@`, which is what `name@version` means.
  const at = declared.indexOf("@");
  const name = at === -1 ? declared : declared.slice(0, at);
  const version = at === -1 ? null : declared.slice(at + 1);
  // `Object.hasOwn`, not `in`: `in` walks the prototype chain, so `constructor@1` would pass.
  if (!Object.hasOwn(PACKAGE_MANAGERS, name)) {
    return null;
  }
  if (version !== null && !PACKAGE_MANAGER_VERSION.test(version)) {
    return null;
  }
  return { name, version };
}

/**
 * Reads via `git show <base>:package.json`, never the worktree's copy, so no pass in this run can
 * have edited the commands. On a review round the base ref is one the worktree was synced with
 * rather than cut from, so `unverifiableChanges` is what stands between earlier rounds' commits
 * and the definition of passing.
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

  // Both is a contradiction, not a preference: whichever were checked first would win, making the verdict a property of this function's line order.
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

/** Probes Maven exists first — without it an absent Maven makes the test step exit non-zero, reported as `failed`: the harness's own missing dependency read as a verdict about the model's code. */
async function mavenPlan(
  runner: CommandRunner,
  raw: string,
  request: Pick<VerifyRequest, "repoPath" | "baseRef" | "stepTimeoutMs">,
): Promise<PlanResult> {
  // Unreadable is not the same as untested, so it refuses rather than proceeding.
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
      steps: [{ name: "test", argv: [MAVEN, "-B", SKIP_GIT_STAMP, "test"], cold: true }],
      toolchain: "maven",
      note: ` — using ${MAVEN} from PATH with ${SKIP_GIT_STAMP}, so this is not byte-for-byte the build CI runs; if the repository has a wrapper it was not executed either, which makes a toolchain difference the first thing to check`,
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

/** Uses `--name-only -z` for the same reason the diff gate does: without it, a filename containing a newline becomes two entries. */
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
 * Runs the plan against the worktree before the model has touched it, since `failed` means *the
 * change is bad* — a claim only true relative to a base that would otherwise have passed. Both
 * non-passing outcomes become `unusable`, but the whole `VerificationResult` is carried out rather
 * than a boolean since "failed" and "refused" reach the same decision without being the same
 * sentence. See architecture/solve.md §15.
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
 * Keeps `refused` apart from `failed`: "the tests failed" is a fact about the code, while "install
 * died" is the harness declining an opinion, and collapsing them would judge a solver on evidence
 * never gathered. A timed-out step is a failure, not a refusal, since a hang is plausible for a bad fix to cause.
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

  // Skipped entirely rather than run as a no-op: an "install" line that never ran is a step a reader would count as evidence.
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
      // Not a failure: nothing was verified. Output is quoted here rather than left in `results`, since this branch returns before a caller could otherwise read it.
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
    // A cold step's own dependency resolution would otherwise time out the first Java build on a machine and report that as the change being wrong.
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
      log.info("solve.verify.failed", { step: step.name, timedOut: result.timedOut });
      return {
        outcome: "failed",
        steps: results,
        // The note rides on the cold step because that step is also the install, so there is no install refusal to carry it.
        reason:
          `${step.name} did not pass (${result.timedOut ? "timed out" : `exit ${String(result.exitCode)}`})` +
          `${step.cold ? plan.note : ""}`,
      };
    }
  }

  log.info("solve.verify.passed", { steps: results.map((step) => step.name) });
  return { outcome: "passed", steps: results };
}

/** Written to fail in one direction only: both over- and under-matching bias the answer towards `guarded`, the weak verdict, and neither can manufacture a `vacuous` finding. */
export const TEST_PATHS: readonly RegExp[] = [
  /(^|\/)[^/]*\.(test|spec)\.[cm]?[jt]sx?$/u,
  /(^|\/)__tests__(\/|$)/u,
  /(^|\/)tests?\//u,
];

export function isTestPath(path: string): boolean {
  return TEST_PATHS.some((pattern) => pattern.test(path));
}

export type FailFirstResult =
  /** The run's tests failed without the run's fix. They separate the two. */
  | { readonly outcome: "guarded"; readonly tests: readonly string[] }
  /** They passed without it. The test is named for something it does not check. */
  | { readonly outcome: "vacuous"; readonly tests: readonly string[] }
  /** There was no experiment to run. Not a finding either way. */
  | { readonly outcome: "skipped"; readonly reason: string }
  /** The experiment could not be completed, so it says nothing. */
  | { readonly outcome: "inconclusive"; readonly reason: string };

export interface FailFirstRequest {
  readonly repoPath: string;
  readonly worktreePath: string;
  /** Derived by the caller from the solve worktree's own path, never supplied by a model. */
  readonly probePath: string;
  readonly baseRef: string;
  /** Every path the run changed, as git reported it. */
  readonly changedPaths: readonly string[];
  readonly stepTimeoutMs: number;
  readonly installTimeoutMs: number;
}

/**
 * Applies the house mutation rule (a guard is not shipped until it fails when unplugged) to the
 * tests the solver writes. This catches only the weaker failure — red against nothing at all, not
 * necessarily against a plausible wrong fix, which `SOLVE_INSTRUCTIONS.md` §2 asks for in prose
 * instead since a harness cannot enumerate "the obvious wrong fix". Only `vacuous` is trustworthy;
 * `guarded` just means this experiment didn't find them vacuous, so it is reported and never used
 * to refuse a fix. Uses a second worktree — a detached checkout of the base with the run's test
 * files laid on top — rather than reverting this one, since the fix here is verified and uncommitted.
 */
export async function checkFailFirst(
  runner: CommandRunner,
  request: FailFirstRequest,
): Promise<FailFirstResult> {
  const { repoPath, worktreePath, probePath, baseRef, changedPaths } = request;
  const { stepTimeoutMs, installTimeoutMs } = request;

  const tests = changedPaths.filter(isTestPath);
  if (tests.length === 0) {
    return {
      outcome: "skipped",
      reason: "the run changed no test file, so there is no new guard to unplug",
    };
  }
  if (changedPaths.every(isTestPath)) {
    return {
      outcome: "skipped",
      reason: "the run changed tests only, so there is no fix to take away from them",
    };
  }

  // Not optional tidying: `write-tree` refuses an index holding `--intent-to-add` entries, which `gitDiff` leaves behind for every new file.
  const staged = await runner.run(["git", "-C", worktreePath, "add", "--", ...changedPaths], {
    cwd: worktreePath,
    timeoutMs: stepTimeoutMs,
  });
  if (staged.timedOut || staged.exitCode !== 0) {
    return {
      outcome: "inconclusive",
      reason: `could not stage the run's own changes to read them back — ${tail(staged)}`,
    };
  }
  const written = await runner.run(["git", "-C", worktreePath, "write-tree"], {
    cwd: worktreePath,
    timeoutMs: stepTimeoutMs,
  });
  const tree = written.stdout.trim();
  // Checked as a whole string: this becomes an argument to `git checkout`, and a partial match would let a ref-ish thing through where an object id is expected.
  if (written.timedOut || written.exitCode !== 0 || !/^[0-9a-f]{40,64}$/u.test(tree)) {
    return { outcome: "inconclusive", reason: "could not write a tree for the run's own changes" };
  }

  const planned = await discoverPlan(runner, { repoPath, baseRef, stepTimeoutMs });
  if (planned.outcome === "refused") {
    return { outcome: "inconclusive", reason: planned.reason };
  }
  const { plan } = planned;
  const testStep = plan.steps.find((step) => step.name === "test");
  if (testStep === undefined) {
    // Unreachable today, but written rather than asserted so a third toolchain produces no finding here instead of a crash after the pull request has already been paid for.
    return { outcome: "inconclusive", reason: "the base declares no test step" };
  }

  const cut = await runner.run(
    ["git", "-C", repoPath, "worktree", "add", "--detach", probePath, baseRef],
    { cwd: repoPath, timeoutMs: stepTimeoutMs },
  );
  if (cut.timedOut || cut.exitCode !== 0) {
    return {
      outcome: "inconclusive",
      reason: `could not cut a checkout of ${baseRef} to test against — ${tail(cut)}`,
    };
  }

  try {
    // Safe by construction: the checkout was cut one command ago, so every path this overwrites holds only base content.
    const laid = await runner.run(["git", "-C", probePath, "checkout", tree, "--", ...tests], {
      cwd: probePath,
      timeoutMs: stepTimeoutMs,
    });
    if (laid.timedOut || laid.exitCode !== 0) {
      // A deleted test file lands here: not in the tree, so the checkout refuses — reported rather than worked around.
      return {
        outcome: "inconclusive",
        reason: `could not lay the run's tests onto ${baseRef} — ${tail(laid)}`,
      };
    }

    if (plan.install !== null) {
      const installed = await runner.run(plan.install, {
        cwd: probePath,
        timeoutMs: installTimeoutMs,
      });
      if (installed.timedOut || installed.exitCode !== 0) {
        return {
          outcome: "inconclusive",
          reason: `dependency install failed in the probe checkout${plan.note}`,
        };
      }
    }

    const ran = await runner.run(testStep.argv, {
      cwd: probePath,
      timeoutMs: testStep.cold ? installTimeoutMs : stepTimeoutMs,
    });
    // A timeout counts as red, matching `verify` — the conservative direction, since it produces `guarded`, the verdict this function is not trusted on.
    const passed = !ran.timedOut && ran.exitCode === 0;
    log.info("solve.fail_first", { outcome: passed ? "vacuous" : "guarded", tests });
    return passed ? { outcome: "vacuous", tests } : { outcome: "guarded", tests };
  } finally {
    const removed = await runner.run(
      ["git", "-C", repoPath, "worktree", "remove", "--force", probePath],
      { cwd: repoPath, timeoutMs: stepTimeoutMs },
    );
    if (removed.timedOut || removed.exitCode !== 0) {
      // Logged and not returned: the finding is about the change, a leftover directory is about this machine.
      log.warn("solve.fail_first.probe_left", { probePath, output: tail(removed) });
    }
  }
}
