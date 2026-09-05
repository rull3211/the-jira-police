# the-jira-police — bug-squashing agents

> **Progress, 2026-09-05.** Phases A through D4e are built and merged; the service claims a
> ticket, solves it in an isolated worktree, opens a pull request, answers the reviewer, and
> labels the ticket for whatever happened. 1872 tests, no build step. **D4b is built and the
> daemon (E) is next**, and it is deliberately last. A human always merges.

## Context

The service grooms tickets: it discovers new SSX issues over Jira REST, runs `/intake-triage`
headlessly, gates the result, and posts a verdict. `ARCHITECTURE.md` describes that system and
the solve pipeline built on top of it.

This plan covers the next stage: **for the subset of bugs an agent can fix safely, let an agent
fix them.** Triage grows a fitness assessment and tags the ticket `agent:solvable`. A second
poller watches for tagged tickets and, when authorised, fixes them in an isolated git worktree,
opens a draft pull request, asks for review, iterates on that review, and hands over to a human.

Two things make this different from the grooming service, and both drive the design:

1. **The solver needs `Write` and `Edit`.** No component in this service had ever had either.
   That is a real privilege escalation and gets isolation and mechanical — not model-asserted —
   verification.
2. **Triage cannot read source code.** The fitness call is made from the ticket plus the
   knowledge vault only. It is a _candidate_ signal, not a guarantee, so the solver re-checks
   against real code and is allowed to bail before writing anything.

Default posture is **manual**: nothing is solved until a human adds a label.

---

## Design

### 1. Two pollers

The existing poller cannot serve the solve queue. `isUnseen` (`src/state/store.ts`) checks a
permanent `seenKeys` list, so a ticket triaged on Monday can never re-enter — but a ticket
labelled for solving on Friday must. And the solve queue has no time dimension at all: it cares
about label state, not recency.

|            | new-issue poller       | solve-queue poller             |
| ---------- | ---------------------- | ------------------------------ |
| Selects on | `created >= -Nm`       | labels                         |
| Cursor     | yes, `state/poll.json` | **none**                       |
| Dedupe     | local `seenKeys`       | **ticket label state in Jira** |
| Cadence    | `POLL_INTERVAL_MS`     | its own, slower                |

Dedupe living in Jira rather than on disk is the important half: the queue survives a restart, a
wiped `state/`, and a second instance, without a lock file.

`buildSolveQueueJql` sits in `src/jira/jql.ts` beside `buildNewIssuesJql`, reusing `assertSafe`
and `jqlValue`:

```
project = SSX AND component IN (...) AND statusCategory != Done
  AND labels = "agent:solvable"
  AND labels = "agent:start"            -- manual mode only; omitted in auto
  AND labels NOT IN ("agent:solving", "agent:reviewing", "agent:review-done",
                     "agent:done", "agent:closed", "agent:failed")
ORDER BY updated ASC
```

**The `labels NOT IN (...)` gotcha is real on this board and was measured, not assumed** — it
excludes issues whose `labels` field is empty:

```
labels IS EMPTY                                    → 57 issues
labels IS EMPTY AND labels NOT IN (the three)      →  0 issues   ← excludes on absence
labels = "triaged"                                 → 46 issues
labels = "triaged" AND labels NOT IN (the three)   → 46 issues   ← no over-exclusion
```

So the positive `labels = "agent:solvable"` clause is load-bearing and must not be removed as
redundant by a future rewrite.

**A second query, `buildInFlightJql`.** `MAX_CONCURRENT_SOLVES` cannot be enforced from the queue
result, because the queue excludes in-flight tickets by design — the ones that count against the
limit are exactly the ones it cannot see. It deliberately drops `statusCategory != Done`: a solve
whose ticket someone closed mid-run is still in flight, and undercounting a concurrency limit is
the failure that lets a second claim through. Over-counting only causes waiting.

### 2. Fitness assessment in triage

`TRIAGE_SCHEMA` (`src/triage/schema.ts`) carries an `agentFitness` object beside `mutation`:

```ts
agentFitness: {
  solvable: boolean,          // the call
  confidence: "low"|"med"|"high",
  rationale: string,          // why, in one line
  blockers: string[],         // empty iff solvable
}
```

**Left out of the top-level `required` list.** Each required field is another way for a run to
fail after paying for the work, and this one is several subfields deep. `parseAgentFitness` reads
absent, malformed, and truthy-but-not-`true` all as `solvable: false`, so silence is a refusal
rather than a retry loop.

