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
pnpm triage:once SSX-1234 --skill intake-triage
```

Runs the real skill (~3–8 min, ~$0.11), writes `groomed/SSX-1234.md`, and posts **nothing**. The
report contains the verdict, the label delta, the DoR check, and the **agent-fitness call** —
whether this ticket looks safely fixable by an agent, with the reasoning.

Add `--write` to actually post the comment and labels:

```bash
pnpm triage:once SSX-1234 --skill intake-triage --write
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
pnpm start --skill mock-triage --interval 10s --for 1m
```

**Grooming only.** The daemon does not run the solve queue and is not meant to yet — see
_Phases_ below. The next section is how to work up to a real run.

---

## Running the daemon for real

`pnpm start` polls, triages and repeats until told to stop. Three flags override settings **for a
single run**, so a smoke test needs no edit to `.env` and leaves nothing behind in it:

| Flag                    | Overrides                      | Example                     |
| ----------------------- | ------------------------------ | --------------------------- |
| `--skill <name>`        | `SKILL_NAME`                   | `--skill live-triage-probe` |
| `--interval <duration>` | `POLL_INTERVAL_MS`             | `--interval 30s`            |
| `--for <duration>`      | nothing — bounds the whole run | `--for 4m`                  |

Durations take `ms`, `s`, `m`, `h`, or a bare millisecond count: `30s`, `4m`, `1.5m`, `2h`.

There is **no `--write` flag on the daemon.** Unlike `triage:once`, posting is controlled only by
`WRITE_BACK` in the environment. A long-running unattended process should not be able to acquire
write access from a shell history entry.

### Work up to it in four steps

Each step turns on one more real thing. Run each for a bounded `--for` and read the log before
going on.

**1 — the loop itself. Free, no Atlassian, no model.**

```bash
pnpm start --skill mock-triage --interval 10s --for 1m
```

`mock-triage` reads nothing and is given an empty tool allowlist. This exercises cadence, the
cursor, the state file, backoff and graceful shutdown, and costs nothing. If something is wrong
with the _service_, it is wrong here.

Expect one `cycle.done` per interval and a clean stop:

```
{"message":"service.start", …}
{"message":"poll.query",  …}
{"message":"cycle.done","found":1,"skipped":1,"triaged":0, …}
{"message":"cycle.done","found":1,"skipped":1,"triaged":0, …}
{"message":"shutdown.requested","reason":"deadline", …}
{"message":"service.stopped","cycles":2,"failures":0}
```

`found: 1, triaged: 0` is the normal result on a repeat run — the ticket was found and then
skipped because it is already in `seenKeys`. See _the cursor persists_ below.

**2 — a real subprocess and a real Atlassian session, still no verdicts.**

```bash
pnpm start --skill live-triage-probe --interval 30s --for 4m
```

`live-triage-probe` is a stand-in: it opens a genuine MCP session and reads the ticket, so it
proves the subprocess contract, MCP connectivity and the timeout path. It is **structurally
unable to post** — stand-in skills are pinned to preview no matter what `WRITE_BACK` says.

**3 — the real skill, previewing.**

```bash
FIRST_RUN_LOOKBACK_MINUTES=5 pnpm start --skill intake-triage --for 20m
```

Real triage, real cost — roughly **$0.11 and 3–8 minutes per ticket**. Reports land in
`groomed/`; nothing reaches Jira while `WRITE_BACK=false`, which is the default.

Name the skill on the command line even if `.env` already sets it. `SKILL_NAME` **defaults to
`mock-triage`**, deliberately — an unconfigured service must not be able to post — so a run that
omits the flag on a machine without that setting quietly produces mock verdicts, and mock output
is plausible enough to be believed. Stating it makes each step of this ladder self-contained.

Note `--interval` is the gap _between_ cycles, not a rate limit on triages: a cycle takes as long
as its tickets do, so `--interval 20s` with the real skill does not mean three triages a minute.

**4 — writing to the board.**

```bash
WRITE_BACK=true pnpm start --skill intake-triage --for 20m
```

Everything above, plus comments and labels on real tickets, as your own Jira user.

Both halves are required and neither is enough alone: a stand-in skill ignores `WRITE_BACK`
entirely, and the real skill with `WRITE_BACK=false` previews. Posting needs the real skill _and_
the setting.

### The two things that catch people out

**The lookback window on a first run.** With no state file the service looks back
`FIRST_RUN_LOOKBACK_MINUTES` (default 60). Widen it and you get _one paid triage per historical
issue_ in the window. Narrow it for a demo:

```bash
FIRST_RUN_LOOKBACK_MINUTES=5 pnpm start --for 10m
```

**The cursor persists.** `state/poll.json` holds the cursor and every key ever seen:

```json
{ "cursor": "2026-09-03T20:01:26.658+0200", "seenKeys": ["SSX-3813", "SSX-3814", "…"] }
```

A ticket in `seenKeys` is never triaged again, so a second demo run finds nothing. To replay:

```bash
rm state/poll.json          # full reset — re-triages everything in the lookback window
```

Both `state/` and `groomed/` are gitignored. The file is re-read at the start of every cycle
rather than held in memory, so editing it out of band — or running `poll:once` alongside — is
respected rather than clobbered.

### Stopping it

`Ctrl-C` (or `SIGTERM`, or closing the terminal) lets the current cycle finish, so a ticket
mid-triage is either completed and recorded or left untouched for next time. A **second** signal
exits immediately. Look for `service.stopped` in the log — its absence means the process died
rather than stopped.

---

## Demoing the solve queue end to end

The queue selects on labels, so a demo needs a ticket wearing them. It is staged on purpose:
three of these four observations should be empty, and that is what makes the fourth mean
something.

Pick a ticket in `SSX` / component `SSX Advisor`, not Done, carrying a `svc:<repo>` label naming
a repo on `SOLVE_REPOS`.

| Step | Do                                  | Expect in `groomed/solve-cycle.md`                                  |
| ---- | ----------------------------------- | ------------------------------------------------------------------- |
| 0    | Nothing — run it as a control       | `## The queue was empty`                                            |
| 1    | Add `agent:solvable` in the Jira UI | Still empty — the human gate is holding                             |
| 2    | Add `agent:start`                   | `## PLAN — SSX-1234` with the claim `+agent:solving` `-agent:start` |
| 3    | Remove both labels                  | Empty again                                                         |

