import { describe, expect, it } from "vitest";

import type { PassRunner } from "../solve/orchestrator.ts";
import type { SolveRunOptions } from "../solve/runner.ts";
import { type AuditRecord, newRecord } from "./audit.ts";
import {
  type AuditOutcome,
  type TicketFacts,
  auditPasses,
  createAuditNotifier,
} from "./notifier.ts";
import type { AuditStore, Loaded, Publisher, Thread } from "./store.ts";

const NOW = new Date("2026-09-28T13:58:00Z");
const BASE_URL = "https://example.atlassian.net";

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

/** A ticket's property, with a delay on every read and write so two unserialised updates would interleave. */
function store(initial: Loaded = { kind: "absent" }): {
  readonly store: AuditStore;
  readonly saved: () => AuditRecord | null;
  failSave?: boolean;
} {
  let current: Loaded = initial;
  const handle = {
    failSave: false,
    saved: () => (current.kind === "found" ? current.record : null),
    store: {
      load: async (): Promise<Loaded> => {
        await tick();
        return current;
      },
      save: async (_key: string, record: AuditRecord): Promise<void> => {
        await tick();
        if (handle.failSave) {
          throw new Error("jira said 503");
        }
        current = { kind: "found", record };
      },
    },
  };
  return handle;
}

function publisher(
  behaviour: {
    readonly gone?: boolean;
    readonly fail?: boolean;
    readonly failBroadcast?: boolean;
    readonly failRemove?: boolean;
  } = {},
): {
  readonly publisher: Publisher;
  readonly calls: string[];
  readonly bumps: string[];
} {
  const calls: string[] = [];
  const bumps: string[] = [];
  let next = 0;
  let bumped = 0;
  return {
    calls,
    bumps,
    publisher: {
      post: async (): Promise<Thread> => {
        if (behaviour.fail === true) {
          throw new Error("Slack chat.postMessage failed: not_in_channel");
        }
        next += 1;
        calls.push(`post ${String(next)}`);
        return { channel: "C1", ts: `ts-${String(next)}` };
      },
      update: async (_key, thread) => {
        calls.push(`update ${thread.ts}`);
        return behaviour.gone === true ? "gone" : "updated";
      },
      broadcast: async (_key, thread, message) => {
        if (behaviour.failBroadcast === true) {
          throw new Error("Slack chat.postMessage failed: ratelimited");
        }
        bumped += 1;
        calls.push(`broadcast b-${String(bumped)} in ${thread.ts}`);
        bumps.push(message.text);
        return `b-${String(bumped)}`;
      },
      remove: async (_key, _thread, ts) => {
        if (behaviour.failRemove === true) {
          throw new Error("Slack chat.delete failed: cant_delete_message");
        }
        calls.push(`remove ${ts}`);
        return "removed";
      },
    },
  };
}

/** A ticket whose thread already exists, so an event edits it rather than posting a new one. */
function threaded(bump: string | null = null): Loaded {
  return {
    kind: "found",
    record: {
      ...newRecord("SSX-1", "Cache", `${BASE_URL}/browse/SSX-1`),
      slack: { channel: "C1", ts: "ts-0" },
      bump,
    },
  };
}

function notifier(s: AuditStore, p: Publisher, lookup?: (key: string) => Promise<TicketFacts>) {
  return createAuditNotifier({
    store: s,
    publisher: p,
    jiraBaseUrl: BASE_URL,
    now: () => NOW,
    ...(lookup === undefined ? {} : { lookup }),
  });
}

