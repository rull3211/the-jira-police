import { describe, expect, it } from "vitest";

import {
  ALLOWED_TOOLS,
  McpUnavailableError,
  WRITE_TOOLS,
  assertMcpReady,
  buildArgs,
  buildPrompt,
  childEnv,
  toolsFor,
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
    expect(buildPrompt(BASE)).toBe("/intake-triage SSX-1234 --no-write");
  });

  it("passes --no-write so nothing is published to the ticket", () => {
    expect(buildPrompt(BASE)).toBe("/intake-triage SSX-1234 --no-write");
  });

  it("passes --yes when the run may write, because no one is there to say y", () => {
    // Without it the skill renders the mutation payload and stops at
    // "[y] post · [n] skip · [e] edit" — a prompt with no operator behind it.
    // The run would burn its whole timeout and publish nothing.
    expect(buildPrompt({ ...BASE, noWrite: false })).toBe("/intake-triage SSX-1234 --yes");
  });

  it("never emits both, and never neither", () => {
    for (const noWrite of [true, false]) {
      const prompt = buildPrompt({ ...BASE, noWrite });
      expect(prompt.includes("--no-write") ? 1 : 0).not.toBe(prompt.includes("--yes") ? 1 : 0);
    }
  });

  it("combines flags", () => {
    expect(buildPrompt({ ...BASE, deep: true })).toBe("/intake-triage SSX-1234 --no-write --deep");
  });

  it("supports swapping in the mock skill", () => {
    expect(buildPrompt({ ...BASE, skillName: "mock-triage" })).toBe(
      "/mock-triage SSX-1234 --no-write",
    );
  });

  it("passes --no-html, since the run has no Write tool to render one with", () => {
    expect(buildPrompt({ ...BASE, noHtml: true })).toBe(
      "/intake-triage SSX-1234 --no-write --no-html",
    );
  });

  it("leaves --no-html off for skills that never write a dashboard", () => {
    expect(buildPrompt(BASE)).not.toContain("--no-html");
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

  it("adds the vault as a working directory so Read can reach it", () => {
    // The vault is a sibling of this repo, not inside it. Without --add-dir the
    // skill's reads land outside every directory the run is allowed to touch.
    const args = buildArgs({ ...BASE, vaultPath: "/vaults/insurance-knowledge-vault" });
    expect(args[args.indexOf("--add-dir") + 1]).toBe("/vaults/insurance-knowledge-vault");
  });

  it("omits --add-dir entirely when there is no vault", () => {
    expect(buildArgs(BASE)).not.toContain("--add-dir");
    expect(buildArgs({ ...BASE, vaultPath: "" })).not.toContain("--add-dir");
  });

  it("does not pass the vault as a prompt flag", () => {
    // It travels as an environment variable instead: a path the model has to
    // parse back out of a prompt string is a path that can be misread.
    expect(buildPrompt({ ...BASE, vaultPath: "/vaults/v" })).not.toContain("/vaults/v");
  });

  it("grants no Jira write tools by default", () => {
    const granted = ALLOWED_TOOLS.join(" ");
    expect(granted).not.toContain("editJiraIssue");
    expect(granted).not.toContain("addCommentToJiraIssue");
    expect(granted).not.toContain("transitionJiraIssue");
  });
});

describe("toolsFor", () => {
  it("withholds the write tools from a preview run", () => {
    // The prompt already says --no-write, but that is a sentence the model
    // could misread. This is a permission check it cannot.
    expect(toolsFor(BASE)).toEqual(ALLOWED_TOOLS);
    expect(toolsFor(BASE).join(" ")).not.toContain("addCommentToJiraIssue");
  });

  it("grants them to a run that is going to write", () => {
    const granted = toolsFor({ ...BASE, noWrite: false });

    for (const tool of WRITE_TOOLS) {
      expect(granted).toContain(tool);
    }
    // Still everything it needs to read, or it would write an uninformed verdict.
    for (const tool of ALLOWED_TOOLS) {
      expect(granted).toContain(tool);
    }
  });

  it("never grants the transition tool, on either side of the switch", () => {
    // The skill promises never to change status — "not after a `y`, not for a
    // close-as-duplicate". Withholding the tool makes that enforceable rather
    // than merely promised, which is the difference that matters if the skill
    // is ever edited upstream.
    for (const noWrite of [true, false]) {
      expect(toolsFor({ ...BASE, noWrite }).join(" ")).not.toContain("transitionJiraIssue");
    }
  });

  it("lets an explicit allowlist win, so the mock can be given nothing", () => {
    expect(toolsFor({ ...BASE, noWrite: false, allowedTools: [] })).toEqual([]);
  });

  it("reaches the command line", () => {
    const args = buildArgs({ ...BASE, noWrite: false });
    expect(args[args.indexOf("--allowedTools") + 1]).toBe(
      [...ALLOWED_TOOLS, ...WRITE_TOOLS].join(","),
    );
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

  it("hands the skill its vault, so it never reaches the ask-a-human branch", () => {
    expect(childEnv({ PATH: "/usr/bin" }, "/vaults/v")["INSURANCE_VAULT"]).toBe("/vaults/v");
  });

  it("overrides a vault path inherited from the operator's shell", () => {
    // Otherwise the service would silently triage against whatever clone
    // happened to be exported in the terminal it was started from.
    expect(childEnv({ INSURANCE_VAULT: "/stale" }, "/vaults/v")["INSURANCE_VAULT"]).toBe(
      "/vaults/v",
    );
  });

  it.each([undefined, ""])("sets nothing for vault path %o", (vaultPath) => {
    expect(childEnv({ PATH: "/usr/bin" }, vaultPath)["INSURANCE_VAULT"]).toBeUndefined();
  });

  it("does not mutate the parent environment", () => {
    const parent = { JIRA_AUTH: "placeholder", PATH: "/usr/bin" };
    childEnv(parent);

    expect(parent["JIRA_AUTH"]).toBe("placeholder");
  });
});
