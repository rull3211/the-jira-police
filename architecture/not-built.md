# the-jira-police — architecture: not built (architectural)

What the built system deliberately does not do, and why — as distinct from
[`PLAN.md`](../PLAN.md), which tracks work not yet started rather than shape not yet chosen.

Index: [`ARCHITECTURE.md`](../ARCHITECTURE.md)

---

## 13. Not built

- ~~**The Slack canvas sink.**~~ **Deleted 2026-09-08, on an operator's call.** `canvas.ts` (123
  lines) and `canvas.test.ts` (134 lines) rendered the markdown and built the `canvases.edit`
  request bodies. There was never an HTTP call, a token, or an `OutputSink` implementation —
  **nothing was ever sent to Slack.** It was blocked on canvas write access and an Enterprise Grid
  app install, both human-gated, and neither arrived.

  What the reachability sweep added to "blocked" was that the module was **unreachable from all six
  entry points**, its only importer was its own test file, it dated from the initial commit, and
  the string "Slack" appeared nowhere else in `src/`. `formatChecklistLine` in `sink.ts` was the
  same lineage with zero references anywhere. So it was not a feature waiting on an install but 257
  lines of tested code for an integration the service does not have — and its tests were the kind
  this file warns about: **they passed, and they were testing nothing anyone could reach.**

  The header it left behind is the part worth keeping. `sink.ts` said the `OutputSink` interface
  existed "to keep that swap cheap", which is the standard defence of an abstraction with one
  implementation. It went untested for the whole life of the project, so the interface was never
  shown to be flexible — only unexercised. `git log -- src/output/canvas.ts` has it back if the
  access ever lands.

- ~~**Cost telemetry.**~~ **Done 2026-09-04.** `sessionCost` in `session.ts` reads
  `total_cost_usd`, `duration_ms`, `num_turns` and the four token counts off the `result` event
  and logs them as `session.cost`. One place, so it prices everything: triage, the poster, the
  relevance check and every solve pass. Two properties are load-bearing and both are mutation-tested — every field is
  `number | null` because **an unreported cost is not a free one**, and the log line sits _above_
  the success check because a failed run has still been paid for, so a total that skipped failures
  would look best on the days that went worst.

  The measurement that motivated it: `storecode -p "say ok"` — a two-word answer — cost
  **$0.127**, on 2 input tokens, 4 output tokens and **20,351 cache-creation tokens** billed at
  list. So the old "$0.11 per triage" figure was almost entirely fixed overhead rather than the
  cost of reading a ticket, and the per-invocation floor is about a tenth of a dollar before the
  model does any work. A solve is four such sessions.

- **`--max-budget-usd` / `--max-turns` / per-job `--session-id`.** Now actionable: `session.cost`
  supplies the number a cap would be set from.
- **Deployment.** No launchd job, no container, no metrics. `pnpm start` in a terminal is the
  current answer.
- **Concurrency.** Issues are triaged sequentially. Fine at 4–5/day.
- **Unproven paths.** REST pagination and REST error handling (401/429/5xx) are unit-tested only;
  the live board has returned a single clean page every time.
- **Attachment bytes on the discovery credential. Decided 2026-09-16: keep, and widen to images for
  the passes that hold no `Write`.** `fetchAttachmentText` downloads attachment content and
  `solve/ticket.ts` inlines it into the solver's prompt. §14.11 records why this is a fresh widening
  of the governing constraint rather than an ordinary read, that it landed without the invariant
  being updated with it, and what the new bound is. The operator's call was recon and triage, not
  the write-holding passes: a screenshot is what most tickets here actually contain, and what the
  fix pass needs out of one reaches it as recon's brief rather than as pixels.

  **What is built reaches triage and nothing else.** `attachments/stage.ts` writes a ticket's
  images read-only under a derived name, `attach:stage` prints the block a pass would be given, and
  `createGroom` hands both to the analyst when `TRIAGE_IMAGES` is on — which took `WebFetch`,
  `WebSearch` and `Task` off that session first. No solve pass constructs either; recon behind a
  typed setting is still owed. **The bound that
  does not exist is a text control over a picture** — `sanitiseUntrusted` sees a path, and an
  instruction painted into a screenshot reaches the model unread by anything else.

