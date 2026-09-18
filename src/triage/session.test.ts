import { describe, expect, it, vi } from "vitest";

import { createLogger } from "../logger.ts";
import {
  SessionError,
  SessionTimeoutError,
  runSession,
  sessionCost,
  sessionDenials,
  watchdogIntervalFor,
} from "./session.ts";

/**
 * A real `result` event, trimmed to the fields this reads. Kept verbatim rather than rounded: the
 * cost here is dominated by cache-creation tokens rather than by the work itself.
 */
const RESULT = {
  type: "result",
  subtype: "success",
  total_cost_usd: 0.12730375,
  duration_ms: 3123,
  num_turns: 1,
  usage: {
    input_tokens: 2,
    output_tokens: 4,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 20_351,
  },
} as const;

describe("sessionCost", () => {
  it("reads what a real run reported", () => {
    expect(sessionCost({ ...RESULT })).toStrictEqual({
      costUsd: 0.12730375,
      durationMs: 3123,
      turns: 1,
      inputTokens: 2,
      outputTokens: 4,
      cacheReadTokens: 0,
      cacheWriteTokens: 20_351,
    });
  });

  // An absent cost and a free run are different facts; only one is safe to sum.
  it("does not report an absent cost as a free one", () => {
    expect(sessionCost({ type: "result" }).costUsd).toBeNull();
    expect(sessionCost({ type: "result", total_cost_usd: 0 }).costUsd).toBe(0);
  });

  it("keeps a cache read of zero apart from no cache read at all", () => {
    expect(sessionCost({ usage: { cache_read_input_tokens: 0 } }).cacheReadTokens).toBe(0);
    expect(sessionCost({ usage: {} }).cacheReadTokens).toBeNull();
  });

  // `NaN` is a number and would poison a whole day's summed total, not just one run.
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "refuses %p, which would poison every sum it reached",
    (value) => {
      expect(sessionCost({ total_cost_usd: value }).costUsd).toBeNull();
    },
  );

  // Not coerced: a cost arriving as a string means the event shape changed.
  it.each([["0.12"], [null], [undefined], [{}], [[]], [true]])(
    "reports %p as not reported rather than guessing at it",
    (value) => {
      expect(sessionCost({ total_cost_usd: value }).costUsd).toBeNull();
    },
  );

  // A malformed usage block must not turn a solve that worked into one that did not.
  it.each([
    ["a missing usage block", { type: "result" }],
    ["a null usage block", { type: "result", usage: null }],
    ["a usage block that is not an object", { type: "result", usage: "lots" }],
    ["a usage array", { type: "result", usage: [] }],
    ["an empty event", {}],
  ])("cannot be made to throw by %s", (_label, event) => {
    expect(() => sessionCost(event as Record<string, unknown>)).not.toThrow();
  });

  it("reports every field as absent when the event says nothing", () => {
    expect(sessionCost({})).toStrictEqual({
      costUsd: null,
      durationMs: null,
      turns: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
    });
  });
});

