/**
 * Runs the intake-triage skill headlessly and parses the result.
 *
 * This is the ANALYST half of the pipeline, and it never writes to Jira. It
 * reads the issue, decides, and returns the verdict together with the exact
 * mutation that verdict implies. Posting that mutation is `poster.ts`, and only
 * after `gate.ts` has agreed the verdict is coherent.
 *
 * The split exists because of a defect this service shipped: the skill posts
 * its comment mid-run, but `structured_output` — the only thing we can check —
 * arrives with the final result event. Checking afterwards is not checking; on
 * SSX-3822 a contradictory verdict was already on the board by the time we
 * could see it. With the write moved out, the check happens between the two
 * halves, where refusing still means nothing was sent.
 *
 * So there is deliberately no write path here any more, and no `--yes`. A
 * second way to post would be a second way to post unchecked.
 *
 * Invocation shape, with every flag verified against the local arg parser
 * rather than assumed:
 *
 *   storecode -p "/intake-triage SSX-1234 --no-write --no-html"
 *             --output-format stream-json --verbose
 *             --permission-mode dontAsk
 *             --allowedTools <explicit list>
 *             --add-dir <vault>
 *             --json-schema '<inline draft-07>'
 *
 * with `INSURANCE_VAULT=<vault>` in the child's environment.
 *
 * Three non-obvious decisions:
 *
 * 1. `dontAsk` rather than `acceptEdits`. acceptEdits does not auto-approve MCP
 *    tool calls, so a run would stall waiting for input that never comes.
 *    bypassPermissions would also work but disables the safety hooks, which is
 *    not a trade worth making for a background job.
 *
 * 2. The MCP connection is checked explicitly. If the Atlassian OAuth session
 *    has expired, the run still exits 0 — it simply reports that it could not
 *    read the issue. That failure is silent, indistinguishable from a real
 *    verdict downstream, and is the single most likely production bug in this
 *    service. The init event carries per-server status, so we fail loudly.
 *
 * 3. The vault reaches the skill as an environment variable and an extra
 *    working directory, never as its `--vault` flag. See `vaultPath` below.
 */

import { logger } from "../logger.ts";
import type { Verdict } from "../output/sink.ts";
import { TRIAGE_SCHEMA, TRIAGE_SCHEMA_JSON } from "./schema.ts";
import { DENIED_BUILTIN_TOOLS, runSession } from "./session.ts";

// Re-exported so callers and tests that reason about a triage run keep a single
// import. The machinery moved to `session.ts` when the poster began sharing it;
// where it lives is an implementation detail of running a subprocess.
export {
  McpUnavailableError,
  SessionTimeoutError as TriageTimeoutError,
  assertMcpReady,
} from "./session.ts";

/**
 * Tools the skill legitimately needs, pre-approved so the run never stalls.
 *
 * This list does NOT restrict anything — omission from it is not denial. See
 * `DENIED_BUILTIN_TOOLS` in `session.ts` for the probe that established that,
 * and `ANALYST_DENIED_TOOLS` below for the list that does the restricting.
 */
export const ALLOWED_TOOLS: readonly string[] = [
  "mcp__atlassian__getJiraIssue",
  "mcp__atlassian__searchJiraIssuesUsingJql",
  "mcp__atlassian__search",
  "mcp__atlassian__getConfluencePage",
  "mcp__atlassian__searchConfluenceUsingCql",
  // Denying this one is not free. A live run reported it: "Component
  // create-metadata could not be fetched (getAccessibleAtlassianResources
  // denied); SSX Advisor was validated against the copy live on the issue,
  // which does not re-confirm that all four policy streams still exist." That
  // was a caveat in a preview; with WRITE_BACK on, the component is a real
  // mutation, so the run needs to be able to check the name before setting it.
  "mcp__atlassian__getAccessibleAtlassianResources",
  "Read",
  "Grep",
  "Glob",
];

/**
 * Tools withheld from the analyst.
 *
 * The header says this half "never writes to Jira" and that there is
 * "deliberately no write path here any more". Until 2026-09-04 both sentences
 * rested on `--allowedTools`, which enforces nothing; they now rest on this.
 *
 * The four built-ins are verified withheld. The Atlassian mutators are listed
 * on the same principle but are NOT verified: a bare `storecode -p` run has no
 * MCP server connected, so the probe that would distinguish "denied" from
 * "absent" returned `edit=NO get=NO` and proved nothing either way. Listing
 * them cannot hurt — an unrecognised name is inert — but nobody should read
 * this list as evidence that the analyst is mechanically unable to edit a Jira
 * issue. What keeps it from doing so today is still `--no-write` in the prompt
 * plus the fact that `gate.ts` sits between it and the poster.
 */
