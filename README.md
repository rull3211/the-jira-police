# the-jira-police

A service that watches the SSX Jira board, runs Storebrand's `/intake-triage` skill against every
new ticket, checks the verdict mechanically, and posts it back.

A **second queue** is being added alongside it: tickets a triage assessment marked
`agent:solvable`, waiting to be fixed by an agent. Today that queue picks tickets and plans the
label edit that would claim one. It cannot make the edit, cannot write code, and is not run by
the daemon.

`ARCHITECTURE.md` is the design document — why grooming is three steps, which credential is
allowed to do what, and what is deliberately unbuilt. This file is how to run it.

---

## Setup

Node ≥ 24 and pnpm ≥ 11. There is **no build step** — Node runs the TypeScript directly by
stripping types.

```bash
pnpm install
cp .env.example .env    # then fill in JIRA_EMAIL, JIRA_AUTH, VAULT_PATH
```

Check it without spending anything:

```bash
pnpm poll:once --dry-run
```

That does discovery only — no model call, no cost, no writes. It is the fastest way to find out
whether the credential and the JQL scope are right.

---

## Demo path

Four commands, in escalating order of what they touch. Nothing below writes to Jira unless the
command says so.

### 1. What would be triaged?

```bash
pnpm poll:once --dry-run
```

Lists the new tickets discovery found and stops. Free.

### 2. Triage one ticket, without posting

```bash
pnpm triage:once SSX-1234
```

Runs the real skill (~3–8 min, ~$0.11), writes `groomed/SSX-1234.md`, and posts **nothing**. The
report contains the verdict, the label delta, the DoR check, and the **agent-fitness call** —
whether this ticket looks safely fixable by an agent, with the reasoning.

Add `--write` to actually post the comment and labels:

```bash
pnpm triage:once SSX-1234 --write
```

`--write` **decides** `WRITE_BACK` for that run rather than adding to it — typing it posts even
if `.env` says `false`, and omitting it previews even if `.env` says `true`. Both directions are
deliberate: an operator who does not type the flag cannot post to a shared ticket by inheriting a
setting they never looked at. There is no `--no-write`; preview is the default.

One exception: a stand-in skill (`mock-triage`, `live-triage-probe`) never posts, flag or not. A
rehearsal that comments on a real ticket is not a rehearsal.

### 3. What would the solve queue pick up?

```bash
SOLVE_ENABLED=true pnpm solve:once
cat groomed/solve-cycle.md
```

Reads the board, works out which tickets it would claim and the exact label edit each claim would
be, and writes it all to `groomed/solve-cycle.md`. **Changes nothing** — not a label, not a
branch, not a file.

The report carries the config the cycle ran under, both JQL queries verbatim so you can paste
them into Jira and check by hand, and every candidate with the decision made about it beside the
labels that decision was made from.

### 4. Run the daemon

```bash
pnpm start --interval 20s          # override POLL_INTERVAL_MS for this run
pnpm start --interval 30s --for 4m # …and stop after four minutes
pnpm dev                           # same, with --watch
```

**Grooming only.** The daemon does not run the solve queue and is not meant to yet — see
*Phases* below.

---

## Demoing the solve queue end to end

The queue selects on labels, so a demo needs a ticket wearing them. It is staged on purpose:
three of these four observations should be empty, and that is what makes the fourth mean
something.

Pick a ticket in `SSX` / component `SSX Advisor`, not Done, carrying a `svc:<repo>` label naming
a repo on `SOLVE_REPOS`.

| Step | Do | Expect in `groomed/solve-cycle.md` |
| --- | --- | --- |
| 0 | Nothing — run it as a control | `## The queue was empty` |
| 1 | Add `agent:solvable` in the Jira UI | Still empty — the human gate is holding |
| 2 | Add `agent:start` | `## PLAN — SSX-1234` with the claim `+agent:solving` `-agent:start` |
| 3 | Remove both labels | Empty again |

Re-run `SOLVE_ENABLED=true pnpm solve:once` after each step.

**Add the labels in the Jira UI, not through the MCP tool.** The UI adds one label atomically;
the write path available to this service can only replace the whole label field, which would
silently drop anything edited in between. See invariant 11 in `ARCHITECTURE.md`.

