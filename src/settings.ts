/**
 * Declarative settings table plus a generic reader.
 *
 * Every setting the service understands is declared once, here, as data. The
 * reader is generic over that table, which buys three things over hand-written
 * `process.env` lookups scattered across modules:
 *
 *   - one place to see everything the service needs to run;
 *   - a single validation pass at startup, so a misconfigured deployment fails
 *     immediately with a complete list rather than one error at a time, hours
 *     in, when some code path is first reached;
 *   - a `sensitive` marker, so diagnostics can print the resolved config
 *     without leaking the values that matter.
 *
 * No values live in this file. Sensitive ones are supplied at runtime through
 * the environment; see .env.example for the template.
 */

export interface SettingSpec {
  readonly name: string;
  readonly description: string;
  /** Used when the environment does not supply a value. */
  readonly fallback?: string;
  /** When true and there is no fallback, startup fails without a value. */
  readonly required?: boolean;
  /** Never print the resolved value. */
  readonly sensitive?: boolean;
}

export const SETTINGS = [
  {
    name: "JIRA_BASE_URL",
    description: "Atlassian site root, no trailing slash.",
    fallback: "https://storebrand.atlassian.net",
  },
  {
    name: "JIRA_EMAIL",
    description: "Account the service authenticates as.",
    required: true,
  },
  {
    name: "JIRA_AUTH",
    description: "Atlassian API credential for the account above.",
    required: true,
    sensitive: true,
  },
  {
    name: "JIRA_PROJECT",
    description: "Board to watch.",
    fallback: "SSX",
  },
  {
    name: "JIRA_COMPONENTS",
    description:
      'Comma-separated components to watch, by name or id. The SSX board is shared by several teams, so this is what keeps the service off other teams\' tickets. "SSX Advisor" is id 12644 — not to be confused with "App Buy Insurance Advisor" (11408). Blank watches the whole board.',
    fallback: "SSX Advisor",
  },
  {
    name: "JIRA_EXCLUDED_TYPES",
    description:
      "Comma-separated issue type ids to skip. Defaults to Deloppgave (sub-tasks), which arrive attached to a parent that was triaged already.",
    fallback: "10009",
  },
  {
    name: "POLL_INTERVAL_MS",
    description: "Gap between polls.",
    fallback: "300000",
  },
  {
    name: "CURSOR_OVERLAP_MS",
    description:
      "How far back to re-scan each poll. Jira's date filters are minute-precision, so a strict cursor can miss issues created in the same minute as the last one seen; the key-level dedupe absorbs the resulting overlap.",
    fallback: "120000",
  },
  {
    name: "FIRST_RUN_LOOKBACK_MINUTES",
    description:
      "Window used when no state file exists. Deliberately short: a wide first window would trigger a triage run per historical issue.",
    fallback: "60",
  },
  {
    name: "STATE_PATH",
    description: "Where poll state is persisted.",
    fallback: "state/poll.json",
  },
  {
    name: "OUTPUT_DIR",
    description: "Where triage reports are written.",
    fallback: "groomed",
  },
  {
    name: "SKILL_NAME",
    description:
      "Skill to run per issue. Defaults to the mock so an unconfigured service cannot post real verdicts.",
    fallback: "mock-triage",
  },
  {
    name: "VAULT_PATH",
    description:
      "Absolute path to the insurance-knowledge-vault clone. intake-triage stops and asks a human if it cannot find one, which in a headless run means exiting successfully having done nothing — so this is set explicitly rather than left to the skill's own search. Blank for skills that need no vault.",
    fallback: "",
  },
  {
    name: "WRITE_BACK",
    description:
      "Whether the skill may post its verdict to the Jira issue itself: a comment, a label union and, on a duplicate, an issue link. Never a transition — the skill refuses to change status even when asked. Off by default, because this is the only setting whose effect the whole team can see, and an unattended service that starts commenting on shared tickets should be an explicit decision rather than a default. Off still writes the local markdown report.",
    fallback: "false",
  },
  {
    name: "STORECODE_PATH",
    description: "Executable used to run the skill.",
    fallback: "storecode",
  },
  {
    name: "TRIAGE_TIMEOUT_MS",
    description:
      "Per-issue wall-clock budget before the run is killed. Guards against a wedged session blocking the loop forever, and that is the only thing it is for — it is a cap, not a target, so a run that finishes in two minutes costs nothing extra for the headroom above it. Raised from 600000 on 2026-09-04: SSX-3831 blew through ten minutes and then completed in four and a half on an unchanged retry, so the same ticket varied by more than 2x and the shorter budget killed a run that was not stuck. That failure is expensive and silent-looking — the session is billed in full, the artifact is never written, and the operator sees a stack trace rather than a verdict — whereas the cost of overshooting is only that a genuinely hung run holds the queue longer before it is reaped.",
    fallback: "1200000",
  },
  {
    name: "SOLVE_ENABLED",
    description:
      'Master switch for the solve queue. Off means the second poller never starts, so no ticket is ever claimed. Separate from SOLVE_MODE because they answer different questions — whether the machinery runs at all, and how much human approval it needs when it does — and collapsing them into one setting would mean the only way to test the plumbing was to arm it. Strict "true", so a typo fails closed.',
    fallback: "false",
  },
  {
    name: "SOLVE_MODE",
    description:
      'manual | auto. Manual additionally requires the label "agent:start" on a ticket before it may be claimed, which is the single human step in the whole flow and the only thing standing between a triage assessment and an unattended code change. Defaults to manual, and an unrecognised value is a startup error rather than a fallback: guessing here would guess in the direction of more privilege.',
    fallback: "manual",
  },
  {
    name: "SOLVE_AUTO_ISSUE_TYPES",
    description:
      'Issue types that may be solved UNATTENDED, by id or by name, consulted only when SOLVE_MODE=auto. Defaults to "Feil" — this board is Norwegian and its bug type is not called "Bug", so an English default would match nothing and make autosolve look enabled while never firing. Prefer the numeric id if you have it: names are localised and can be renamed out from under this setting. Blanking this does NOT widen auto mode to every type: an empty value falls back to "Feil" like any other setting here, and the fallback is itself the restriction. Widening is done by naming more types, which leaves a record of who decided to.',
    fallback: "Feil",
  },
  {
    name: "SOLVE_REPOS",
    description:
      "Comma-separated allowlist of repositories the solver may touch. Unlike JIRA_COMPONENTS, blank means *nothing* is allowed rather than everything: this list grants a write privilege, so its empty state has to be the safe one. A ticket naming a repo outside the list is skipped and not failed, so widening the list later picks it up without a manual reset.",
    // Deliberately has no fallback, and it is the only solve setting that
    // doesn't. Every other blank here falls back to something *more*
    // restrictive than the alternative, so the fallback is safe. This one is an
    // allowlist: a default would name a repository that no operator ever typed,
    // and — because `readSettings` cannot tell blank from unset — it would make
    // the privilege unrevokable by the obvious means. Someone emptying
    // SOLVE_REPOS to take the solver off a repo would have handed it straight
    // back. Unset means no repository is allowed, which costs a line in .env
    // and buys an allowlist that can actually be emptied.
  },
  {
    name: "SOLVE_REPO_ROOT",
    description:
      "Directory holding the local checkouts the solver works from; a ticket's repository is resolved as SOLVE_REPO_ROOT/<name> where the name comes from the ticket's own svc: label. The solver never edits these checkouts — it creates a git worktree from one — but it does read and fetch in them, so this points at real repositories and is deliberately not guessed.",
    // No fallback, for the same reason as SOLVE_REPOS. A default of "the
    // directory above this one" would be right on this machine and silently
    // wrong on any other, and the way it would be wrong is by finding some
    // other checkout with a matching name. Naming the path costs one line and
    // makes the answer to "which code can this touch" readable.
  },
  {
    name: "SOLVE_BASE_REF",
    description:
      "The ref a solve branches from and targets. origin/main by default, and fetched immediately before branching so a solve never starts from a stale local ref. Configurable because not every repository calls it main; changing it does not widen anything, since the branch created from it is still a fresh implementation branch and the push guard still refuses protected names.",
    fallback: "origin/main",
  },
  {
    name: "SOLVE_GIT_TIMEOUT_MS",
    description:
      "Budget for a single git invocation — fetch, worktree add, commit, push. Generous next to how long git usually takes, because the one that is slow is the first fetch of a repository nobody has fetched today, and killing that produces a confusing failure a long way from its cause.",
    fallback: "120000",
  },
  {
    name: "SOLVE_STEP_TIMEOUT_MS",
    description:
      "Budget for one verification step: the repository's own test, typecheck or lint command. Per step rather than per run, because a repository may define several and the slow one should not be charged for the fast ones.",
    fallback: "600000",
  },
  {
    name: "SOLVE_INSTALL_TIMEOUT_MS",
    description:
      "Budget for installing dependencies in a fresh worktree. Separate from SOLVE_STEP_TIMEOUT_MS and larger, because a new worktree has no node_modules and the first install in a repository is the slowest thing the solver does. Later installs are much faster — pnpm's store is content-addressable — so this is sized for the cold case and rarely reached.",
    fallback: "900000",
  },
  {
    name: "SOLVE_TIMEOUT_MS",
    description:
      "Per-pass wall-clock budget for a solve session, not per-ticket: a solve is four sessions, so a ticket may legitimately take four times this. Higher than TRIAGE_TIMEOUT_MS because the work is harder — triage reads a ticket and a vault, whereas a fix pass reads a repository it has never seen and edits it — and because the failure is worse. A killed triage costs one re-run; a killed fix pass leaves a worktree half-edited, and the pipeline deliberately does not retry it, so an overtight budget here converts slow runs into abandoned ones. Wall-clock means wall-clock: a machine that sleeps mid-pass spends the budget without the pass running, which killed a recon on SSX-3831 that had done nothing wrong. Harmless for a hand-driven run on a waking machine and not harmless for E, where a laptop daemon meets this every night.",
    fallback: "1800000",
  },
  {
    name: "SOLVE_GITHUB_OWNER",
    description:
      "The GitHub owner or organisation pull requests are opened against; a ticket's repository becomes SOLVE_GITHUB_OWNER/<name>, where the name is the same one SOLVE_REPOS allows and the ticket's svc: label supplies. gh is never left to infer the repository from whatever remote the worktree happens to carry, because a wrong inference here opens a pull request on somebody else's repository and there is no undo that unsends the notifications.",
    // No fallback, for the same reason as SOLVE_REPOS and SOLVE_REPO_ROOT: this
    // names a place that gets written to. An owner guessed from the checkout's
    // remote would be right until the day someone adds a fork as `origin`.
  },
  {
    name: "SOLVE_WORKTREE_ROOT",
    description:
      "Directory the solver cuts its worktrees into, one per issue key. Defaults to the system temp directory, which is where a temporary checkout belongs — deliberately nowhere near the repository, so a failed run leaves its evidence somewhere obviously not the working copy. Configurable because a run that fails keeps its worktree for a human to read, and on macOS the default lands under /private/var, which some tooling cannot open; pointing this at a readable directory is the difference between a diff that can be reviewed by hand and one that can only be described.",
    fallback: "",
    // Empty means the system temp directory. It cannot default to the literal
    // path because `tmpdir()` is a function of the environment, and freezing
    // today's answer into a string would break the first machine that disagrees.
  },
  {
    name: "SOLVE_BOT_NAME",
    description:
      "Author name on commits the solver makes. Says a machine wrote it, in the one place every reader of the repository already looks: git blame, the PR author line, and whatever CODEOWNERS automation reads the log. Defaulted rather than required because a missing value here would block a run over a cosmetic field, and unlike the repository settings a wrong name widens nothing.",
    fallback: "jira-police",
  },
  {
    name: "SOLVE_BOT_EMAIL",
    description:
      "Author email on commits the solver makes. A noreply address on purpose: replies to a bot's commits should go to the ticket, and a real mailbox here would collect them silently.",
    fallback: "jira-police@users.noreply.github.com",
  },
  {
    name: "SOLVE_GH_TIMEOUT_MS",
    description:
      "Budget for a single gh invocation — opening the pull request, requesting the review, reading the review back, undrafting. Separate from SOLVE_GIT_TIMEOUT_MS because these are API round trips rather than local work, so they fail differently: a slow one is GitHub being slow or a token being re-authorised, neither of which is helped by the generous budget a cold git fetch needs.",
    fallback: "60000",
  },
  {
    name: "MAX_CONCURRENT_SOLVES",
    description:
      "How many tickets may be in flight at once, counted from the tickets currently carrying the claim label rather than from anything local. One, for the pilot: a solve is expensive, and a bounded blast radius is worth more than throughput while the fitness call is still being calibrated.",
    fallback: "1",
  },
  {
    name: "MAX_REVIEW_ITERATIONS",
    description:
      "How many times a solve may respond to the requested REVIEWER before the pull request is marked ready anyway, with the ticket comment saying the cap was hit. A cap rather than a loop, because a bot reviewer and a fixer that disagree can trade comments indefinitely and neither of them is paying. It counts reviewer rounds only: a round answering a human does not spend one, because the whole reason to bound this conversation is that nothing in it brings in information from outside it, and a person asking for a change is exactly that information. A batch holding both counts as human. Reaching this undrafts the pull request and keeps listening — it is the reviewer running out of turns, not the loop ending. MAX_PR_ROUNDS_TOTAL is what bounds every round regardless of who asked.",
    fallback: "3",
  },
  {
    name: "MAX_PR_ROUNDS_TOTAL",
    description:
      "The absolute number of rounds any one pull request may ever cost, counted from the marker comment on it. Deliberately not MAX_REVIEW_ITERATIONS under another name: that one is a policy about how much argument a bot reviewer is worth, and it is expected to be relaxed — human feedback is not capped by it at all. This is a brake on the machinery, and conflating the two would let a policy change disable a safety stop. Twenty, because the same measurement serves both and only one of them may be tuned freely. On hitting it: stop advancing, say so on the ticket, and leave the pull request open for a human.",
    fallback: "20",
  },
  {
    name: "REVIEW_POLL_MS",
    description:
      "How often to look at a pull request under review. Two minutes, from measurement rather than taste: every Copilot review on PR #2658 landed two and a half to four minutes after the review was requested, so a shorter interval buys nothing and a longer one adds dead time to every round. A look that finds nothing costs two gh reads, no checkout and no model call, so this is cheap to lower — and lowering it no longer shortens the service's patience, which it used to, because that is now REVIEW_SILENCE_MS in wall-clock time rather than a count of ticks.",
    fallback: "120000",
  },
  {
    name: "REVIEW_SILENCE_MS",
    description:
      "How long a pull request may go with nothing happening on it before the loop stops waiting and hands it to a human. Twenty minutes, which is what the old count of ten silent polls came to at the default interval. It is the bound on the one thing the round caps cannot see: a reviewer that never answers produces no rounds, so MAX_REVIEW_ITERATIONS and MAX_PR_ROUNDS_TOTAL both stay at zero while the loop spins. Measured from the newest dated thing on the pull request itself — its own creation if there is nothing else — so it survives a restart and means the same number of minutes whatever REVIEW_POLL_MS is set to. Counting ticks instead made a cadence change silently a policy change.",
    fallback: "1200000",
  },
  {
    name: "MAX_REVIEW_ROUNDS_PER_TICK",
    description:
      "How many pull requests one pass over the watched set may run a round for. Every other round bound is per pull request and counted from its marker; this one is per tick and is the only thing standing between a reviewer that answered twenty pull requests while the machine slept and twenty paid rounds in the first minute after it wakes — the largest single spend this service can make, on the tick nobody is watching. Three, which is roughly three dollars at the measured round cost. Tickets over the bound are deferred rather than skipped: they are still actionable, the next tick takes them, and because the set is ordered oldest-updated first the same one cannot be starved twice. Zero is meaningful and is the dry run — look at everything, spend on nothing.",
    fallback: "3",
  },
  {
    name: "WATCH_ENABLED",
    description:
      "Whether the sendback watch runs at all. Off by default, and it is the switch that most deserves to be: every other loop here spends money because somebody asked for something — a ticket was labelled, a reviewer commented, an operator typed a command — and this one spends it because a reporter edited a ticket, which is not a request for anything. Separate from SOLVE_ENABLED rather than folded into it, because the two grant unrelated privileges: that one lets a bot write code, this one lets it re-open a conversation it was already told to stop.",
    fallback: "false",
  },
  {
    name: "MAX_RETRIAGE_PER_TICKET",
    description:
      "How many times one watched ticket may be re-triaged before the watch is dropped with a comment saying so. Three. Counted from this service's own comments on the ticket rather than from disk, so it survives a restart and a second instance for the same reason the solve queue's dedupe does. A ticket edited more often than this is a conversation rather than a signal, and the watch is the one loop with no human waiting on the result, so the bound is the only thing that ends it. Note the number was chosen in the plan against a measured triage cost of $0.11 that later proved to be $1.56, so it is understated as a spending limit by roughly an order of magnitude — re-derive it before the watch runs on a timer.",
    fallback: "3",
  },
  {
    name: "FAIL_FIRST_CHECK",
    description:
      "Whether a verified solve also runs its own new tests against the base, to see whether they fail when the fix is taken away. On by default, which is the opposite of every other switch here: this one grants nothing and writes nothing, and the failure mode of it being off is the thing it exists to catch — a regression test that is green against the bug it is named for. Set it to false only for cost, since it buys one extra install and one extra test run per solve. The result is reported on the pull request and never withholds one.",
    fallback: "true",
  },
  {
    name: "LOG_LEVEL",
    description: "debug | info | warn | error",
    fallback: "info",
  },
] as const satisfies readonly SettingSpec[];

