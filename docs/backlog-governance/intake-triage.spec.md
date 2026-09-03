# Skill spec — `intake-triage`

> Vetted via an adversarial design panel (3 proposals × 3 lenses + synthesis).
> **Decision: one skill, not two.** Status: **spec — not yet built.**

## Decision

**One self-contained skill** that always emits the full PM report, plus an additive `--deep`
techlead appendix over the **same** research pass.

**Why not two skills** (PM dedup + techlead implementation): dedup and implementation/routing
share ~80% of one expensive research substrate (parse idea → normalize NO/EN terms → search the
vault graph → search Jira). Two skills either recompute that twice, or re-create the PM→techlead
handoff we are removing. Techlead depth is _additive_, never a prerequisite — the PM report is
complete standalone.

## Purpose

Pre-screen ONE new idea / Jira ticket **before the Trio looks**, so a non-technical PM can answer
in one run: is it a duplicate or already built · does it meet DoR · where would it be built and
what depends on it · how critical (hint) · **does it even belong to our team**. Writes triage
labels + the report back to the ticket.

## File layout (matches vault `scan-repo` / `sync-openapi` convention)

```
skills/intake-triage/
├── SKILL.md                  # thin body; frontmatter name+description; disable-model-invocation: true
├── INTAKE_INSTRUCTIONS.md    # substrate procedure, routing rules, criticality rubric, label vocab
├── DOR_CHECKLIST.md          # mirrors the Confluence DoR page
└── REPORT_TEMPLATES.md       # PM report + techlead appendix templates
```

Install location for actual use: `~/.claude/skills/` or a repo's `.claude/skills/`.

## Inputs / flags

| Input             | Meaning                                                                          |
| ----------------- | -------------------------------------------------------------------------------- |
| target            | Jira key (`SSX-1234`), Jira URL, **or** raw pasted idea text (no ticket yet)     |
| `--deep`          | techlead/designer depth — **appends** technical appendix over cached research    |
| `--project <KEY>` | scope Jira dedup (default SSX + sibling insurance projects + one org-wide query) |
| `--sweep <JQL>`   | batch mode — loop the single-item pipeline over a set (legacy de-pollution)      |
| `--no-write`      | dry-run — produce report, apply **no** Jira changes (PM preview)                 |
| `--vault <path>`  | override vault location if auto-locate fails                                     |

## Steps

0. **Locate vault + load contract.** Try `--vault` → `$INSURANCE_VAULT` →
   `~/Projects/repositories/insurance-knowledge-vault` → walk up from cwd for an `index.yaml`
   with the vault header. **If none found → STOP and ask the user for the path, or tell them
   they must clone `insurance-knowledge-vault` to run intake.** Note freshness
   (`last_scanned` / `last_commit_sha`).
1. **Cache check.** For a Jira key, look for `.claude/intake/<KEY>-dossier.yaml` keyed on the
   issue `updated` timestamp. Unchanged → skip research, render from cache (this is how `--deep`
   and re-runs pay no re-research cost).
2. **Ingest + normalize.** `getJiraIssue` (summary, description, type, components, labels,
   reporter, links, dates) or raw text. Build an idea signature: entities, NO+EN keywords,
   actor verb, surface (buy | claim | mypages | admin | backend).
3. **Domain classify.** Match signature against vault-root `CLAUDE.md` keyword banks +
   `reference/glossary.md` + `domains/*/glossary.md` → primary domain + confidence.
4. **Candidate repo match.** ⚠️ **GREP `keywords:` frontmatter in `repos/*.md`** — the
   authoritative source (50/51 files). `index.yaml` has **no** per-entry keywords; use its
   `description` (secondary) and `domain`/`type` (filter). Open top candidates' `repos/<name>.md`.
5. **Already-solved check (dedup A).** For rest-api candidates read `openapi/<app>.md` tables;
   for web candidates read `repos/<name>.md` Routes/Pages. Record exact method+path/route, or
   "no existing implementation found". (Schema confirmation deferred to `--deep`.)
6. **Already-raised check (dedup B).** `searchJiraIssuesUsingJql` with glossary-expanded
   synonyms: one open-duplicate query, one already-solved (Done/Released), one broad org-wide
   query (catch other-team tickets). Rank by similarity; present as **weak evidence + confidence**.