export const ANALYST_DENIED_TOOLS: readonly string[] = [
  ...DENIED_BUILTIN_TOOLS,
  "mcp__atlassian__editJiraIssue",
  "mcp__atlassian__addCommentToJiraIssue",
  "mcp__atlassian__createJiraIssue",
  "mcp__atlassian__transitionJiraIssue",
  "mcp__atlassian__createIssueLink",
];

export interface TriageRunOptions {
  readonly issueKey: string;
  /**
   * Skill to invoke, without the leading slash. Normally `intake-triage`;
   * `mock-triage` exercises the whole pipeline with no Jira and no vault.
   */
  readonly skillName: string;
  /** Path to the storecode executable. */
  readonly executable: string;
  /** Directory to run in — must be where the skill and vault are resolvable. */
  readonly workingDirectory: string;
  /** Silence budget for the run; see `SessionOptions.idleMs`. */
  readonly idleMs: number;
  /** Awake-time ceiling on the run; see `SessionOptions.maxRunMs`. */
  readonly maxRunMs: number;
  readonly deep: boolean;
  /**
   * Absolute path to the insurance-knowledge-vault clone.
   *
   * Passed two ways, because one is not enough. As `$INSURANCE_VAULT`, which is
   * the skill's own second resolution step, so it never reaches the "STOP and
   * ask the user" branch that a headless run cannot answer. And as `--add-dir`,
   * because the vault is a sibling of this repo rather than inside it, and
   * without that the Read tool has no business being there.
   *
   * Deliberately not passed as the skill's `--vault` flag: that value would
   * have to survive the model parsing it out of a prompt string, and an
   * environment variable does not.
   */
  readonly vaultPath?: string;
  /**
   * Suppresses the HTML roll-up dashboard the skill otherwise writes after
   * every run. This service has a sink of its own, and `Write` is withheld by
   * `ANALYST_DENIED_TOOLS` — so left on, it ends every run with a denied call.
   *
   * Note that until 2026-09-04 `Write` was *not* in fact withheld, only absent
   * from the allowlist, which denied nothing. Every run made with `noHtml`
   * unset could have written that dashboard to disk and, as far as this service
   * can tell after the fact, some of them did.
   */
  readonly noHtml?: boolean;
  /**
   * Servers that must be `connected`. Empty for the mock skill, which reads
   * nothing — requiring Atlassian there would fail runs for the wrong reason.
   */
  readonly requiredMcpServers: readonly string[];
  /** Tools the run may use. Defaults to ALLOWED_TOOLS. */
  readonly allowedTools?: readonly string[];
}

export type LinkType = "duplicates" | "relates to";

export interface IssueLink {
  readonly type: LinkType;
  readonly targetKey: string;
}

/**
 * The §11 mutation payload, as data rather than as printed text.
 *
 * A label DELTA rather than a final set, deliberately. §11 requires the write
 * to union against the labels live on the issue and forbids "a bare replacement
 * array"; if the analyst returned a finished set, a human who edited labels
 * between analysis and post would have their edit silently reverted. The delta
 * survives that gap because it is applied, not imposed.
 */
export interface Mutation {
  readonly commentBody: string;
  readonly labelsAdd: readonly string[];
  readonly labelsRemove: readonly string[];
  /** Empty when uncertain or already correct — never a guess. */
  readonly component: string;
  readonly links: readonly IssueLink[];
  readonly commentAction: "create" | "update";
}

export type Confidence = "low" | "med" | "high";

/**
 * Whether a coding agent could be trusted to fix this ticket unattended.
 *
 * An estimate, and a weak one by construction: the analyst has no `--deep`, no
 * `Task`, and no checkout of the repo it is naming, so the call is made from the
 * ticket plus the knowledge vault. It is a candidate signal — the thing that
 * decides a ticket is *worth* looking at — not a warrant. Whatever eventually
 * acts on it reads the code first and is expected to disagree sometimes.
 *
 * The one field with teeth is `solvable`, and it fails closed: absent means
 * false. See the schema for why the whole object is optional.
 */
