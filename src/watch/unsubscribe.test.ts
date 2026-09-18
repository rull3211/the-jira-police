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
    // An empty edit instead of null would still bump `updated` on a ticket
    // this service has no business touching.
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
    expect(unsubscribeNote("closed")).toBeNull();
  });

  it.each(["exhausted", "uncountable"] as const)(
    "breaks the silence when it gives up on a ticket that is still open (%s)",
    (reason) => {
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