**`solvable: true` is gated on `verdict === "ready-ish"`.** This falls out of the existing rules
rather than being bolted on: the dev lens only fires on ACCEPT, `assertDorCoherent` already
forbids `ready-ish` when `dorPlaceholders` is non-empty, and a bug whose acceptance criteria are
not yet testable is genuinely not safely auto-fixable. So `dor:gaps` tickets are never
`agent:solvable`, and that is correct rather than a limitation.

The coherence check reads `labels` and **not** `labelsAdd`. The delta holds only labels not
already on the issue, so a second run over an already-marked ticket legitimately omits it. A
separate rule bounds the namespace: triage may add or remove `agent:solvable` and no other
`agent:` label, so it cannot grant itself `agent:start`.

**Where the repository comes from.** Not `agentFitness.repo` — that would need a private channel
from the triage artifact to the solve queue. The board already carries **`svc:<repo>`**, an
existing triage convention that matches `SOLVE_REPOS` verbatim, so `repoFromLabels` reads the
ticket's own labels. Every ambiguous reading resolves to `null` (no `svc:` label, two of them,
`impl-uncertain` present, or a name failing `/^[A-Za-z0-9][A-Za-z0-9._-]*$/`), because this value
decides which repository gets written to and a contradiction must not become a decision.

### 3. Label state machine

```
agent:solvable          triage's call; set by the grooming poster
   + agent:start        the human go-ahead (manual mode) — the only human step
   → agent:solving      claimed; agent:start removed in the same edit
   → agent:reviewing    pull request open, review requested; agent:solving removed
   ⇄ agent:review-done  undrafted; the agentic cycle is over, only human approval is left
   → agent:done         the pull request was MERGED
   → agent:closed       the pull request was closed unmerged
   → agent:failed       bailed; a comment says why
agent:watching          triage sent the ticket back but thinks it is nearly solvable (F)
```

`agent:solving` is written **before** any work starts. That single edit is the claim, and it is
what makes the queue idempotent.

**`agent:reviewing` replaces `agent:solving` rather than accompanying it**, and `agent:done` means
merged rather than undrafted. The two changes must ship together: `buildInFlightJql` counts
`agent:solving`, so a ticket keeping it until merge would hold the only slot for as long as a
human takes to review — days, where the claim is minutes. Replace without moving `agent:done` and
nothing is excluded from the queue during review, so the ticket is claimed twice; move without
replacing and the queue stalls.

**`agent:done` is merged-only because it is a metric.** A comment is enough for a reader and not
for a count. Closed-unmerged gets `agent:closed` — not `agent:failed`, because the agent did the
job and a person declined it, and not folded into `agent:done`, because _work the tool completed
that nobody wanted_ is the more interesting of the two numbers and is invisible if the buckets
are merged.

#### 3a. The claim writes a delta, and getting there took a decision about the credential

**This section used to say the opposite, and the history is the point.** The only write path was
MCP `editJiraIssue`, whose input schema has one field for issue data — `fields`, set semantics,
`additionalProperties: false` — with no `update` key to pass. So the claim meant reading all N
labels, appending, and writing all N back, and any label anyone added in between was silently
dropped: a PM adding `next:to-trio` mid-solve lost their edit with nothing in either history
explaining it. The mitigation was read-back-and-verify, which narrows the window and cannot close
it.

What changed is not the tool surface but **a decision about the standing rule that the REST
credential is discovery-only.** Jira's REST API has supported `update.labels` with atomic
`add`/`remove` all along. The amendment is deliberately the narrowest one that closes the hole:
one method (`JiraClient.updateLabels`), one HTTP verb, labels only, and only labels matching
`/^agent:[a-z][a-z0-9-]{0,60}$/` — so the write is physically incapable of touching `triaged`,
`svc:*`, `dor:*` or a human's `next:*`. **Comments stay on the MCP path**, because those are ADF
and reimplementing the markdown conversion would widen the credential for no benefit.

Three things follow:

1. **Concurrent claims are still not prevented**, only made unlikely (`MAX_CONCURRENT_SOLVES=1`,
   one host). A delta is not a compare-and-swap.
2. **Verification narrowed on purpose.** With a delta, the check asks only whether the delta took
   (`diffEdit`), not whether the whole field matches — a bystander label appearing between write
   and read-back is a colleague working, and reporting it as `unverified` would fire the check on
   innocent events, which is how a check ends up switched off.
3. **`releaseClaim` derives its delta from the receipt, not from the live set.** "Remove whatever
   is live and was not there before" reads as the careful version and is the old clobber by
   another route.

### 4. Control plane

Every setting fails closed except one, and the exception is argued rather than assumed.

