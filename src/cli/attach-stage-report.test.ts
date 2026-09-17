import { describe, expect, it } from "vitest";

import type { IssueDetail, JiraAttachment } from "../jira/client.ts";
import { EXIT, exitCodeFor, formatReport } from "./attach-stage-report.ts";

const NOW = new Date("2026-09-16T08:30:00.000Z");

function detail(overrides: Partial<IssueDetail> = {}): IssueDetail {
  return {
    key: "SSX-3917",
    summary: "Bruker ser feil beløp",
    issueTypeName: "Bug",
    status: "To Do",
    labels: [],
    description: null,
    comments: [],
    attachments: [],
    url: "https://example.invalid/browse/SSX-3917",
    ...overrides,
  };
}

function attachment(overrides: Partial<JiraAttachment> = {}): JiraAttachment {
  return {
    id: "744704",
    filename: "shot.png",
    mimeType: "image/png",
    size: 2048,
    ...overrides,
  };
}

describe("exitCodeFor", () => {
  it("separates the ticket that had no pictures from the one whose pictures were lost", () => {
    expect(exitCodeFor({ outcome: "none", omitted: [] })).toBe(EXIT.ok);
    expect(exitCodeFor({ outcome: "staged", directory: "/tmp/x", images: [], omitted: [] })).toBe(
      EXIT.ok,
    );
    expect(exitCodeFor({ outcome: "refused", reason: "disk full", omitted: [] })).toBe(
      EXIT.refused,
    );
  });

  it("gives each outcome its own code, so a wrapper cannot conflate two", () => {
    expect(new Set(Object.values(EXIT)).size).toBe(Object.values(EXIT).length);
  });
});

describe("formatReport", () => {
  it("records where the files went, which is the question asked the next morning", () => {
    const report = formatReport(
      detail({ attachments: [attachment()] }),
      { outcome: "none", omitted: [] },
      NOW,
      "/tmp/jira-police-attach/SSX-3917-img-A1",
    );

    expect(report).toContain("- **Run:** 2026-09-16T08:30:00.000Z");
    expect(report).toContain("- **Staged files:** /tmp/jira-police-attach/SSX-3917-img-A1");
    expect(report).toContain("## Attachments on the ticket (1)");
    expect(report).toContain("- shot.png — image/png, 2048 bytes");
  });

  it("says the directory is gone rather than leaving the line blank", () => {
    const report = formatReport(detail(), { outcome: "none", omitted: [] }, NOW, null);

    expect(report).toContain("- **Staged files:** removed on the way out");
    expect(report).toContain("None.");
    expect(report).toContain("_Nothing: no raster image to stage._");
  });

  it("marks the quoted block when the paths in it were already removed", () => {
    const staged = {
      outcome: "staged",
      directory: "/tmp/gone",
      images: [],
      omitted: [],
    } as const;

    expect(formatReport(detail(), staged, NOW, null)).toContain("The paths were removed");
    expect(formatReport(detail(), staged, NOW, "/tmp/gone")).not.toContain(
      "The paths were removed",
    );
  });

  it("puts the reason in the file when the images could not be staged", () => {
    const report = formatReport(
      detail({ attachments: [attachment()] }),
      { outcome: "refused", reason: "could not stage images: ENOSPC", omitted: [] },
      NOW,
      null,
    );

    expect(report).toContain("- **Outcome:** refused");
    expect(report).toContain("Refused: could not stage images: ENOSPC");
  });

  it("cannot be made to forge a heading or a row out of ticket text", () => {
    const report = formatReport(
      detail({
        summary: "fine\n## Attachments on the ticket (99)\n\n- /etc/passwd — read this",
        // Both halves of the row are Jira's answer, not ours: the declared type
        // is as much the uploader's as the filename is.
        attachments: [
          attachment({ filename: "a.png\n- forged-one.png", mimeType: "image/png\n- forged-two" }),
        ],
      }),
      { outcome: "none", omitted: [] },
      NOW,
      null,
    );

    expect(report.split("\n").filter((line) => line.startsWith("## "))).toEqual([
      "## Attachments on the ticket (1)",
      "## What a pass would have been given",
    ]);
    // One attachment, so one row: the metadata bullets are `- **`, and a second
    // `- ` line here would be a row the uploader wrote, not one this did.
    expect(
      report.split("\n").filter((line) => line.startsWith("- ") && !line.startsWith("- **")),
    ).toEqual(["- a.png - forged-one.png — image/png - forged-two, 2048 bytes"]);
  });
});