The other two decision types need no board changes — both are env overrides on top of step 2:

```bash
# SKIP — eligible, but the repository is not allowed
SOLVE_ENABLED=true SOLVE_REPOS= pnpm solve:once

# WAIT — eligible and allowed, but no capacity this cycle
SOLVE_ENABLED=true MAX_CONCURRENT_SOLVES=0 pnpm solve:once
```

`groomed/solve-cycle.md` is a snapshot, replaced on every run. To keep a stage for comparison,
`cp` it somewhere between runs.

---

## Commands

| Command | What it does | Writes? |
| --- | --- | --- |
| `pnpm poll:once --dry-run` | Discovery only. Free | no |
| `pnpm poll:once` | One full grooming cycle | only with `WRITE_BACK=true` |
| `pnpm triage:once <KEY>` | Triage one ticket, preview the result | `groomed/<KEY>.md` |
| `pnpm triage:once <KEY> --write` | …and post it. The flag decides `WRITE_BACK` on its own | Jira |
| `pnpm triage:once <KEY> --skill <name>` | Use a different skill (e.g. `mock-triage`) | as above |
| `pnpm solve:once` | One solve cycle. Needs `SOLVE_ENABLED=true` | `groomed/solve-cycle.md` |
| `pnpm start [--interval 20s]` | The daemon — **grooming only** | as configured |
| `pnpm dev` | The daemon with `--watch` | as configured |
| `pnpm check-types && pnpm lint && pnpm test` | The full check | no |

The typecheck script is **`check-types`**, not `typecheck`.

### Flags that do not exist yet

`solve:once` takes no arguments today. As the remaining phases land it grows one flag each, every
one implying the ones before it, so the command line reads as the privilege escalation it is:

```
pnpm solve:once                    # whole queue, dry              ← built
pnpm solve:once SSX-1234           # one named ticket, dry
pnpm solve:once SSX-1234 --claim   # writes the claim label
pnpm solve:once SSX-1234 --solve   # runs the solver, nothing pushed
pnpm solve:once SSX-1234 --pr      # opens the draft PR
```

---

## Settings

Full table in `ARCHITECTURE.md` §10. The ones that matter for a demo:

| Setting | Default | Notes |
| --- | --- | --- |
| `JIRA_EMAIL`, `JIRA_AUTH` | — | Required. Discovery only — this credential never writes |
| `VAULT_PATH` | — | Required by the real skill; checked at startup, not on the first ticket |
| `SKILL_NAME` | `mock-triage` | **Defaults to the mock**, so an unconfigured service cannot post |
| `WRITE_BACK` | `false` | The only setting the whole team can see the effect of. Strict `"true"` |
| `SOLVE_ENABLED` | `false` | Master switch for the solve queue. Strict `"true"` |
| `SOLVE_MODE` | `manual` | `manual` also requires the human's `agent:start` label |
| `SOLVE_REPOS` | — | Repository allowlist, **no default**. Unset means nothing is allowed |

Anything that grants privilege reads silence as "no". A blank or misspelled `WRITE_BACK` does not
post; an empty `SOLVE_REPOS` allows no repository.

---

## Phases

The bug-fixing feature ships in stages, so the fitness assessment can be judged before anything
acts on it. Triage cannot read source code, so `agent:solvable` is a *candidate* signal.

| Phase | Scope | State |
| --- | --- | --- |
| A | Fitness assessment in triage, `agent:solvable` | **built** |
| B1 | The picker: solve queue, claim planning, cycle report | **built** |
| B2 | The claim write, verified by re-reading, plus release | not started |
| C | The solver: worktree, recon, edit, verification, diff gate | not started |
| D | Push, draft PR, Copilot review loop, undraft | not started |
| E | Run it from the daemon | **last, on purpose** |

Every phase owes two hand-operated commands before it counts as done: a dry run that reports what
it *would* change, and a single run against one named ticket. The daemon is last because the only
thing it adds is that nobody is watching — a ticket claimed, solved and PR'd by hand is a
demonstration; the same sequence on a five-minute timer is a deployment.

A human always merges. The bot has no merge path.