- `SOLVE_ENABLED` (default `false`) — master switch.
- `SOLVE_MODE` (`manual` | `auto`, default **`manual`**) — manual requires `agent:start`. An
  unrecognised value is a startup error, not a fallback: guessing here guesses towards privilege.
- `SOLVE_AUTO_ISSUE_TYPES` (default `Feil`) — auto mode is not manual-minus-a-check; it drops the
  human's label and takes on an issue-type restriction in exchange. The default is `Feil` because
  **this board is Norwegian and its bug type is not called `Bug`** — a hardcoded English default
  would have matched nothing and made autosolve appear enabled while never firing.
- **`SOLVE_REPOS` has no fallback**, alone among the solve settings. `readSettings` cannot
  distinguish blank from unset, so a default would be a write privilege that survives being
  deleted from `.env`. Unset ⇒ nothing is allowed.
- `MAX_CONCURRENT_SOLVES` (1), `MAX_REVIEW_ITERATIONS` (3), `MAX_PR_ROUNDS_TOTAL` (20),
  `REVIEW_POLL_MS`, `REVIEW_SILENCE_MS`, `MAX_REVIEW_ROUNDS_PER_TICK` (3).
- **`FAIL_FIRST_CHECK` (default `true`) — the one setting that defaults on.** Deliberately the
  mirror of `flag()`: it reads `!== "false"` rather than `=== "true"`. Every other switch fails
  closed so a typo cannot arm a privilege; this one grants nothing and writes nothing, so a typo
  must not silently _withdraw a guard_.

A ticket whose repository is not on `SOLVE_REPOS` is skipped, not failed — widening the allowlist
picks it up later with no manual reset.

### 5. The solver

**Isolation is mandatory.** Of five SSX repos checked out locally, three are dirty and on feature
branches. The solver never touches a working checkout:

```
git -C <repo> fetch origin
git -C <repo> worktree add <tmp>/SSX-1234 -b fix/ssx-1234-<slug> origin/main
```

Branch names follow the vault convention (`fix/{jira-id}-{slug}`). Protected prefixes are refused
before any session starts. Worktrees are removed on completion and kept on failure.

Verification is **discovered, not assumed**: read the manifest in the worktree, require a test
script, run install first. `verifyBase` runs the same steps against the base before judging the
change — a red build is only a verdict about a change if the same steps were green before it.

**Recon before code.** The first pass is read-only: locate the fault, confirm the dev lens was
right. If it was not, the run writes `agent:failed` plus a comment explaining what triage could
not have known, and stops. **Bailing here is a success, not an error** — it is the honest answer
to a fitness call made without source access.

Guards on the write pass:

- **Tool denylist, not allowlist.** `--allowedTools` was probed and restricts nothing: it is an
  auto-approve list, so naming a tool pre-approves it and omitting one does nothing.
  `--disallowedTools` restricts properly. **The model gets no shell** — the harness runs every
  command itself, which also disposes of "no `git push` from inside the model's session".
- **Verification is mechanical.** The harness runs the steps and reads exit codes. The model is
  never asked whether the tests passed.
- **Diff-bounds gate.** Caps files and lines; refuses lockfiles, CI config, `.github/`, and
  anything outside the repo. It adds a category the first draft did not have: **files that define
  what verification means** (`package.json`, `tsconfig*`, lint and test config), refused
  unconditionally and exempt from any cap, because a run that can edit them can make every
  subsequent check pass while verifying nothing. It parses `--numstat -z`, since without `-z` an
  attacker-suggested filename containing a newline can forge a numstat record.
- Commit messages must satisfy Conventional Commits — mechanically checkable, so checked.

#### 5a. The fail-first check

A regression test that passes against the bug it is named for is decorative, and this has shipped
twice. The check lays the run's own new test files onto an untouched checkout of the base and runs
the discovered test step there.

**It reports and never refuses.** A vacuous test does not make a correct fix wrong.

**Only `vacuous` is sound, so only `vacuous` is rendered.** A new test importing a new non-test
helper fails against the base for reasons unrelated to the fix, so `guarded` is unreliable and a
green tick beside the verification ticks would overclaim. The test-path heuristic inherits the
same asymmetry: over- and under-matching both bias towards `guarded`, and neither can manufacture
a `vacuous`.

**The mechanical tier is much weaker than it sounds, and the measurement says so.** Replaying the
seven new assertions from the SSX-3833 pull request:

| the new assertions go red against | count      |
| --------------------------------- | ---------- |
| the **original** bug              | **7 of 7** |
| the **plausible wrong fix**       | **1 of 7** |