Re-run `SOLVE_ENABLED=true pnpm solve:once` after each step.

**Add the labels however you like.** This paragraph used to say "in the Jira UI, not through the
MCP tool", because the only write path this service had replaced the whole label field and would
silently drop anything edited in between. It no longer does: `JiraClient.updateLabels` sends
Jira's own `update.labels.add` / `.remove` and can only ever name `agent:*`. See invariant 11 in
`ARCHITECTURE.md`.

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

| Command                                                | What it does                                                                 | Writes?                     |
| ------------------------------------------------------ | ---------------------------------------------------------------------------- | --------------------------- |
| `pnpm poll:once --dry-run`                             | Discovery only. Free                                                         | no                          |
| `pnpm poll:once`                                       | One full grooming cycle                                                      | only with `WRITE_BACK=true` |
| `pnpm triage:once <KEY> --skill intake-triage`         | Triage one ticket, preview the result                                        | `groomed/<KEY>.md`          |
| `pnpm triage:once <KEY> --skill intake-triage --write` | …and post it. The flag decides `WRITE_BACK` on its own                       | Jira                        |
| `pnpm triage:once <KEY>`                               | Same, but the skill comes from `SKILL_NAME` — **which defaults to the mock** | `groomed/<KEY>.md`          |
| `pnpm solve:once`                                      | One solve cycle. Needs `SOLVE_ENABLED=true`                                  | `groomed/solve-cycle.md`    |
| `pnpm start`                                           | The daemon — **grooming only**. Takes `--skill`, `--interval`, `--for`       | only with `WRITE_BACK=true` |
| `pnpm dev`                                             | The daemon with `--watch`; same flags                                        | as above                    |
| `pnpm check-types && pnpm lint && pnpm test`           | The full check                                                               | no                          |

The typecheck script is **`check-types`**, not `typecheck`.

### The escalation ladder

Each `solve:once` flag is one phase's worth of privilege, so the command line reads as the
escalation it is. **The ladder is cumulative**: `--pr` claims the ticket, solves it and opens the
pull request. This README previously said it was not, which was true while the phases were built
out of order and `--claim` refused; both are wired now.

```
pnpm solve:once                    # whole queue, dry
pnpm solve:once SSX-1234           # one named ticket, dry
pnpm solve:once SSX-1234 --claim   # claims, checks the queue drops it, releases
pnpm solve:once SSX-1234 --solve   # ... and runs the solver; nothing is pushed
pnpm solve:once SSX-1234 --pr      # ... and opens the draft PR, reviewer @copilot
```

**A run that stops short of a pull request puts the labels back.** `releaseClaim` restores exactly
the set the claim found, derived from the receipt rather than from the ticket's current labels — so
a `next:to-trio` a PM added while the ticket was claimed survives. The one run that keeps
`agent:solving` is one that opened a pull request, because there the work is real and ongoing.

The rest of the label state machine is not built. A published pull request leaves the ticket on
`agent:solving`; `agent:reviewing` and `agent:done` are moved by hand for now, and the command says
so when it happens.

### Temporary: the pnpm 9 shim, and when a solve needs it

**Delete this section once the pilot repository pins its own `packageManager`.** There is a PR to
write that does exactly that; until it merges, this is the workaround.

