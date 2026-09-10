# Definition of Ready — checklist

> Mirror of the canonical Confluence page (space SDRM):
> <https://storebrand.atlassian.net/wiki/spaces/SDRM/pages/1563820058/Definition+of+Ready+DOR>
> If the two ever diverge, the Confluence page wins — update this file to match.
>
> **Rows 5, 6, 7 and 9 are skill-local additions not on the Confluence page** (row 9 is tech-lead
> policy, 2026-08-28). The canonical page lists six criteria; this table has ten. Reconcile by
> adding them there, not by quietly keeping two bars.
>
> **Row 8 is a deliberate local deviation, not drift.** The canonical wording is "Rough size is known
> (or flagged as _'needs sizing'_)" — a criterion with its own escape hatch. Here it is advisory and
> cannot fail an item at all. See "Advisory rows" below for why.

An item is **Ready** for the refined backlog only when every **blocking** box is true. Rows 8 and 9
are **advisory** — scored and reported, never able to fail an item.

| #   | Criterion                                                                              | Auto-fillable by the skill?                                                                        |
| --- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1   | Problem is clear and the affected user / segment is named                              | partial (restates problem)                                                                         |
| 2   | Value and why-now are stated (business justification)                                  | no — ask the requester                                                                             |
| 3   | Acceptance criteria are written and testable                                           | no — ask the requester                                                                             |
| 4   | No open duplicate; related items are linked                                            | **yes** — dedup steps                                                                              |
| 5   | Affected service / build site is known                                                 | **yes** — candidate-repo match (+ `owning_team` / `jira_project` from `index.yaml`)                |
| 6   | Dependencies are identified                                                            | **yes** — dependency chain                                                                         |
| 7   | Design / Figma link present (if UI)                                                    | no — ask the requester                                                                             |
| 8   | _(advisory)_ Rough size is known (or flagged "needs sizing")                           | hint only                                                                                          |
| 9   | _(advisory)_ **Evidence / data** — baseline metric + source, and the expected movement | partial — names the source (GA4 / Datadog / commerce-explorer-web); requester supplies the numbers |
| 10  | Trio sign-off: value ✓ feasibility ✓ UX ✓                                              | no — human gate                                                                                    |

## How the skill uses this

- Score the item against criteria 1–9. Criteria 4, 5, 6 are **auto-filled** from the vault/Jira research; criterion 9 (data) is **partly** auto-filled — the skill names the data source, the requester supplies the numbers; the rest are checked from the ticket text.
- Output `dor:pass` only if **1–7** hold. Otherwise `dor:gaps` and, for each failing row, emit a **concrete question to send the requester** (not just "missing value" — instead "Which customer segment is affected, and what breaks for them today?").
- **Rows 8 and 9 never change the label or the verdict.** Score them, and when they are thin or absent say so — in the DoR cell and as a follow-up in `→ Next`, phrased as something to go and get rather than as a question blocking the ticket. An item failing only 8 and/or 9 is `dor:pass`.
- Criterion 10 (Trio sign-off) is never auto-satisfied — it is the human gate the whole intake protects.

## Advisory rows — why 8 and 9 do not block

**Measured over the 29 reports in `groomed/`, these two were not failing items; they were being
argued past.** Only 2 of 12 `dor:gaps` items would have flipped if both rows were deleted — every
other one was also missing an acceptance criterion or a value statement, which fails it anyway. But
**11 of the 16 `dor:pass` items carried a written argument for why a thin or absent row 9 should not
block**, and three of them independently invented the same unwritten exemption: _"rad 9 finnes for å
stoppe umålte funksjoner"_ — row 9 exists to stop unmeasured features, so a reproducible defect is
exempt. That rule was in nobody's checklist.

A bar that two thirds of the passing population has to talk its way past is not measuring what it
thinks it is. Worse, the override lived in prose, so the difference between "row 9 genuinely holds"
and "row 9 was waived" was invisible to everything downstream. Advisory makes the waiver the default
and the _reporting_ mandatory, which is the honest version of what was already happening.

Both rows still earn their place in the report — an unsized ticket and an unmeasured one are real
things for the Trio to see. They are just not reasons to send a well-understood ticket back.

**What this gives up.** Row 9 was added for a specific case and that case is real: `SSX-3517` was a
product-approved order arriving with no measurement, where _"dataene finnes og er tilgjengelige"_ —
the data exists and is available. Under the advisory rule that item is a `dor:pass` with a nudge.
If the Trio wants the hard gate back for a class of item, that is a checklist change, not a
judgement call at triage time.

## Tiered DoR — the bar depends on the issue's hierarchy level

The checklist above (blocking rows 1–7, advisory 8–9, human gate 10) is the **leaf** bar (Story / Task / Bug). Do **not** apply it unchanged to
containers or sub-tasks — an Epic is "ready" when its _scope and children_ are clear, not when its
own description restates a problem. Read `issuetype.hierarchyLevel` (and `issuetype.subtask`) from
`getJiraIssue` and pick the tier:

| Tier                                               | Detect                                                                                             | DoR bar                                                                                                                                                           | Empty own-body?                               |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| **Container / Epic**                               | `hierarchyLevel ≥ 1`, or issuetype `Epic`; or a leaf whose naming + links show it only groups work | Goal / outcome statement **or** ≥1 linked child with clear scope. Criteria 2–3 (AC, why-now) are **NOT required on the epic itself** — they live on the children. | **Not a fail** — judge by children (roll-up). |
| **Leaf** (Story/Task/Bug, `hierarchyLevel 0`)      | default                                                                                            | Blocking rows 1–7. **Inherit** value/why-now (crit 2) and scope from the parent epic when the leaf omits it and the parent states it.                             | Fail (nothing to work from).                  |
| **Sub-task** (`subtask:true`, `hierarchyLevel −1`) | default                                                                                            | Atomic action + acceptance **inherited from the parent**. Only crit 1 (clear action) is required standalone.                                                      | Judge against the parent, not standalone.     |

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