Classic fail-first was already fully satisfied by a suite that was six-sevenths decorative. So the
house rule and red-green are different rules: red-green unplugs the _defect_, this repository's
rule unplugs the _plausible wrong implementation_, and only the second catches that case. That
half cannot be mechanised — "the obvious wrong fix" is not a thing a diff gate can enumerate — so
it lives in `SOLVE_INSTRUCTIONS.md` §2 as an instruction to name the wrong fix and check the test
catches it.

**Known limitation.** The probe is cut on the machine the harness runs on and inherits its
environment. A test whose vacuity is environment-dependent — one reading `ZoneId.systemDefault()`,
say — gets opposite verdicts on a UTC runner and a developer's laptop. A probe that inherits the
operator's environment cannot answer a question about CI's.

### 6. Delivery: pull request → review → iterate → handover

```
gh pr create --draft ...        # links the Jira issue
gh pr edit <n> --add-reviewer @copilot
→ agent:reviewing
```

The review loop needs no third poller: each solve-poller tick first advances any ticket under
review, then starts at most one new solve. `advance()` implements a round and is reachable as
`solve:once <KEY> --advance`.

#### 6.1 The loop ends at the pull request, not at the reviewer

The terminal is **merged or closed**, not undrafted:

- `state === "MERGED"` → release, `agent:done`, comment the merge on the ticket.
- `state === "CLOSED"` → release, `agent:closed`, comment that it was closed unmerged.
- `state === "OPEN"` → keep going, whether or not it is still a draft.

Undrafting is a transition rather than an ending, and writes `agent:review-done`.

#### 6.1b Reviewer feedback arrives in three places and only two are on the `--json` flags

Review bodies and issue comments come back from `gh pr view --json reviews,comments`. **Inline
comments are neither** — they live at REST `pulls/N/comments` and GraphQL `reviewThreads`.

Before this was fixed the loop hallucinated its input: handed only a summary sentence mentioning
"robustness/test-isolation improvements", a round guessed one of the two real inline comments
correctly and invented a third the reviewer never made, then declined its own invention with three
named precedents. The reasoning was excellent and the premise was fabricated. `readReviewThreads`
closes it, and **a comment the loop cannot see must not be summarised into one it can.**

A reviewer's own boilerplate is not feedback and is stripped before the pass sees it — otherwise
the round answers the reviewer's advertisement in public on a bugfix.

#### 6.1c The reviewer is not an oracle

Two reviews of the same unchanged code disagreeing is information about the reviewer, not about
the diff. Three rules:

1. **Investigate before resolving.** A review comment is a claim about the code, and the pass has
   the code. Say in `responses` what was checked.
2. **Push back in public**, on the thread, where the reviewer and any human can see the argument
   next to the comment it answers.
3. **Resolve the thread — including the ones it rejects**, bounded by _evidence, not confidence_:
   a thread may be resolved only with a reply attached, and only when the pass either changed code
   for it or cited something checkable. Anything resting on judgement alone stays open.

**Rejecting a bad argument is not the same as rejecting the claim.** A loop taught only the first
move will talk itself out of real bugs with good reasoning.

**When feedback has no thread**, the round's `responses` are posted as one `bot: round N` comment.
The `bot: ` prefix is load-bearing: `reviewerComments` drops our own by that prefix, so a response
posted without it is read back next round as a reviewer asking for something and the loop argues
with itself.

**Draft means _this side is still working_.** A round that pushed stays a draft; a round that
changed nothing has done all it can and undrafts — gated on the answer being _visible_, because
undrafting after a failed post shows a human an objection with the rebuttal nowhere.

#### 6.2 Both reviewers, and only one of them is on a budget — **D4b, built 2026-09-05**

The comments were already there: `readReview` builds its list from `[...reviews, ...comments]` with
no author filter, and `reviewerComments` drops only our own. Human feedback has been collected all
along. What discarded it was `reviewerResponded`, computed from logins matching the _requested_
reviewer, which gated `waiting`. A human who commented before the bot reviewer did was read, found,
and thrown away by a gate asking a different question.

So the fix is a classification, not a new data source. `matchesReviewer` already draws the line;
push its result into the payload as `origin: "reviewer" | "human"` on `ReviewComment`, and:

- **Gate on "anyone actionable has spoken"**, not on the reviewer. `waiting` means the comment
  list is empty after dropping our own.
- **Count rounds only against `reviewer` feedback.** `MAX_REVIEW_ITERATIONS` exists to stop two
  machines talking to each other forever, because nothing in that conversation brings in
  information from outside it. A person asking for a change _is_ that outside information.
  Capping it would mean the bot telling a reviewer it had run out of turns.
- **A mixed batch is a human round.** The failure directions are not symmetric: over-counting
  silently declines work a human asked for, under-counting spends one more round.