describe("sessionDenials", () => {
  /**
   * A real denial shape. `tool_input` is kept in the fixture precisely because it must not come
   * out the other side.
   */
  const DENIED = {
    ...RESULT,
    permission_denials: [
      {
        tool_name: "Write",
        tool_use_id: "toolu_vrtx_01MHNioehxyTTWEqpsv9ioMN",
        tool_input: { file_path: "/tmp/hookprobe/.env", content: "FOO=bar\n" },
      },
    ],
  };

  it("names the tool a real denial refused", () => {
    expect(sessionDenials(DENIED)).toStrictEqual([{ tool: "Write" }]);
  });

  // The refused bytes must not be copied into a log by a later change that carries more through.
  it("does not carry the refused input out with the name", () => {
    expect(Object.keys(sessionDenials(DENIED)[0] ?? {})).toStrictEqual(["tool"]);
  });

  // Read from the array rather than the result's error status, since a stopped run still calls
  // itself a success.
  it("reads a denial off an event reporting success", () => {
    expect(DENIED.subtype).toBe("success");
    expect(sessionDenials(DENIED)).toHaveLength(1);
  });

  // Counted, not deduplicated: attempts and distinct tools are two different facts.
  it("counts every attempt, including a second denial of the same tool", () => {
    expect(
      sessionDenials({
        permission_denials: [{ tool_name: "Write" }, { tool_name: "Write" }, { tool_name: "Read" }],
      }),
    ).toStrictEqual([{ tool: "Write" }, { tool: "Write" }, { tool: "Read" }]);
  });

  it("reports no denials for a run that had none", () => {
    expect(sessionDenials({ ...RESULT })).toStrictEqual([]);
    expect(sessionDenials({ ...RESULT, permission_denials: [] })).toStrictEqual([]);
  });

  // Same rule as `sessionCost`: must not turn a solve that worked into one that did not.
  it.each([
    ["a missing array", {}],
    ["a null array", { permission_denials: null }],
    ["an array that is not one", { permission_denials: "Write" }],
    ["an entry that is not an object", { permission_denials: ["Write", null, 7] }],
    ["an entry with no tool name", { permission_denials: [{ tool_use_id: "toolu_1" }] }],
    ["an entry naming an empty tool", { permission_denials: [{ tool_name: "" }] }],
  ])("survives %s without throwing or inventing a denial", (_label, event) => {
    expect(sessionDenials(event as Record<string, unknown>)).toStrictEqual([]);
  });
});

/**
 * A fake storecode: a node process that prints the events it was handed. Exercises the real
 * line-buffered NDJSON reader without the cost of a real model run per assertion.
 */
function fakeSession(events: readonly Record<string, unknown>[]) {
  const script = events.map((event) => `${JSON.stringify(event)}\n`).join("");
  return {
    executable: process.execPath,
    args: ["-e", `process.stdout.write(${JSON.stringify(script)})`],
    workingDirectory: process.cwd(),
    idleMs: 600_000,
    maxRunMs: 10_000,
    env: process.env,
    requiredMcpServers: [] as readonly string[],
    label: "fake pass of SSX-1234",
  };
}

/**
 * A fake storecode that behaves rather than merely printing. Budgets are in hundreds of
 * milliseconds, which needs `watchdogIntervalFor` to scale the tick down from its fixed default.
 */
function behavingSession(body: string, overrides: Record<string, unknown> = {}) {
  return {
    executable: process.execPath,
    args: ["-e", body],
    workingDirectory: process.cwd(),
    idleMs: 800,
    maxRunMs: 60_000,
    env: process.env,
    requiredMcpServers: [] as readonly string[],
    label: "fake pass of SSX-1234",
    ...overrides,
  };
}

/** Speaks once and then wedges — a child that starts normally and then stops. */
const WEDGED = 'process.stdout.write("starting\\n"); setTimeout(() => {}, 60000)';

// Talks steadily for 2.5s then exits. Deliberately not JSON: liveness is about the process, not the schema.
const CHATTY =
  'const t = setInterval(() => process.stdout.write("still here\\n"), 100); setTimeout(() => clearInterval(t), 2500)';

/**
 * The rejection, typed, and an assertion that there was one — narrows by observing the rejection
 * rather than casting, so a run that unexpectedly succeeds fails here with the reason instead of
 * downstream with a type error.
 */
async function failureOf<E extends Error>(run: Promise<unknown>): Promise<E> {
  try {
    await run;
  } catch (thrown) {
    return thrown as E;
  }
  throw new Error("expected the session to fail, and it resolved");
}

describe("watchdogIntervalFor", () => {
  it("uses the shipped interval for the shipped budgets", () => {
    expect(watchdogIntervalFor(600_000, 1_800_000)).toBe(15_000);
  });

  // Enforcement can only be as fine as the tick; a small budget must not be rounded up past it.
  it("looks at least twice inside the smaller budget", () => {
    expect(watchdogIntervalFor(1000, 60_000)).toBe(500);
    expect(watchdogIntervalFor(60_000, 1000)).toBe(500);
  });

  it("will not become a busy loop for a budget of one millisecond", () => {
    expect(watchdogIntervalFor(1, 1)).toBe(25);
  });
});

