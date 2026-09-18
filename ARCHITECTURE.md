# the-jira-police — architecture

A Node/TypeScript service that watches the SSX Jira board, runs Storebrand's `/intake-triage`
skill against every new ticket, and — when enabled — posts the verdict back to the ticket as a
comment plus labels.

```
new SSX ticket  →  discover  →  analyse  →  gate  →  post
                                    ↓
                            groomed/SSX-1234.md

labelled ticket →  solve queue  →  claim  →  solve  →  draft PR  →  review rounds
                                    ↓
                            groomed/solve-cycle.md

sent-back ticket → watch queue →  did somebody else edit it?  →  re-triage
```

The AI step is not ours. `/intake-triage` is Jacob Biørn's skill; a human normally invokes it by
hand. This service automates the trigger, checks the result, and applies it.

Status: running end to end against production Jira. 2733 tests in 87 files, no build step, no
deployment target yet.

A **second queue** exists alongside grooming: tickets a triage assessment marked
`agent:solvable`, waiting to be fixed by an agent. It selects the right tickets, claims them, and
excludes whatever is already in flight — the dedupe lives in the ticket's own labels rather than
on disk. A **third** watches tickets triage sent back, and re-triages one when somebody other
than this service edits it.

Past that queue the whole pipeline is wired, and every rung of it has been driven by hand before
being given to a loop. `pnpm solve:once <KEY>` climbs a cumulative ladder — `--claim` writes the
Jira label, `--solve` cuts a worktree and runs the model passes under a diff bound and mechanical
verification, `--pr` commits, pushes and opens a draft pull request, `--review` then works the
review to a handover — and `--advance`, a separate mode rather than a rung, runs one review round
against a pull request an earlier run left open. Real tickets have been claimed, solved, pushed,
reviewed and merged this way; §15 records what each step cost.

**`pnpm start` now does all of it.** What this section said for two months was that the pipeline
was "wired to nothing", and then for two days that the daemon "only advances pull requests that
already exist". Both were true when written and both are now false: `createReviewLoop` runs
`runReviewSweep` and then `runSolveClaims` in **one tick**, and `runSolveClaims` calls
`runWriteRungs(..., "pr", ...)` — so an unattended tick claims a ticket nobody looked at, cuts a
worktree, runs the paid passes, pushes a branch and opens a pull request. The ordering rule that
kept the claim out of the daemon has been spent, deliberately; what bounds it now is
`MAX_CONCURRENT_SOLVES`, the attempt ledger (§9) and `SOLVE_ENABLED`, not the absence of a
caller.

**A human still merges. The bot has no merge path**, and that is the one guarantee this change
did not touch.

See §2 for the three loops, §4 for the three queues, §15 for the pipeline, and §13 for what is
genuinely absent.

---

## This file is an index, not the map

**It used to be the map — 3160 lines, sixteen sections in one file — and a document that size stops
getting reread.** `STARTING.md` requires `ARCHITECTURE.md` to move in the same commit as the module
it describes; a file too large to hold in one pass is a file that rule quietly stops applying to.
Split by module instead, 2026-09-18, so that checking the map against a change costs roughly what
the change does. **Every `§N` citation anywhere in this tree still means the same section it always
did** — headings were moved whole, never renumbered — so a bare `§7` in a code comment resolves to
`architecture/module-map.md` exactly as it resolved into this file before the split.

**Read the file for the module you are touching, not this one.** This index tells you which file
that is; it does not restate what is in it, for the reason `STARTING.md` gives about a fact with two
homes.

| working on…                                                                                                                                       | read                                                             | sections                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------- |
| the three loops, state/correctness, the subprocess contract, refusals, the failure model, or the testing rule — anything that is not one module's | [`architecture/overview.md`](architecture/overview.md)           | §1, §2, §5, §6, §8, §9, §11 |
| **which file owns which module**, or adding/renaming/splitting/deleting one                                                                       | [`architecture/module-map.md`](architecture/module-map.md)       | §7                          |
| triage: analyse/gate/post, the discovery queries, or the upstream `intake-triage` divergence                                                      | [`architecture/triage.md`](architecture/triage.md)               | §3, §4, §12                 |
| solve: the worktree, the model passes, the diff gate, verification, delivery, or the review round-trip                                            | [`architecture/solve.md`](architecture/solve.md)                 | §15                         |
| a setting, a flag, or the `bot:once` ladder                                                                                                       | [`architecture/configuration.md`](architecture/configuration.md) | §10                         |
| whether a change holds a property the whole system depends on                                                                                     | [`architecture/invariants.md`](architecture/invariants.md)       | §14                         |
| what the built system deliberately does not do                                                                                                    | [`architecture/not-built.md`](architecture/not-built.md)         | §13                         |
| a hook, a branch guard, or what the guard suite does and does not prove                                                                           | [`architecture/guardrails.md`](architecture/guardrails.md)       | §16                         |

**Structural facts still live in exactly one of the eight files above, cited from everywhere else —
never restated.** `pnpm docs:check` verifies every `§N` resolves against some section-numbered
document; it cannot tell you which file that document is, which is what the table above is for.

**When implementation moves, the file describing it moves in the same commit** — the rule did not
change, only its unit. A module added, renamed, split or deleted moves `module-map.md`. A changed
invariant moves `invariants.md`. Touching two files for one change is a sign the change crossed a
module boundary, not a sign the split is wrong.