7. **Routing / ownership verdict.** Rules: (a) candidate repo in `index.yaml` + our domain →
   **OURS**; (b) best-matching core system appears **only** in some repo's `depends_on`, never as
   a top-level `name:` (salesforce, keycloak, F2100/cwp-proxy, alis, nav, customer-master,
   Bisnode…) → **route:other-team**, name the boundary system; (c) a dedup hit sits in a non-SSX
   Jira project → corroborate that team; (d) no match → **route:unknown / needs-human**. Emit
   verdict + confidence + rationale; state ownership is _inferred_ (no `owning_team` field).
8. **Implementation location + blast radius.** From the owning repo(s) read `depends_on`
   (upstream), `depended_on_by` + `endpoint_consumers{}` (who breaks); cross-ref `repos/<name>.md`
   Integrations / Downstream Data Flows. Flag shared-lib / monorepo touches (high blast radius).
   Plain language for the PM.
9. **DoR + criticality.** Score against `DOR_CHECKLIST.md`; auto-fill affected-system +
   dependencies from steps 4–8; list gaps as concrete questions. Criticality = value × effort ×
   urgency band, **H/M/L HINT only**, labeled _"the Trio decides"_.
10. **Write dossier.** `.claude/intake/<KEY-or-slug>-dossier.yaml` keyed on `updated` timestamp,
    with source citations + per-finding confidence + machine frontmatter. Single source for both
    the PM view and the `--deep` appendix.
11. **`--deep` only — technical appendix.** Reuse cached dossier. Confirm request/response
    schemas via `openapi` `spec_url`; dispatch read-only Explore subagents against candidate
    **source** repos only where the vault summary is insufficient. Append appendix; update dossier.
12. **Render + write back.** Render PM report (plain language, complete 5-part answer) + appendix
    if `--deep`. Print verdict banner + next action. Unless `--no-write` / raw-text target:
    apply labels (`editJiraIssue`); post report as a Jira comment with an idempotent
    `<!--intake-triage-->` marker (re-runs **update in place**); `createIssueLink`
    (`duplicates` / `relates to`). **Never auto-transition** — only if `getTransitionsForJiraIssue`
    shows the column exists; otherwise recommend. End with a run summary.

## PM-facing report sections

Verdict banner (one line) · What this idea is · Already raised? · Already solved? ·
Does it belong to us? · Where it would be built · Ready for the Trio? (DoR gaps as questions) ·
How big / how urgent (advisory) · Recommended next step · Labels + evidence & confidence.

`--deep` appends: target service(s) & module · capability-exists evidence (method+path, schema) ·
dependency chain + blast radius · cross-team/external integration points · effort drivers +
open technical questions · machine dossier block.

## Labels

`triaged` · `dup:open|solved|none` · `route:ours|other-team|shared-lib|unknown` ·
`domain:insurance|claims|mypages|shared` · `svc:<repo>` (or `impl-uncertain`) · `dor:pass|gaps` ·
`value:high|med|low` + `effort:S|M|L` + `urgent` · `intake:pm-screened|tech-reviewed` ·
`next:to-trio|to-reporter|to-other-team|needs-techlead`.

## Safety (non-technical operator)

- `--no-write` dry-run; never write when target is raw text (no ticket).
- Idempotent comment marker so re-runs update, not duplicate.
- Never auto-transition; criticality is always an advisory H/M/L hint.

## Known accuracy bounds (state in every report)

- **Vault staleness** — `repos/`/`openapi/` are snapshots; an "already implemented" / "not our
  team" verdict can be wrong. Recommend `--deep` source dive before closing anything as duplicate.
- **JQL recall** over mixed NO/EN — present "no duplicate found" as weak evidence; expand with
  glossary synonyms; search open + Done + org-wide.
- **MCP visibility** — non-SSX Jira projects may be invisible to the token, undercutting the
  other-team dedup query.

## Highest-leverage follow-up

Add an **`owning_team`** (and `jira_project` / `component`) field to `index.yaml`, or a
`config/team-map.yaml`, to make routing **deterministic** instead of inferred.
