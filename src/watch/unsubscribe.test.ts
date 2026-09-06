import { describe, expect, it } from "vitest";

import { AGENT_LABELS } from "../solve/labels.ts";
import type { UnsubscribeReason } from "./decide.ts";
import { unsubscribeEdit, unsubscribeNote } from "./unsubscribe.ts";

describe("unsubscribeEdit", () => {
  it("removes the watch label and adds nothing", () => {
    const edit = unsubscribeEdit(["triaged", AGENT_LABELS.watching, "svc:thing"]);

    expect(edit).toEqual({ add: [], remove: [AGENT_LABELS.watching] });
  });

  it("refuses to write at all when the ticket is not watched", () => {
    // The mutation that matters: return an empty edit here instead of null and
    // the caller sends a removal Jira accepts and ignores — except for the part
    // where it bumps `updated` on a ticket this service has no business
    // touching. Reachable from `watch:once <KEY>` on any closed ticket.
    expect(unsubscribeEdit(["triaged"])).toBeNull();
    expect(unsubscribeEdit([])).toBeNull();
  });

  it("leaves every other label alone, including the rest of the agent namespace", () => {
    const edit = unsubscribeEdit([AGENT_LABELS.watching, AGENT_LABELS.solvable, "next:to-trio"]);

    expect(edit?.remove).toEqual([AGENT_LABELS.watching]);
  });
});

describe("unsubscribeNote", () => {
  const reasons: readonly UnsubscribeReason[] = ["closed", "exhausted", "uncountable"];

  it("says nothing at all when the ticket closed", () => {
    // Closing is how nearly every watch ends, and a comment is a paid session.
    // Give this one a string and the commonest outcome becomes a standing
    // charge for telling a reporter what they just did themselves.
    expect(unsubscribeNote("closed")).toBeNull();
  });

  it.each(["exhausted", "uncountable"] as const)(
    "breaks the silence when it gives up on a ticket that is still open (%s)",
    (reason) => {
      // The failure this pays for: a reporter answers afterwards, hears
      // nothing, and reads it as the tool having seen the answer and declined
      // it — worse than never having been watched.
      expect(unsubscribeNote(reason)).toMatch(/triaged again/);
    },
  );

  it("gives the two speaking reasons different messages", () => {
    expect(unsubscribeNote("exhausted")).not.toBe(unsubscribeNote("uncountable"));
  });

  it("does not make a reporter learn a label name", () => {
    for (const reason of reasons) {
      expect(unsubscribeNote(reason) ?? "").not.toContain("agent:");
    }
  });
});