/**
 * Widened view used for iteration.
 *
 * `as const` above is what makes SettingName a union of literals, but it also
 * means each element's type lists only the properties it actually declares —
 * so `spec.fallback` is a type error on entries that have no fallback. Reading
 * through the interface restores uniform access without losing the literals.
 */
const SPECS: readonly SettingSpec[] = SETTINGS;

export type SettingName = (typeof SETTINGS)[number]["name"];

export type Settings = Readonly<Record<SettingName, string>>;

export class SettingsError extends Error {
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    super(
      `Missing required configuration: ${missing.join(", ")}. Copy .env.example to .env and fill it in.`,
    );
    this.name = "SettingsError";
    this.missing = missing;
  }
}

/**
 * Resolves every declared setting, reporting all missing ones at once.
 *
 * Blank strings count as absent. An empty value in a .env file is almost always
 * an unfilled template line rather than a deliberate choice, and treating it as
 * present produces a confusing downstream failure instead of a clear one here.
 */
export function readSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  const resolved: Record<string, string> = {};
  const missing: string[] = [];

  for (const spec of SPECS) {
    const supplied = env[spec.name]?.trim();
    if (supplied !== undefined && supplied !== "") {
      resolved[spec.name] = supplied;
      continue;
    }
    if (spec.fallback !== undefined) {
      resolved[spec.name] = spec.fallback;
      continue;
    }
    if (spec.required === true) {
      missing.push(spec.name);
      continue;
    }
    resolved[spec.name] = "";
  }

  if (missing.length > 0) {
    throw new SettingsError(missing);
  }

  return resolved as Settings;
}