- **Dead code, found by a reachability sweep 2026-09-08. The declarations are gone; the reporting
  channels are not.** Removed the same day, with `canvas.ts` above: `isEligible` and `AgentLabel`
  (`labels.ts`), `formatChecklistLine` (`sink.ts`), and `REQUIRED_MCP_SERVERS` (`triage/runner.ts`).

  **Two of those four are worth more than the line count.** `isEligible` looked like the recurring
  defect this file names — a guard with 21 assertions and zero production callers — and it was
  **not**: it was a boolean wrapper over `eligibility`, which _is_ called, at `poller.ts:186` and
  `claim.ts:236`, with the same rule mirrored in the JQL at `jql.ts:258`. So the rule is enforced
  three ways and only the wrapper was unreachable; the 21 assertions were exercising `eligibility`
  through it and were redirected onto it rather than deleted. Recorded because the first reading of
  the sweep had this backwards, and "a tested guard nothing calls" and "a tested guard called
  through one indirection" are the same shape from the outside and opposite findings.

  `REQUIRED_MCP_SERVERS` is the same trap from the other side, and the first reading of it here was
  wrong in the dangerous direction. Its doc comment — _"MCP servers that must report `connected`
  before the run is trusted"_ — was written up as a precondition **nothing enforced**, on the
  strength of the constant having no readers. That was a call-graph conclusion about a symbol
  presented as a behavioural conclusion about the system, and this document already contradicted it
  in two places (§7's failure table, which records the check firing for real on 2026-09-03, and
  `README.md`'s smoke-test description). The precondition is enforced: `assertMcpReady`
  (`triage/session.ts:140`) throws `McpUnavailableError` on the init event for any required server
  not reporting `connected`, and `["atlassian"]` reaches it from `wiring.ts:145`, `poster.ts:244`
  and `commenter.ts:181`.

  So what died was a **module-level constant superseded by a per-call option**, which is a
  strictly better shape and the reason it went unreferenced: a fixed `REQUIRED_MCP_SERVERS` cannot
  express `passes.ts` needing no server at all or the mock path needing none, and both pass `[]`
  today. The deletion was right and the epitaph was not. Recorded at length because the failure was
  this file's own defect class committed by the sweep meant to find it — **an unreferenced
  declaration is evidence about a name, not about a guarantee**, and the guarantee has to be traced
  to the code that would break.

  **Still dead, and both are decisions rather than sweeps.** `injectionNoticed` is `required` in
  three schemas and instructed for in two prompts, parsed in three places, and **read by nothing**;
  recon's copy reaches the fix pass only incidentally inside the JSON brief, and the fix, simplify
  and review copies go nowhere — a reporting channel for prompt injection with no listener. Deleting
  it is not obviously right: the field costs a schema entry and the plumbing already exists, so
  wiring a listener is cheaper than rebuilding it after the first injection nobody heard about. Four
  fields are computed and dropped: `ReviewState.reviewerErrored` (the standing debt item, now
  proven), `ReviewThread.isOutdated`, `VerificationPlan.toolchain` and `StepResult.output`. Clean by
  the same sweep: **all 49 settings are read**, and there are no orphan files.

### The solve feature, from the claim onward

Everything that _selects_ a ticket is built and was verified against the live board on
2026-09-03. **Everything that _changes_ anything is now built, composed and driven by hand** —
claim, solve, push, draft pull request, and a review round against an open one. §15 records what
each step did and what it cost. This list is what is still missing, and it is shorter than the
five bullets it replaced; the four that went are kept below in one line each, because a reader
who remembers them should be able to see that they were retired rather than quietly dropped.

- **Retired, 2026-09-03 to 2026-09-05.** _A composition_ — `wiring.ts` now builds a
  `CommandRunner`, a `PassRunner` and a `ClaimCapabilities`, and `settings.ts` declares every
  value they need. _The claim write_ — driven, and the queue-drops-it experiment ran. _A run
  against a real repository_ — worktrees cut, passes spawned, `pnpm test` run in
  `buy-insurance-advisor-web`, pull requests opened and merged. _Delivery end to end_ — `publish`
  and `advance` are both called from `src/cli/solve-run.ts`, and `buildAdvanceRequest` passes
  `MAX_REVIEW_ITERATIONS` and `MAX_PR_ROUNDS_TOTAL` in.
- **Retired, 2026-09-05.** _`agent:reviewing`, and the pull request as the terminal._ Both are
  written. `reviewTransition` replaces the claim when the pull request opens,
  `reviewStageTransition` mirrors the draft flag onto `agent:review-done`, and
  `completionTransition` writes `agent:done` on a merge, `agent:closed` on a close and
  `agent:failed` on a bail. `state` (`OPEN`/`CLOSED`/`MERGED`) is read, and the loop no longer
  ends at the undraft. **The review step moved to the daemon rather than stalling**, and landed
  there 2026-09-06 — see below.
- **Retired, 2026-09-05.** _Both reviewers._ `waiting` now asks whether anyone actionable spoke,
  not whether the requested reviewer did, so a human who comments first is acted on rather than
  collected and discarded. Every `ReviewComment` and every `ThreadComment` carries an `origin`
  (`reviewer` | `human`), the marker carries a second count, and `MAX_REVIEW_ITERATIONS` reads
  only the reviewer's half — a person's request no longer burns a budget invented to bound two
  machines talking to each other. A mixed batch counts as human, a thread's origin is its first
  comment's, and `exhausted` became `reviewer-exhausted` because it stopped being an ending: the
  pull request undrafts and the loop keeps listening. `MAX_PR_ROUNDS_TOTAL` still counts
  everything, since a brake a person's comment could step past is not a brake.
- **Retired, 2026-09-07/08. _Running it from the daemon._** This bullet said "half done" for two
  days: the review sweep ran unattended and the solve queue did not, so the daemon only advanced
  pull requests a person had already asked for. **Both halves now run.** `createReviewLoop`'s tick
  is `runReviewSweep` and then `runSolveClaims`, and `runSolveClaims` calls
  `runWriteRungs(..., "pr", ...)` — an unattended tick claims, cuts a worktree, pays for the
  passes, pushes and opens a pull request. The sendback watch (`watch-loop.ts`) landed beside it
  behind `WATCH_ENABLED`.

  **The three gates that were holding the solve half were closed, not waived**, and each one is
  now a setting rather than a promise:

  | Was blocking                     | Closed by                                                                                        |
  | -------------------------------- | ------------------------------------------------------------------------------------------------ |
  | a **per-ticket attempt count**   | `MAX_SOLVE_ATTEMPTS_PER_TICKET` + `attempts.ts` — the ledger `runSolveClaims` reserves against   |
  | **machine sleep**                | `SESSION_IDLE_TIMEOUT_MS` + the drift watchdog in `session.ts`, which credits back the slept gap |
  | rounds that die before reserving | `MAX_FAILED_STARTS`, after SSX-3835 retried every two minutes for four days unnoticed            |

  **What has _not_ been closed is the one that was named first: cost per ticket per day.** The
  plan's own "Cost per ticket per day" entry asked for it before the loop was switched on, and it is
  still not measured. A completed solve has never been costed end to end. So the daemon's per-day
  spend is bounded by arithmetic over `MAX_CONCURRENT_SOLVES`, `MAX_SOLVE_ATTEMPTS_PER_TICKET` and
  `MAX_REVIEW_ROUNDS_PER_TICK` rather than by observation, and the difference between those two
  is what an invoice is for. **This is the largest open item in the file.**

  One thing the split already answered, which was listed as a blocker: **what a solve failure does
  to the backoff.** Separate loops mean it does nothing to grooming. A review sweep that throws
  backs off the review side alone, and `loop.ts` needs no new notion of failure kind.

  The corollary the file held for two months has now been spent, and it should be read as spent
  rather than quietly dropped: **a ticket claimed, solved and PR'd by hand is a demonstration; the
  same sequence on a timer is a deployment.** This is a deployment. What still holds is the part
  underneath it — every rung was driven by hand, against a named ticket, with a person reading the
  output, before the loop was given it, and the loop calls those same functions rather than a
  lookalike (§7).

Each phase is expected to ship two hand-operated commands before it counts as done — a dry run
that reports what it _would_ change, and a single run against one named ticket, chosen by the
operator rather than by the queue. `triage:once SSX-1234 [--write]` is the shape being copied.
`solve:once` grows one flag per phase (`--claim`, `--solve`, `--pr`), each implying the ones
before it, so the command line reads as the privilege escalation it is.

- **Probes.** The `Bash(pnpm test:*)` scoping question was run 2026-09-04 and answered in the
  worst available way — see §6 and §14.12. Phase C took the shape the fallback described, not
  because that was preferred but because the alternative turned out not to exist.

  **Copilot review — answered 2026-09-04, with no write.** The plan called for a throwaway pull
  request; the org's own history answers most of it for free. In
  `storebrand-digital/buy-insurance-advisor-web`, **8 of the last 60 pull requests carry a review
  by `copilot-pull-request-reviewer[bot]`**, the most recent the day before. So the feature is
  enabled for this org and this repo, and it posts substantive findings rather than a rubber
  stamp. Two details that matter to `pr.ts`, both already handled and now confirmed against
  reality rather than assumed:

  - The login that answers is `copilot-pull-request-reviewer[bot]`, not `copilot`. This is why
    `matchesReviewer` is a prefix match on the requested handle; the case is pinned in
    `pr.test.ts`.
  - Copilot's review state is **`COMMENTED`**, never `APPROVED`. `readReview` never reads
    `state` to decide whether anyone spoke — today `anyoneResponded` asks only whether a
    non-ours entry exists at all, and the login decides `origin` rather than whether the loop
    wakes. Had either keyed off an approving state, the review loop would have waited forever on
    a reviewer that had already spoken.

  One sub-question genuinely needed a write and was **deferred to phase D** rather than probed on
  a throwaway pull request: whether `gh pr edit --add-reviewer @copilot` succeeds with this token's
  `repo` scope. Phase D opens a real draft pull request anyway, so the probe cost nothing there and
  would have cost a junk PR in a team repo. Deferring was safe because of _where_ the answer lands:
  the reviewer request happens after the PR exists and before anything is undrafted, so an
  insufficient scope surfaces as a loud failure on a draft a human can finish by hand — not as a
  skip nobody sees. What phase D must therefore **not** do is treat a failed `--add-reviewer` as a
  warning and carry on to `gh pr ready`: that would undraft a PR nobody has reviewed, turning a
  missing scope into a merge candidate.

  **Answered on PR #2657, 2026-09-04, and the answer had a second half nobody asked for.** The
  request succeeded — `repo` scope is enough, the app was assigned, and its job ran. The app then
  failed: `Resource not accessible by integration` on `GET /repos/…/pulls/2657`, because the
  Copilot installation lacks `pull_requests: read` on that repository. That is an org
  configuration, not something this codebase can fix, and re-requesting produced the same result.

  **Granted since.** On PR #2658, 2026-09-05, Copilot reviewed for real. `reviewerErrored` stays:
  the permission can be revoked, and a guard removed because the thing it caught stopped happening
  is a guard removed at exactly the wrong time.

  The part that is ours is **how the failure came back**: as an ordinary `COMMENTED` review whose
  whole body was "Copilot encountered an error and was unable to review this pull request." Read
  as feedback, that spends a paid review round asking a model to address an error message. Read as
  a review with no comments, it is an approval — the loop undrafts and moves the ticket to
  `agent:review-done` on a review that never happened, which is the pipeline telling a human their
  code was reviewed when it was not. `ReviewState` therefore has a third state, `reviewerErrored`, sitting between
  "no response" and "a review". It is recognised from the reviewer's own text, which is brittle
  and is the only signal there is; both phrases must match, and the match is scoped to the
  requested reviewer so a person quoting the failure keeps their comment.

- **`main` is protected, and that is a stronger backstop than the plan claimed.**
  `required_approving_review_count: 1` with `require_code_owner_reviews: true`. Since Copilot only
  ever `COMMENTED` and a bot is not a code owner, **a human code owner must approve before
  anything merges** — enforced by GitHub, not by this codebase. "A human merges, always" therefore
  holds even if every guard here were removed. Worth knowing precisely because it means the guards
  here are not the only thing standing between a bot and `main`.

  The other half is less comfortable: `required_status_checks.contexts` is **empty**. There is no
  CI gate on that repo, so the harness's own `verify` run is the only mechanical check a
  bot-authored change passes before a person looks at it. That raises rather than lowers the value
  of verification being mechanical and of the diff gate refusing edits to the files that define
  what verification means.

- ~~**Cost of a solve is still unmeasured.**~~ **Measured 2026-09-04**, across three consecutive
  `--pr` runs on SSX-3822. Recon does cost more than the fix, and by a wide margin:

  | pass      | cost                | duration      | turns   |
  | --------- | ------------------- | ------------- | ------- |
  | recon     | $1.40 – $1.71       | 3.8 – 4.7 min | 41 – 48 |
  | fix       | $0.85 – $0.96       | 1.3 – 1.6 min | 22 – 29 |
  | simplify  | $0.32 – $0.42       | 0.6 – 0.9 min | 8 – 9   |
  | verify    | **$0**              | ~40 s         | —       |
  | **total** | **≈ $2.60 – $3.00** | ~7 min        |         |

  Verify is free because it is mechanical — the harness runs the commands and reads exit codes,
  and no model is asked whether the tests passed (invariant 13). Recon is roughly half the bill,
  which is the read-only pass that can decline the work: the pass most worth paying for is also
  the one that most often produces no code. Against a triage run — **$1.56 measured on 2026-09-05,
  not the $0.11 this line used to quote** — a solve is under 2×, which is a very different shape of
  budget from the one the old figure implied.

  The spread across three runs of the _same ticket_ is itself a reading. Same ticket, same repo,
  same base — 15% variance in cost and a different `simplify` verdict each time.

- **The host's own safety hook can abandon a fix pass, non-deterministically.** Observed
  2026-09-04 on the second solve of SSX-3822. The fix pass tried to write
  `src/utils/setFavicon.ts` and storecode's `pipelock` PreToolUse hook denied it —
  `pipelock: blocked (Credential Path Directive)`. The likely trigger is content, not path: this
  ticket is about detecting non-production environments, and the Credential Path Directive fires
  on text containing the `.env` substring, which `import.meta.env.PROD` contains. **The first
  solve of the same ticket wrote the same feature and was not blocked**, so this varies with
  whatever the model happens to write, not with the ticket.

  Three things to take from it, in order of importance:

  1. **The refusal contract held under real pressure.** The pass did not retry a variation, did
     not look for a way around the hook, and — the part worth keeping — **declined to ship the
     half of the change that had succeeded**, on the grounds that a lone `favicon-test.svg` would
     read as a complete fix. That is the failure mode the pass contract names, refused
     unprompted.
  2. **`abandoned` is now known to be overloaded.** It currently means both "the model judged
     this ticket unfixable" and "the environment would not let the model write", which are
     different facts with different remedies — the first is feedback about triage, the second is
     a host misconfiguration and says nothing about the ticket. The calibration record cannot
     currently tell them apart, so `dev-lens.md` will slowly accumulate environment failures
     scored as ticket assessments.
  3. **It is not this service's bug to fix.** The hook lives in `~/.storecode/`, a protected path,
     and editing a safety hook so that this project's own agent can write is exactly the move the
     operating rules forbid. It needs a human to decide whether the directive is over-matching.

- **Triage duration is high-variance, and the first reading of that was wrong.** On 2026-09-04 a
  triage of SSX-3831 exceeded the 600 s `TRIAGE_TIMEOUT_MS`. The obvious inference — that the
  ticket's two long comments had made the run expensive, comments having just been added to §1 —
  was recorded here and then falsified by the retry: the same ticket, the same comments, the same
  skill, **266 s**. More than 2x apart on identical input, so the cause is variance in the session
  and not the size of what it reads. Worth keeping as an example of the failure this document
  exists to catch, in the document itself: a plausible cause arrived at the same moment as a
  change that would explain it, and it took one more measurement to notice the two were unrelated.

  `TRIAGE_TIMEOUT_MS` was raised to 1 200 000 all the same. The asymmetry decides it rather than
  the diagnosis: a cap that fires early costs a fully-billed session and produces no artifact,
  while a cap set too high costs only that a genuinely wedged run is reaped later. See §10.
