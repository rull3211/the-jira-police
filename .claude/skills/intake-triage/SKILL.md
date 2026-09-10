---
name: intake-triage
description: Pre-screen one backlog idea or Jira ticket before the SSX Trio looks — dedup, Definition of Ready, implementation location, criticality, and team-ownership routing — using the insurance-knowledge-vault and the Atlassian/Jira MCP
disable-model-invocation: true
---

Pre-screen ONE new backlog idea or Jira ticket **before the Trio (Techlead + PM + Designer) looks**, so a non-technical PM can answer in a single run:

1. **Already raised / already solved?** — duplicate or prior delivery (Jira + vault)
2. **Definition of Ready** — does it pass, and if not, what is missing
3. **Where would it be built?** — candidate service(s) + dependency chain / blast radius
4. **How critical?** — a value × effort × urgency HINT (the Trio decides)
5. **Does it even belong to us?** — a routing/ownership verdict: ours, another team, or unplaceable

The default run always emits the complete PM report. `--deep` reuses the same research and **appends** a techlead technical appendix — it is additive, never a prerequisite, so the PM is never blocked on the techlead.

The board's issue types — **Oppgave** (Task), **Feil** (Bug), **Epic** — steer the path (see `INTAKE_INSTRUCTIONS.md` §1b); a planned `bugFastPath` switch (**OFF now**) will later send a **Feil** straight to _Prioritized_. Every **ACCEPT** carries a default **dev lens** (feasibility + the top technical question) so developers weigh in during prioritization, not after — and DoR carries an **advisory data/evidence** row: an unmeasured item is reported and passed, never sent back on that alone. Every run also writes a self-contained, shareable **HTML roll-up dashboard** for the Trio (local file, never a Jira write).

## Usage

- `/intake-triage SSX-1234` — triage a Jira ticket (key or URL); prints the report, RENDERS the proposed Jira payload, then STOPS and asks before any write
- `/intake-triage "<pasted idea text>"` — triage raw text before a ticket exists (never writes — no ticket)
- `/intake-triage SSX-1234 --deep` — also append the techlead technical appendix
- `/intake-triage SSX-1234 --no-write` — pure preview: print the report + payload, never offer to write (demos, learning, CI)
- `/intake-triage SSX-1234 --yes` — non-interactive/cron only (advanced): skip the gate, still no transition, still honours `--limit`
- `/intake-triage --sweep "<JQL>"` — batch mode: numbered manifest → `all`/`none`/`1,2,5` selective apply, paged, no hard cap (warns on large sets; optional `--limit N`)
- Flags: `--project <KEY>` (scope dedup) · `--vault <path>` (override vault location) · `--limit N` (bound a run) · `--no-html` / `--html <path>` (the HTML roll-up dashboard is written automatically after every run — suppress it, or set its path)

## Steps (summary — full contract in `INTAKE_INSTRUCTIONS.md`)