- **Exhaustion stops being an ending.** `exhausted` becomes `reviewer-exhausted`: undraft, say so
  on the ticket, and keep listening on the human channel.

`MAX_REVIEW_ITERATIONS` keeps its name but not its meaning; its doc comment described half the
reviews and was rewritten in the same commit.

**Splitting the cap forced a marker format change, and the compatibility argument decided its
shape.** Two counts cannot live in one number, so `Marker` gained `reviewerCount` and the comment
gained a third line — appended _after_ the high-water mark, never inserted above it, because the
first two lines are read positionally and markers written before the split are sitting on open
pull requests right now. Inserting would have made every one of them unreadable, which by
`marker.ts`'s own rule means unadvanceable. A **missing** line reads as `count`, not as zero: a
pre-split marker cannot say which of its rounds were human, and the two guesses are not
symmetric — reading them as the reviewer's can only make the cap fire sooner, reading them as
human hands the whole budget back on every open pull request. `reviewerCount > count` is
**refused rather than clamped**, for the reason the file already refuses an unparseable count:
`min(a, b)` quietly resumes a number nobody can vouch for, on the one pull request where the
state is known to be wrong.

**The blank-reviewer case is the one asymmetry in `reviewOrigin` and it is deliberate.** Nothing
matches an empty name, so the natural reading makes every comment `human` — and `human` is the
exemption from the cap, so a typo in `.env` would lift the spend brake on every open pull request
at once. A blank setting therefore reads as `reviewer`. The exemption is something a reviewer name
grants; never something its absence does. A thread comment whose author could not be read goes the
same way for the same reason, except that it lands on `human`, since an unidentifiable login is
not the reviewer speaking and must not be handed the reviewer's budget either.

Twelve mutations caught: the human exemption removed, the mixed batch read with `every` instead of
`some`, a thread's origin taken from its newest comment rather than its first, the reservation
advancing the reviewer count on a human round, the `waiting` gate narrowed back to the reviewer,
the blank-reviewer early return deleted, both origin call sites hardcoded to `reviewer`, the
missing marker line read as zero, the over-count clamped, the line rendered above the high-water
mark, and a non-numeric reviewer count read as zero.

#### 6.3 A cursor over reviews

Without one the loop cannot tell a new comment from one it already handled, so a single human
review left in place is re-read, re-resolved and re-pushed every tick at full solve cost. With
§6.2 lifting the cap for exactly the comments that will dominate, the cursor is what makes the two
requests jointly safe — which is why it shipped **before** D4b.

**Both numbers live in one comment on the pull request, edited in place**, for the same reasons
the queue puts its state in Jira: it survives a restart, a wiped `state/`, and a second instance,
and a human can read it. One comment rather than one per round, because a round answers by pushing
a commit and a comment per round is a wall of bot chatter on every pull request a person has to
read past.

```
bot: iteration count 3
Last read: 2026-09-05T10:22:31Z

- round 1 — narrowed the type
- round 2 — answered without changing code
- round 3 — split the helper
```

Mechanics, all three forced by what the API returns:

- **The cursor cannot be the marker's own timestamp** — `gh pr view --json comments` returns
  `createdAt` and nothing that moves on an edit. So the high-water mark is written into the body
  and read back out of it, which is also why a human can see what the bot thinks it has read.
- **Never `gh pr comment --edit-last`.** It edits the last comment of the current user, and the
  current user is the operator — so a round that ran after you commented would overwrite your
  words. Ours is located by prefix and edited by node id.
- **A marker that will not parse refuses the round.** It must not read as zero: losing the count
  and starting from one is how a bounded loop silently becomes an unbounded one.

**There is no login that separates the bot from the human it posts as** — `gh` is authenticated as
the operator. Ours is what carries the `bot: ` prefix, not what carries a name.

**The write comes before the work.** The count is a reservation, not a receipt: bump it and write
the cursor _before_ running the pass, because posting afterwards means a failed post hands back a
free round, every tick, forever.

**`reRequest` is gated on the round having pushed something.** A reviewer handed a byte-identical
diff can only restate itself, so pinging after a no-op round buys a paid review whose content is
already on the pull request — and then the instability rule spends the _next_ round recognising
it. The loop was manufacturing the instability it is written to survive.

A human always merges. The bot has no merge path.

### 7. Sendback subscription — watching the nearly-solvable (F)

A ticket triaged SEND BACK is not a rejection; it is a ticket with a fixable gap, and the reporter
is usually told exactly what to add. When they add it, nothing looks again.