export interface AgentFitness {
  readonly solvable: boolean;
  /**
   * Not solvable today, but would be if `blockers` were filled in.
   *
   * A second field rather than a third value of the first, and the gate keeps
   * them mutually exclusive. `solvable` cannot carry this signal because it is
   * forced false whenever the verdict is not `ready-ish`, which is every ticket
   * this one is about — so the two are alternatives that happen to be spelled
   * as booleans, and a payload with both true is a contradiction rather than a
   * strong opinion.
   *
   * Fails closed the same way `solvable` does, for a weaker but real reason: a
   * wrong `true` here does not authorise a code change, it authorises a
   * *recurring charge*. The ticket goes on a watch list, and every edit somebody
   * makes to it buys another triage run.
   */
  readonly plausible: boolean;
  readonly confidence: Confidence;
  /** Single repo the fix would land in; empty when unknown or spread across several. */
  readonly repo: string;
  readonly rationale: string;
  /** Empty iff `solvable`, and non-empty whenever `plausible`. */
  readonly blockers: readonly string[];
}

/**
 * An unfilled fill-in placeholder, and the DoR row it stands in for.
 *
 * `row` is what decides whether the placeholder is evidence of a contradiction
 * or merely of a nudge, now that rows 8 and 9 cannot fail an item. See
 * `BLOCKING_DOR_ROWS` for which rows are which, and why an unattributed
 * placeholder is treated as blocking rather than waved through.
 */
export interface DorPlaceholder {
  /** The placeholder verbatim, as it appears in the ticket. */
  readonly text: string;
  /** The DoR checklist row it stands in for, or `UNATTRIBUTED_DOR_ROW`. */
  readonly row: number;
}

/**
 * The DoR rows a leftover placeholder can still fail an item on.
 *
 * Rows 1-3 are the ones that describe whether the ticket is *understood* —
 * problem and segment, value and why-now, testable acceptance criteria. Rows 4-7
 * are auto-filled from research rather than from the ticket body, so a
 * placeholder never stands in for one. Rows 8 and 9 are advisory and block
 * nothing; row 10 is the human Trio gate.
 */
const BLOCKING_DOR_ROWS: ReadonlySet<number> = new Set([1, 2, 3]);

/**
 * The row of a placeholder the model did not attribute, or attributed to a row
 * that does not exist.
 *
 * Treated as **blocking**, which is the one place this change deliberately fails
 * closed. "There is an unfilled placeholder here and I cannot say which row it
 * belongs to" is the exact shape of SSX-3822 — the evidence present, the step
 * from evidence to label missing — and that is the payload this guard exists to
 * refuse. The escape is free and requires only honesty: a model that believes
 * the placeholder is the row 9 baseline says `row: 9` and the item passes.
 */
export const UNATTRIBUTED_DOR_ROW = 0;

export interface TriagePayload {
  readonly verdict: Verdict;
  readonly labels: readonly string[];
  /** Unfilled fill-in placeholders the skill found in the ticket, with their rows. */
  readonly dorPlaceholders: readonly DorPlaceholder[];
  readonly recommendedNextStep: string;
  readonly report: string;
  /** What a write WOULD send. Nothing in this module sends it. */
  readonly mutation: Mutation;
  /** Never absent here even when absent from the model's reply — see `parseAgentFitness`. */
  readonly agentFitness: AgentFitness;
}

export class TriageError extends Error {}

/**
 * The structured verdict contradicts the evidence in the same payload.
 *
 * Raised for the failure this service has now seen twice: a report whose prose
 * is accurate and whose machine-readable field is not. On SSX-3814 the enum
 * offered no honest option and the model said so; on SSX-3822 it wrote
 * "baseline [N] left unfilled" into its own scorecard, flagged the row green,
 * and emitted `dor:pass` + `ready-ish`. Nothing was fabricated either time —
 * the step from evidence to label is what broke, and the label is the only part
 * downstream reads.
 *
 * Re-aimed when DoR rows 8 and 9 became advisory. Both incidents were row 9,
 * and row 9 can no longer fail an item — so the original rule ("any placeholder
 * contradicts a pass") now condemns payloads that are simply correct. What
 * survives the demotion is the rule underneath it: a payload may not assert a
 * pass while its own evidence names a *blocking* row as unmet. So the check now
 * reads the row each placeholder is attributed to, and fires on `BLOCKING_DOR_ROWS`
 * only. The literal SSX-3822 payload — a `[N]` standing in for the baseline
 * metric — is legal today, deliberately: under the advisory rule it is no longer
 * a contradiction.
 *
 * IMPORTANT — this is detection, not prevention. The skill posts its comment
 * mid-run via `addCommentToJiraIssue`; `structured_output` only arrives with
 * the final result event. By the time this throws, a write-enabled run has
 * already commented on the ticket. What it does buy: the contradiction is
 * refused rather than compounded into the local report, the operator is told,
 * and — because the poller does not record a failed key as seen — the next
 * cycle retries. The skill's comment is idempotent on its footer sentinel, so
 * a retry that gets it right updates the comment in place rather than stacking
 * a second one.
 */
