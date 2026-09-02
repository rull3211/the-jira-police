import { describe, expect, it } from "vitest";

import {
  buildAppendAtEndRequest,
  buildAppendRequest,
  escapeLinkLabel,
  renderChecklist,
  renderChecklistItem,
} from "./canvas.ts";
import type { TriageResult } from "./sink.ts";

function result(overrides: Partial<TriageResult> = {}): TriageResult {
  return {
    issueKey: "SSX-1",
    issueUrl: "https://storebrand.atlassian.net/browse/SSX-1",
    summary: "Kunden får feil pris",
    verdict: "needs-info",
    labels: ["dor:gaps"],
    recommendedNextStep: "Ask the reporter.",
    report: "## report",
    ...overrides,
  };
}

describe("escapeLinkLabel", () => {
  it("escapes brackets that would terminate the link early", () => {
    expect(escapeLinkLabel("Feil [kritisk] i pris")).toBe("Feil \\[kritisk\\] i pris");
  });

  it("escapes backslashes", () => {
    expect(escapeLinkLabel("a\\b")).toBe("a\\\\b");
  });

  it("flattens newlines, which would break the list item", () => {
    expect(escapeLinkLabel("line one\nline two")).toBe("line one line two");
  });

  it("preserves Norwegian characters", () => {
    expect(escapeLinkLabel("Kunden får løsning på økt")).toBe("Kunden får løsning på økt");
  });
});

describe("renderChecklistItem", () => {
  it("renders an unchecked box with the verdict emoji and a link", () => {
    expect(renderChecklistItem(result())).toBe(
      "- [ ] 🟨 [SSX-1 — Kunden får feil pris](https://storebrand.atlassian.net/browse/SSX-1)  `dor:gaps`",
    );
  });

  it("omits the label suffix when there are none", () => {
    expect(renderChecklistItem(result({ labels: [] }))).not.toContain("`");
  });

  it("uses red for both rejecting verdicts", () => {
    expect(renderChecklistItem(result({ verdict: "duplicate" }))).toContain("🟥");
    expect(renderChecklistItem(result({ verdict: "not-our-team" }))).toContain("🟥");
  });

  it("uses green for ready-ish", () => {
    expect(renderChecklistItem(result({ verdict: "ready-ish" }))).toContain("🟩");
  });

  it("escapes a summary containing brackets", () => {
    const line = renderChecklistItem(result({ summary: "Feil [P1] i pris" }));
    expect(line).toContain("\\[P1\\]");
  });
});

describe("renderChecklist", () => {
  it("returns null for an empty batch, since the API rejects empty content", () => {
    expect(renderChecklist([])).toBeNull();
  });

  it("ends with a newline, which the API requires", () => {
    expect(renderChecklist([result()])?.endsWith("\n")).toBe(true);
  });

  it("puts one issue per line", () => {
    const markdown = renderChecklist([result(), result({ issueKey: "SSX-2" })]);
    expect(markdown?.trimEnd().split("\n")).toHaveLength(2);
  });
});

describe("buildAppendRequest", () => {
  it("emits exactly one operation, which is all canvases.edit accepts", () => {
    const request = buildAppendRequest("F0BU3CNM65V", "sec-1", [result()]);
    expect(request?.changes).toHaveLength(1);
  });

  it("targets the requested canvas and section", () => {
    const request = buildAppendRequest("F0BU3CNM65V", "sec-1", [result()]);

    expect(request).toMatchObject({
      canvas_id: "F0BU3CNM65V",
      changes: [{ operation: "insert_after", section_id: "sec-1" }],
    });
  });

  it("returns null rather than an empty edit on a quiet cycle", () => {
    expect(buildAppendRequest("F0BU3CNM65V", "sec-1", [])).toBeNull();
  });
});

describe("buildAppendAtEndRequest", () => {
  it("appends to the document when no section is resolvable", () => {
    const request = buildAppendAtEndRequest("F0BU3CNM65V", [result()]);

    expect(request?.changes[0]?.operation).toBe("insert_at_end");
    expect(request?.changes[0]?.section_id).toBeUndefined();
  });

  it("returns null for an empty batch", () => {
    expect(buildAppendAtEndRequest("F0BU3CNM65V", [])).toBeNull();
  });
});
