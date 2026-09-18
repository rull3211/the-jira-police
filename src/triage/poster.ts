/**
 * The WRITER half: applies an already-decided, checked mutation via its own Atlassian MCP
 * session, never the REST credential — except `updateLabels`, which writes `agent:*` over REST
 * since MCP's `editJiraIssue` has set semantics (`architecture/triage.md` §12).
 *
 * Given no skill, vault or search, so it cannot re-analyse; §11 still requires read access
 * (`getJiraIssue`, `atlassianUserInfo`) so the label union and comment idempotency can be checked.
 */

import { createLogger } from "../logger.ts";
import { childEnv } from "./runner.ts";
import type { Mutation } from "./runner.ts";
import { DENIED_BUILTIN_TOOLS, runSession } from "./session.ts";

const log = createLogger("post");

/**
 * Read tools the write genuinely needs. `getJiraIssue` supplies current labels/comments to match
 * against; `atlassianUserInfo` identifies which comment is the poster's own, for update-in-place.
 */
const POSTER_READ_TOOLS: readonly string[] = [
  "mcp__atlassian__getJiraIssue",
  "mcp__atlassian__atlassianUserInfo",
  "mcp__atlassian__getIssueLinkTypes",
];

/**
 * The write tools, exactly as named in §11. `transitionJiraIssue` is absent deliberately, but
 * absence from `--allowedTools` alone denies nothing — enforcement depends on
 * `POSTER_DENIED_TOOLS`, and whether MCP names are honoured there is unverified.
 */
const POSTER_WRITE_TOOLS: readonly string[] = [
  "mcp__atlassian__editJiraIssue",
  "mcp__atlassian__addCommentToJiraIssue",
  "mcp__atlassian__createIssueLink",
];

export const POSTER_TOOLS: readonly string[] = [...POSTER_READ_TOOLS, ...POSTER_WRITE_TOOLS];

/**
 * Tools withheld from the poster. `Bash` alone would give it `curl`, and therefore the whole
 * Jira API, including the status transition it's told never to make.
 */
export const POSTER_DENIED_TOOLS: readonly string[] = [
  ...DENIED_BUILTIN_TOOLS,
  "mcp__atlassian__transitionJiraIssue",
  "mcp__atlassian__createJiraIssue",
];

/**
 * What the poster reports back, kept small deliberately: every extra required field is another
 * way for the run to fail after the writes have already happened.
 */
export const POST_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  additionalProperties: false,
  required: ["commentAction", "labelsWritten", "linksCreated", "problems"],
  properties: {
    commentAction: {
      type: "string",
      enum: ["created", "updated", "skipped"],
      description: "What actually happened to the comment.",
    },
    labelsWritten: {
      type: "array",
      items: { type: "string" },
      description: "The complete label array as sent to editJiraIssue, after the union.",
    },
    linksCreated: {
      type: "array",
      items: { type: "string" },
      description: 'Links created, e.g. "duplicates SSX-1234". Empty if none.',
    },
    problems: {
      type: "array",
      items: { type: "string" },
      description:
        "Anything that did not go as instructed — a denied tool, a rejected field, a step skipped. Empty if everything applied cleanly. Do not explain successes here.",
    },
  },
} as const;

export interface PostReceipt {
  readonly commentAction: "created" | "updated" | "skipped";
  readonly labelsWritten: readonly string[];
  readonly linksCreated: readonly string[];
  readonly problems: readonly string[];
}

export interface PostOptions {
  readonly issueKey: string;
  readonly mutation: Mutation;
  readonly executable: string;
  readonly workingDirectory: string;
  readonly idleMs: number;
  readonly maxRunMs: number;
}

export class PostError extends Error {}

/**
 * The instruction given to the poster: an imperative checklist, not a goal, since judgement was
 * already exercised and checked upstream. "Do not edit the comment text" is repeated because its
 * violation would be hardest to notice afterwards.
 */
