# Definition of Ready — checklist

> Mirror of the canonical Confluence page (space SDRM):
> <https://storebrand.atlassian.net/wiki/spaces/SDRM/pages/1563820058/Definition+of+Ready+DOR>
> If the two ever diverge, the Confluence page wins — update this file to match.
>
> **Row 9 (Evidence / data) is a skill-local addition (tech-lead policy, 2026-08-28) not yet on the
> Confluence page — add it there to reconcile.**

An item is **Ready** for the refined backlog only when every box is true:

| #   | Criterion                                                                                          | Auto-fillable by the skill?                                                                        |
| --- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1   | Problem is clear and the affected user / segment is named                                          | partial (restates problem)                                                                         |
| 2   | Value and why-now are stated (business justification)                                              | no — ask the requester                                                                             |
| 3   | Acceptance criteria are written and testable                                                       | no — ask the requester                                                                             |
| 4   | No open duplicate; related items are linked                                                        | **yes** — dedup steps                                                                              |
| 5   | Affected service / build site is known                                                             | **yes** — candidate-repo match (+ `owning_team` / `jira_project` from `index.yaml`)                |
| 6   | Dependencies are identified                                                                        | **yes** — dependency chain                                                                         |
| 7   | Design / Figma link present (if UI)                                                                | no — ask the requester                                                                             |
| 8   | Rough size is known (or flagged "needs sizing")                                                    | hint only                                                                                          |
| 9   | **Evidence / data** — baseline metric + source, and the expected movement (tech-lead: data-driven) | partial — names the source (GA4 / Datadog / commerce-explorer-web); requester supplies the numbers |
| 10  | Trio sign-off: value ✓ feasibility ✓ UX ✓                                                          | no — human gate                                                                                    |

## How the skill uses this

- Score the item against criteria 1–9. Criteria 4, 5, 6 are **auto-filled** from the vault/Jira research; criterion 9 (data) is **partly** auto-filled — the skill names the data source, the requester supplies the numbers; the rest are checked from the ticket text.
- Output `dor:pass` only if 1–9 hold. Otherwise `dor:gaps` and, for each failing row, emit a **concrete question to send the requester** (not just "missing value" — instead "Which customer segment is affected, and what breaks for them today?").
- Criterion 10 (Trio sign-off) is never auto-satisfied — it is the human gate the whole intake protects.

## Tiered DoR — the bar depends on the issue's hierarchy level

The checklist above (criteria 1–10) is the **leaf** bar (Story / Task / Bug). Do **not** apply it unchanged to
containers or sub-tasks — an Epic is "ready" when its _scope and children_ are clear, not when its
own description restates a problem. Read `issuetype.hierarchyLevel` (and `issuetype.subtask`) from
`getJiraIssue` and pick the tier:

| Tier                                               | Detect                                                                                             | DoR bar                                                                                                                                                                        | Empty own-body?                               |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| **Container / Epic**                               | `hierarchyLevel ≥ 1`, or issuetype `Epic`; or a leaf whose naming + links show it only groups work | Goal / outcome statement **or** ≥1 linked child with clear scope. Criteria 2–3 (AC, why-now) and 9 (data) are **NOT required on the epic itself** — they live on the children. | **Not a fail** — judge by children (roll-up). |
| **Leaf** (Story/Task/Bug, `hierarchyLevel 0`)      | default                                                                                            | Full 1–9 leaf bar (incl. data/evidence). **Inherit** value/why-now (crit 2) and scope from the parent epic when the leaf omits it and the parent states it.                    | Fail (nothing to work from).                  |
| **Sub-task** (`subtask:true`, `hierarchyLevel −1`) | default                                                                                            | Atomic action + acceptance **inherited from the parent**. Only crit 1 (clear action) is required standalone.                                                                   | Judge against the parent, not standalone.     |

### Container roll-up (Epics) — fetch children, decide from the set

Fetch children with `parent = <KEY>` **or** `"Epic Link" = <KEY>`, then:

- **All children Done / closed** → `verify-if-done` (confirm delivered, then close) — **never** `send-back`.
- **Some open, scope clear** → `keep` (refine the open children, not the epic body).
- **Zero children + empty body + stale** → `archive-candidate`.
- **Zero children + empty body + recent** → `send-back` (ask what it should contain) — the only epic `dor:gaps`.

### Container naming signals (promote a leaf issue-type to the container tier)

Treat as a container even at a leaf issue-type when the summary matches: `🪣` / `bucket`,
`paraply` / umbrella, `samle`* / grouping, `handover`, `Temauker` (theme week), `Steg N` /
`Cleanup` placeholder — or the item has children / many `relates` links and no atomic action.

Emit `tier:epic|leaf|subtask` alongside `dor:*` so the verdict is auditable.
