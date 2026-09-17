import { describe, expect, it } from "vitest";

import { DENIED_BUILTIN_TOOLS } from "./session.ts";
import {
  ALLOWED_TOOLS,
  ANALYST_DENIED_TOOLS,
  McpUnavailableError,
  type Mutation,
  TriageContradictionError,
  TriageError,
  UNATTRIBUTED_DOR_ROW,
  assertDorCoherent,
  assertMcpReady,
  parseAgentFitness,
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
  idleMs: 600_000,
  maxRunMs: 1000,
  deep: false,
  requiredMcpServers: ["atlassian"],
} as const;

const IMAGES = {
  block: "## Images (1)\n\n- /tmp/stage/744806.png — shot.png (image/png, 58997 bytes)",
  directory: "/tmp/stage",
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
    // No combination of options drops it; the analyst decides, `poster.ts` writes.
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
    // `--yes` skips the skill's confirm gate and writes, which made checking-before-posting impossible.
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

  it("puts the staged-image block under the command rather than inside it", () => {
    const prompt = buildPrompt({ ...BASE, images: IMAGES });

    // The first line is parsed as a slash command and its flags; a block joined with a space
    // would arrive as arguments to the skill.
    expect(prompt.split("\n")[0]).toBe("/intake-triage SSX-1234 --no-write");
    expect(prompt).toContain(IMAGES.block);
  });

  it("is byte-identical to an imageless run when staging produced no block", () => {
    // The branch is on the block's content rather than on `images` being present; a presence
    // check would append two blank lines to every ticket with an attachment but no picture.
    expect(buildPrompt({ ...BASE, images: { block: "", directory: null } })).toBe(
      buildPrompt(BASE),
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

  it("withholds the network and subagents, which is what lets this session read pictures", () => {
    // `Task` belongs with the other two: a subagent's tool surface is not this list and is not
    // verified to inherit from it, which would make denying the first two decorative. Read off
    // the command line rather than the constant, since a correct list that never reaches
    // `--disallowedTools` is a failure this could otherwise miss.
    const args = buildArgs(BASE);
    const denied = (args[args.indexOf("--disallowedTools") + 1] ?? "").split(",");

    expect(denied).toEqual(expect.arrayContaining(["WebFetch", "WebSearch", "Task"]));
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

  it("widens the workspace to the staged directory, alongside the vault", () => {
    const args = buildArgs({ ...BASE, images: IMAGES, vaultPath: "/vaults/v" });
    const dirs = args.filter((_, index) => args[index - 1] === "--add-dir");

    expect(dirs).toEqual(["/vaults/v", "/tmp/stage"]);
  });

  it("names no staged directory when nothing was written to disk", () => {
    // An `--add-dir` naming a path that was never created fails the session at startup, turning a
    // ticket with one unreadable attachment into a ticket with no verdict at all.
    const args = buildArgs({ ...BASE, images: { block: "note", directory: null } });

    expect(args).not.toContain("--add-dir");
  });

  it("adds the vault as a working directory so Read can reach it", () => {
    // The vault is a sibling of this repo, not inside it, so without --add-dir it's unreachable.
    const args = buildArgs({ ...BASE, vaultPath: "/vaults/insurance-knowledge-vault" });
    expect(args[args.indexOf("--add-dir") + 1]).toBe("/vaults/insurance-knowledge-vault");
  });

  it("omits --add-dir entirely when there is no vault", () => {
    expect(buildArgs(BASE)).not.toContain("--add-dir");
    expect(buildArgs({ ...BASE, vaultPath: "" })).not.toContain("--add-dir");
  });

  it("does not pass the vault as a prompt flag", () => {
    // Travels as an environment variable instead: a path parsed out of a prompt string can be misread.
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
    // Asserts only that these are not PRE-APPROVED; absence from the allowlist is not denial —
    // that's `--disallowedTools`, asserted separately below.
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

describe("the analyst denylist", () => {
  // --allowedTools pre-approves, it does not restrict — a run given `--allowedTools Read` still
  // used Bash. Every guarantee about what the analyst cannot do rests on these args, not the allowlist.

  it("withholds the shell and both write tools", () => {
    const args = buildArgs(BASE);
    const denied = (args[args.indexOf("--disallowedTools") + 1] ?? "").split(",");

    // Bash is load-bearing: with a shell the run has curl, and with curl the whole Jira REST API.
    expect(denied).toContain("Bash");
    expect(denied).toContain("Write");
    expect(denied).toContain("Edit");
  });

  it("withholds them even when the caller supplies its own allowlist", () => {
    // The mock skill passes `allowedTools: []`; that must not end up denying nothing, which is
    // what would happen if the denylist were derived from the allowlist rather than fixed.
    const args = buildArgs({ ...BASE, allowedTools: [] });

    expect(args[args.indexOf("--disallowedTools") + 1]).toBe(ANALYST_DENIED_TOOLS.join(","));
  });

  it("never pre-approves a tool it also denies", () => {
    // A name in both lists is a contradiction the arg parser resolves silently, in a direction
    // nobody here has checked.
    const overlap = ANALYST_DENIED_TOOLS.filter((tool) => ALLOWED_TOOLS.includes(tool));

    expect(overlap).toEqual([]);
  });

  it("denies every built-in the shared list denies", () => {
    // Guards against a future edit that rebuilds this list by hand and quietly drops one.
    for (const tool of DENIED_BUILTIN_TOOLS) {
      expect(ANALYST_DENIED_TOOLS).toContain(tool);
    }
  });
});

describe("assertMcpReady", () => {
  // Guards against an expired Atlassian session: the run would otherwise exit 0 having produced
  // a verdict without reading the ticket.
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

describe("assertDorCoherent", () => {
  const clean = {
    verdict: "needs-info",
    labels: ["dor:gaps", "route:ours"],
    dorPlaceholders: [],
    recommendedNextStep: "Ask the reporter.",
    report: "## report",
    mutation: MUTATION,
    agentFitness: {
      solvable: false,
      plausible: false,
      confidence: "low",
      repo: "",
      rationale: "Needs a human.",
      blockers: ["no reproduction steps"],
    },
  } as const;

  it("passes a payload with no placeholders", () => {
    expect(() => assertDorCoherent(clean, "SSX-1")).not.toThrow();
  });

  it("passes when placeholders are reported alongside dor:gaps", () => {
    // Must not be punished — the point is to make honest reporting free and contradiction expensive.
    expect(() =>
      assertDorCoherent({ ...clean, dorPlaceholders: [{ text: "[N]", row: 3 }] }, "SSX-1"),
    ).not.toThrow();
  });

  it("allows the exact SSX-3822 payload, because row 9 is now advisory", () => {
    // Row 9 cannot fail an item, so a pass alongside an unfilled baseline is no longer a
    // contradiction. The lever for reverting this is BLOCKING_DOR_ROWS, not this test.
    expect(() =>
      assertDorCoherent(
        {
          ...clean,
          verdict: "ready-ish",
          labels: ["triaged", "dor:pass", "route:ours", "next:to-trio"],
          dorPlaceholders: [{ text: "[N]", row: 9 }],
        },
        "SSX-3822",
      ),
    ).not.toThrow();
  });

  it("still rejects the SSX-3822 shape when the placeholder is on a blocking row", () => {
    // Same payload, one field different: [N] stands in for an acceptance criterion, not a baseline metric.
    expect(() =>
      assertDorCoherent(
        {
          ...clean,
          verdict: "ready-ish",
          labels: ["triaged", "dor:pass", "route:ours", "next:to-trio"],
          dorPlaceholders: [{ text: "[N]", row: 3 }],
        },
        "SSX-3822",
      ),
    ).toThrow(TriageContradictionError);
  });

  it("treats an unattributed placeholder as blocking", () => {
    // Fails closed on purpose; the escape costs the model one honest integer.
    expect(() =>
      assertDorCoherent(
        {
          ...clean,
          verdict: "ready-ish",
          labels: ["dor:pass"],
          dorPlaceholders: [{ text: "[N]", row: UNATTRIBUTED_DOR_ROW }],
        },
        "SSX-1",
      ),
    ).toThrow(TriageContradictionError);
  });

  it("ignores an advisory placeholder sitting beside a blocking one", () => {
    // The message must name the row that actually blocks, or an operator reads
    // the refusal and goes looking for the wrong gap.
    try {
      assertDorCoherent(
        {
          ...clean,
          verdict: "ready-ish",
          labels: ["dor:pass"],
          dorPlaceholders: [
            { text: "[N]", row: 9 },
            { text: "[TBD]", row: 2 },
          ],
        },
        "SSX-1",
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('"[TBD]" (row 2)');
      expect(message).not.toContain("[N]");
    }
  });

  it("catches a bad label even when the verdict is defensible", () => {
    expect(() =>
      assertDorCoherent(
        {
          ...clean,
          verdict: "needs-info",
          labels: ["dor:pass"],
          dorPlaceholders: [{ text: "[TBD]", row: 1 }],
        },
        "SSX-1",
      ),
    ).toThrow(TriageContradictionError);
  });

  it("catches a bad verdict even when the labels are honest", () => {
    // The verdict is what this service actually consumes; guarding only the label leaves it unguarded.
    expect(() =>
      assertDorCoherent(
        {
          ...clean,
          verdict: "ready-ish",
          labels: ["dor:gaps"],
          dorPlaceholders: [{ text: "[N]", row: 3 }],
        },
        "SSX-1",
      ),
    ).toThrow(TriageContradictionError);
  });

  it("names the placeholder and the rule, so the log explains itself", () => {
    try {
      assertDorCoherent(
        {
          ...clean,
          verdict: "ready-ish",
          labels: ["dor:pass"],
          dorPlaceholders: [{ text: "[N]", row: 3 }],
        },
        "SSX-3822",
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("SSX-3822");
      expect(message).toContain('"[N]" (row 3)');
      expect(message).toContain("dor:pass only if 1-7 hold");
      // The operator needs to know Jira may already have been written.
      expect(message).toContain("already on the issue");
    }
  });

  it("is enforced by parsePayload, not merely available to it", () => {
    // Testing this function only in isolation would leave the suite green even if the call to it
    // were deleted from parsePayload, the only path that runs in production.
    expect(() =>
      parsePayload(
        {
          verdict: "ready-ish",
          labels: ["dor:pass"],
          dorPlaceholders: [{ text: "[N]", row: 3 }],
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
          dorPlaceholders: [{ text: "[N]", row: 9 }],
          recommendedNextStep: "Ask for the baseline.",
          report: "## report",
        },
        "SSX-3822",
      ),
    ).toMatchObject({ verdict: "needs-info", dorPlaceholders: [{ text: "[N]", row: 9 }] });
  });

  it("reads a legacy bare string as unattributed, so a stale skill fails closed", () => {
    // The skill is prose the model interprets, not code deployed with this file, so a run
    // mid-rollout can still answer in the old shape.
    expect(() =>
      parsePayload(
        {
          verdict: "ready-ish",
          labels: ["dor:pass"],
          dorPlaceholders: ["[N]"],
          report: "## report",
        },
        "SSX-3822",
      ),
    ).toThrow(TriageContradictionError);
  });

  it("reads a row outside 1-10 as unattributed rather than trusting it", () => {
    expect(
      parsePayload(
        {
          verdict: "needs-info",
          labels: ["dor:gaps"],
          dorPlaceholders: [{ text: "[N]", row: 42 }],
          report: "## report",
        },
        "SSX-1",
      ).dorPlaceholders,
    ).toEqual([{ text: "[N]", row: UNATTRIBUTED_DOR_ROW }]);
  });

  it("drops a placeholder with no text, since there is nothing to point at", () => {
    expect(
      parsePayload(
        {
          verdict: "needs-info",
          labels: ["dor:gaps"],
          dorPlaceholders: [{ row: 3 }, { text: "", row: 3 }, null],
          report: "## report",
        },
        "SSX-1",
      ).dorPlaceholders,
    ).toEqual([]);
  });

  it("treats a missing dorPlaceholders field as empty rather than crashing", () => {
    // Older skills, and the two stand-ins, may not emit it at all.
    expect(
      parsePayload({ verdict: "ready-ish", labels: ["dor:pass"], report: "x" }, "SSX-1")
        .dorPlaceholders,
    ).toEqual([]);
  });

  it("is a TriageError, so the poller's existing handling applies", () => {
    // The key is not recorded as seen, so the next cycle retries; the comment is idempotent, so a
    // better run overwrites it.
    const error = new TriageContradictionError(
      "SSX-1",
      [{ text: "[N]", row: 3 }],
      ["the label dor:pass"],
    );
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
      // The variable is documented nowhere; absent is the only value that means "hooks on" under
      // both plausible readings of it.
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

describe("parseAgentFitness", () => {
  // Every test here answers "no" when not told a clear yes: `solvable: true` authorises a
  // subprocess to edit source, and a wrong `false` is far cheaper than a wrong `true`.

  it.each([undefined, null, "yes", 42, [], "{}"])("reads %o as not solvable", (value) => {
    expect(parseAgentFitness(value).solvable).toBe(false);
  });

  it("reads an object that never mentions solvable as not solvable", () => {
    expect(parseAgentFitness({ confidence: "high", repo: "x" }).solvable).toBe(false);
  });

  it.each(["true", 1, "TRUE", {}])("does not accept the truthy-but-not-true %o", (solvable) => {
    // A JSON schema constrains a well-behaved reply, not a malformed one, and
    // this is the field where coercion would be most expensive.
    expect(parseAgentFitness({ solvable }).solvable).toBe(false);
  });

  it.each([undefined, null, "yes", 1, "true", {}])("reads plausible %o as no watch", (value) => {
    // A wrong `true` here authorises a recurring triage run, not a code change. `plausible` also
    // isn't schema-required, so its absence is the ordinary case, not a malformed reply.
    expect(parseAgentFitness({ plausible: value }).plausible).toBe(false);
  });

  it("reads a well-formed plausible", () => {
    expect(parseAgentFitness({ plausible: true }).plausible).toBe(true);
  });

  it("accepts a well-formed yes", () => {
    expect(
      parseAgentFitness({
        solvable: true,
        plausible: false,
        confidence: "high",
        repo: "buy-insurance-advisor-web",
        rationale: "One file.",
        blockers: [],
      }),
    ).toEqual({
      solvable: true,
      plausible: false,
      confidence: "high",
      repo: "buy-insurance-advisor-web",
      rationale: "One file.",
      blockers: [],
    });
  });

  it.each(["certain", "medium", "", undefined, 3])(
    "downgrades the unrecognised confidence %o to low",
    (confidence) => {
      // Falling back to the model's own string would let an unknown level be
      // read downstream as a strong one purely by not matching "low".
      expect(parseAgentFitness({ solvable: true, confidence }).confidence).toBe("low");
    },
  );

  it("drops non-string blockers rather than stringifying them", () => {
    expect(parseAgentFitness({ blockers: ["real", 7, null] }).blockers).toEqual(["real"]);
  });

  it("is applied by parsePayload, not merely available to it", () => {
    // Testing the helper in isolation proves nothing if deleting its call site leaves the suite green.
    const parsed = parsePayload(
      {
        verdict: "ready-ish",
        labels: [],
        dorPlaceholders: [],
        recommendedNextStep: "Go.",
        report: "## report",
        mutation: {},
        agentFitness: { solvable: true, confidence: "med", repo: "r", rationale: "", blockers: [] },
      },
      "SSX-1",
    );

    expect(parsed.agentFitness).toEqual({
      solvable: true,
      plausible: false,
      confidence: "med",
      repo: "r",
      rationale: "",
      blockers: [],
    });
  });

  it("gives parsePayload a declining fitness when the field is absent", () => {
    // `agentFitness` is optional on purpose: the ordinary path for a run that volunteers no opinion.
    const parsed = parsePayload(
      {
        verdict: "needs-info",
        labels: [],
        dorPlaceholders: [],
        recommendedNextStep: "Ask.",
        report: "## report",
        mutation: {},
      },
      "SSX-1",
    );

    expect(parsed.agentFitness.solvable).toBe(false);
  });
});
