# Backlog Governance Strategy — SSX Trio

> One funnel, one gate, one owner-body. Business ideas enter through a single intake queue,
> pass a Definition of Ready, and only then reach the refined backlog — with AI doing the
> tedious first-pass screening so the Trio spends time on decisions, not cleanup.

---

## Context

The PM and techlead are **new** and have **no felt ownership** of the backlog. At the same
time the product/business side **pollutes** it:

- Raw ideas — no acceptance criteria, no value statement
- Duplicates, stale items, and general noise
- Business writes **directly into the dev backlog** (no intake gate)
- No prioritization — everything looks equally urgent
- **Legacy debt** — old Jiras where nobody knows if the work was done; many poorly documented tickets

Decisions are made by a **Trio**: Techlead + PM + Designer. They decide _how_ and _when_ work
is implemented. This strategy gives the Trio real ownership, stops new pollution at the source,
and cleans up the existing mess — with an **AI-assisted intake** the team can adopt.

---

## Core principle

**One funnel, one gate, one owner-body.** Ideas enter only through a single **Intake queue**,
never the dev backlog. Nothing crosses into the refined backlog until it passes the
**Definition of Ready (DoR)** and the **Trio** approves it.

---

## Strategy — 5 parts

### 1. Ownership: name the gate, make it a ritual

- The **Trio owns the backlog** as a body: **PM** owns _value/priority_, **Techlead** owns
  _feasibility/sizing_, **Designer** owns _user/UX impact_. An item needs all three lenses to advance.
- New people build ownership through **cadence**, not decree. Two fixed rituals:
  - **Weekly triage (30 min)** — empty the Intake queue: accept / reject / send-back.
  - **Bi-weekly refinement (60 min)** — shape accepted items to Ready, size, prioritize.
- Write a one-page **Working Agreement** (who decides what, SLAs, what "no" looks like).
  This is the artifact that converts "new and unsure" into "we own this."

### 2. Single intake funnel: stop direct writes

- Create a separate **Intake** entry point (a distinct Jira project, or an "Idea/Triage"
  status lane) that is the _only_ place business submits.
- Business **loses create-rights** on the dev backlog; they submit ideas, the Trio promotes them.
- A short **intake template** forces minimum context: problem, who's affected, value/why-now,
  rough size (unknown OK), links/evidence.

### 3. Definition of Ready — the quality bar

An item may enter the refined backlog only when it has:

- Clear problem statement + affected user/segment
- Value / why-now (business justification)
- Acceptance criteria (testable)
- No open duplicate; links to related items
- Trio sign-off (value ✓ feasibility ✓ UX ✓)

Items failing DoR are **sent back with a reason**, not silently parked. This trains the business
over time and is the single biggest anti-pollution lever.

> **Canonical DoR** lives in Confluence: _Definition of Ready (DOR)_, space **SDRM** —
> <https://storebrand.atlassian.net/wiki/spaces/SDRM/pages/1563820058/Definition+of+Ready+DOR>

### 4. AI-assisted intake — the accelerator

Insert an **AI pre-screen between submission and the Trio** so garbage is caught before a human
looks. It leverages the team's **`insurance-knowledge-vault`** to answer questions a
non-technical PM otherwise cannot — _including whether the item even belongs to our team._

On each new intake item the AI:

- Scores it against the **DoR** and lists what's missing (as questions to send the requester)
- **Already raised?** — searches Jira (open + done) for duplicates / prior delivery
- **Already solved?** — checks the vault's `openapi/*.md` endpoint tables and `repos/*.md`
  routes for an existing implementation
- **Where would it be built?** — matches the idea to candidate repos and walks the dependency
  chain / blast radius
- **Does it belong to us?** — a **routing/ownership verdict**: ours, another team, or unplaceable
- **Which component?** — maps the item to the correct **existing** SSX Jira component (fetched live,
  never invented) so it lands on the right board
- **How critical?** — a value × effort × urgency **hint** (explicitly: _the Trio decides_)
- Labels the ticket with a **structured, filterable set** so the Trio can query the board without
  opening tickets — `triaged`, `dup:open|solved|none`, `route:ours|other-team|shared-lib|unknown`,
  `domain:*`, `svc:<repo>`, `dor:pass|gaps`, `value:*` + `effort:*`, `next:*` (component is set on
  the native Jira field, not a label)

**Why the vault matters:** it is a machine-readable service graph.

| Vault asset                                                         | What the skill reads it for                                                          |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `repos/*.md` frontmatter `keywords:` (50/51 files)                  | **Authoritative** candidate-repo match (⚠️ `index.yaml` has _no_ per-entry keywords) |
| `index.yaml` `domain` / `type` / `description`                      | Narrow candidates, classify build site                                               |
| `index.yaml` `depends_on` / `depended_on_by` / `endpoint_consumers` | Dependency chain + blast radius                                                      |
| `openapi/*.md` endpoint tables                                      | "Already solved?" capability check                                                   |
| `domains/*` + `reference/glossary.md`                               | Norwegian↔English term normalization, domain classify                                |
| `repos/*.md` `last_scanned` / `last_commit_sha`                     | Freshness / confidence caveat                                                        |

**Routing signal (verified):** external / other-team systems (salesforce, keycloak, F2100,
alis, Bisnode…) appear only inside a repo's `depends_on`, never as a top-level `name:`. That is
the "not our team" detector — so a report that belongs elsewhere is spotted _before_ refinement.