`agentFitness` gains `plausible: boolean` — _would be solvable if the named blockers were filled
in_ — with two coherence rules: `plausible` may be true only when `solvable` is false, and it
requires non-empty `blockers`. "Nearly solvable, but I cannot say what is missing" is a guess, and
it would put a ticket on a paid watch list with no condition that could ever clear it.

`plausible: true` writes **`agent:watching`**, and a third JQL selects on it.

**The obvious implementation is an infinite paid loop.** Posting a triage comment _is_ an update
to the ticket, so `updated > ourLastComment` is true the instant we finish writing. The answer is
the same shape as the review cursor: **compare against what someone else did, not against what
changed** — re-triage only when the newest non-bot comment or field change is newer than our own.
Plus `MAX_RETRIAGE_PER_TICKET` (3), counted from the bot's own comments so it survives a restart.

Unsubscribing: the label comes off when the ticket closes, or when a re-triage returns `ready-ish`
— at which point the normal path takes over with no special case. That hand-off is the whole point
of the feature.

---

## Phasing

| Phase   | Scope                                                                                                                           | New privilege                                      | State                                                                                                                             |
| ------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **A**   | `agentFitness` schema + gate rule + `agent:solvable`                                                                            | none                                               | built                                                                                                                             |
| **B1**  | Second poller, both queries, label machine, `solve:once`                                                                        | none                                               | built, verified live                                                                                                              |
| **B2**  | The claim write + read-back-and-verify, release, comment                                                                        | Jira label writes                                  | built, driven by hand                                                                                                             |
| **C**   | Real solver: worktree, recon, edit, mechanical verification, diff gate                                                          | `Write`/`Edit` — **not `Bash`**                    | built, driven by hand                                                                                                             |
| **D1**  | Push, draft PR, request review                                                                                                  | `git push`, `gh`                                   | built; real PRs merged                                                                                                            |
| **D2**  | Wire `advance` — the `--advance` mode                                                                                           | the bot pushes to an existing PR unprompted        | done                                                                                                                              |
| **D3**  | Inline comments + review cursor + reply comment + thread resolution                                                             | the bot answers and closes a reviewer's comment    | done                                                                                                                              |
| **D4a** | The label slice — the four coordinated edits                                                                                    | the bot moves a ticket through its whole lifecycle | done                                                                                                                              |
| **D4b** | **Both reviewers (§6.2)** — `origin`, the `waiting` gate, round classification, the marker's second count, `reviewer-exhausted` | none beyond D2                                     | **built 2026-09-05, `feat/review-human-rounds`.** 1872 tests; twelve mutations caught. Not yet driven against a live pull request |
| **D4c** | The bail terminal — `agent:failed` plus the reason                                                                              | the bot closes a ticket against itself             | done                                                                                                                              |
| **D4d** | `--review`, the fifth rung — the whole chain in one command                                                                     | the first loop with nobody between iterations      | done                                                                                                                              |
| **D4e** | Every outcome reports on the ticket                                                                                             | none; removes a silence                            | done                                                                                                                              |
| **E**   | **Run it from the daemon**                                                                                                      | **runs unattended**                                | not started, deliberately last                                                                                                    |
| **F**   | Sendback subscription (§7)                                                                                                      | re-triage spend with nobody asking                 | not started; after E                                                                                                              |

**Each phase is branched out.** One implementation branch per phase, never on `main`, so the
privilege each grants is reviewable on its own. Later branches stack rather than fan out, because
each edits code the one below it is the first to call.

### Every phase ships hand-drivable, and the daemon comes after all of them

```
pnpm solve:once                    # whole queue, dry
pnpm solve:once SSX-3822           # one ticket, dry
pnpm solve:once SSX-3822 --claim   # writes the claim
pnpm solve:once SSX-3822 --solve   # ... and runs the solver, no push
pnpm solve:once SSX-3822 --pr      # ... and opens the draft PR
pnpm solve:once SSX-3822 --review  # ... and works the review to a handover
pnpm solve:once SSX-3822 --advance # one review round on an existing PR
pnpm solve:once --watch            # poll the whole review queue until it empties
pnpm solve:once SSX-3822 --watch   # ... or just that ticket
```

Each flag implies the ones before it, so the command line reads as the escalation it is.

**`--advance` breaks that rule deliberately.** It is not a later step of a solve — it operates on
a pull request a previous run created. Implying `--solve` would mean re-solving the ticket from
scratch before touching the review, which is the opposite of what the word says. So it is a
separate mode, and the parser refuses to combine it with a rung.