1. **Read the contract first.** Open `skills/intake-triage/INTAKE_INSTRUCTIONS.md` (substrate procedure, routing rules, criticality rubric, label vocabulary), `DOR_CHECKLIST.md`, `SSX_COMPONENTS.md` (component mapping), and `REPORT_TEMPLATES.md`. Routing authority is the vault's `reference/teams.md` (team ↔ `jira_project` ↔ `ssx_component`), read at run time alongside `index.yaml`.
2. **Locate the vault.** Resolve `--vault` → `$INSURANCE_VAULT` → `~/Projects/repositories/insurance-knowledge-vault` → walk up from cwd for an `index.yaml` carrying the vault header. **If none is found, STOP and ask the user for the path, or tell them they must clone `insurance-knowledge-vault` to run intake.** Note vault freshness (`last_scanned` / `last_commit_sha`).
3. **Cache check.** For a Jira key, reuse `.claude/intake/<KEY>-dossier.yaml` if the ticket's `updated` timestamp is unchanged (this is how `--deep` and re-runs pay no re-research cost).
4. **Run the research substrate** (ingest → domain classify → candidate repo match → already-solved → already-raised → routing verdict → component detection → blast radius → DoR + criticality). One pass answers all five questions.
5. **Render → confirm gate → write back.** Print the verdict banner + next action, then RENDER the exact mutation payload: the VERBATIM comment body, the LABEL DELTA (`+ add: …` / `- remove: …`), the links, whether it will CREATE or UPDATE the skill comment, and a fixed line `Transition: none (recommend-only)`. Then STOP and ask: `[y] post · [n] skip · [e] edit the comment first`. Write ONLY on `y`; on `n` write nothing (the report still printed); on `e` let the operator amend, re-render the payload, ask again. Unsure → `n`, take it to the Trio. In preview (the default dry-run, `--no-write`) render the payload but never offer to write; raw-text input never writes (no ticket). `--yes` skips the gate for non-interactive/cron runs only — it still honours `--limit` and still never transitions. On a confirmed write: READ current labels and UNION with the skill's namespaced set (send no bare replacement array; on a verdict change drop only the skill's OWN stale `route:*`/`dup:*`/`dor:*`/`tier:*`/`intake:*` labels — never touch human labels); post/refresh the report as a Jira comment identified by BOTH its own Jira account authorship AND the full footer sentinel `_🤖 Generated by intake-triage · re-run the command to refresh._` (update only a comment satisfying both, else create — the preview says which); create the issue link (`duplicates` only for a dup:HIGH match, else `relates to`). **Never auto-transition** — status changes (incl. close-as-duplicate) are only ever printed in `→ Next`. After the run resolves, ALWAYS write the local **HTML roll-up dashboard** (§12; a report, not a Jira write — single ticket = one row, sweep = full table) and print its path; `--no-html` opts out.

## Non-negotiables

- **Grounding:** candidate-repo matching greps `keywords:` frontmatter in `repos/*.md` (authoritative — `index.yaml` has NO per-entry keywords). Ownership is **read, not inferred** — take `owning_team` / `jira_project` / `ssx_component` off the matched repo's `index.yaml` entry; `route:ours` iff `owning_team == SSX`, else `route_target = owning_team` with the entry's `jira_project`. `reference/teams.md` is the authority for field meanings and normalisation (CLI→ICC, EDH2→SSX, BI legacy, POPS private, USN/IT support desks excluded). **Never route on labels.**
- **Components (tech-lead policy — four only):** assign a Jira component ONLY from the four team streams — `SSX Advisor` · `EDH` · `SSX Partner` · `SSX Nettsalg` (validate against the live set at runtime; mapping guide in `SSX_COMPONENTS.md`). Never invent one; never auto-assign any other component (product lines, apps, `Old stuff`, `SMÅOPPGAVER`); cap auto-apply at 1 and only at high confidence, else emit `comp:uncertain` and suggest. For an SSX repo, **seed** from the entry's `ssx_component` (already 1:1 with one of the four); fall back to the surface→stream map only when it is `multiple`/absent. Never seed a component for a non-SSX repo (the component axis is SSX-only). Merge — never clobber a human-set component.
- **Scannable output (`triage-scorecard`):** verdict + action on line 1 (H1); lines 1–3 must answer the yes/no alone; then the fixed 6-gate scorecard (Ours→Raised→Solved→DoR→Build→Component). A cell carries prose ONLY when its flag is not 🟢, so exceptions are the only thing to read. Fixes go in `→ Next`, never a cell. Reserve 🟡/🔴 for genuine attention (a PASS-with-follow-up DoR stays 🟢) — protect the flags from fatigue. Full spec in `REPORT_TEMPLATES.md`.
- **Safety for a non-technical operator:** a CONFIRM GATE is the default — no Jira write happens without an explicit `y`; the payload preview shows the verbatim comment body + label delta + `Transition: none` so the operator can sanity-check before any write; `--no-write` is a pure preview (never offered to write); raw text never writes; labels UNION with current (never clobber); never auto-transition (status changes are recommend-only, printed in `→ Next`); `--sweep` is a numbered manifest + selective apply (`all`/`none`/`1,2,5`), never a blind batch; the comment sentinel makes re-runs update in place, not duplicate; criticality is always an advisory H/M/L hint, never an authoritative score — it lives in the reason line, never as a scorecard gate.
- **Honesty:** state accuracy bounds in every report (vault staleness, JQL recall over Norwegian/English, MCP project visibility).
- **Do not spawn sub-agents in the default run** — they cannot prompt for tool permissions and will fail. `--deep` may dispatch read-only Explore sub-agents against source repos only where the vault is insufficient.