**Delivery: one skill, not two.** _(decided via an adversarial design panel — see `skills/intake-triage.spec.md`)_

- A single **`intake-triage`** skill always emits the full PM report (all six answers above),
  then an additive **`--deep`** mode appends a techlead technical appendix over the **same**
  research pass.
- **Why not two skills** (one PM-dedup, one techlead-implementation)? Dedup and
  implementation/routing share ~80% of one expensive research substrate (parse idea → normalize
  terms → search vault graph → search Jira). Two skills either recompute that twice or
  **re-create the exact PM→techlead handoff we are trying to remove**. The PM must get the
  complete answer alone; the techlead only wants _more depth_, not a _different_ answer.
- **Phase A (start here):** the Claude skill over the Atlassian MCP + local vault. Low cost, no
  infra, lives in the existing workflow. Authored to match the vault's `SKILL.md` convention.
- **Phase B (later, only if volume justifies):** a web intake form → AI, so cleaned/scored
  drafts land in Jira and business never touches Jira directly. Strongest pollution control, real build cost.

### 5. Legacy cleanup — backlog bankruptcy, AI-assisted

The old/undocumented Jiras are a **separate, parallel** track:

- **Age-out rule:** anything untouched > _N_ months (default 6) auto-flagged `stale`.
- **AI sweep:** batch-classify old items — likely-done / duplicate / still-relevant / unclear.
  The `intake-triage` skill runs in a `--sweep` batch mode over the same pipeline; for
  "likely-done" it cross-checks `openapi/*.md` and merged PRs where reachable.
- **Trio verdict** on the flagged set: archive/close in bulk; keep only what survives DoR.
- **Declare bankruptcy once:** archive the long tail. A small, owned backlog is what makes
  ownership possible for new people.

---

## Get it running — PM & Designer

The skill is an explicit tool you invoke as `/intake-triage` — it never runs by itself. Three
things must be in place first:

| Prerequisite    | What / how                                                                                                                  |
| --------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Claude Code     | Installed and signed in.                                                                                                    |
| Atlassian MCP   | Connected + authenticated once: `/mcp` → **atlassian** → **Authenticate** (browser sign-in). Needed for Jira + Confluence.  |
| Knowledge vault | Clone `insurance-knowledge-vault` to `~/Projects/repositories/insurance-knowledge-vault` — the skill hard-stops without it. |

**Install (once):** copy or symlink the skill folder into your personal skills dir, then start a
session — `cp -r <path>/intake-triage ~/.claude/skills/`. Verify with `/skills` or by typing `/`
and looking for `/intake-triage`. No restart needed.

**Run:**

| Command                              | Does                                                     |
| ------------------------------------ | -------------------------------------------------------- |
| `/intake-triage SSX-1234`            | Full triage of one ticket — the PM report                |
| `/intake-triage "<idea text>"`       | Triage a raw idea before a ticket exists (no write-back) |
| `/intake-triage SSX-1234 --no-write` | Preview — change nothing in Jira                         |
| `/intake-triage SSX-1234 --deep`     | Append the techlead technical appendix                   |

> **Full how-to** — step-by-step install, troubleshooting, and command reference:
> [How to run intake-triage](https://storebrand.atlassian.net/wiki/spaces/SDRM/pages/1563426827/How+to+run+intake-triage+AI+backlog+pre-check)
> (Confluence, space SDRM). Canonical text: `skills/intake-triage/QUICKSTART.md`.

---

## Recommended rollout order

1. **Week 1** — Working Agreement + DoR agreed by the Trio _(DoR page already drafted)_.
2. **Week 1–2** — Stand up the Intake funnel; remove direct-create on the dev backlog; publish
   the intake template to the business.
3. **Week 2** — Start the two rituals (weekly triage, bi-weekly refinement).
4. **Week 2–4** — Build the **`intake-triage`** Claude skill (Phase A) to auto-screen the queue.
5. **Parallel** — Run the **legacy AI sweep** + backlog-bankruptcy pass.
6. **Later** — Evaluate the **web intake form** (Phase B) only if needed.

---

## Open decisions for the Trio

| Decision              | Default assumed here                                                   |
| --------------------- | ---------------------------------------------------------------------- |
| Gate strictness       | **Trio-consensus** (vs PM-sole)                                        |
| Stale threshold _N_   | **6 months**                                                           |
| Priority framework    | **Value × Effort** grid (vs WSJF-lite)                                 |
| Intake location       | separate Jira project **or** status lane                               |
| Deterministic routing | add `owning_team` / `jira_project` to `index.yaml` (removes inference) |

> **Routing accuracy note:** the vault has **no `owning_team` field** today, so ownership is
> _inferred_. Adding `owning_team` (or a `config/team-map.yaml`) to the vault makes routing
> deterministic and is the highest-leverage follow-up.

---

## Verification — how to know it worked

- Business `create` on the dev backlog is disabled; all new items arrive via Intake — measurable.
- Every refined-backlog item has acceptance criteria + Trio sign-off (spot-check 10 items).
- Intake queue is emptied each week (triage ritual has ~zero carry-over on average).
- Legacy: count of `stale` / undocumented items trends to ~0 after the bankruptcy pass.
- Phase A shipped: AI labels present on 100% of new intake; Trio triage time per item drops.

---

_Companion files: `README.md` (index) · `strategy.html` (presentable) · `skills/intake-triage.spec.md` (vetted skill spec)._
