import { describe, expect, it, vi } from "vitest";

import type { ProjectFacts } from "../jira/client.ts";
import { type FileGateDeps, fileability } from "./gate.ts";
import type { DraftTicket } from "./runner.ts";

const TICKET: DraftTicket = {
  summary: "commerce-rest: raise the export timeout",
  project: "SSX",
  component: "SSX Advisor",
  issueType: "Oppgave",
  description: "## Where",
};

const FACTS: ProjectFacts = {
  components: ["SSX Advisor", "SSX Customer"],
  issueTypes: ["Oppgave", "Feil", "Historie"],
};

function gate(overrides: Partial<FileGateDeps> = {}): {
  readonly deps: FileGateDeps;
  readonly facts: ReturnType<typeof vi.fn<(project: string) => Promise<ProjectFacts>>>;
} {
  const facts = vi.fn(async (_project: string) => FACTS);
  return { deps: { projects: ["SSX"], facts, ...overrides }, facts };
}

describe("fileability", () => {
  it("allows a ticket in a listed project whose component and type that project lists", async () => {
    const { deps, facts } = gate();

    expect(await fileability(TICKET, deps)).toEqual({ ok: true });
    expect(facts).toHaveBeenCalledExactlyOnceWith("SSX");
  });

  it("allows nothing while no project is listed, whatever the draft chose", async () => {
    const { deps, facts } = gate({ projects: [] });

    expect(await fileability(TICKET, deps)).toEqual({
      ok: false,
      reason: "SSX is not on DRAFT_PROJECTS",
    });
    expect(facts).not.toHaveBeenCalled();
  });

  it("refuses a project that is not listed without asking Jira about it", async () => {
    const { deps, facts } = gate({ projects: ["OTHER"] });

    expect(await fileability(TICKET, deps)).toMatchObject({ ok: false });
    expect(facts).not.toHaveBeenCalled();
  });

  it("matches a project exactly, not by prefix, case or substring", async () => {
    const { deps } = gate({ projects: ["SSX"] });

    for (const project of ["ssx", "SSXX", "SS", "SSX ", " SSX"]) {
      expect(await fileability({ ...TICKET, project }, deps)).toMatchObject({ ok: false });
    }
  });

  it("refuses a draft that chose no project, naming that rather than an empty one", async () => {
    const { deps } = gate();

    expect(await fileability({ ...TICKET, project: "" }, deps)).toEqual({
      ok: false,
      reason: "the draft chose no project",
    });
  });

  it.each([
    ["component", "no component"],
    ["issueType", "no issue type"],
  ] as const)(
    "refuses a draft that chose %s of nothing, without asking Jira",
    async (field, said) => {
      const { deps, facts } = gate();

      const verdict = await fileability({ ...TICKET, [field]: "" }, deps);

      expect(verdict).toMatchObject({ ok: false });
      expect(verdict.ok ? "" : verdict.reason).toContain(said);
      expect(facts).not.toHaveBeenCalled();
    },
  );

  it("refuses a component the project does not list", async () => {
    const { deps } = gate();

    expect(await fileability({ ...TICKET, component: "SSX Payments" }, deps)).toEqual({
      ok: false,
      reason: "SSX Payments is not a component of SSX",
    });
  });

  it("matches a component and a type exactly, as Jira spells them", async () => {
    const { deps } = gate();

    expect(await fileability({ ...TICKET, component: "ssx advisor" }, deps)).toMatchObject({
      ok: false,
    });
    expect(await fileability({ ...TICKET, issueType: "oppgave" }, deps)).toMatchObject({
      ok: false,
    });
  });

  it("refuses an issue type the project cannot create", async () => {
    const { deps } = gate();

    expect(await fileability({ ...TICKET, issueType: "Deloppgave" }, deps)).toEqual({
      ok: false,
      reason: "Deloppgave is not an issue type SSX can create",
    });
  });

  it("reads a Jira that cannot be asked as a refusal saying why, never as a list with nothing in it or a yes", async () => {
    const { deps } = gate({
      facts: async () => {
        throw new Error("Request to /rest/api/3/project/SSX failed: fetch failed");
      },
    });

    expect(await fileability(TICKET, deps)).toEqual({
      ok: false,
      reason:
        "Jira could not be asked what SSX lists (Request to /rest/api/3/project/SSX failed: fetch failed)",
    });
  });

  it("refuses when Jira lists nothing at all", async () => {
    const { deps } = gate({ facts: async () => ({ components: [], issueTypes: [] }) });

    expect(await fileability(TICKET, deps)).toMatchObject({ ok: false });
  });
});