export function buildPostPrompt(options: PostOptions): string {
  const { issueKey, mutation } = options;

  const labelStep =
    mutation.labelsAdd.length === 0 && mutation.labelsRemove.length === 0
      ? "2. LABELS — no change required. Do not call editJiraIssue for labels."
      : [
          "2. LABELS — read the issue's CURRENT labels first, then send the union.",
          `   Add: ${mutation.labelsAdd.join(", ") || "(none)"}`,
          `   Remove: ${mutation.labelsRemove.join(", ") || "(none)"}`,
          "   Send current ∪ add, minus remove. Never send a bare replacement array.",
          "   Leave every label not named above exactly as you found it.",
        ].join("\n");

  const componentStep =
    mutation.component === ""
      ? "3. COMPONENT — no change required."
      : `3. COMPONENT — set components to include "${mutation.component}", merged with any already present. Never remove an existing component.`;

  const linkStep =
    mutation.links.length === 0
      ? "4. LINKS — none to create."
      : [
          "4. LINKS — create exactly these, and no others:",
          ...mutation.links.map((link) => `   ${link.type} → ${link.targetKey}`),
        ].join("\n");

  return [
    `Apply a prepared intake-triage result to Jira issue ${issueKey}.`,
    "",
    "The analysis is already complete and has passed review. You are the write step.",
    "Do NOT re-analyse the issue. Do NOT form your own view of it. Do NOT improve,",
    "reword, translate, reformat or shorten any text below. Apply it as given.",
    "",
    `1. COMMENT — ${
      mutation.commentAction === "update"
        ? "UPDATE the existing intake-triage comment in place. Identify it by BOTH your own Jira account authorship AND the exact footer sentinel line. If no comment satisfies both, create a new one instead."
        : "CREATE a new comment. First confirm none already satisfies BOTH your own Jira account authorship AND the exact footer sentinel line — if one does, update that one instead."
    }`,
    "   Post the following body VERBATIM, byte for byte, between the markers.",
    "   The markers themselves are not part of the body.",
    "",
    "---BEGIN COMMENT BODY---",
    mutation.commentBody,
    "---END COMMENT BODY---",
    "",
    labelStep,
    "",
    componentStep,
    "",
    linkStep,
    "",
    "5. TRANSITION — none. Never change the issue status, for any reason.",
    "",
    "If a step fails, complete the others and record the failure in `problems`.",
    "Report what you actually did, not what you were asked to do.",
  ].join("\n");
}

export function buildPostArgs(options: PostOptions): string[] {
  return [
    "-p",
    buildPostPrompt(options),
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    POSTER_TOOLS.join(","),
    // The allowlist above pre-approves; only this withholds.
    "--disallowedTools",
    POSTER_DENIED_TOOLS.join(","),
    "--json-schema",
    JSON.stringify(POST_SCHEMA),
  ];
}

export function parseReceipt(value: unknown, issueKey: string): PostReceipt {
  if (typeof value !== "object" || value === null) {
    throw new PostError(`No structured output returned by the poster for ${issueKey}`);
  }
  const candidate = value as Record<string, unknown>;
  const action = candidate["commentAction"];
  return {
    commentAction: action === "created" || action === "updated" ? action : "skipped",
    labelsWritten: strings(candidate["labelsWritten"]),
    linksCreated: strings(candidate["linksCreated"]),
    problems: strings(candidate["problems"]),
  };
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/**
 * Whether the labels requested match what the receipt says landed. `problems` is free text that
 * conflates real failures with mere FYIs, so this reads the structured `labelsWritten` array
 * instead — the same rule the gate learned: trust the machine-readable field, not the prose beside it.
 */
export function findLabelDiscrepancies(
  mutation: Mutation,
  receipt: PostReceipt,
): readonly string[] {
  const written = new Set(receipt.labelsWritten);

  return [
    ...mutation.labelsAdd
      .filter((label) => !written.has(label))
      .map((label) => `"${label}" was to be added but is absent from the labels written`),
    ...mutation.labelsRemove
      .filter((label) => written.has(label))
      .map((label) => `"${label}" was to be removed but is still present in the labels written`),
  ];
}

/**
 * Posts the mutation and returns what the run says it did. A receipt with `problems` does not
 * throw — the writes already landed — but a `skipped` comment does, since that means nothing
 * happened. Only a mechanical discrepancy logs at `error`; advisory notes log at `warn`, since an
 * error line on an otherwise clean run trains a team to ignore error lines.
 */
export async function runPost(options: PostOptions): Promise<PostReceipt> {
  log.info("post.start", {
    issueKey: options.issueKey,
    commentAction: options.mutation.commentAction,
  });

  const receipt = await runSession(
    {
      executable: options.executable,
      args: buildPostArgs(options),
      workingDirectory: options.workingDirectory,
      idleMs: options.idleMs,
      maxRunMs: options.maxRunMs,
      env: childEnv(process.env),
      requiredMcpServers: ["atlassian"],
      label: `Post to ${options.issueKey}`,
    },
    (structuredOutput) => parseReceipt(structuredOutput, options.issueKey),
  );

  const discrepancies = findLabelDiscrepancies(options.mutation, receipt);

  if (discrepancies.length > 0) {
    log.error("post.incomplete", {
      issueKey: options.issueKey,
      discrepancies,
      problems: receipt.problems,
    });
  } else if (receipt.problems.length > 0) {
    log.warn("post.notes", { issueKey: options.issueKey, problems: receipt.problems });
  }

  if (receipt.commentAction === "skipped") {
    throw new PostError(
      `${options.issueKey}: the poster did not post the comment. Problems: ${
        receipt.problems.join("; ") || "none reported"
      }`,
    );
  }

  log.info("post.done", {
    issueKey: options.issueKey,
    commentAction: receipt.commentAction,
    labels: receipt.labelsWritten.length,
    links: receipt.linksCreated.length,
  });
  return receipt;
}
