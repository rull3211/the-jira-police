/**
 * What this service is allowed to call a branch, and what it must never touch: `isWorkBranch`
 * is an allowlist of prefixes it may create and push; `isProtectedRef` is a denylist checked
 * independently at every git call site, since a base ref, push target, and PR base don't all
 * flow through the same code path.
 * Does not ask the remote which branches are protected — a lookup that fails open under load
 * is worse than a hardcoded list.
 */

/** Deliberately narrower than the Conventional Commits type list in `runner.ts` — the diff gate already refuses a run before it needs a `style`/`build`/`ci` branch name. */
export const WORK_BRANCH_PREFIXES: ReadonlySet<string> = new Set([
  "fix",
  "feat",
  "chore",
  "docs",
  "test",
  "refactor",
  "perf",
]);

/** Compared case-insensitively: `Main` and `MAIN` are the same ref on a case-insensitive filesystem. */
const PROTECTED_NAMES: ReadonlySet<string> = new Set([
  "main",
  "master",
  "develop",
  "development",
  "trunk",
  "staging",
  "stage",
  "production",
  "prod",
  "release",
  "next",
  "head",
]);

/** Prefixes whose entire subtree is protected, e.g. `release/2026-09`. */
const PROTECTED_PREFIXES: readonly string[] = ["release/", "hotfix/", "support/"];

/** Strips a leading remote name from a ref, e.g. `origin/main`; only one segment, so `feat/origin/thing` isn't misread as remote `feat`. */
function withoutRemote(ref: string): string {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) {
    return ref;
  }
  const head = ref.slice(0, slash);
  // Prefer reading a work-prefix head as a branch, not a remote — the reading that keeps the protected check strict.
  return WORK_BRANCH_PREFIXES.has(head) ? ref : ref.slice(slash + 1);
}

/** Accepts fully-qualified refs, remote-tracking refs, or bare names, so callers never need to normalise first. */
export function isProtectedRef(ref: string): boolean {
  const trimmed = ref.trim();
  if (trimmed === "") {
    // Not a ref at all; refusing is the safe reading of a value that should never have reached here.
    return true;
  }

  let name = trimmed.toLowerCase();
  for (const qualifier of ["refs/heads/", "refs/remotes/"]) {
    if (name.startsWith(qualifier)) {
      name = name.slice(qualifier.length);
    }
  }
  // Both readings tested, not just the stripped one: stripping is a guess about whether it's a remote, wrong in both directions (`release/2026-09` vs `origin/main`), so a ref is refused if either reading is protected.
  for (const candidate of new Set([name, withoutRemote(name)])) {
    // `main^{commit}`, `main~1`, `main@{u}` all resolve to a protected branch; cutting at the first revision operator refuses unrecognised expressions rather than allowing them.
    const bare = candidate.split(/[\^~@:]/u)[0] ?? candidate;
    if (PROTECTED_NAMES.has(bare)) {
      return true;
    }
    if (PROTECTED_PREFIXES.some((prefix) => bare.startsWith(prefix))) {
      return true;
    }
  }
  return false;
}

/** Both halves must hold — the protected check catches `chore/main` and `feat/release/2026-09`, which satisfy the prefix allowlist alone. */
export function isWorkBranch(branch: string): boolean {
  const slash = branch.indexOf("/");
  if (slash <= 0) {
    return false;
  }
  const prefix = branch.slice(0, slash);
  const rest = branch.slice(slash + 1);
  if (!WORK_BRANCH_PREFIXES.has(prefix)) {
    return false;
  }
  if (rest === "") {
    return false;
  }
  return !isProtectedRef(rest);
}

/** Throws unless `branch` is a legitimate work branch; exists because the push path has nothing sensible to do with a bad value and must not continue. */
export function assertWorkBranch(branch: string, what: string): void {
  if (!isWorkBranch(branch)) {
    throw new Error(
      `${what} ${JSON.stringify(branch)} is not an implementation branch — this service writes only to ${[...WORK_BRANCH_PREFIXES].join("/")}-prefixed branches, and never to a protected ref`,
    );
  }
}
