/**
 * The WRITER half: applies an already-decided, already-checked mutation to Jira.
 *
 * It is a separate storecode run rather than plain HTTP for the reason that
 * governs this whole service — the Jira REST credential is for discovery only,
 * so every mutation goes through an Atlassian MCP session and lands as a real
 * Jira user rather than a service account. `childEnv` withholds the REST
 * credential from this subprocess exactly as it does from the analyst.
 *
 * Everything about it is arranged to stop it thinking:
 *
 * - It is not given the skill. The prompt is a direct instruction, so there is
 *   no `/intake-triage` to re-enter and no second opinion to form.
 * - It is not given the vault, Confluence, Grep, Glob or `search`. It could not
 *   redo the duplicate hunt or the DoR assessment if it wanted to.
 * - The comment body arrives verbatim in its prompt and it is told, twice, not
 *   to edit it.
 *
 * What it is NOT is blind. §11 requires the label write to union against
 * whatever is live on the issue, and requires the comment to update in place
 * when one matching both the sentinel and its own authorship already exists.
 * Both are reads, so `getJiraIssue` and `atlassianUserInfo` are granted. The
 * guarantee is therefore not "it cannot see the ticket" but "it has the
 * finished text, and no means of researching an alternative".
 */

import { logger } from "../logger.ts";
import { childEnv } from "./runner.ts";
import type { Mutation } from "./runner.ts";
import { runSession } from "./session.ts";

/**
 * Read tools the write genuinely needs, and no others.
 *
 * `getJiraIssue` supplies the current labels to union against and the existing
 * comments to match the sentinel against. `atlassianUserInfo` answers "which
 * comment is mine" — without it the authorship half of the idempotency rule
 * cannot be evaluated and a re-run stacks a second comment instead of
 * refreshing the first.
 */
const POSTER_READ_TOOLS: readonly string[] = [
  "mcp__atlassian__getJiraIssue",
  "mcp__atlassian__atlassianUserInfo",
  "mcp__atlassian__getIssueLinkTypes",
];

/**
 * The write tools, exactly as named in §11.
 *
 * Conspicuously absent: `transitionJiraIssue`. The skill promises never to
 * change status — "not after a `y`, not for a close-as-duplicate" — and
 * withholding the tool turns that promise into something the service enforces
 * rather than something it trusts. Absent too is every tool the analyst uses to
 * form a view: no `search`, no Confluence, no filesystem.
 */
const POSTER_WRITE_TOOLS: readonly string[] = [
  "mcp__atlassian__editJiraIssue",
  "mcp__atlassian__addCommentToJiraIssue",
  "mcp__atlassian__createIssueLink",
];

export const POSTER_TOOLS: readonly string[] = [...POSTER_READ_TOOLS, ...POSTER_WRITE_TOOLS];

/**
 * What the poster reports back.
 *
 * Small on purpose. Its job has one honest summary — what did you change? —
 * and every extra required field is another way for the run to fail after the
 * writes have already happened.
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
  readonly timeoutMs: number;
}

export class PostError extends Error {}

/**
 * The instruction given to the poster.
 *
 * Written as an imperative checklist rather than a description of a goal.
 * A goal invites judgement, and judgement is the thing that has already been
 * exercised and checked by the time this runs. The one instruction repeated
 * twice is the one whose violation would be hardest to notice afterwards:
 * do not edit the comment text.
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
 * Posts the mutation and returns what the run says it did.
 *
 * A receipt reporting `problems` is logged as an error but does NOT throw. The
 * writes are already applied by then, so failing the ticket would send the
 * poller round again to redo work that partly succeeded; the comment sentinel
 * makes a re-run safe, but a partial success is better surfaced than retried
 * blindly. A receipt saying it skipped the comment entirely is a different
 * matter and does throw — that is the run reporting it did nothing.
 */
export async function runPost(options: PostOptions): Promise<PostReceipt> {
  logger.info("post.start", {
    issueKey: options.issueKey,
    commentAction: options.mutation.commentAction,
  });

  const receipt = await runSession(
    {
      executable: options.executable,
      args: buildPostArgs(options),
      workingDirectory: options.workingDirectory,
      timeoutMs: options.timeoutMs,
      env: childEnv(process.env),
      requiredMcpServers: ["atlassian"],
      label: `Post to ${options.issueKey}`,
    },
    (structuredOutput) => parseReceipt(structuredOutput, options.issueKey),
  );

  if (receipt.problems.length > 0) {
    logger.error("post.partial", { issueKey: options.issueKey, problems: receipt.problems });
  }

  if (receipt.commentAction === "skipped") {
    throw new PostError(
      `${options.issueKey}: the poster did not post the comment. Problems: ${
        receipt.problems.join("; ") || "none reported"
      }`,
    );
  }

  logger.info("post.done", {
    issueKey: options.issueKey,
    commentAction: receipt.commentAction,
    labels: receipt.labelsWritten.length,
    links: receipt.linksCreated.length,
  });
  return receipt;
}
