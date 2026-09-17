# the-jira-police — architecture: module map

Every production module, grouped by what it belongs to rather than alphabetically, because the
grouping is the architecture. **This is the file that moves when a module is added, renamed, split
or deleted** — the rule is in [`STARTING.md`](../.claude/skills/dev-house-rules/STARTING.md).

Index: [`ARCHITECTURE.md`](../ARCHITECTURE.md)

---

## 7. Module map

85 production modules, 75 test files. Grouped by what they belong to rather than alphabetically,
because the grouping is the architecture.

**The shell — scheduling and composition**

| Path                    | Role                                                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/index.ts`          | Daemon entry point. Three loops, signal handling, `--skill` / `--interval` / `--for` overrides                                                               |
| `src/loop.ts`           | Scheduling shell: interval, exponential backoff to a 15-min cap, interruptible sleep                                                                         |
| `src/poller.ts`         | One grooming cycle. Ordering, dedupe, failure isolation, the three rules above                                                                               |
| `src/review-loop.ts`    | Review schedule + **the advance-then-claim tick**: `SOLVE_ENABLED`, `REVIEW_POLL_MS`, deps once                                                              |
| `src/watch-loop.ts`     | The sendback watch's schedule: `WATCH_ENABLED`, `WATCH_POLL_MS`. The switch that most earns one                                                              |
| `src/wiring.ts`         | **The composition.** Every `create*Deps` and every `build*Request`, for all six entry points                                                                 |
| `src/settings.ts`       | Declarative settings table + generic reader, with a `sensitive` marker                                                                                       |
| `src/logger.ts`         | JSON lines to stdout/stderr; `console` is banned by lint. `q`: ⏳ nothing happened, 🔧 it did                                                                |
| `src/duration.ts`       | `30s` / `4m` / `1.5h` for CLI flags                                                                                                                          |
| `src/text.ts`           | Text bounds shared by anything placing untrusted content where it must fit. `shorten`, and `oneLine` for the documents made of headings and rows             |
| `src/read-only-tree.ts` | Staging a throwaway directory a session may read and nothing may write. Extracted from `skill-root.ts` when a second caller wanted the same 0o555/0o444 pair |

**Jira**

| Path                 | Role                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| `src/jira/client.ts` | `/rest/api/3/search/jql`, token pagination, Basic auth, the changelog and activity reads         |
| `src/jira/jql.ts`    | Query builders — new-issue, solve queue, in-flight, review, sendback watch. Injection-safe       |
| `src/jira/types.ts`  | The slice of the Jira payload actually read, plus `TicketRef`                                    |
| `src/jira/adf.ts`    | Atlassian Document Format rendered down to plain text. No I/O, so testable against real payloads |
| `src/state/store.ts` | Cursor + seen keys, atomic write                                                                 |

**Attachments — the image path, and triage is what constructs it**

| Path                        | Role                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------- |
| `src/attachments/images.ts` | Which types may be staged, and what the leading bytes say the file actually is                          |
| `src/attachments/stage.ts`  | Images written read-only under a derived name, and the block naming them. `staged` / `none` / `refused` |

`createGroom` (`wiring.ts:225`) stages before the analyst runs and removes the directory in a
`finally` after it, whenever `TRIAGE_IMAGES` is on — so the daemon, `poll:once`, `triage:once`,
`bot:once` and `watch:once` all reach this path through one construction site rather than five.
It defaults off and the analyst is denied `WebFetch`, `WebSearch` and `Task` before any pixel
arrives. **No solve pass constructs either module**, by the same decision: the fix pass gets recon's
brief rather than the picture. `attach:stage` remains the dry run, and the only way to look at a
staged file, since a pass sweeps its own directory. §13 has the decision that authorised the bytes
and the recon phase still owed; §14.11 has what the widening cost.

**The watch check is the attachment consumer that fetches nothing.** `watch/context.ts` copies
names, types and sizes field by field — never bytes — capped at `MAX_CONTEXT_ATTACHMENTS` (20),
with `MAX_FIELD_CHARS` (4000) on the text beside it and the truncation notice written **outside**
the fence, next to the omitted-comments notice and for the same reason. The field-by-field copy is
deliberate: it makes the day that widens a visible edit rather than a widening arriving by
inheritance.

**Triage — the grooming half**

| Path                         | Role                                                                                                                                                                                         |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/triage/schema.ts`       | The draft-07 contract handed to the analyst. Descriptions double as instructions                                                                                                             |
| `src/triage/session.ts`      | Shared subprocess machinery for every run: NDJSON, killing timeout, MCP check, cost                                                                                                          |
| `src/triage/runner.ts`       | The analyst                                                                                                                                                                                  |
| `src/triage/gate.ts`         | The check                                                                                                                                                                                    |
| `src/triage/poster.ts`       | The writer                                                                                                                                                                                   |
| `src/triage/single.ts`       | Triaging one named key, when discovery is the half being skipped. One copy for four callers                                                                                                  |
| `src/triage/fitness-note.ts` | Renders the fitness call into the comment from the field, so prose cannot disagree with it — and owns that region of the body, stripping any copy a re-run carried in before writing its own |
| `src/triage/order.ts`        | What order triage spends in, and how far the cursor may advance — two questions the poll cycle used to answer with one loop variable. `settledCursor` is the guard that separates them       |

