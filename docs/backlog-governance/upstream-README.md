# Backlog Governance — SSX Trio

Home for the SSX team's backlog-governance strategy and the AI-assisted intake skill.

**Problem this solves:** the new PM + techlead lack backlog ownership, and the business side
pollutes the backlog (raw ideas, duplicates, wrong entry point, no priority, legacy debt).

**The fix:** one funnel, one gate (Definition of Ready + the Trio), one owner-body — with an
AI pre-screen that leverages `insurance-knowledge-vault` to answer _"is it a duplicate, is it
critical, where would it be built, and does it even belong to our team?"_

## Contents

| File                                                             | What it is                                                                                                                              |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| [`strategy.md`](./strategy.md)                                   | The full strategy — readable Markdown                                                                                                   |
| [`strategy.html`](./strategy.html)                               | The same strategy — presentable, self-contained HTML (open in a browser)                                                                |
| [`skills/intake-triage.spec.md`](./skills/intake-triage.spec.md) | Vetted spec for the `intake-triage` Claude skill                                                                                        |
| [`skills/intake-triage/`](./skills/intake-triage/)               | The built skill — `SKILL.md`, `INTAKE_INSTRUCTIONS.md`, `DOR_CHECKLIST.md`, `SSX_COMPONENTS.md`, `REPORT_TEMPLATES.md`, `QUICKSTART.md` |

## Related, off-repo

- **Backlog Governance (hub)** — Confluence, space SDRM — start here; groups the pages below:
  <https://storebrand.atlassian.net/wiki/spaces/SDRM/pages/1563688972/Backlog+Governance+SSX+Trio>
  - **Backlog Working Agreement** — <https://storebrand.atlassian.net/wiki/spaces/SDRM/pages/1564737544/Backlog+Working+Agreement+SSX+Trio>
  - **Definition of Ready (DoR)** — <https://storebrand.atlassian.net/wiki/spaces/SDRM/pages/1563820058/Definition+of+Ready+DOR>
  - **How to run intake-triage** (install + run + troubleshooting) — <https://storebrand.atlassian.net/wiki/spaces/SDRM/pages/1563426827/How+to+run+intake-triage+AI+backlog+pre-check>
- **Knowledge vault** — `~/Projects/repositories/insurance-knowledge-vault` (the service graph the skill reads)

## Distribution & roadmap

- **Now:** copy/symlink `skills/intake-triage` into each person's `~/.claude/skills/` (see `QUICKSTART.md`).
- **Planned:** host the skill inside `insurance-knowledge-vault` (alongside `scan-repo` /
  `sync-openapi`) so a vault clone ships it to every developer and AI agent that specs Jiras.
- **Open decision — `disable-model-invocation`:** currently `true` (manual `/intake-triage` only;
  Claude never auto-runs it — safe for a non-technical operator, since it writes to Jira). If we
  want AI agents to auto-use it while spec'ing Jiras, flip to model-invocable and rely on
  `--no-write` + the idempotent comment marker for safety. Keep manual-only until the write path
  is proven.

## Status

- [x] Strategy drafted (`strategy.md` / `strategy.html`)
- [x] DoR page seeded in Confluence
- [x] `intake-triage` skill architecture decided + spec written _(one skill, not two)_
- [x] `intake-triage` skill built (Phase A) — installed at `~/.claude/skills/intake-triage` (symlink)
- [x] Legacy backlog sweep run — see sizing below
- [x] Working Agreement seeded in Confluence
- [ ] Web intake form evaluated (Phase B)

## Legacy sweep — SSX sizing (read-only, 2026-08-27)

| Metric                                                | Count     |
| ----------------------------------------------------- | --------- |
| Total SSX (incl. Done)                                | 3599      |
| **Open** (not Done)                                   | **446**   |
| — To Do (raw backlog)                                 | 367       |
| — In Progress (WIP)                                   | 79        |
| Open, unassigned                                      | 336 (75%) |
| Open, stale > 12 mo                                   | 76        |
| Open, no description                                  | 81        |
| Open, created > 2 yr                                  | 84        |
| **Bankruptcy pool** (stale > 12 mo OR no description) | **142**   |

~142 items (~39% of the 367 To Do backlog) are prime archive/close candidates. Clearing them
cuts the To Do backlog to ~225.