export class TriageContradictionError extends TriageError {
  readonly issueKey: string;
  readonly placeholders: readonly DorPlaceholder[];

  constructor(
    issueKey: string,
    placeholders: readonly DorPlaceholder[],
    claims: readonly string[],
  ) {
    const named = placeholders
      .map(
        (p) => `"${p.text}" (${p.row === UNATTRIBUTED_DOR_ROW ? "no row given" : `row ${p.row}`})`,
      )
      .join(", ");
    super(
      `${issueKey}: the ticket still contains ${named}, ` +
        `so a blocking DoR row does not hold — but the run returned ${claims.join(" and ")}. ` +
        `DOR_CHECKLIST.md: "Output dor:pass only if 1-7 hold." Refusing the verdict; ` +
        `if the run was write-enabled, a comment making the same claim is already on the issue.`,
    );
    this.name = "TriageContradictionError";
    this.issueKey = issueKey;
    this.placeholders = placeholders;
  }
}

/**
 * Variables withheld from the triage subprocess.
 *
 * The two halves of this service authenticate to Jira by different means and
 * deliberately so: the poller uses a REST credential to discover *which*
 * tickets are new, and the skill uses the Atlassian MCP session to read what
 * is *in* them. The skill therefore never needs the REST credential, so it
 * does not get it. Inheriting the whole environment would hand it over for no
 * reason, and least privilege is cheap here.
 */
const WITHHELD_FROM_CHILD = /^JIRA_/;

/**
 * Undocumented switch that this service must never be the one to set.
 *
 * It appears in neither the environment-variable reference nor the hooks
 * reference, and the two plausible readings disagree about the value we were
 * using: if it is a presence check, `CLAUDE_SKIP_HOOKS=0` means "skip hooks";
 * if it is a value check, it means "do not skip". This file previously set it
 * to "0" under the comment "safety hooks must stay active" — which, on the
 * first reading, silently disabled the hooks in every triage subprocess and
 * would have made any future PreToolUse guard a no-op that looked installed.
 *
 * Removing it from the child's environment is correct under both readings, so
 * the ambiguity does not need resolving. Hooks are turned off deliberately via
 * the documented `disableAllHooks` setting, not by an inherited variable.
 */
const HOOK_KILL_SWITCH = "CLAUDE_SKIP_HOOKS";

/**
 * The child's environment: ours, minus the Jira REST credential.
 *
 * Exported for testing — that the credential is absent is a property worth
 * asserting, not assuming.
 */
export function childEnv(
  parent: NodeJS.ProcessEnv = process.env,
  vaultPath?: string,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(parent)) {
    if (WITHHELD_FROM_CHILD.test(key) || key === HOOK_KILL_SWITCH) {
      continue;
    }
    result[key] = value;
  }
  // Set last, so a stale value in the operator's own shell cannot win.
  if (vaultPath !== undefined && vaultPath !== "") {
    result["INSURANCE_VAULT"] = vaultPath;
  }
  return result;
}

/**
 * `--no-write` is unconditional, and is the whole point of this half.
 *
 * It is a "pure dry-run" in the skill's own words: it still renders the full
 * §11 mutation payload, which the schema now collects, but it never offers to
 * write. The analyst therefore produces everything needed to post without being
 * able to post any of it.
 */
