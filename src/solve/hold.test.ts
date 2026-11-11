import { describe, expect, it, vi } from "vitest";

import { AGENT_LABELS } from "./labels.ts";
import {
  TicketHeldError,
  type WriteGate,
  assertMayWrite,
  createWriteGate,
  gatePasses,
} from "./hold.ts";
import type { PassRunner } from "./orchestrator.ts";

const LABELS_OF = (labels: readonly string[]) => async () => labels;

describe("createWriteGate", () => {
  it("clears a ticket that is readable and not ignored", async () => {
    const gate = createWriteGate(LABELS_OF([AGENT_LABELS.solvable, AGENT_LABELS.reviewing]));

    expect(await gate("SSX-1", "a push")).toBe(true);
  });

  it("holds a ticket carrying agent:ignore, whatever else it carries", async () => {
    const gate = createWriteGate(LABELS_OF([AGENT_LABELS.solving, AGENT_LABELS.ignore]));

    expect(await gate("SSX-1", "a push")).toBe(false);
  });

  it("holds a ticket whose label was typed in another case, as the queues do", async () => {
    const gate = createWriteGate(LABELS_OF(["Agent:Ignore"]));

    expect(await gate("SSX-1", "a push")).toBe(false);
  });

  it("holds the write when the labels cannot be read", async () => {
    // The plausible wrong version treats a failed read as "nothing says stop" and writes.
    const gate = createWriteGate(async () => {
      throw new Error("Jira returned 503");
    });

    expect(await gate("SSX-1", "a push")).toBe(false);
  });

  it("reads the labels for the key asked about, on every call", async () => {
    const read = vi.fn(async (_key: string) => [] as readonly string[]);
    const gate = createWriteGate(read);

    await gate("SSX-1", "a push");
    await gate("SSX-2", "a comment");
    await gate("SSX-1", "a reply");

    // A cached answer is the earlier list again, which is the thing this gate exists not to trust.
    expect(read.mock.calls.map(([key]) => key)).toEqual(["SSX-1", "SSX-2", "SSX-1"]);
  });

  it("follows the label as it arrives and as it is removed", async () => {
    let labels: readonly string[] = [];
    const gate = createWriteGate(async () => labels);

    expect(await gate("SSX-1", "first")).toBe(true);
    labels = [AGENT_LABELS.ignore];
    expect(await gate("SSX-1", "second")).toBe(false);
    labels = [];
    expect(await gate("SSX-1", "third")).toBe(true);
  });
});

describe("assertMayWrite", () => {
  it("returns when the gate clears the write", async () => {
    await expect(assertMayWrite(async () => true, "SSX-1", "a push")).resolves.toBeUndefined();
  });

  it("throws a TicketHeldError naming the ticket and the write when the gate holds it", async () => {
    const held = assertMayWrite(async () => false, "SSX-7", "the publish");

    await expect(held).rejects.toBeInstanceOf(TicketHeldError);
    await expect(held).rejects.toMatchObject({ issueKey: "SSX-7", where: "the publish" });
    await expect(held).rejects.toThrow(/SSX-7 is held at the publish/);
  });

  it("holds the write for any answer that is not exactly true", async () => {
    // A gate that returns nothing, or a truthy string, is a bug in the gate and must not clear a write.
    for (const answer of [undefined, null, 0, "", "yes", 1]) {
      const gate = (async () => answer) as unknown as WriteGate;
      await expect(assertMayWrite(gate, "SSX-1", "a push")).rejects.toBeInstanceOf(TicketHeldError);
    }
  });
});

/** A pass runner that records which passes ran and answers each with its own name. */
function inner(): { readonly passes: PassRunner; readonly ran: string[] } {
  const ran: string[] = [];
  return {
    ran,
    passes: {
      run: async (pass, _options, parse) => {
        ran.push(pass);
        return parse({ ok: pass });
      },
    },
  };
}

describe("gatePasses", () => {
  const OPTIONS = { issueKey: "SSX-1", worktreePath: "/tmp/w", ticket: "t" };

  it("runs the pass and returns its result when the ticket stays clear", async () => {
    const { passes, ran } = inner();
    const gated = gatePasses(passes, async () => true);

    const result = await gated.run("recon", OPTIONS, (output) => output);

    expect(result).toEqual({ ok: "recon" });
    expect(ran).toEqual(["recon"]);
  });

  it("does not start a pass on a ticket that is held", async () => {
    const { passes, ran } = inner();
    const gated = gatePasses(passes, async () => false);

    await expect(gated.run("fix", OPTIONS, (output) => output)).rejects.toBeInstanceOf(
      TicketHeldError,
    );
    // A paid pass is the thing being saved.
    expect(ran).toEqual([]);
  });

  it("discards a pass's result when the label arrived while it ran", async () => {
    const { passes, ran } = inner();
    const answers = [true, false];
    const gated = gatePasses(passes, async () => answers.shift() ?? false);

    const outcome = gated.run("fix", OPTIONS, (output) => output);

    await expect(outcome).rejects.toBeInstanceOf(TicketHeldError);
    // It did run: the check before it was clear. What matters is that its result went nowhere.
    expect(ran).toEqual(["fix"]);
  });

  it("names which side of the pass held it", async () => {
    const { passes } = inner();
    const before = gatePasses(passes, async () => false);
    const answers = [true, false];
    const after = gatePasses(passes, async () => answers.shift() ?? false);

    await expect(before.run("review", OPTIONS, (o) => o)).rejects.toThrow(/before the review pass/);
    await expect(after.run("review", OPTIONS, (o) => o)).rejects.toThrow(/after the review pass/);
  });

  it("asks about the ticket the pass is for", async () => {
    const { passes } = inner();
    const asked: string[] = [];
    const gated = gatePasses(passes, async (key) => {
      asked.push(key);
      return true;
    });

    await gated.run("recon", { ...OPTIONS, issueKey: "SSX-42" }, (output) => output);

    expect(asked).toEqual(["SSX-42", "SSX-42"]);
  });
});