/**
 * Runs an entry point, turning a configuration problem into a message.
 *
 * Wraps the whole of `main` rather than just `readSettings`, because not every
 * such problem is visible from one setting alone: `SKILL_NAME=intake-triage`
 * with no `VAULT_PATH` is only wrong as a pair, and it is caught at wiring
 * time. A misconfiguration is the operator's to fix either way, so it earns a
 * sentence and EX_CONFIG rather than a stack trace.
 */
export async function withConfigErrors(main: () => Promise<void>): Promise<void> {
  try {
    await main();
  } catch (error) {
    if (!(error instanceof SettingsError)) {
      throw error;
    }
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 78; // EX_CONFIG
  }
}

/** Resolved settings with sensitive values masked, safe to log. */
export function describeSettings(settings: Settings): Record<string, string> {
  const described: Record<string, string> = {};
  for (const spec of SPECS) {
    const value = settings[spec.name as SettingName];
    described[spec.name] =
      spec.sensitive === true ? (value === "" ? "<unset>" : "<redacted>") : value;
  }
  return described;
}

/**
 * Reads a numeric setting, with a floor.
 *
 * The finite check alone was not enough, and the gap is easy to miss because
 * every value here is a duration or a count and neither has a meaningful
 * negative. `Number("-1")` is perfectly finite, so a stray minus sign used to
 * sail through and land somewhere that reads much worse than it looks:
 * `setTimeout` treats a negative delay as zero, so a negative
 * `TRIAGE_TIMEOUT_MS` does not disable the timeout, it fires it immediately and
 * kills every run at the starting line. A negative poll interval is the same
 * bug wearing a different hat — a busy loop against Jira.
 *
 * `min` defaults to 0 because that is the weakest claim true of every caller.
 * The two settings where zero is itself nonsense pass `min: 1`; the ones where
 * zero is a legitimate choice — no cursor overlap, a concurrency cap of none —
 * keep the default, so the floor stays a statement about each setting rather
 * than a blanket rule that would have to be argued with.
 *
 * Range lives here rather than at the call sites for the reason the whole
 * module exists: a bad value should stop the process at startup with the
 * setting's name in the message, not surface later as behaviour nobody
 * connects back to a typo in `.env`.
 */
