import { describe, expect, it } from "vitest";

import { JiraError } from "../jira/client.ts";
import { ALLOWED_TOOLS, ANALYST_DENIED_TOOLS } from "../triage/runner.ts";
import { DENIED_BUILTIN_TOOLS } from "../triage/session.ts";
import {
  PROBE_PROJECT,
  type ProbeCase,
  type ProbeEvidence,
  buildProbeArgs,
  collectEvidence,
  probeCases,
  projectUnused,
  verdictOf,
} from "./probe.ts";

describe("projectUnused", () => {
  it("clears the run only when Jira says it has no such project", async () => {
    const asked: string[] = [];

    const refusal = await projectUnused(async (project) => {
      asked.push(project);
      throw new JiraError(404, "No project could be found");
    });

    expect(refusal).toBeNull();
    expect(asked).toEqual([PROBE_PROJECT]);
  });

  it("refuses when the project exists", async () => {
    await expect(projectUnused(async () => ({ components: [], issueTypes: [] }))).resolves.toMatch(
      /ZZNOPROJ exists in Jira/u,
    );
  });

  // A 403 is Jira declining to say, and the MCP user may see what this one cannot.
  it.each([
    ["no permission", new JiraError(403, "forbidden")],
    ["Jira down", new JiraError(500, "boom")],
    ["no answer", new JiraError(0, "Request failed: fetch failed")],
    ["something that is not a Jira error", new Error("socket hang up")],
    ["a 404 that is not Jira's", Object.assign(new Error("not found"), { status: 404 })],
  ])("refuses on %s, which cannot show the key unused", async (_name, error) => {
    await expect(
      projectUnused(async () => {
        throw error;
      }),
    ).resolves.toMatch(/could not show that ZZNOPROJ does not exist/u);
  });
});

const CASES = probeCases("acme.atlassian.net");

function named(name: string): ProbeCase {
  const found = CASES.find((probe) => probe.name === name);
  if (found === undefined) {
    throw new Error(`no case ${name}`);
  }
  return found;
}

describe("probeCases", () => {
  it("has each case once", () => {
    const names = CASES.map((probe) => probe.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("never names anything but a project that does not exist", () => {
    for (const probe of CASES) {
      const mentioned = JSON.stringify(probe.args).match(/[A-Z][A-Z0-9]+(?=-\d|")/gu) ?? [];
      expect(mentioned.some((key) => key === PROBE_PROJECT)).toBe(true);
      expect(JSON.stringify(probe.args)).not.toMatch(/\bSSX\b/u);
    }
  });

  it("takes the drafting session's tool lists from the code that starts it, not from a copy", () => {
    for (const name of ["draft-readable", "draft-writer"]) {
      expect(named(name).allowed).toBe(ALLOWED_TOOLS);
      expect(named(name).denied).toBe(ANALYST_DENIED_TOOLS);
    }
  });

  it("asks the ungranted case for a tool its allowlist does not hold, and the denylist case for one it names", () => {
    const ungranted = named("writer-ungranted");
    expect(ungranted.allowed).not.toContain(ungranted.tool);

    const wins = named("deny-wins");
    expect(wins.allowed).toContain(wins.tool);
    expect(wins.denied).toContain(wins.tool);
  });

  it("gives each isolating case a control that differs from it only in the list it isolates", () => {
    const control = named("deny-control");
    const wins = named("deny-wins");
    expect({ ...control, name: "", question: "", denied: [], predicts: [] }).toEqual({
      ...wins,
      name: "",
      question: "",
      denied: [],
      predicts: [],
    });
    expect(control.denied).toEqual(DENIED_BUILTIN_TOOLS);
    expect(wins.denied).toEqual([...DENIED_BUILTIN_TOOLS, wins.tool]);
  });

  it("predicts a call that goes through only where the tool is allowed and not denied", () => {
    for (const probe of CASES) {
      const goes = probe.predicts.includes("executed");
      expect(goes).toBe(probe.allowed.includes(probe.tool) && !probe.denied.includes(probe.tool));
    }
  });
});

describe("buildProbeArgs", () => {
  it("passes both lists as the poster does, under dontAsk, asking for one structured field", () => {
    const probe = named("writer-ungranted");

    const args = buildProbeArgs(probe);

    expect(
      args.slice(args.indexOf("--permission-mode"), args.indexOf("--permission-mode") + 2),
    ).toEqual(["--permission-mode", "dontAsk"]);
    expect(args[args.indexOf("--allowedTools") + 1]).toBe(probe.allowed.join(","));
    expect(args[args.indexOf("--disallowedTools") + 1]).toBe(probe.denied.join(","));
    expect(JSON.parse(args[args.indexOf("--json-schema") + 1] ?? "")).toMatchObject({
      required: ["said"],
    });
  });

  it("puts the tool and its arguments in the prompt", () => {
    const probe = named("writer-granted");

    const prompt = buildProbeArgs(probe)[1];

    expect(prompt).toContain(probe.tool);
    expect(prompt).toContain(JSON.stringify(probe.args));
  });
});

const TOOL = "mcp__atlassian__addCommentToJiraIssue";

function stream(...events: readonly Record<string, unknown>[]): ReturnType<typeof collectEvidence> {
  const collector = collectEvidence(TOOL);
  for (const event of events) {
    collector.observe(event);
  }
  return collector;
}

const init = (tools: unknown): Record<string, unknown> => ({
  type: "system",
  subtype: "init",
  ...(tools === undefined ? {} : { tools }),
});

const calls = (name: string, id = "t1"): Record<string, unknown> => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", id, name, input: {} }] },
});

const returns = (text: unknown, id = "t1"): Record<string, unknown> => ({
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: true }] },
});