**`--watch` is a mode for the same reason, and bare is its ordinary form.** It is the review cycle
on a timer with a person watching, so it takes no rung and refuses to be combined with one. Without
a key it polls the whole watched set the review query returns; with a key it polls that ticket
alone — a filter applied after the query rather than a second query, because **the subscription is
the label pair**, so a named ticket carrying neither correctly reads as not under review and the
loop ends rather than waiting for something that will never arrive. It exits when the watched set
is empty, which is the honest terminal: everything it was watching has been merged, closed, or
handed to a human. It refuses up front when `SOLVE_ENABLED` is off, because an empty watched set
would otherwise report as _nothing is under review_ — a true sentence about a query that was never
run, and this project's own defect class pointing an operator at labels for a fault in their `.env`.

**There is no resume.** Each invocation re-runs from scratch. `--advance` rebuilds a worktree from
the pull request's branch rather than remembering one, because a worktree registry on disk is
exactly the state §1 spent the whole design avoiding.

**Why the daemon is last.** The property it adds is _nobody is watching_, and that is the one
property to add after everything else has been watched. Every phase before it is verifiable by a
person typing a command and reading the result; wiring the loop converts all of them at once into
things that happen on a timer whether or not anyone looks. It is also the only phase that adds no
capability — the bot can already do everything by then, and E only changes who asks it to.

**`pnpm start` runs the grooming loop only until E.** A ticket claimed, solved and PR'd by hand is
a demonstration; the same sequence on a five-minute timer is a deployment.

### What E needs that does not exist yet

- Its own cadence, slower than `POLL_INTERVAL_MS`.
- ~~The review-advance step running **before** any new claim, selecting on `agent:reviewing` **or**
  `agent:review-done`.~~ **Built as `buildReviewQueueJql` and `runReviewCycle`, 2026-09-06,
  `feat/review-cycle`,** and given a hand-driven caller the same day as `solve:once --watch`. So
  what E still owes it is not a caller but a cadence it does not have to be told, alongside the
  daemon's other unanswered questions below. Two things it settled that the plan had left open. The look/act split is the shape the
  whole cycle rests on — everything decidable about a pull request costs two `gh` reads and no
  checkout, so watching the whole set every minute is cheap and only the actionable few cost
  anything. And the cycle needed a bound the plan did not have: `maxRounds` on one _tick_, because
  a reviewer that answered twenty pull requests while the machine slept would otherwise buy twenty
  rounds in the first tick after it wakes — the largest single spend this service can make, and the
  one nobody would be watching. Deferred rather than skipped, oldest-updated first, so the same
  pull request cannot be starved. It writes nothing, so the ordering rule holds: granting the write
  is a change to an interface rather than a line inside a loop.
- **Cost per ticket per day.** A triage run was long quoted at $0.11 and that is wrong by 14×: a
  single bailed ticket measured **$3.99**, and a review round $0.94. A _completed_ solve has never
  been costed at all. Three changes turned single-shot costs into recurring ones, so a per-run
  number is no longer enough. **The most overdue item here.**
- A decision about what a failed solve cycle does to the daemon's backoff — a solve failure is not
  the same event as a Jira outage, and `loop.ts` knows only the latter.
- **An answer to machine sleep.** A pass killed at `SOLVE_TIMEOUT_MS` because the laptop slept has
  done nothing wrong, is deliberately not retried, and silently converts a claimed ticket into an
  abandoned one. Hand-driven runs use `caffeinate`; a daemon has no such person.
- **An answer to the second gate.** The solve subprocess inherits the operator's `PreToolUse`
  hooks, and one denied a write pass its `Write` tool. `runner.ts` reasons about
  `--allowedTools`/`--disallowedTools` and concludes the solver has `Write`; a hook this harness
  never sees can veto that per call. It is content-based rather than path-based, and it degraded a
  _read_ tool in the same session before any write was attempted — a pass that cannot `Grep`
  produces a worse answer rather than an error.
- **A transient/deterministic split plus a per-ticket attempt count.** `refused` and `failed`
  still release, so auto mode can spend repeatedly on a ticket whose diff the harness would not
  judge. Also the only answer to D4e's stacking problem, where a re-claimed ticket is re-commented
  nightly.
- **A test harness for `runSolveRungs`.** Measured, not assumed: putting the wrong predicate back
  at that call site leaves all 1841 tests green, because nothing constructs its dependencies.

---

## Verification

Unit and integration, following existing patterns, plus the house rule: **a guard is not shipped
until a test fails when it is unplugged.** Guards worth naming, because each protects against a
recurring charge rather than a wrong answer:

- **cursor** — unplug the high-water mark and the same comment is resolved twice.
- **marker parsing** — three mutations, failing in three directions: an unparseable marker reading
  as zero; the reservation written after the pass; "our own comments" keyed on the author again.
