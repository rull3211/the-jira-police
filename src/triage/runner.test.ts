import { describe, expect, it } from "vitest";

import {
  ALLOWED_TOOLS,
  McpUnavailableError,
  assertMcpReady,
  buildArgs,
  buildPrompt,
  childEnv,
} from "./runner.ts";

const BASE = {
  issueKey: "SSX-1234",
  skillName: "intake-triage",
  executable: "storecode",
  workingDirectory: "/tmp",
  timeoutMs: 1000,
  noWrite: true,
  deep: false,
  requiredMcpServers: ["atlassian"],
} as const;

describe("buildPrompt", () => {
  it("renders the skill as a slash command", () => {
    expect(buildPrompt({ ...BASE, noWrite: false })).toBe("/intake-triage SSX-1234");
  });

  it("passes --no-write so nothing is published to the ticket", () => {
    expect(buildPrompt(BASE)).toBe("/intake-triage SSX-1234 --no-write");
  });

  it("combines flags", () => {
    expect(buildPrompt({ ...BASE, deep: true })).toBe("/intake-triage SSX-1234 --no-write --deep");
  });

  it("supports swapping in the mock skill", () => {
    expect(buildPrompt({ ...BASE, skillName: "mock-triage" })).toBe(
      "/mock-triage SSX-1234 --no-write",
    );
  });
});

describe("buildArgs", () => {
  it("requests stream-json, which needs --verbose", () => {
    const args = buildArgs(BASE);
    expect(args).toContain("--verbose");
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
  });

  it("uses dontAsk, not acceptEdits", () => {
    // acceptEdits does not auto-approve MCP tools, so the run would hang.
    const args = buildArgs(BASE);
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
  });

  it("never requests bypassPermissions", () => {
    expect(buildArgs(BASE).join(" ")).not.toContain("bypassPermissions");
  });

  it("passes the schema inline, not as a path", () => {
    // Verified against the arg parser: a path is rejected as invalid JSON.
    const schema = buildArgs(BASE)[buildArgs(BASE).indexOf("--json-schema") + 1];
    expect(() => JSON.parse(schema ?? "")).not.toThrow();
  });

  it("defaults the tool allowlist and allows overriding it", () => {
    expect(buildArgs(BASE)[buildArgs(BASE).indexOf("--allowedTools") + 1]).toBe(
      ALLOWED_TOOLS.join(","),
    );
    const mocked = buildArgs({ ...BASE, allowedTools: [] });
    expect(mocked[mocked.indexOf("--allowedTools") + 1]).toBe("");
  });

  it("grants no Jira write tools", () => {
    const granted = ALLOWED_TOOLS.join(" ");
    expect(granted).not.toContain("editJiraIssue");
    expect(granted).not.toContain("addCommentToJiraIssue");
    expect(granted).not.toContain("transitionJiraIssue");
  });
});

describe("assertMcpReady", () => {
  // The failure this guards against: when the Atlassian session has expired the
  // run still exits 0, having produced a verdict without reading the ticket.
  it("accepts a connected server", () => {
    expect(() => assertMcpReady([{ name: "atlassian", status: "connected" }])).not.toThrow();
  });

  it.each(["needs-auth", "failed", "pending", "disabled"])("rejects status %s", (status) => {
    expect(() => assertMcpReady([{ name: "atlassian", status }])).toThrow(McpUnavailableError);
  });

  it("rejects a server that is missing entirely", () => {
    expect(() => assertMcpReady([{ name: "figma", status: "connected" }])).toThrow(/absent/);
  });

  it("ignores unrelated servers", () => {
    expect(() =>
      assertMcpReady([
        { name: "atlassian", status: "connected" },
        { name: "figma", status: "failed" },
      ]),
    ).not.toThrow();
  });

  it("requires nothing when the caller requires nothing", () => {
    // The mock skill reads no data, so demanding Atlassian would fail runs for
    // a reason unrelated to what is under test.
    expect(() => assertMcpReady([], [])).not.toThrow();
  });
});

/**
 * The poller and the skill reach Jira by different routes on purpose: a REST
 * credential to discover which tickets are new, the Atlassian MCP session to
 * read what is in them. The skill has no use for the REST credential, so it
 * must not be handed one.
 */
describe("childEnv", () => {
  it("withholds the Jira REST credential from the subprocess", () => {
    const env = childEnv({ JIRA_AUTH: "placeholder", JIRA_EMAIL: "a@b.c", PATH: "/usr/bin" });

    expect(env["JIRA_AUTH"]).toBeUndefined();
    expect(env["JIRA_EMAIL"]).toBeUndefined();
  });

  it("passes everything else through, since storecode needs the Vertex config", () => {
    const env = childEnv({ PATH: "/usr/bin", CLAUDE_CODE_USE_VERTEX: "1", HOME: "/home/x" });

    expect(env).toMatchObject({
      PATH: "/usr/bin",
      CLAUDE_CODE_USE_VERTEX: "1",
      HOME: "/home/x",
    });
  });

  it("keeps the safety hooks on even if the parent turned them off", () => {
    expect(childEnv({ CLAUDE_SKIP_HOOKS: "1" })["CLAUDE_SKIP_HOOKS"]).toBe("0");
  });

  it("does not mutate the parent environment", () => {
    const parent = { JIRA_AUTH: "placeholder", PATH: "/usr/bin" };
    childEnv(parent);

    expect(parent["JIRA_AUTH"]).toBe("placeholder");
  });
});