describe("createAuditNotifier", () => {
  it("posts the first event and saves the thread with the record, then edits for the next", async () => {
    const s = store();
    const p = publisher();
    const audit = notifier(s.store, p.publisher);

    const first = await audit.record(
      "SSX-1",
      { kind: "triage-started" },
      { summary: "Cache", url: `${BASE_URL}/browse/SSX-1` },
    );
    const second = await audit.record("SSX-1", { kind: "claimed", repo: null });

    expect([first.kind, second.kind]).toEqual(["posted", "edited"]);
    expect(p.calls).toEqual(["post 1", "update ts-1"]);
    expect(s.saved()?.slack).toEqual({ channel: "C1", ts: "ts-1" });
    expect(s.saved()?.summary).toBe("Cache");
    expect(s.saved()?.timeline.map((entry) => entry.text)).toEqual(["triage started", "claimed"]);
  });

  it("applies two events fired together one after the other, so neither is lost", async () => {
    const s = store();
    const audit = notifier(s.store, publisher().publisher);

    await Promise.all([
      audit.record("SSX-1", { kind: "pass-started", pass: "fix" }),
      audit.record("SSX-1", { kind: "pass-finished", pass: "fix" }),
    ]);

    expect(s.saved()?.timeline.map((entry) => entry.text)).toEqual(["fix started", "fix finished"]);
  });

  it("leaves a record it cannot read alone, and says what to do about it", async () => {
    const s = store({ kind: "unreadable" });
    const p = publisher();

    const outcome = await notifier(s.store, p.publisher).record("SSX-1", {
      kind: "claimed",
      repo: null,
    });

    expect(outcome.kind).toBe("skipped");
    expect((outcome as Extract<AuditOutcome, { kind: "skipped" }>).reason).toContain(
      "delete the property",
    );
    expect(p.calls).toEqual([]);
    expect(s.saved()).toBeNull();
  });

  it("returns a Slack failure with Slack's reason instead of throwing, and saves nothing", async () => {
    const s = store();

    const outcome = await notifier(s.store, publisher({ fail: true }).publisher).record("SSX-1", {
      kind: "triage-started",
    });

    expect(outcome).toEqual({
      kind: "failed",
      reason: "Slack chat.postMessage failed: not_in_channel",
    });
    expect(s.saved()).toBeNull();
  });

  it("posts a fresh message when the thread's message was deleted", async () => {
    const existing = {
      ...newRecord("SSX-1", "Cache", `${BASE_URL}/browse/SSX-1`),
      slack: { channel: "C1", ts: "old" },
    };
    const s = store({ kind: "found", record: existing });
    const p = publisher({ gone: true });

    const outcome = await notifier(s.store, p.publisher).redraw("SSX-1");

    expect(outcome.kind).toBe("posted");
    expect(p.calls).toEqual(["update old", "post 1"]);
    expect(s.saved()?.slack?.ts).toBe("ts-1");
  });

  it("touches nothing remote for an event that changed nothing", async () => {
    const s = store();
    const p = publisher();
    const audit = notifier(s.store, p.publisher);
    const crash = { kind: "crashed", where: "review", message: "gh said 502" } as const;

    await audit.record("SSX-1", crash);
    const repeat = await audit.record("SSX-1", crash);

    expect(repeat).toEqual({ kind: "skipped", reason: "the event changed nothing" });
    expect(p.calls).toEqual(["post 1"]);

    // Not only a crash: the look at a PR already ready, which every review tick repeats.
    const q = publisher();
    const reviewed = notifier(store(threaded()).store, q.publisher);
    const opened = { kind: "pr-opened", url: "https://github.com/o/r/pull/7", number: 7 } as const;
    await reviewed.record("SSX-1", { ...opened, title: "fix(cache): evict" });
    await reviewed.record("SSX-1", { kind: "pr-ready" });
    const before = [...q.calls];

    expect(await reviewed.record("SSX-1", { kind: "pr-ready" })).toEqual(repeat);
    expect(q.calls).toEqual(before);
  });

  it("retitles a record whose event changed nothing else, and only once", async () => {
    const existing = {
      ...newRecord("SSX-1", "SSX-1", `${BASE_URL}/browse/SSX-1`),
      slack: { channel: "C1", ts: "ts-0" },
    };
    const s = store({ kind: "found", record: existing });
    const p = publisher();
    const audit = notifier(s.store, p.publisher);
    const ticket = { summary: "Cache", url: `${BASE_URL}/browse/SSX-1` };

    const first = await audit.record("SSX-1", { kind: "pr-reworking" }, ticket);
    const second = await audit.record("SSX-1", { kind: "pr-reworking" }, ticket);

    expect([first.kind, second.kind]).toEqual(["edited", "skipped"]);
    expect(s.saved()?.summary).toBe("Cache");
    expect(p.calls).toEqual(["update ts-0"]);
  });

  it("reads the title once for a record started from a typed key, and never for a caller that named it", async () => {
    const s = store();
    const asked: string[] = [];
    const lookup = async (key: string): Promise<TicketFacts> => {
      asked.push(key);
      return {
        summary: "Kredittsjekk viser ikke frivillig sperre",
        url: `${BASE_URL}/browse/${key}`,
      };
    };
    const audit = notifier(s.store, publisher().publisher, lookup);

    await audit.record("SSX-1", { kind: "triage-started" });
    await audit.record("SSX-1", { kind: "claimed", repo: null });
    expect(s.saved()?.summary).toBe("Kredittsjekk viser ikke frivillig sperre");

    // Titleless already, as the review sweep's first look finds a record the pipeline started blind.
    const named = store({ kind: "found", record: newRecord("SSX-2", "SSX-2", BASE_URL) });
    await notifier(named.store, publisher().publisher, lookup).record(
      "SSX-2",
      { kind: "triage-started" },
      { summary: "Named", url: BASE_URL },
    );

    expect(asked).toEqual(["SSX-1"]);
    expect(named.saved()?.summary).toBe("Named");
  });

  it("draws the event under the key when the title cannot be read, a blank one included", async () => {
    for (const lookup of [
      async (): Promise<TicketFacts> => {
        throw new Error("jira said 403");
      },
      async (): Promise<TicketFacts> => ({ summary: "  ", url: BASE_URL }),
    ]) {
      const s = store();

      const outcome = await notifier(s.store, publisher().publisher, lookup).record("SSX-1", {
        kind: "triage-started",
      });

      expect(outcome.kind).toBe("posted");
      expect(s.saved()?.summary).toBe("SSX-1");
    }
  });

  it("resurfaces a ticket on each major entry, keeping one broadcast in the channel", async () => {
    const s = store(threaded());
    const p = publisher();
    const audit = notifier(s.store, p.publisher);
    const opened = {
      kind: "pr-opened",
      url: "https://github.com/o/r/pull/7",
      number: 7,
      title: "fix(cache): evict",
    } as const;

    await audit.record("SSX-1", opened);
    await audit.record("SSX-1", { kind: "claimed", repo: null });
    await audit.record("SSX-1", { kind: "pr-ready" });

    expect(p.calls).toEqual([
      "update ts-0",
      "broadcast b-1 in ts-0",
      "update ts-0",
      "update ts-0",
      "broadcast b-2 in ts-0",
      "remove b-1",
    ]);
    expect(s.saved()?.bump).toBe("b-2");
    expect(p.bumps[1]).toContain("PR ready for review");
    expect(p.bumps[1]).toContain(`<${BASE_URL}/browse/SSX-1|SSX-1 · Cache>`);
  });

  it("broadcasts the latest major entry again only on a redraw asked to bump", async () => {
    const existing = threaded("b-old");
    if (existing.kind !== "found") {
      throw new Error("threaded() returns a found record");
    }
    const withEntry = {
      ...existing.record,
      major: [{ at: NOW.toISOString(), icon: "👀", text: "PR ready for review" }],
    };
    const s = store({ kind: "found", record: withEntry });
    const p = publisher();
    const audit = notifier(s.store, p.publisher);

    await audit.redraw("SSX-1");
    await audit.redraw("SSX-1", undefined, true);

    expect(p.calls).toEqual([
      "update ts-0",
      "update ts-0",
      "broadcast b-1 in ts-0",
      "remove b-old",
    ]);
    expect(p.bumps).toEqual([expect.stringContaining("PR ready for review")]);
    expect(s.saved()?.bump).toBe("b-1");
  });

  it("does not broadcast a thread it has just posted, which is already at the bottom", async () => {
    const p = publisher();

    await notifier(store().store, p.publisher).record("SSX-1", {
      kind: "triage-verdict",
      verdict: "ready-ish",
      solvable: false,
      confidence: null,
      posted: true,
    });

    expect(p.calls).toEqual(["post 1"]);
  });

  it("saves the edited record when the broadcast or the deletion fails, since only the bump is lost", async () => {
    const pr = { kind: "pr-ended", state: "merged" } as const;
    for (const [behaviour, bump] of [
      [{ failBroadcast: true }, "b-old"],
      [{ failRemove: true }, "b-1"],
    ] as const) {
      const s = store(threaded("b-old"));

      const outcome = await notifier(s.store, publisher(behaviour).publisher).record("SSX-1", pr);

      expect(outcome.kind).toBe("edited");
      expect(s.saved()?.major.at(-1)?.text).toBe("PR merged");
      expect(s.saved()?.bump).toBe(bump);
    }
  });

  it("mentions each subscriber on the broadcast, and broadcasts without them when the list cannot be read", async () => {
    const lists = [
      async () => ["U0ME", "U0OTHER"],
      async () => {
        throw new Error("jira said 403");
      },
    ];
    const seen: [string, string | undefined][] = [];
    for (const subscribers of lists) {
      const p = publisher();
      const audit = createAuditNotifier({
        store: store(threaded()).store,
        publisher: p.publisher,
        jiraBaseUrl: BASE_URL,
        now: () => NOW,
        subscribers,
      });
      const outcome = await audit.record("SSX-1", { kind: "pr-ended", state: "merged" });
      seen.push([outcome.kind, p.bumps[0]]);
    }

    expect(seen[0]?.[1]).toMatch(/PR merged.* <@U0ME> <@U0OTHER>$/u);
    expect(seen[1]?.[0]).toBe("edited");
    expect(seen[1]?.[1]).toContain("PR merged");
    expect(seen[1]?.[1]).not.toContain("<@");
  });

  it("puts a pass on the timeline as a start and a finish, and a pass that died as a start only", async () => {
    const s = store();
    const audit = notifier(s.store, publisher().publisher);
    const passes = auditPasses(
      {
        run: async <T>(
          pass: string,
          _options: unknown,
          parse: (value: unknown) => T,
        ): Promise<T> => {
          if (pass === "fix") {
            throw new Error("session died");
          }
          return parse({});
        },
      } as PassRunner,
      audit,
    );
    const options = { issueKey: "SSX-1" } as unknown as SolveRunOptions;

    await passes.run("recon", options, () => "ok");
    await expect(passes.run("fix", options, () => "ok")).rejects.toThrow("session died");

    expect(s.saved()?.timeline.map((entry) => entry.text)).toEqual([
      "recon started",
      "recon finished",
      "fix started",
    ]);
  });

  it("reports a record it posted but could not save, the case that opens a duplicate thread", async () => {
    const s = store();
    s.failSave = true;

    const outcome = await notifier(s.store, publisher().publisher).record("SSX-1", {
      kind: "triage-started",
    });

    expect(outcome).toEqual({ kind: "failed", reason: "jira said 503" });
  });
});
