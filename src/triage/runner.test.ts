import { describe, expect, it } from "vitest";

import {
  ALLOWED_TOOLS,
  McpUnavailableError,
  assertMcpReady,
  buildArgs,
  buildPrompt,
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