`--solve` runs the pilot repository's own install and test scripts in the worktree. That
repository's manifest declares no `packageManager`, so `verify.ts` falls back to whichever `pnpm`
is on `PATH` — and this machine's is 11, which no longer honours the `pnpm.overrides` block the
repository's pnpm-9 lockfile depends on. The install dies on a repository whose CI is green. The
refusal says so (`versionNote`), which is how it was diagnosed, but saying so does not fix it.

```bash
mkdir -p /tmp/pnpm9bin
printf '#!/bin/sh\nexec corepack pnpm@9.15.9 "$@"\n' > /tmp/pnpm9bin/pnpm
chmod +x /tmp/pnpm9bin/pnpm
```

Then run the solver through `node` rather than through `pnpm`:

```bash
PATH="/tmp/pnpm9bin:$PATH" node --env-file-if-exists=.env src/cli/solve-once.ts SSX-1234 --solve
```

**`node`, not `pnpm solve:once`, and that is not a style preference.** The shell resolves `pnpm`
_after_ applying the `PATH=` prefix, so `PATH=... pnpm solve:once` would run pnpm 9 against _this_
repository — which pins `pnpm@11.20.0` and declares `engines.pnpm >= 11`, so it fails before it
starts. There is no build step here, so the `node` line above is exactly what the script runs.

`/tmp` is cleared on reboot. If a solve suddenly starts failing its install again, re-create the
shim before looking anywhere else.

---

## Settings

Full table in `ARCHITECTURE.md` §10. The ones that matter for a demo:

| Setting                   | Default       | Notes                                                                   |
| ------------------------- | ------------- | ----------------------------------------------------------------------- |
| `JIRA_EMAIL`, `JIRA_AUTH` | —             | Required. Reads, plus `agent:*` labels — nothing else on the ticket     |
| `VAULT_PATH`              | —             | Required by the real skill; checked at startup, not on the first ticket |
| `SKILL_NAME`              | `mock-triage` | **Defaults to the mock**, so an unconfigured service cannot post        |
| `WRITE_BACK`              | `false`       | The only setting the whole team can see the effect of. Strict `"true"`  |
| `SOLVE_ENABLED`           | `false`       | Master switch for the solve queue. Strict `"true"`                      |
| `SOLVE_MODE`              | `manual`      | `manual` also requires the human's `agent:start` label                  |
| `SOLVE_REPOS`             | —             | Repository allowlist, **no default**. Unset means nothing is allowed    |
| `SOLVE_GITHUB_OWNER`      | —             | Owner a PR is opened against, **no default**. `--pr` refuses without it |
| `SOLVE_WORKTREE_ROOT`     | —             | Where worktrees are cut. Blank means the system temp directory          |

Anything that grants privilege reads silence as "no". A blank or misspelled `WRITE_BACK` does not
post; an empty `SOLVE_REPOS` allows no repository; an unset `SOLVE_GITHUB_OWNER` opens no pull
request. `SOLVE_WORKTREE_ROOT` is the exception and grants nothing — set it to somewhere you can
open in a file browser, because macOS puts the default under `/private/var` and the diff review the
solver phase depends on is a person reading that worktree.

---

## Phases

The bug-fixing feature ships in stages, so the fitness assessment can be judged before anything
acts on it. Triage cannot read source code, so `agent:solvable` is a _candidate_ signal.

| Phase | Scope                                                      | State                |
| ----- | ---------------------------------------------------------- | -------------------- |
| A     | Fitness assessment in triage, `agent:solvable`             | **built**            |
| B1    | The picker: solve queue, claim planning, cycle report      | **built**            |
| B2    | The claim write, verified by re-reading, plus release      | **built**            |
| C     | The solver: worktree, recon, edit, verification, diff gate | **built**            |
| D     | Push, draft PR, reviewer requested                         | **built and run**    |
| D2    | The Copilot review loop and undraft (`advance`)            | built, not called    |
| E     | Run it from the daemon                                     | **last, on purpose** |

Every phase owes two hand-operated commands before it counts as done: a dry run that reports what
it _would_ change, and a single run against one named ticket. The daemon is last because the only
thing it adds is that nobody is watching — a ticket claimed, solved and PR'd by hand is a
demonstration; the same sequence on a five-minute timer is a deployment.

D was driven end to end on 2026-09-04: SSX-3822 claimed, solved, verified, committed, pushed, and
opened as [draft PR #2657](https://github.com/storebrand-digital/buy-insurance-advisor-web/pull/2657)
with Copilot requested. Copilot itself then failed — its app installation cannot read pull requests
in that repository — which is an org permission to grant and not a thing this codebase can fix.
It is recorded here because it is the reason D2 stays uncalled: see `reviewerErrored` in
`src/solve/pr.ts` for why a reviewer's own error must not be read as an approval.

A human always merges. The bot has no merge path.