export function numeric(settings: Settings, name: SettingName, min = 0): number {
  const raw = settings[name];
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Setting ${name} must be a number, got "${raw}"`);
  }
  if (parsed < min) {
    throw new Error(`Setting ${name} must be at least ${min}, got ${parsed}`);
  }
  return parsed;
}

/**
 * Reads a boolean setting.
 *
 * Only "true" enables — deliberately strict rather than truthy. The one flag
 * this reads today decides whether the service writes to shared Jira tickets,
 * and a typo there should fail closed, not open.
 */
export function flag(settings: Settings, name: SettingName): boolean {
  return settings[name].trim().toLowerCase() === "true";
}

/**
 * Whether the fail-first experiment runs. **Only "false" turns it off.**
 *
 * The mirror image of `flag` above, and the asymmetry is the point rather than
 * an oversight. `flag` fails closed because the thing it reads decides whether
 * this service writes to shared tickets, so a typo must not grant a privilege.
 * This reads a quality check that grants nothing, and there a typo must not
 * silently withdraw a guard — `FAIL_FIRST_CHECK=fasle` should keep checking.
 * Two settings, two directions, both chosen by what a mistake costs.
 */
export function failFirstCheck(settings: Settings): boolean {
  return settings["FAIL_FIRST_CHECK"].trim().toLowerCase() !== "false";
}

export function list(settings: Settings, name: SettingName): readonly string[] {
  return settings[name]
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/**
 * How much human approval a solve needs.
 *
 * `manual` requires the label `agent:start` on the ticket; `auto` does not.
 * There is no third value and there is deliberately no "off" — that is
 * `SOLVE_ENABLED`, kept separate so that arming the machinery and lowering the
 * approval bar are two decisions rather than one.
 */
export type SolveMode = "manual" | "auto";

/**
 * Reads `SOLVE_MODE`, refusing anything it does not recognise.
 *
 * The obvious alternative — treat an unreadable value as `manual`, since
 * `manual` is the safe one — is wrong for a reason worth writing down. Falling
 * back silently means `SOLVE_MODE=atuo` runs the service in a mode the operator
 * did not choose and cannot see, and the failure is invisible in exactly the
 * case they were trying to change the setting. Refusing at startup costs a
 * restart; a silent fallback costs a wrong belief about what the service is
 * doing, and the whole point of this setting is that somebody knows.
 *
 * That this fails closed *and* loudly is not a compromise between the two: an
 * unreadable value is not evidence of intent in either direction, so there is
 * nothing to fail closed to.
 *
 * The wording of the resulting message is inherited from `SettingsError`, which
 * frames every configuration problem as a missing setting. That reads slightly
 * off for a present-but-invalid one; `missing` still names `SOLVE_MODE`, and
 * the value is quoted below so the operator can see their typo.
 */
export function solveMode(settings: Settings): SolveMode {
  const raw = settings.SOLVE_MODE.trim().toLowerCase();
  if (raw === "manual" || raw === "auto") {
    return raw;
  }
  throw new SettingsError([
    `SOLVE_MODE (expected "manual" or "auto", got "${settings.SOLVE_MODE}")`,
  ]);
}