export function buildPrompt(options: TriageRunOptions): string {
  const flags = [
    "--no-write",
    options.deep ? "--deep" : "",
    options.noHtml === true ? "--no-html" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `/${options.skillName} ${options.issueKey} ${flags}`;
}

/**
 * The tools pre-approved for a run.
 *
 * The metaphor this comment used to reach for was belt and braces: the prompt
 * says `--no-write`, and the permission check catches the model misreading it.
 * The braces were not attached. Omitting a write tool from this list never
 * denied it — that is `ANALYST_DENIED_TOOLS`, passed alongside as
 * `--disallowedTools`, and it is the reason the sentence is safe to make now.
 */
export function toolsFor(options: TriageRunOptions): readonly string[] {
  return options.allowedTools ?? ALLOWED_TOOLS;
}

export function buildArgs(options: TriageRunOptions): string[] {
  const vaultPath = options.vaultPath ?? "";
  return [
    "-p",
    buildPrompt(options),
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    toolsFor(options).join(","),
    // Not a duplicate of the line above. The allowlist pre-approves; only this
    // withholds. See DENIED_BUILTIN_TOOLS for the probe.
    "--disallowedTools",
    ANALYST_DENIED_TOOLS.join(","),
    ...(vaultPath === "" ? [] : ["--add-dir", vaultPath]),
    "--json-schema",
    TRIAGE_SCHEMA_JSON,
  ];
}

/**
 * The accepted verdicts, read off the schema the model was given.
 *
 * Deriving them rather than restating them means the check and the contract
 * cannot disagree — and the annotation makes it a compile error for the schema
 * to offer a verdict `Verdict` has no name for.
 */
const VERDICTS: readonly Verdict[] = TRIAGE_SCHEMA.properties.verdict.enum;

function isVerdict(value: unknown): value is Verdict {
  return typeof value === "string" && VERDICTS.includes(value as Verdict);
}

/**
 * Refuses a payload whose verdict contradicts its own evidence.
 *
 * Checks both the label and the verdict, deliberately. The label is what the
 * skill's own rule is written about; the verdict is what this service actually
 * consumes — it sets the emoji, the sink's heading and anything routed later.
 * Guarding only the label would leave the field that matters unguarded.
 *
 * Exported for testing: the point is not that it exists but that it fires.
 */
export function blockingPlaceholders(
  placeholders: readonly DorPlaceholder[],
): readonly DorPlaceholder[] {
  return placeholders.filter(
    (placeholder) =>
      placeholder.row === UNATTRIBUTED_DOR_ROW || BLOCKING_DOR_ROWS.has(placeholder.row),
  );
}

export function assertDorCoherent(payload: TriagePayload, issueKey: string): void {
  const blocking = blockingPlaceholders(payload.dorPlaceholders);
  if (blocking.length === 0) {
    return;
  }

  const claims = [
    payload.labels.includes("dor:pass") ? "the label dor:pass" : "",
    payload.verdict === "ready-ish" ? 'the verdict "ready-ish"' : "",
  ].filter((claim) => claim !== "");

  if (claims.length === 0) {
    return;
  }

  throw new TriageContradictionError(issueKey, blocking, claims);
}

/**
 * Turns the run's structured output into a payload, or refuses it.
 *
 * Exported because testing `assertDorCoherent` in isolation proved nothing: a
 * mutation that deleted the call from here left the whole suite green. The
 * check has to be exercised through the path the run actually takes.
 */
export function parsePayload(value: unknown, issueKey: string): TriagePayload {
  if (typeof value !== "object" || value === null) {
    throw new TriageError(`No structured output returned for ${issueKey}`);
  }
  const candidate = value as Record<string, unknown>;
  const verdict = candidate["verdict"];
  if (!isVerdict(verdict)) {
    throw new TriageError(`Unrecognised verdict for ${issueKey}: ${String(verdict)}`);
  }

  const payload: TriagePayload = {
    verdict,
    labels: strings(candidate["labels"]),
    dorPlaceholders: dorPlaceholders(candidate["dorPlaceholders"]),
    recommendedNextStep: String(candidate["recommendedNextStep"] ?? ""),
    report: String(candidate["report"] ?? ""),
    mutation: parseMutation(candidate["mutation"]),
    agentFitness: parseAgentFitness(candidate["agentFitness"]),
  };

  assertDorCoherent(payload, issueKey);
  return payload;
}

/**
 * Reads the mutation leniently, because the gate reads it strictly.
 *
 * Nothing here throws on a missing field: an absent comment body becomes `""`,
 * which `assertPostable` then refuses by name. Rejecting twice, in two places,
 * with two different messages would only make the failure harder to read — and
 * a payload that cannot be posted is still worth keeping, since the local
 * report is written either way.
 */
function parseMutation(value: unknown): Mutation {
  const source =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  return {
    commentBody: String(source["commentBody"] ?? ""),
    labelsAdd: strings(source["labelsAdd"]),
    labelsRemove: strings(source["labelsRemove"]),
    component: String(source["component"] ?? ""),
    links: parseLinks(source["links"]),
    commentAction: source["commentAction"] === "update" ? "update" : "create",
  };
}

/** Read off the schema, so the parser cannot accept a level the model was never offered. */
const CONFIDENCES: readonly Confidence[] =
  TRIAGE_SCHEMA.properties.agentFitness.properties.confidence.enum;

/**
 * Reads the fitness object, defaulting every way out to "no".
 *
 * Three separate paths lead to `solvable: false` here: the object is missing,
 * the object is malformed, or `solvable` is anything other than the literal
 * `true`. That is not defensiveness for its own sake — this field is the first
 * one in the service whose `true` eventually authorises a subprocess to edit
 * source, and the asymmetry between a wrong `false` (a human triages the ticket,
 * as they do today) and a wrong `true` (a bot opens a pull request nobody asked
 * for) is not close. Every ambiguity resolves to the cheap mistake.
 *
 * `confidence` falls back to `low` rather than to the model's string, so an
 * unrecognised level cannot be read downstream as a strong one.
 *
 * `plausible` takes the identical `=== true` treatment and is not required by
 * the schema, so an older skill that has never heard of it reads as "not
 * watching this ticket" rather than as a parse failure. That is the whole reason
 * it can be added to a live schema at all: the field is new, every payload
 * currently in flight omits it, and omission has to be the safe answer.
 */
export function parseAgentFitness(value: unknown): AgentFitness {
  const source =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const confidence = source["confidence"];
  return {
    solvable: source["solvable"] === true,
    plausible: source["plausible"] === true,
    confidence: CONFIDENCES.includes(confidence as Confidence) ? (confidence as Confidence) : "low",
    repo: String(source["repo"] ?? ""),
    rationale: String(source["rationale"] ?? ""),
    blockers: strings(source["blockers"]),
  };
}

/**
 * Unknown link types are dropped rather than coerced.
 *
 * The two §11 types differ in consequence — `duplicates` is the one that
 * invites a human to close a ticket — so guessing which was meant is worse than
 * creating no link at all. A dropped link costs a re-run; a wrong one costs
 * somebody's ticket.
 */
function parseLinks(value: unknown): readonly IssueLink[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const links: IssueLink[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const type = record["type"];
    const targetKey = record["targetKey"];
    if (
      (type === "duplicates" || type === "relates to") &&
      typeof targetKey === "string" &&
      targetKey !== ""
    ) {
      links.push({ type, targetKey });
    }
  }
  return links;
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/**
 * Reads the placeholder list, tolerating a model that answers in the old shape.
 *
 * A bare string was the whole field until rows 8 and 9 went advisory, and the
 * skill is prose the model interprets rather than code that is deployed with
 * this file — so a run mid-rollout can still return `["[N]"]`. That parses to an
 * `UNATTRIBUTED_DOR_ROW`, which `blockingPlaceholders` treats as blocking. The
 * old shape therefore keeps the old behaviour exactly, which is the property
 * worth having: the failure mode of a stale skill is the guard being too strict,
 * never it silently switching off.
 */
function dorPlaceholders(value: unknown): readonly DorPlaceholder[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const parsed: DorPlaceholder[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      parsed.push({ text: entry, row: UNATTRIBUTED_DOR_ROW });
      continue;
    }
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const candidate = entry as Record<string, unknown>;
    const text = candidate["text"];
    if (typeof text !== "string" || text === "") {
      continue;
    }
    const row = candidate["row"];
    const valid = typeof row === "number" && Number.isInteger(row) && row >= 1 && row <= 10;
    parsed.push({ text, row: valid ? row : UNATTRIBUTED_DOR_ROW });
  }
  return parsed;
}

export async function runTriage(options: TriageRunOptions): Promise<TriagePayload> {
  logger.info("triage.start", { issueKey: options.issueKey });

  const payload = await runSession(
    {
      executable: options.executable,
      args: buildArgs(options),
      workingDirectory: options.workingDirectory,
      idleMs: options.idleMs,
      maxRunMs: options.maxRunMs,
      env: childEnv(process.env, options.vaultPath),
      requiredMcpServers: options.requiredMcpServers,
      label: `Triage of ${options.issueKey}`,
    },
    (structuredOutput) => parsePayload(structuredOutput, options.issueKey),
  );

  logger.info("triage.done", { issueKey: options.issueKey, verdict: payload.verdict });
  return payload;
}
