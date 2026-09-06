import { describe, expect, it, vi } from "vitest";

import type { IssueActivity } from "../jira/client.ts";
import { AGENT_LABELS } from "../solve/labels.ts";
import { endWatch, type EndWatchDeps } from "./end.ts";

function activity(labels: readonly string[]): IssueActivity {
  return {
    key: "SSX-1234",
    statusCategoryKey: "indeterminate",
    labels,
    comments: [],
    changes: [],
  };
}

/** Records the order the two writes happened in, which is the thing under test. */
function deps(overrides: { readonly commentFails?: boolean } = {}) {
  const order: string[] = [];
  const updateLabels = vi.fn(async () => {
    order.push("label");
  });
  const comment = vi.fn(async () => {
    order.push("comment");
    if (overrides.commentFails === true) {
      throw new Error("storecode session died");
    }
  });

  return { deps: { client: { updateLabels }, commenter: { comment } } as EndWatchDeps, order };
}

describe("endWatch", () => {
  it("takes the label off", async () => {
    const { deps: d } = deps();

    const result = await endWatch(d, "SSX-1234", activity([AGENT_LABELS.watching]), "exhausted");

    expect(result).toBe("unsubscribed");
    expect(d.client.updateLabels).toHaveBeenCalledWith("SSX-1234", {
      add: [],
      remove: [AGENT_LABELS.watching],
    });
  });

  it("writes the label before it posts the comment", async () => {
    // The mutation: swap these two. Then a failed label write leaves a ticket
    // that has been told nobody is watching it and is still on the watch list,
    // so it is told again every sweep — a bot repeating a goodbye on somebody's
    // bug, forever, with each repeat costing a session.
    const { deps: d, order } = deps();

    await endWatch(d, "SSX-1234", activity([AGENT_LABELS.watching]), "exhausted");

    expect(order).toEqual(["label", "comment"]);
  });

  it("stays silent on a closed ticket but still unsubscribes it", async () => {
    const { deps: d } = deps();

    const result = await endWatch(d, "SSX-1234", activity([AGENT_LABELS.watching]), "closed");

    expect(result).toBe("unsubscribed");
    expect(d.client.updateLabels).toHaveBeenCalledOnce();
    expect(d.commenter.comment).not.toHaveBeenCalled();
  });

  it("writes nothing at all when the ticket was never watched", async () => {
    // Reachable: `watch:once <KEY>` accepts an unlabelled ticket on purpose, and
    // a closed one among those decides `unsubscribe`.
    const { deps: d } = deps();

    const result = await endWatch(d, "SSX-1234", activity(["triaged"]), "closed");

    expect(result).toBe("not-watched");
    expect(d.client.updateLabels).not.toHaveBeenCalled();
    expect(d.commenter.comment).not.toHaveBeenCalled();
  });

  it("still reports success when only the comment failed", async () => {
    // The watch is already off and there is nothing left to retry, so throwing
    // would report the unsubscribe as not having happened when the half that
    // matters did — and would abandon the rest of a sweep over a courtesy.
    const { deps: d } = deps({ commentFails: true });

    await expect(
      endWatch(d, "SSX-1234", activity([AGENT_LABELS.watching]), "uncountable"),
    ).resolves.toBe("unsubscribed");
  });

  it("does not retry the label write when the comment failed", async () => {
    const { deps: d } = deps({ commentFails: true });

    await endWatch(d, "SSX-1234", activity([AGENT_LABELS.watching]), "uncountable");

    expect(d.client.updateLabels).toHaveBeenCalledOnce();
  });
});
