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

/** Throws a clear error instead of a TypeError when no session was captured. */
function firstSession(): Captured {
  const first = runSession.mock.calls[0]?.[0] as Captured | undefined;
  if (first === undefined) {
    throw new Error("no session was started");
  }
  return first;
}

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
    // Read, Grep and Glob are scoped to whatever directory is passed here.
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
    // The denylist itself is tested in runner.test.ts; this checks that the
    // arguments it builds are the ones that reach the process.
    const session = await capture();

    const denied = session.args[session.args.indexOf("--disallowedTools") + 1] ?? "";
    expect(denied.split(",")).toContain("Bash");
  });

  it("builds each pass's own arguments, so the grant follows the pass", async () => {
    // Recon must never receive Write or Edit; pinning the pass argument here
    // would let that regress silently.
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
    // A fix pass may have written files before dying, so a second attempt is
    // not a retry — it's a pass over a worktree in an unknown state.
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