const finished = (denials: readonly string[] = [], said = "done"): Record<string, unknown> => ({
  type: "result",
  subtype: "success",
  total_cost_usd: 0.05,
  structured_output: { said },
  permission_denials: denials.map((tool) => ({ tool_name: tool })),
});

describe("verdictOf", () => {
  it("calls a refused call denied, whatever else the stream says", () => {
    const { evidence } = stream(
      init([TOOL]),
      calls(TOOL),
      returns("Permission denied"),
      finished([TOOL]),
    );

    expect(verdictOf(evidence())).toBe("denied");
  });

  it("calls a call whose result is not a refusal executed, an error from Jira included", () => {
    const { evidence } = stream(
      calls(TOOL),
      returns("Error calling tool: project ZZNOPROJ does not exist"),
      finished(),
    );

    expect(verdictOf(evidence())).toBe("executed");
  });

  it("calls a call to a tool that is not in the session absent, not executed", () => {
    const { evidence } = stream(
      calls(TOOL),
      returns([{ type: "text", text: "Error: No such tool available: " + TOOL }]),
      finished(),
    );

    expect(verdictOf(evidence())).toBe("absent");
  });

  it("reads a call with no result in the stream as executed, the direction that over-reports a leak", () => {
    expect(verdictOf(stream(calls(TOOL), finished()).evidence())).toBe("executed");
  });

  it("calls a stream with no call to the tool not attempted, whatever the model said", () => {
    const { evidence } = stream(
      init([]),
      calls("mcp__atlassian__getJiraIssue"),
      finished([], "it went through"),
    );

    expect(verdictOf(evidence())).toBe("not-attempted");
    expect(evidence().said).toBe("it went through");
  });

  it("does not take another tool's refusal for this tool's", () => {
    const { evidence } = stream(
      calls(TOOL),
      returns("ok"),
      finished(["mcp__atlassian__createJiraIssue"]),
    );

    expect(verdictOf(evidence())).toBe("executed");
  });

  it("takes executed if any one of several calls ran", () => {
    const { evidence } = stream(
      calls(TOOL, "a"),
      returns("No such tool available", "a"),
      calls(TOOL, "b"),
      returns("Error calling tool: not found", "b"),
      finished(),
    );

    expect(verdictOf(evidence())).toBe("executed");
  });
});

describe("collectEvidence", () => {
  it("records whether the init event listed the tool, and null when it listed none", () => {
    expect(stream(init([TOOL])).evidence().listed).toBe(true);
    expect(stream(init(["Read"])).evidence().listed).toBe(false);
    expect(stream(init(undefined)).evidence().listed).toBeNull();
  });

  it("keeps the cost and the result text, trimmed", () => {
    const { evidence } = stream(calls(TOOL), returns("x".repeat(1000)), finished());

    expect(evidence().cost?.costUsd).toBe(0.05);
    expect(evidence().results[0]).toHaveLength(300);
  });

  it("ignores an event of a shape it does not know rather than throwing inside the line reader", () => {
    const collector = collectEvidence(TOOL);

    expect(() => {
      collector.observe({ type: "assistant", message: "not an object" });
      collector.observe({ type: "user", message: { content: "not a list" } });
      collector.observe({ type: "result", structured_output: 7, permission_denials: "no" });
      collector.observe({});
    }).not.toThrow();
  });
});

describe("a verdict outside the prediction", () => {
  const verdictFor = (evidence: ProbeEvidence): boolean =>
    named("writer-ungranted").predicts.includes(verdictOf(evidence));

  it("is what a leak looks like for a tool that was not granted", () => {
    const { evidence } = stream(calls(TOOL), returns("created"), finished());

    expect(verdictFor(evidence())).toBe(false);
  });
});
