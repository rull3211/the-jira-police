import { describe, expect, it } from "vitest";

import { type AuditRecord, newRecord } from "./audit.ts";
import { type AuditOutcome, createAuditNotifier } from "./notifier.ts";
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

function publisher(behaviour: { readonly gone?: boolean; readonly fail?: boolean } = {}): {
  readonly publisher: Publisher;
  readonly calls: string[];
} {
  const calls: string[] = [];
  let next = 0;
  return {
    calls,
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
    },
  };
}

function notifier(s: AuditStore, p: Publisher) {
  return createAuditNotifier({ store: s, publisher: p, jiraBaseUrl: BASE_URL, now: () => NOW });
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

  it("reports a record it posted but could not save, the case that opens a duplicate thread", async () => {
    const s = store();
    s.failSave = true;

    const outcome = await notifier(s.store, publisher().publisher).record("SSX-1", {
      kind: "triage-started",
    });

    expect(outcome).toEqual({ kind: "failed", reason: "jira said 503" });
  });
});