describe("runSession budgets", () => {
  // A child producing output must die of the ceiling, never of the silence budget. The idle
  // budget is set well above node's boot time so the test isn't flaky under a loaded machine.
  it("does not charge a streaming pass against the silence budget", async () => {
    const error = await failureOf(
      runSession(behavingSession(CHATTY, { idleMs: 1500, maxRunMs: 60_000 }), () => "parsed"),
    );

    // Ran its full 2.5s and exited on its own; an idle-kind SessionTimeoutError here would mean
    // its chatter stopped resetting the silence budget.
    expect(error).toBeInstanceOf(SessionError);
    expect(error).not.toBeInstanceOf(SessionTimeoutError);
    expect(error.message).toMatch(/without structured output/);
  }, 20_000);

  it("kills a child that has stopped talking", async () => {
    const started = Date.now();
    const error = await failureOf<SessionTimeoutError>(
      runSession(behavingSession(WEDGED, { idleMs: 800 }), () => "parsed"),
    );

    expect(error).toBeInstanceOf(SessionTimeoutError);
    expect(error.kind).toBe("idle");
    expect(error.message).toMatch(/produced no output/);
    // Reaped promptly rather than at the ceiling, which is sixty seconds away.
    expect(Date.now() - started).toBeLessThan(8000);
  });

  // A storecode transcript survives SIGKILL and `--resume <id>` reads it back intact, so this id
  // is the difference between a killed pass being lost work and recoverable by hand.
  it("carries the killed run's session id out with the error", async () => {
    const init = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "a62b6195-ea02-4c62-8331-7cd1ec3b971b",
      mcp_servers: [],
    });
    const error = await failureOf<SessionTimeoutError>(
      runSession(
        behavingSession(`process.stdout.write(${JSON.stringify(`${init}\n`)}); ${WEDGED}`, {
          idleMs: 800,
        }),
        () => "parsed",
      ),
    );

    expect(error).toBeInstanceOf(SessionTimeoutError);
    expect(error.sessionId).toBe("a62b6195-ea02-4c62-8331-7cd1ec3b971b");
  });

  it("reports no session id when the run never named one", async () => {
    const error = await failureOf<SessionTimeoutError>(
      runSession(behavingSession(WEDGED, { idleMs: 800 }), () => "parsed"),
    );

    expect(error).toBeInstanceOf(SessionTimeoutError);
    // Null rather than a placeholder: an operator holding a fake id would go looking for a
    // transcript that does not exist.
    expect(error.sessionId).toBeNull();
  });

  // The clock is jumped forward an hour mid-run to simulate a suspend. The child is silent for
  // the whole hour and must survive it (frozen, not idle) and survive the maxRun ceiling too,
  // since sleep is excluded from both budgets.
  it("does not spend either budget on time the machine was asleep", async () => {
    const realNow = Date.now.bind(Date);
    let offset = 0;
    const now = vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
    const warn = vi.spyOn(createLogger("session"), "warn").mockImplementation(() => {});
    const jump = setTimeout(() => {
      offset = 3_600_000;
    }, 500);

    try {
      const error = await failureOf(
        runSession(
          // Silent for its whole 2.5s life and exits on its own; only the injected hour could
          // produce a SessionTimeoutError here, and it must not.
          behavingSession("setTimeout(() => {}, 2500)", { idleMs: 3000, maxRunMs: 8000 }),
          () => "parsed",
        ),
      );

      expect(error).toBeInstanceOf(SessionError);
      expect(error).not.toBeInstanceOf(SessionTimeoutError);
      // Not an exact match: drift is `now - lastTickAt - tickMs`, so a timer firing slightly
      // before it's due can put the figure up to one tick under the injected value.
      const slept = warn.mock.calls.filter(([event]) => event === "session.slept");
      expect(slept.length).toBeGreaterThan(0);
      const details = slept.map(([, detail]) => detail as { label: string; sleptMs: number });
      const biggest = details.reduce((a, b) => (b.sleptMs > a.sleptMs ? b : a));
      expect(biggest).toMatchObject({ label: "fake pass of SSX-1234" });
      expect(biggest.sleptMs).toBeGreaterThan(3_600_000 - watchdogIntervalFor(3000, 8000));
    } finally {
      clearTimeout(jump);
      now.mockRestore();
      warn.mockRestore();
    }
  }, 20_000);
});

