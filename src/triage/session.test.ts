import { describe, expect, it, vi } from "vitest";

import { logger } from "../logger.ts";
import {
  SessionError,
  SessionTimeoutError,
  runSession,
  sessionCost,
  sessionDenials,
  watchdogIntervalFor,
} from "./session.ts";

/**
 * A real `result` event, trimmed to the fields this reads.
 *
 * The numbers are from an actual `storecode -p "say ok"` run on 2026-09-04 —
 * two input tokens, four output tokens, twelve cents. Kept verbatim rather than
 * rounded to something tidy, because the whole point of the shape is that the
 * cost is dominated by the 20k cache-creation tokens rather than by the work.
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

  // The distinction the whole `number | null` shape exists for. A run that did
  // not say what it cost and a run that cost nothing are different facts, and
  // only one of them should be safe to add to a total.
  it("does not report an absent cost as a free one", () => {
    expect(sessionCost({ type: "result" }).costUsd).toBeNull();
    expect(sessionCost({ type: "result", total_cost_usd: 0 }).costUsd).toBe(0);
  });

  it("keeps a cache read of zero apart from no cache read at all", () => {
    expect(sessionCost({ usage: { cache_read_input_tokens: 0 } }).cacheReadTokens).toBe(0);
    expect(sessionCost({ usage: {} }).cacheReadTokens).toBeNull();
  });

  // `NaN` is a number, and one of these in a day's worth of runs would make the
  // whole day's total `NaN` rather than merely wrong by one run.
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "refuses %p, which would poison every sum it reached",
    (value) => {
      expect(sessionCost({ total_cost_usd: value }).costUsd).toBeNull();
    },
  );

  // Not coerced. A cost arriving as a string means the event shape changed, and
  // a silent `Number("0.12")` would hide that for as long as it kept working.
  it.each([["0.12"], [null], [undefined], [{}], [[]], [true]])(
    "reports %p as not reported rather than guessing at it",
    (value) => {
      expect(sessionCost({ total_cost_usd: value }).costUsd).toBeNull();
    },
  );

  // Telemetry attached to a verdict that has already been decided. If this can
  // throw, a malformed usage block turns a solve that worked into one that did
  // not — the tail wagging the dog.
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
   * A real denial, captured 2026-09-06 from a nested headless run whose `Write`
   * was refused by a local guard.
   *
   * The `tool_input` is kept in the fixture precisely because it must not come
   * out the other side: this is the shape of the field, and its content is the
   * body of a `.env` write, which is what a denial's input looks like when it
   * is worth denying.
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

  // The guard, not the formatting. `toStrictEqual` above would already fail on
  // an extra key, but this says why in the name: the refused bytes must not be
  // copied into a log by a later change that helpfully carries more through.
  it("does not carry the refused input out with the name", () => {
    expect(Object.keys(sessionDenials(DENIED)[0] ?? {})).toStrictEqual(["tool"]);
  });

  // The run that was stopped still calls itself a success, which is the entire
  // reason this array is read rather than the result's error status.
  it("reads a denial off an event reporting success", () => {
    expect(DENIED.subtype).toBe("success");
    expect(sessionDenials(DENIED)).toHaveLength(1);
  });

  // Counted, not deduplicated. The model retries a refused call under another
  // tool, so the number of attempts and the number of tools are two facts.
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

  // Same rule as `sessionCost`: telemetry attached to a verdict already
  // reached must not be able to turn a solve that worked into one that did not.
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
 * A fake storecode: a node process that prints the events it was handed.
 *
 * Cheaper and more honest than mocking `spawn` — it exercises the real
 * line-buffered NDJSON reader, which is the part of `runSession` most likely to
 * be broken by a change to it. The cost of a real model run per assertion is
 * why nothing else in this file spawns anything.
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
 * A fake storecode that behaves rather than merely printing.
 *
 * The budgets here are in hundreds of milliseconds, which is the whole reason
 * `watchdogIntervalFor` is a function: a fixed fifteen-second tick would make
 * every assertion below either a fifteen-second wait or a lie.
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

/**
 * Speaks once and then wedges, which is the case worth testing.
 *
 * A child that never says anything would also be caught by a deadline armed at
 * spawn; a child that starts normally and then stops is the one the old
 * mechanism could not see, because from its point of view a healthy long run
 * and a run that died after ten seconds look identical until the budget
 * expires.
 */
