import { describe, expect, it, vi } from "vitest";

import { createPassRunner, labelFor } from "./passes.ts";
import type { SolveRunOptions } from "./runner.ts";

const runSession = vi.hoisted(() => vi.fn());

vi.mock("../triage/session.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../triage/session.ts")>()),
  runSession,
}));

const options: SolveRunOptions = {
  issueKey: "SSX-3822",
  worktreePath: "/tmp/solve/SSX-3822",
  ticket: "Favicon is missing on the advisor page",
};

interface Captured {
  readonly executable: string;
  readonly args: readonly string[];
  readonly workingDirectory: string;
  readonly timeoutMs: number;
  readonly env: NodeJS.ProcessEnv;
  readonly requiredMcpServers: readonly string[];
  readonly label: string;
}

/**
 * The session options the runner passed, or a failure that says so.
 *
 * `mock.calls[0]?.[0] as Captured` types away a value that may not exist, and
 * a test that TypeErrors on a missing session reports the wrong thing. This
 * says "no session was started", which is the actual finding.
 */
function firstSession(): Captured {
  const first = runSession.mock.calls[0]?.[0] as Captured | undefined;
  if (first === undefined) {
    throw new Error("no session was started");
  }
  return first;
}

/** Runs one pass against the mocked session and returns what it was given. */
async function capture(
  overrides: Partial<SolveRunOptions> = {},
  parentEnv: NodeJS.ProcessEnv = {},
): Promise<Captured> {
  runSession.mockReset();
  runSession.mockImplementation((session: Captured, parse: (value: unknown) => unknown) =>
    parse({ ok: true }),
  );

  const runner = createPassRunner({
    executable: "/bin/storecode",
    idleMs: 600_000,
    maxRunMs: 900_000,
    parentEnv,
  });
  await runner.run("recon", { ...options, ...overrides }, (value) => value);

  return firstSession();
}

describe("createPassRunner", () => {
  it("runs the pass inside the worktree, not the repository", async () => {
    // The session's Read, Grep and Glob are rooted here. This one line is why
    // "it can only see the copy" is structural rather than an instruction.
    const session = await capture();

    expect(session.workingDirectory).toBe("/tmp/solve/SSX-3822");
  });

  it("follows the worktree when the worktree moves", async () => {
    const session = await capture({ worktreePath: "/tmp/solve/SSX-9001" });

    expect(session.workingDirectory).toBe("/tmp/solve/SSX-9001");
  });

  it("withholds the Jira credential from the pass", async () => {
    const session = await capture({}, { JIRA_API_TOKEN: "secret", PATH: "/usr/bin" });

    expect(session.env["JIRA_API_TOKEN"]).toBeUndefined();
    expect(session.env["PATH"]).toBe("/usr/bin");
  });

  it("requires no MCP server, so there is no connection to write Jira through", async () => {
    const session = await capture();

    expect(session.requiredMcpServers).toEqual([]);
  });

  it("passes the vault through to the child environment", async () => {
    const session = await capture({ vaultPath: "/vault" });

    expect(session.env["INSURANCE_VAULT"]).toBe("/vault");
  });

  it("withholds the shell from the session it actually starts", async () => {
    // The denylist is tested in runner.test.ts. This asserts the arguments the
    // real runner builds are the ones that reach the process, which is the
    // join those tests cannot see.
    const session = await capture();

    const denied = session.args[session.args.indexOf("--disallowedTools") + 1] ?? "";
    expect(denied.split(",")).toContain("Bash");
  });

  it("builds each pass's own arguments, so the grant follows the pass", async () => {
    // Hardcoding a pass here survives every other test in this file, and the
    // failure is asymmetric: pinning to `recon` merely breaks the fix pass,
    // while pinning to `fix` hands recon Write and Edit. Recon being unable to
    // write is what keeps "should this be attempted" and "here is the attempt"
    // from collapsing into one answer, so it is asserted at the join and not
    // only where the lists are declared.
    const grant = async (pass: "recon" | "fix"): Promise<readonly string[]> => {
      runSession.mockReset();
      runSession.mockImplementation((_s: Captured, parse: (value: unknown) => unknown) =>
        parse({}),
      );
      const runner = createPassRunner({
        executable: "/bin/storecode",
        idleMs: 600_000,
        maxRunMs: 1000,
      });
      await runner.run(pass, options, (value) => value);
      const { args } = firstSession();
      return (args[args.indexOf("--allowedTools") + 1] ?? "").split(",");
    };

    expect(await grant("recon")).not.toContain("Write");
    expect(await grant("recon")).not.toContain("Edit");
    expect(await grant("fix")).toContain("Write");
    expect(await grant("fix")).toContain("Edit");
  });

  it("names the pass in the prompt it sends", async () => {
    const session = await capture();

    expect(session.args[session.args.indexOf("-p") + 1]).toContain("--recon");
  });

  it("labels the run so two passes on one ticket are distinguishable", async () => {
    const session = await capture();

    expect(session.label).toBe("recon pass of SSX-3822");
  });

  it("returns the parsed value and calls the parser exactly once", async () => {
    runSession.mockReset();
    runSession.mockImplementation((_session: Captured, parse: (value: unknown) => unknown) =>
      parse({ n: 1 }),
    );
    const parse = vi.fn(() => "parsed");

    const runner = createPassRunner({
      executable: "/bin/storecode",
      idleMs: 600_000,
      maxRunMs: 1000,
    });
    const result = await runner.run("fix", options, parse);

    expect(result).toBe("parsed");
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it("does not retry a pass that threw", async () => {
    // A fix pass may have written files before it died. A second attempt is
    // not a retry; it is a pass over a worktree in an unknown state.
    runSession.mockReset();
    runSession.mockRejectedValue(new Error("session died"));

    const runner = createPassRunner({
      executable: "/bin/storecode",
      idleMs: 600_000,
      maxRunMs: 1000,
    });

    await expect(runner.run("fix", options, (value) => value)).rejects.toThrow("session died");
    expect(runSession).toHaveBeenCalledTimes(1);
  });
});

describe("labelFor", () => {
  it("names the pass and the ticket", () => {
    expect(labelFor("simplify", "SSX-1")).toBe("simplify pass of SSX-1");
  });
});
