/**
 * Whether one drafted ticket may be filed: the question a draft asks before it carries a Post
 * button, and a click asks again before anything is written, since Jira moves in between.
 */

import type { ProjectFacts } from "../jira/client.ts";
import type { DraftTicket } from "./runner.ts";

export interface FileGateDeps {
  /** `DRAFT_PROJECTS`, which has no fallback: empty allows nothing. */
  readonly projects: readonly string[];
  /** Throws when Jira cannot be asked; the gate reads that as a refusal, never as an empty list. */
  facts(project: string): Promise<ProjectFacts>;
}

export type Fileability = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** Every project, component and type here is the drafting session's word, so a reason quoting one is escaped where it is shown. */
export async function fileability(ticket: DraftTicket, deps: FileGateDeps): Promise<Fileability> {
  if (!deps.projects.includes(ticket.project)) {
    return refuse(
      ticket.project === ""
        ? "the draft chose no project"
        : `${ticket.project} is not on DRAFT_PROJECTS`,
    );
  }
  if (ticket.component === "") {
    return refuse("the draft chose no component, and a guess would file it in the wrong stream");
  }
  if (ticket.issueType === "") {
    return refuse("the draft chose no issue type");
  }
  let facts: ProjectFacts;
  try {
    facts = await deps.facts(ticket.project);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return refuse(`Jira could not be asked what ${ticket.project} lists (${why})`);
  }
  if (!facts.components.includes(ticket.component)) {
    return refuse(`${ticket.component} is not a component of ${ticket.project}`);
  }
  if (!facts.issueTypes.includes(ticket.issueType)) {
    return refuse(`${ticket.issueType} is not an issue type ${ticket.project} can create`);
  }
  return { ok: true };
}

function refuse(reason: string): Fileability {
  return { ok: false, reason };
}