const WEDGED = 'process.stdout.write("starting\\n"); setTimeout(() => {}, 60000)';

/**
 * Talks steadily for 2.5s and then exits of its own accord.
 *
 * Deliberately not JSON: a line this module cannot parse is still proof the
 * child is alive, and liveness is a question about the process rather than
 * about the schema.
 */
const CHATTY =
  'const t = setInterval(() => process.stdout.write("still here\\n"), 100); setTimeout(() => clearInterval(t), 2500)';

/**
 * The rejection, typed, and an assertion that there was one.
 *
 * `runSession` resolves to whatever the parser returned, so the obvious
 * `runSession(...).catch((thrown) => thrown as SessionTimeoutError)` awaits a
 * union with that value in it and every property read off the result is a type
 * error. The cast is also a lie in the case that matters: a run which
 * unexpectedly *succeeded* would carry the parsed value into the assertions
 * below and fail somewhere that says nothing about why. This narrows by
 * observing the rejection rather than by asserting it, and a resolution stops
 * here with the reason.
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

  // Enforcement can only be as fine as the tick, so a budget near or below the
  // interval would otherwise be silently rounded up to it.
  it("looks at least twice inside the smaller budget", () => {
    expect(watchdogIntervalFor(1000, 60_000)).toBe(500);
    expect(watchdogIntervalFor(60_000, 1000)).toBe(500);
  });

  it("will not become a busy loop for a budget of one millisecond", () => {
    expect(watchdogIntervalFor(1, 1)).toBe(25);
  });
});

describe("runSession budgets", () => {
  /**
   * The bug this whole mechanism replaced, stated as a test.
   *
   * A child that is producing output is working, and the old single
   * `setTimeout` armed at spawn could not tell it from one that had wedged in
   * the first second. This child talks continuously and must therefore die of
   * the ceiling and never of the silence budget.
   *
   * The mutation: delete the `lastActivityAt = Date.now()` in the stdout
   * handler and this fails, killed as `idle` at 1.5s.
   *
   * The budget is well above what node needs to boot, deliberately. The silence
   * clock starts at spawn — correct in production, where it is ten minutes
   * against a startup measured in hundreds of milliseconds — but an earlier
   * draft of this test set it to 300ms and passed alone while failing inside
   * the full suite, where the machine is busy enough that the child had not
   * started before its budget expired.
   */
  it("does not charge a streaming pass against the silence budget", async () => {
    const error = await failureOf(
      runSession(behavingSession(CHATTY, { idleMs: 1500, maxRunMs: 60_000 }), () => "parsed"),
    );

    // It ran its full 2.5 seconds and exited on its own, so it was never
    // killed — the failure here would be a SessionTimeoutError of kind
    // `idle`, and the only thing keeping it alive is that its own chatter
    // keeps resetting the budget.
    expect(error).toBeInstanceOf(SessionError);
    expect(error).not.toBeInstanceOf(SessionTimeoutError);
    expect(error.message).toMatch(/without structured output/);
  }, 20_000);

  /**
   * The path that had no test at all before this change: nothing anywhere
   * asserted that a child is ever actually killed.
   */
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

  /**
   * The resume handle, and the reason the init event is now read for more than
   * its MCP block.
   *
   * Probed 2026-09-06: a storecode transcript is written as the run goes,
   * survives `SIGKILL`, and `--resume <id>` reads it back with the completed
   * turns intact. So this id is the difference between a killed pass being lost
   * work and being recoverable by hand. It exists nowhere else once the child
   * is gone.
   */
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

    // That it was the budget which killed it, rather than something else
    // producing a null id for an unrelated reason.
    expect(error).toBeInstanceOf(SessionTimeoutError);
    // Null rather than a placeholder: an operator holding a fake id would go
    // looking for a transcript that does not exist.
    expect(error.sessionId).toBeNull();
  });

  /**
   * Machine sleep, which is the failure that killed a recon on SSX-3831 that
   * had done nothing wrong.
   *
   * The clock is jumped forward an hour mid-run, which is what a suspend looks
   * like from inside this process whether or not the platform's monotonic clock
   * ticks through one. The child is silent for the whole hour and must survive
   * it, because it was frozen rather than quiet — and it must survive the
   * sixty-second ceiling too, since that is sleep-excluded for the same reason.
   *
   * The mutation: delete the drift branch and this fails, killed as `idle`.
   */
  it("does not spend either budget on time the machine was asleep", async () => {
    const realNow = Date.now.bind(Date);
    let offset = 0;
    const now = vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const jump = setTimeout(() => {
      offset = 3_600_000;
    }, 500);

    try {
      const error = await failureOf(
        runSession(
          // The child is silent for its whole 2.5s life, which is inside both
          // budgets; the injected hour is the only thing that could blow
          // either, and it must blow neither. It exits by itself, so the only
          // way this run produces a SessionTimeoutError is by being killed.
          behavingSession("setTimeout(() => {}, 2500)", { idleMs: 3000, maxRunMs: 8000 }),
          () => "parsed",
        ),
      );

      expect(error).toBeInstanceOf(SessionError);
      expect(error).not.toBeInstanceOf(SessionTimeoutError);
      // Not an exact match: drift is `now - lastTickAt - tickMs`, so the figure
      // carries the tick's scheduling jitter and is inherently up to one whole
      // interval out. The comment here used to say that and then assert
      // `>= 3_600_000` against an observed 3_600_001 — one millisecond of
      // margin, which is pinning the millisecond by another name. That
      // assertion failed intermittently under a loaded full-suite run.
      //
      // Two things are ruled out by measurement rather than by argument. Node
      // re-arms an interval after its callback returns, so a gap is never
      // shorter than the period — probed directly at a 300ms interval with a
      // 700ms block inside one tick: gaps 301, 301, 300, 700, 301, and none
      // below the period. And `lastTickAt` is seeded before `setInterval` is
      // created, so the first gap is at least a full interval. The injected
      // hour's own drift can therefore only ever land at or above 3_600_000,
      // which means the value that failed was a *different* `session.slept`
      // event — and the label cannot tell them apart, because every session in
      // this file is built with the same one.
      //
      // So: the largest event rather than the first, and a tolerance of one
      // tick rather than none. What is being claimed is that an hour of machine
      // sleep was credited as sleep, not that it was measured to the
      // millisecond. The exact source of the extra event is not established —
      // it did not reproduce in 28 clean runs, nor under ten spinning cores —
      // and that is written here rather than guessed at.
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
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});

    await expect(
      runSession(fakeSession([{ ...RESULT, structured_output: { ok: true } }]), () => "parsed"),
    ).resolves.toBe("parsed");

    expect(info).toHaveBeenCalledWith(
      "session.cost",
      expect.objectContaining({ label: "fake pass of SSX-1234", costUsd: 0.12730375, turns: 1 }),
    );
    info.mockRestore();
  });

  /**
   * The reason the log line sits above the success check rather than below it.
   *
   * A run that failed has already been paid for, and a total that silently
   * omitted every failure would look best on exactly the days that went worst —
   * the opposite of what a budget cap needs to be built on.
   */
  it("still reports the cost of a run that failed", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});

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
  /**
   * The second gate, which the harness could not see until this landed.
   *
   * Two assertions and they pull in opposite directions on purpose. The run
   * **resolves** — a denial is material, not fatal, and the counterexample is
   * this service's own: the D4c commenter was denied an Atlassian tool by
   * don't-ask mode, routed around it, and posted the right comment. And the
   * denial is **warned** — because the same event says `subtype: "success"`,
   * so silence here is indistinguishable from a run whose tools were all
   * granted, which is exactly what happened on SSX-3832.
   *
   * The mutation: drop the log and this fails while every other test in the
   * file still passes, which is the shape of the bug being fixed.
   */
  it("records a refused tool on a run that otherwise succeeded", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

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

  // The guard against a log line that cries every run. `session.denied` is
  // warn-level and meant to be read, so an empty array must say nothing.
  it("says nothing about a run that had no tool refused", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    await expect(
      runSession(fakeSession([{ ...RESULT, structured_output: { ok: true } }]), () => "parsed"),
    ).resolves.toBe("parsed");

    expect(warn).not.toHaveBeenCalledWith("session.denied", expect.anything());
    warn.mockRestore();
  });

  /**
   * Same placement argument as the cost line, one notch sharper.
   *
   * A denial is most interesting on the run it stopped, and that run reaches
   * the result event with a failing `subtype`. Move this below the success
   * check and the harness reports denials for every run except the ones where
   * the denial mattered.
   */
  it("still reports the denial on a run that then failed", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

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