describe("runSession cost reporting", () => {
  it("reports what the run cost", async () => {
    const info = vi.spyOn(createLogger("session"), "info").mockImplementation(() => {});

    await expect(
      runSession(fakeSession([{ ...RESULT, structured_output: { ok: true } }]), () => "parsed"),
    ).resolves.toBe("parsed");

    expect(info).toHaveBeenCalledWith(
      "session.cost",
      expect.objectContaining({ label: "fake pass of SSX-1234", costUsd: 0.12730375, turns: 1 }),
    );
    info.mockRestore();
  });

  // The log line sits above the success check: a failed run has already been paid for, and
  // silently omitting failures would make the total look best on the worst days.
  it("still reports the cost of a run that failed", async () => {
    const info = vi.spyOn(createLogger("session"), "info").mockImplementation(() => {});

    await expect(
      runSession(
        fakeSession([
          { type: "result", subtype: "error_during_execution", total_cost_usd: 0.42, num_turns: 7 },
        ]),
        () => "parsed",
      ),
    ).rejects.toThrow(SessionError);

    expect(info).toHaveBeenCalledWith(
      "session.cost",
      expect.objectContaining({ costUsd: 0.42, turns: 7 }),
    );
    info.mockRestore();
  });
});

describe("runSession denial reporting", () => {
  // Two assertions pulling in opposite directions on purpose: the run resolves, since a denial is
  // material but not fatal (a run can be denied a tool, route around it, and still succeed); and
  // the denial is warned, since the event's own `subtype: "success"` would otherwise hide it.
  it("records a refused tool on a run that otherwise succeeded", async () => {
    const warn = vi.spyOn(createLogger("session"), "warn").mockImplementation(() => {});

    await expect(
      runSession(
        fakeSession([
          {
            ...RESULT,
            structured_output: { ok: true },
            permission_denials: [
              { tool_name: "Write", tool_input: { content: "FOO=bar\n" } },
              { tool_name: "Write", tool_input: { content: "FOO=bar\n" } },
            ],
          },
        ]),
        () => "parsed",
      ),
    ).resolves.toBe("parsed");

    expect(warn).toHaveBeenCalledWith("session.denied", {
      label: "fake pass of SSX-1234",
      count: 2,
      tools: ["Write"],
      sessionId: null,
    });
    warn.mockRestore();
  });

  // `session.denied` is warn-level and meant to be read, so an empty array must say nothing.
  it("says nothing about a run that had no tool refused", async () => {
    const warn = vi.spyOn(createLogger("session"), "warn").mockImplementation(() => {});

    await expect(
      runSession(fakeSession([{ ...RESULT, structured_output: { ok: true } }]), () => "parsed"),
    ).resolves.toBe("parsed");

    expect(warn).not.toHaveBeenCalledWith("session.denied", expect.anything());
    warn.mockRestore();
  });

  // Same placement argument as the cost line: a denial is most interesting on the run it stopped,
  // and that run reaches the result event with a failing `subtype`.
  it("still reports the denial on a run that then failed", async () => {
    const warn = vi.spyOn(createLogger("session"), "warn").mockImplementation(() => {});

    await expect(
      runSession(
        fakeSession([
          {
            type: "result",
            subtype: "error_during_execution",
            permission_denials: [{ tool_name: "Edit" }],
          },
        ]),
        () => "parsed",
      ),
    ).rejects.toThrow(SessionError);

    expect(warn).toHaveBeenCalledWith(
      "session.denied",
      expect.objectContaining({ count: 1, tools: ["Edit"] }),
    );
    warn.mockRestore();
  });
});
