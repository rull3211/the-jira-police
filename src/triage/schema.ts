/**
 * Structured-output contract for a triage run.
 *
 * Passed to Claude Code via `--json-schema`, which takes inline JSON (verified
 * by probing the arg parser: a path argument is rejected with
 * "not valid JSON: Unrecognized token '/'"). Draft-07.
 *
 * When the model's reply does not validate, Claude Code re-prompts and
 * eventually gives up with subtype `error_max_structured_output_retries`, so
 * the schema is kept deliberately small — every extra required field is
 * another way for a run to fail after paying for the work.
 */

export const TRIAGE_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  additionalProperties: false,
  required: ["verdict", "labels", "recommendedNextStep", "report"],
  properties: {
    verdict: {
      type: "string",
      enum: ["duplicate", "not-our-team", "out-of-scope", "needs-info", "ready-ish"],
      // The skill's own banners are ✅ ACCEPT / ⛔ REJECT / ↪ ROUTE / ↩ SEND
      // BACK, so the mapping is spelled out here rather than left to be
      // guessed. `out-of-scope` earns its place the hard way: without it a
      // live run picked `needs-info` as "closest" and said so in its own
      // caveat, which reads as "go ask the reporter" for a ticket that wants
      // nothing of the sort.
      description:
        'The verdict, taken from the report banner. "ACCEPT" is ready-ish. "REJECT → duplicate" (or possible duplicate) is duplicate. "REJECT → out-of-scope" is out-of-scope. "ROUTE" is not-our-team. "SEND BACK" is needs-info.',
    },
    labels: {
      type: "array",
      items: { type: "string" },
      description:
        "Suggested Jira labels, e.g. dup:open, dup:solved, dor:gaps, dor:pass, route:ours, route:other-team.",
    },
    recommendedNextStep: {
      type: "string",
      description: "One sentence: what a human should do with this issue next.",
    },
    report: {
      type: "string",
      description: "The full triage report as markdown, in the language of the source ticket.",
    },
  },
} as const;

export const TRIAGE_SCHEMA_JSON = JSON.stringify(TRIAGE_SCHEMA);