- **the operator's comment is not ours** — a human comment from the same GitHub account the bot
  posts through must be treated as feedback and must never be the comment we edit. This is the one
  whose failure destroys somebody's words rather than costing money.
- ~~**round classification (D4b)** — make a human comment count against `MAX_REVIEW_ITERATIONS`
  and a test must fail; the mixed-batch case separately, since that is where the rule is easiest
  to get subtly wrong.~~ **Done, and the mixed batch needed the separate mutation it was promised:
  `some` → `every` leaves every other classification test green.** Ten more alongside it; see
  §6.2.
- **terminal** — a `MERGED` or `CLOSED` pull request must not produce another round.
- **label pairing** — moving `agent:done` without making `agent:reviewing` replace `agent:solving`
  must fail a test, and so must the reverse. Two mutations, because the half-changes fail in
  opposite directions and one test will only catch one.
- **sendback self-trigger (F)** — the bot's own comment must not qualify as "the ticket changed".
  Invisible in review and obvious on the invoice.

### Probed against reality, not assumed

1. **`--allowedTools` does not restrict at all.** It is an auto-approve list. Four probes
   confirmed scoped and unscoped commands both ran, from inside and outside the repo. So every
   triage run this service had ever made had `Bash`, `Write` and `Edit` available while four
   comments asserted the allowlist prevented exactly that. `--disallowedTools` restricts properly.
   **Read that finding as being about builtin tools only** — a later run had an MCP tool denied by
   the allowlist under `--permission-mode dontAsk` while `Read`, `Grep` and `Glob` stayed
   available to the same session. Two different rules for two kinds of tool.
2. **`labels NOT IN (...)`** — measured with a control group; numbers in §1.
3. **`--add-reviewer @copilot`** — answered in production. It also produced a finding no throwaway
   PR would have: Copilot can reply _"Copilot encountered an error and was unable to review this
   pull request"_ as an ordinary `COMMENTED` review, indistinguishable from feedback.
   `reviewerErrored` exists because of it.
4. **Cost** — see E's blockers above. Open, and the most overdue item in this file.
5. **Label write mechanics** — answered, and the answer changed the design. No _MCP_ path supports
   `update.labels.remove`; Jira's REST API always has. Resolved by amending the discovery-only
   rule for one narrow method rather than by living with the clobber. See §3a.
6. **Review vs. comment field shapes** — settled, and the fear was justified. Comments carry
   `createdAt`; **reviews have no `createdAt` at all** and asking for one returns `null` on every
   entry. The two lists `readReview` merges name the same fact differently, so a cursor reading
   `createdAt` alone would date every comment and no review — precisely the "everything is new"
   degradation the cursor exists to prevent, arriving through a field name. `dateOf` reads both.

### End to end, in order

Every arrow is a person typing a command and reading the output — that is the point of the
ordering. By the time the loop is switched on, each step has been watched at least once in
isolation.

~~triage:once and read `agentFitness`~~ → ~~B1 dry against a hand-labelled ticket~~ → ~~B2
claim/release~~ → ~~C on one ticket, diff inspected by hand~~ → ~~D1, draft PR read by a human~~ →
~~D2 one `--advance` round~~ → ~~D3 threads read, answered and resolved~~ → ~~D4c a bail written to
the ticket~~ → ~~D4d the whole chain in one command~~ → **D4b, a PR with one human review and an
exhausted reviewer budget, confirming the round still runs — built but not yet driven, and it is
the next thing a person does** → the `MERGED → agent:done` arrow, which needs a human to merge →
**E** → **F**.

**What D4b's live run has to show, since a green suite cannot.** A pull request whose marker
already reads `Reviewer rounds: 3` at `MAX_REVIEW_ITERATIONS=3`, and a human comment on it. The
round must run rather than report `reviewer-exhausted`, and the marker afterwards must read one
higher on the total and unchanged on the reviewer's half. PRs #1413 and #2661 both carry pre-split
markers, so either of them also exercises the missing-line default on the way through — the
compatibility case that only exists once.

## Out of scope

Auto-merge. Multi-repo. Cross-repo changes. Reopening `agent:done` tickets. Bot-noise tickets
(CVE/GHSA/SNYK/dependency bumps) — currently discarded at intake, and the most agent-fixable class
there is, so worth revisiting once the pilot has a track record.

## Open, deliberately

`bugFastPath` (default OFF) is the existing hook for bug-specific behaviour and is in direct
tension with this feature: it short-circuits a `Feil` to a one-line note with no scorecard — and
therefore no dev lens and no fitness call. If it is ever switched on, these two need reconciling.
Flagged, not solved.
