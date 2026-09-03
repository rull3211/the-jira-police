import { describe, expect, it } from "vitest";

import {
  ALLOWED_TOOLS,
  McpUnavailableError,
  type Mutation,
  TriageContradictionError,
  TriageError,
  assertDorCoherent,
  assertMcpReady,
  parsePayload,
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
  deep: false,
  requiredMcpServers: ["atlassian"],
} as const;

const MUTATION: Mutation = {
  commentBody: "## report",
  labelsAdd: [],
  labelsRemove: [],
  component: "",
  links: [],
  commentAction: "create",
};

describe("buildPrompt", () => {
  it("renders the skill as a slash command", () => {
    expect(buildPrompt(BASE)).toBe("/intake-triage SSX-1234 --no-write");
  });

  it("passes --no-write unconditionally, so this half can never publish", () => {
    // There is no combination of options that drops it. The analyst decides;
    // `poster.ts` writes, and only after the gate has agreed.
    for (const options of [
      BASE,
      { ...BASE, deep: true },
      { ...BASE, noHtml: true },
      { ...BASE, skillName: "mock-triage" },
      { ...BASE, vaultPath: "/vaults/v" },
    ]) {
      expect(buildPrompt(options)).toContain("--no-write");
    }
  });

  it("never passes --yes, which is what used to make the skill post mid-run", () => {
    // `--yes` skips the skill's confirm gate and writes. Its removal is the
    // change that made checking-before-posting possible at all: while the write
    // happened inside this run, structured_output arrived too late to stop it.
    expect(buildPrompt({ ...BASE, deep: true, noHtml: true })).not.toContain("--yes");
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
  it("grants the analyst no way to mutate a ticket", () => {
    // The prompt already says --no-write, but that is a sentence the model
    // could misread. This is a permission check it cannot. Every one of these
    // is a tool the old write-enabled run was granted.
    const granted = toolsFor(BASE).join(" ");

    for (const tool of [
      "editJiraIssue",
      "addCommentToJiraIssue",
      "createIssueLink",
      "transitionJiraIssue",
    ]) {
      expect(granted).not.toContain(tool);
    }
  });

  it("defaults to the read allowlist", () => {
    expect(toolsFor(BASE)).toEqual(ALLOWED_TOOLS);
  });

  it("lets an explicit allowlist win, so the mock can be given nothing", () => {
    expect(toolsFor({ ...BASE, allowedTools: [] })).toEqual([]);
  });

  it("reaches the command line", () => {
    const args = buildArgs(BASE);
    expect(args[args.indexOf("--allowedTools") + 1]).toBe(ALLOWED_TOOLS.join(","));
  });
});

describe("assertMcpReady", () => {
  // The failure this guards against: when the Atlassian session has expired the
  // run still exits 0, having produced a verdict without reading the ticket.
  it("accepts a connected server", () => {
    expect(() =>
      assertMcpReady([{ name: "atlassian", status: "connected" }], ["atlassian"]),
    ).not.toThrow();
  });

  it.each(["needs-auth", "failed", "pending", "disabled"])("rejects status %s", (status) => {
    expect(() => assertMcpReady([{ name: "atlassian", status }], ["atlassian"])).toThrow(
      McpUnavailableError,
    );
  });

  it("rejects a server that is missing entirely", () => {
    expect(() => assertMcpReady([{ name: "figma", status: "connected" }], ["atlassian"])).toThrow(
      /absent/,
    );
  });

  it("ignores unrelated servers", () => {
    expect(() =>
      assertMcpReady(
        [
          { name: "atlassian", status: "connected" },
          { name: "figma", status: "failed" },
        ],
        ["atlassian"],
      ),
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
describe("assertDorCoherent", () => {
  const clean = {
    verdict: "needs-info",
    labels: ["dor:gaps", "route:ours"],
    dorPlaceholders: [],
    recommendedNextStep: "Ask the reporter.",
    report: "## report",
    mutation: MUTATION,
  } as const;

  it("passes a payload with no placeholders", () => {
    expect(() => assertDorCoherent(clean, "SSX-1")).not.toThrow();
  });

  it("passes when placeholders are reported alongside dor:gaps", () => {
    // This is the correct handling, and it must not be punished — the whole
    // point is to make honest reporting free and contradiction expensive.
    expect(() => assertDorCoherent({ ...clean, dorPlaceholders: ["[N]"] }, "SSX-1")).not.toThrow();
  });

  it("rejects the exact SSX-3822 payload that reached the board", () => {
    // Reconstructed from the posted comment and the labels now on the issue.
    // DOR_CHECKLIST.md line 28: "Output dor:pass only if 1-9 hold." Row 9 is
    // the baseline metric, and the run's own scorecard said it was "[N]".
    expect(() =>
      assertDorCoherent(
        {
          ...clean,
          verdict: "ready-ish",
          labels: ["triaged", "dor:pass", "route:ours", "next:to-trio"],
          dorPlaceholders: ["[N]"],
        },
        "SSX-3822",
      ),
    ).toThrow(TriageContradictionError);
  });

  it("catches a bad label even when the verdict is defensible", () => {
    expect(() =>
      assertDorCoherent(
        { ...clean, verdict: "needs-info", labels: ["dor:pass"], dorPlaceholders: ["[TBD]"] },
        "SSX-1",
      ),
    ).toThrow(TriageContradictionError);
  });

  it("catches a bad verdict even when the labels are honest", () => {
    // The verdict is the field this service actually consumes — it sets the
    // emoji and the sink heading — so guarding only the label would leave the
    // one that matters unguarded.
    expect(() =>
      assertDorCoherent(
        { ...clean, verdict: "ready-ish", labels: ["dor:gaps"], dorPlaceholders: ["[N]"] },
        "SSX-1",
      ),
    ).toThrow(TriageContradictionError);
  });

  it("names the placeholder and the rule, so the log explains itself", () => {
    try {
      assertDorCoherent(
        { ...clean, verdict: "ready-ish", labels: ["dor:pass"], dorPlaceholders: ["[N]"] },
        "SSX-3822",
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("SSX-3822");
      expect(message).toContain('"[N]"');
      expect(message).toContain("dor:pass only if 1-9 hold");
      // The operator needs to know Jira may already have been written.
      expect(message).toContain("already on the issue");
    }
  });

  it("is enforced by parsePayload, not merely available to it", () => {
    // Regression: an earlier version tested this function directly and nothing
    // else. Deleting the call from parsePayload kept every test green, which
    // meant the guard was decorative on the only path that runs in production.
    expect(() =>
      parsePayload(
        {
          verdict: "ready-ish",
          labels: ["dor:pass"],
          dorPlaceholders: ["[N]"],
          recommendedNextStep: "Queue it.",
          report: "## report",
        },
        "SSX-3822",
      ),
    ).toThrow(TriageContradictionError);
  });

  it("lets a coherent payload through parsePayload untouched", () => {
    expect(
      parsePayload(
        {
          verdict: "needs-info",
          labels: ["dor:gaps"],
          dorPlaceholders: ["[N]"],
          recommendedNextStep: "Ask for the baseline.",
          report: "## report",
        },
        "SSX-3822",
      ),
    ).toMatchObject({ verdict: "needs-info", dorPlaceholders: ["[N]"] });
  });

  it("treats a missing dorPlaceholders field as empty rather than crashing", () => {
    // Older skills, and the two stand-ins, may not emit it at all.
    expect(
      parsePayload({ verdict: "ready-ish", labels: ["dor:pass"], report: "x" }, "SSX-1")
        .dorPlaceholders,
    ).toEqual([]);
  });

  it("is a TriageError, so the poller's existing handling applies", () => {
    // Which means the key is not recorded as seen and the next cycle retries —
    // and the skill's comment is idempotent, so a better run overwrites it.
    const error = new TriageContradictionError("SSX-1", ["[N]"], ["the label dor:pass"]);
    expect(error).toBeInstanceOf(TriageError);
  });
});

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

  it.each(["1", "0", "true", ""])(
    "strips the undocumented hook kill switch, whatever the parent set it to (%o)",
    (value) => {
      // Never forwarded and never set. The variable is documented nowhere, and
      // the reading that treats it as a presence check would mean the "0" this
      // file used to set was disabling every safety hook in the subprocess —
      // the opposite of what its comment claimed. Absent is the only value that
      // means "hooks on" under both readings.
      expect(childEnv({ PATH: "/usr/bin", CLAUDE_SKIP_HOOKS: value })).not.toHaveProperty(
        "CLAUDE_SKIP_HOOKS",
      );
    },
  );

  it("still forwards everything else", () => {
    expect(childEnv({ PATH: "/usr/bin", CLAUDE_SKIP_HOOKS: "1" })["PATH"]).toBe("/usr/bin");
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
