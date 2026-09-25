/**
 * `--json-schema` reaches the API as a tool's `input_schema`, which may not have `oneOf`, `allOf` or `anyOf` at its root.
 * Read off each builder's argv rather than a list of schema constants, so a sixth call site cannot be missed.
 */

import { describe, expect, it } from "vitest";

import { buildCommentArgs } from "./solve/commenter.ts";
import { PASSES, buildSolveArgs } from "./solve/runner.ts";
import { buildPostArgs } from "./triage/poster.ts";
import { buildArgs } from "./triage/runner.ts";
import { buildRelevanceArgs } from "./watch/relevance.ts";

const ROOT_COMBINATORS = ["oneOf", "allOf", "anyOf"];

function schemaIn(argv: readonly string[]): Record<string, unknown> {
  const index = argv.indexOf("--json-schema");
  const value = argv[index + 1];
  if (index === -1 || value === undefined) {
    throw new Error("no --json-schema in this argv");
  }
  return JSON.parse(value) as Record<string, unknown>;
}

const CALL_SITES: readonly (readonly [string, readonly string[]])[] = [
  ...PASSES.map(
    (pass) =>
      [
        `the ${pass} pass`,
        buildSolveArgs(pass, { issueKey: "SSX-1", worktreePath: "/tmp/SSX-1", ticket: "t" }),
      ] as const,
  ),
  ["the solve commenter", buildCommentArgs("SSX-1", "a body")],
  [
    "the triage poster",
    buildPostArgs({
      issueKey: "SSX-1",
      mutation: {
        commentBody: "b",
        labelsAdd: [],
        labelsRemove: [],
        component: "",
        links: [],
        commentAction: "create",
      },
      executable: "storecode",
      workingDirectory: "/tmp",
      idleMs: 1000,
      maxRunMs: 1000,
    }),
  ],
  [
    "the triage analyst",
    buildArgs({
      issueKey: "SSX-1",
      skillName: "intake-triage",
      executable: "storecode",
      workingDirectory: "/tmp",
      idleMs: 1000,
      maxRunMs: 1000,
      deep: false,
      requiredMcpServers: [],
    }),
  ],
  [
    "the relevance check",
    buildRelevanceArgs({ key: "SSX-1", sendback: "s", comments: [], omitted: 0, fields: [] }),
  ],
];

describe("every schema handed to --json-schema", () => {
  for (const [site, argv] of CALL_SITES) {
    it(`${site} has no combinator the API refuses at its root`, () => {
      const schema = schemaIn(argv);
      expect(ROOT_COMBINATORS.filter((keyword) => keyword in schema)).toEqual([]);
    });
  }
});