**Solve — selection, claim and the model passes**

| Path                        | Role                                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/solve/labels.ts`       | The `agent:` state machine as pure functions; `repoFromLabels`                                                                             |
| `src/solve/poller.ts`       | One solve cycle: selection, capacity, and the planned claim                                                                                |
| `src/solve/report.ts`       | The cycle as `groomed/solve-cycle.md`, so a dry phase can be judged after the fact                                                         |
| `src/solve/claim.ts`        | The claim and its release. Read, re-check, write, read back                                                                                |
| `src/solve/attempts.ts`     | How often the **daemon** has claimed each ticket, so it stops claiming one that keeps coming back                                          |
| `src/solve/branch.ts`       | What may be written to: a work-prefix allowlist and a protected-name denylist                                                              |
| `src/solve/worktree.ts`     | The throwaway worktree, the branch name, and the `CommandRunner` interface                                                                 |
| `src/solve/ticket.ts`       | The ticket rendered as the text a pass is given — description, comments, attachments                                                       |
| `src/solve/read-scope.ts`   | Which other checkouts on this machine a pass may read for context                                                                          |
| `src/solve/skill-root.ts`   | A throwaway read-only copy of the `agent-solve` skill, staged per pass                                                                     |
| `src/solve/schema.ts`       | The draft-07 contracts handed to `agent-solve`, one per pass                                                                               |
| `src/solve/runner.ts`       | The pass command lines and their parsers. Where `Write` is granted — and everything withheld                                               |
| `src/solve/passes.ts`       | The real `PassRunner`. Working directory is the worktree; no MCP server required                                                           |
| `src/solve/exec.ts`         | The real `CommandRunner`. No shell, executable allowlist, killing timeout, scrubbed env                                                    |
| `src/solve/diff-gate.ts`    | The bound on what a solve run may have changed. Pure — no git, no fs                                                                       |
| `src/solve/escape.ts`       | Notices when a pass wrote somewhere it was never meant to reach                                                                            |
| `src/solve/verify.ts`       | Mechanical verification. `passed` / `failed` / `refused`, never collapsed. Plus `checkFailFirst`                                           |
| `src/solve/orchestrator.ts` | The sequence: worktree → recon → fix → simplify → gate → verify. `resolveReview`'s round-trip lives here too, run later, once a PR is open |

**Solve — delivery and the review round-trip**

| Path                        | Role                                                                                           |
| --------------------------- | ---------------------------------------------------------------------------------------------- |
| `src/solve/pr.ts`           | `git` and `gh` as argv arrays. Commit, push, draft PR, read review and threads, reply, resolve |
| `src/solve/pr-text.ts`      | The title and body of the draft pull request. Pure, so the wording is readable in a test       |
| `src/solve/marker.ts`       | The round cursor as one comment: render, parse, locate, refuse rather than reset. No I/O       |
| `src/solve/delivery.ts`     | `publish`, `surveyReview` and `advance` — the review round-trip as callable steps              |
| `src/solve/base-sync.ts`    | Bringing a PR's branch up to its base before a round spends. Built after a $16 invoice         |
| `src/solve/review-cycle.ts` | One pass over every watched pull request. Cheap look for all, paid round for the few           |
| `src/solve/silence.ts`      | How long a pull request has been quiet, in wall-clock. Pure; the clock is injected             |
| `src/solve/feedback.ts`     | What a run says back to the ticket. `safeText` and `shorten` bound what a model wrote          |
| `src/solve/commenter.ts`    | Posting that comment over an Atlassian MCP session. The narrowest tool surface in the tree     |

**The sendback watch**

| Path                       | Role                                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------------------- |
| `src/watch/decide.ts`      | Whether a watched ticket is worth paying to re-triage. Pure, no I/O — it is the money decision  |
| `src/watch/signals.ts`     | Jira's vocabulary (ADF, status categories) turned into what the decision reads                  |
| `src/watch/context.ts`     | Everything foreign since we last spoke, sliced at the instant the decision was made             |
| `src/watch/relevance.ts`   | Did they move _in the direction we asked for_. A gate on spend, and it has **no tools at all**  |
| `src/watch/memo.ts`        | What the watch already declined, so it does not pay to decline it again                         |
| `src/watch/counter.ts`     | Re-triages already given, as a reservation. The obvious counter does not count — see the header |
| `src/watch/retriage.ts`    | Running a re-triage, in the order that makes the brakes work                                    |
| `src/watch/unsubscribe.ts` | Taking a ticket off the watch list, as a pure edit                                              |
| `src/watch/end.ts`         | Performing that unsubscribe: the label off, then a comment if one is owed                       |
| `src/watch/sweep.ts`       | One pass over the watched tickets. Shared by `watch:once` and the daemon, so they cannot drift  |

**Entry points and their argument parsing**

| Path                             | Role                                                                                                                                   |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `src/cli/poll-once.ts`           | One poll cycle, then exit. The daemon minus the loop, from the same factory                                                            |
| `src/cli/triage-once.ts`         | One triage against a named key, no discovery. `--write` to post it                                                                     |
| `src/cli/solve-once.ts`          | The solve ladder. Dry by default; every write is a typed flag                                                                          |
| `src/cli/solve-args.ts`          | The ladder and the `--advance` mode, and which rungs the settings can actually reach                                                   |
| `src/cli/solve-run.ts`           | The rungs themselves. **The one module that writes to Jira, a worktree or GitHub**                                                     |
| `src/cli/solve-outcome.ts`       | Outcomes to an operator's terminal, and the rule deciding `$?`                                                                         |
| `src/cli/bot-once.ts`            | The whole bot against one ticket: triage, fitness, claim, solve, PR, review                                                            |
| `src/cli/bot-args.ts`            | The same ladder, with an issue key always required                                                                                     |
| `src/cli/watch-once.ts`          | What the sendback watch would do; `--write` does it                                                                                    |
| `src/cli/watch-args.ts`          | Its argument and output shapes, kept out of a file that ends in a top-level `await`                                                    |
| `src/cli/attach-stage.ts`        | `pnpm attach:stage <KEY> [--keep]`. Stages one ticket's images and prints what a pass would be given. Posts nothing, starts no session |
| `src/cli/attach-stage-report.ts` | Its report and its exit rule, kept where a test can import them without running the command                                            |
| `src/cli/daemon-status.ts`       | `pnpm daemon:status`. Is the daemon up? Reads `ps`, needs no credential, writes nothing                                                |
| `src/cli/daemon-processes.ts`    | Picking the daemon out of `ps` output. Split off so a test can import it                                                               |
| `src/cli/docs-check.ts`          | `pnpm docs:check`. Development tooling, not a service entry point — see below                                                          |
| `src/cli/section-refs.ts`        | Resolving a `§N` against the headings that define one. Read by `docs-check.ts` only                                                    |
| `src/cli/count-phrases.ts`       | Count-noun phrases in tracked markdown: declared fact, or listed history                                                               |
| `src/cli/pinned-prose.ts`        | The checklist `CLAUDE.md` is allowed to copy, and what makes copying it safe                                                           |
| `src/cli/length-budget.ts`       | Word bands for the mandatory-reading path, and the ratchet on raising one                                                              |
| `src/cli/rule-citations.ts`      | Every `INCIDENTS.md` entry reachable from a rule, and the authoring gap                                                                |
| `src/cli/scope-bounds.ts`        | The solver's scope prose against `diff-gate.ts`'s rule tables, both directions                                                         |

**Output**

| Path                 | Role                                             |
| -------------------- | ------------------------------------------------ |
| `src/output/sink.ts` | `FileSink` (reports) and the rejection artifacts |

`wiring.ts` exists because there are six entry points — the daemon, `poll:once`, `triage:once`,
`solve:once`, `bot:once` and `watch:once` — and a difference in how they wire the same pipeline
would be a bug
that only shows up in production. `docs-check.ts` and the six modules under it are deliberately not
entry points: they compose nothing, read no settings, and touch neither Jira nor a repository. They
live here because this is where a file you can run lives, and they are called out rather than left
to be counted, since "six" above is a claim about the composition and a new CLI file is exactly what
would quietly falsify it.

**`attach:stage` is the third kind and the reason the sentence says "pipeline" rather than
"wiring.ts".** It does read settings and does call `createJiraClient`, so it is a seventh caller of
that module — but it composes no deps object, runs no pass, and its whole output is a report. Six is
still the number of entry points that could diverge from one another in production.
`attach-stage-report.ts` is a library and not an entry point either, split off for the reason
`watch-args.ts` was: the command file ends in a top-level `await`, so a test that imported it to
check the report or the exit code would run the command instead.

**It did exactly that, twice, and the second time nobody noticed for four modules.** The sentence
here used to say `docs-check.ts` and `section-refs.ts` were "the seventh and eighth files in that
directory" and to reason about "the eight"; `count-phrases.ts`, `pinned-prose.ts`,
`length-budget.ts` and `rule-citations.ts` were extracted afterwards and added to neither the table
nor the count, so the map listed two of six and the prose named a total that had been wrong for four
commits. Corrected in the commit adding `scope-bounds.ts`, which is the module that made it
impossible to add one more row without reading the sentence. **A count of files in a directory is
the shape of fact this document should not be stating**, and it no longer states one: the table is
the list.

Of that group only `docs-check.ts` has a `pnpm` command; the other six are libraries it reads, kept
here rather than beside the code they inspect so that the pair stays together. The two solve commands go further
than sharing `wiring.ts`: their
write rungs are literally the same functions, in `src/cli/solve-run.ts`, so a command file is now
argument parsing plus a call into the one module that writes to Jira, a worktree or GitHub.
`triage:once` used to build its options by hand; the copy drifted the moment the real skill grew
requirements. `wiring.ts` composes the solve pipeline too — `createSolveRunDeps`,
`createClaimCapabilities`, `buildSolveRequest`, `buildPublishRequest`, `buildFindPrRequest`,
`buildAdvanceRequest` — which is what makes the ladder a real escalation rather than six commands
that happen to look alike.

**The daemon is now a seventh caller of those same rungs, and that is the point.** `review-loop.ts`
does not reimplement a claim or a solve; it calls `runReviewSweep` and `runSolveClaims`, which call
`runWriteRungs` — the same function `bot:once --pr` reaches. So the unattended path and the
hand-driven one cannot diverge, which is the only reason it was safe to give the loop the write
rungs at all. The same argument produced `watch/sweep.ts`, extracted out of `watch:once` when the
daemon needed it: the two callers differ in exactly the way that makes a divergence invisible, since
one is run by a person reading the output and the other by nobody.
