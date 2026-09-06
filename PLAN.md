# the-jira-police — bug-squashing agents

> **Progress, 2026-09-06.** Phases A through D4e are built and merged; the service claims a
> ticket, solves it in an isolated worktree, opens a pull request, answers the reviewer, and
> labels the ticket for whatever happened. 2011 tests, no build step. **E has landed its review
> half**: `pnpm start` now runs the review sweep beside the grooming loop, on its own cadence,
> behind `SOLVE_ENABLED`. The solve half — anything that claims a ticket — is still a person
> typing a command, and stays that way until E's remaining blockers are answered. **F has landed
> its signal, its judgement and its engine**: triage can mark a sent-back ticket nearly-solvable
> and label it `agent:watching`, and `pnpm watch:once` reports what the watcher would do to every
> such ticket — with `--write`, unsubscribing the ones that are finished and re-triaging the ones
> somebody answered, against a budget reserved on the ticket before anything is spent. **Nothing
> loops**: a person types the command. A human always merges.

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

#### 4a. Which model runs which task, and nothing chooses today

Requested 2026-09-06, and **the first fact is that there is no setting to change.** `--model`
appears nowhere in this tree. Six task kinds spawn a subprocess — the triage analyst and the
poster (`triage/runner.ts`, `triage/poster.ts`), the four solve passes `recon`, `fix`, `simplify`
and `review` (`solve/runner.ts`), and the ticket commenter (`solve/commenter.ts`) — and every one
of them inherits whatever `storecode` happens to default to. Three argument builders, one flag
each: the mechanism is trivial and the policy is the whole of the work.

**Two changes, and only the second is the feature.** _Recording_ which model a pass ran under costs
nothing and should not wait for the choosing. Every cost figure in this file — triage $1.56, poster
$0.45, recon $1.58, the ticket comment $0.40, a review round $0.94 — is a measurement of an unnamed
model. None of them can be reproduced, compared, or defended, and the cost-per-ticket-per-day
number E is blocked on would inherit that at a larger scale and with nobody watching.

**Where a cheaper model is safe is decided by the gate, not by the price.** The rule: downgrade
where a mechanical gate checks the whole output, and do not downgrade where the gate only bounds a
judgement it cannot check. Four consequences, and three of them cut against the obvious answer:

- **The solve passes take the strongest, and this is measured rather than asserted.** `recon`,
  `fix` and `review` are bounded by the diff gate and by mechanical verification — and neither can
  tell a right fix from a plausible wrong one. SSX-3833 is the worked example: `setMonth(month - 1)`
  is the tempting one-character change, it is wrong, and the fail-first replay put a number on how
  little the machinery would have noticed — **1 of 7 new assertions went red against it, against 7
  of 7 for the original bug.** The gates bound the blast radius; they do not bound the quality of
  the judgement, and the judgement is what is being bought.
- **The analyst is where cheap looks safest and is not.** Its output is schema-checked and
  gate-checked, which by the rule above argues for a downgrade — except the fitness call inside it
  decides whether a paid solve happens at all, and neither the schema nor the gate can tell a right
  call from a wrong one. SSX-3822 cost roughly **$6 to be refused three times for two reasons that
  were both wrong**, which is more than the runs that produced it.
- **The poster is the honest candidate.** Its whole output is a label set and a comment shape, and
  `assertPostable` and `checkLabels` check it mechanically, so a weaker model fails the gate rather
  than posting something wrong. That is the case the rule was written for.
- **The commenter is the cheapest task and the least guarded, which is not the same as safe.** It
  is handed finished prose and asked to post it verbatim; there is no gate, and nothing compares
  what was posted against what was handed over. Its known failure is already recorded — the API
  re-serialised the text server-side — so a weaker model rewording the text would land in the one
  channel this service does not check.

**Shape, and the fail-closed direction is not the obvious one.** One setting per task rather than
one global knob, because a global knob is how everything ends up on the cheap model or everything
on the expensive one, which is the choice this section exists to stop making by accident. The map
copies `SCHEMA_FOR`'s `Record<Pass, …>` so that adding a pass fails to compile instead of
inheriting its neighbour's model — the same bug that map already caught once. **Unset means today's
behaviour**, whatever the CLI defaults to, because defaulting to "the strongest" would change the
cost of every run on the day the setting lands, with nothing in the diff saying so; an
_unrecognised_ name is a startup error, like `SOLVE_MODE`, and not a fallback. A downgrade has to
be typed out against the task it applies to.

Not a blocker for E. The recording half is, in the weak sense that E's own cost item is
unanswerable without it.

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
Plus `MAX_RETRIAGE_PER_TICKET` (3), counted from a label on the ticket so it survives a restart —
written from the bot's own comments until 2026-09-06, when the poster turned out to rewrite them
in place.

Unsubscribing: the label comes off when the ticket closes, or when a re-triage returns `ready-ish`
— at which point the normal path takes over with no special case. That hand-off is the whole point
of the feature.

#### F's signal, landed 2026-09-06 on `feat/sendback-watch`

The first slice is the signal and nothing else: `plausible` in the schema and on `AgentFitness`,
`agent:watching` in `AGENT_LABELS`, four gate rules, and the field rendered in the artifact a human
marks right or wrong. No query, no watcher, no re-triage. **The slice boundary is where the
calibration happens** — the same argument that made Phase A worth living with on its own. The
field can be wrong for weeks at no cost while nothing reads it, and how often it is wrong is the
only thing that decides whether a watcher is worth building.

Four decisions the plan did not settle:

- **`plausible` is asked for, not required.** Every other `agentFitness` subfield is in the
  schema's `required` list; a sixth would make the next run of an unchanged skill fail its own
  schema, which is a payload rejected after the analyst has been paid. Omission reads as `false`,
  the same "no" the whole object's omission already means.
- **The watch is not gated on the verdict, and `solvable` still is.** `solvable` needs `ready-ish`
  because it needs acceptance criteria to check work against; a watch needs only a gap somebody can
  fill, and an `out-of-scope` ticket can acquire one. Pinned by a test so the two rules cannot be
  tidied into looking alike.
- **`TRIAGE_OWNED_AGENT_LABELS` widened for the first time**, from one entry to two. What that buys
  an attacker is worth stating: a ticket body can now talk this skill into putting itself on a
  watch list, which costs re-triage runs. It still cannot talk it into `agent:start`, which costs a
  pull request.
- **`buildFitnessNote` is deliberately untouched.** It returns `null` for every verdict but
  `ready-ish`, which is exactly where `plausible` lives, so the reporter is told nothing yet.
  Promising somebody a bot is watching before anything watches is this project's own defect class,
  and the note goes in with the watcher.

**One rule the gate cannot enforce, recorded rather than faked.** A ticket already carrying
`agent:watching`, re-triaged into `plausible: false` with the label simply left out of `labels`,
needs the label _removed_ — and `TriagePayload` carries what the verdict asserts, never the live
label set. So the mirror catches "asserting a watch while declining one" and structurally cannot
catch "declining a watch that is already running". Ending an existing watch is the watcher's job,
which is the argument for `MAX_RETRIAGE_PER_TICKET` being a terminal rather than a tidy-up.

1961 tests; eleven mutations applied and eleven caught.

**What F still needs:** `buildSendbackWatchJql`; `src/watch/` with the not-our-own-edit rule;
`watch:once <KEY> [--write]`; `MAX_RETRIAGE_PER_TICKET` and `WATCH_ENABLED`; §7c's unsubscribe; the
fitness note; and then a third loop in the daemon on a cadence measured in days. The cost figure
§7b leans on is still the wrong one — it says $0.11 per re-triage and the measured number is
$1.56, which is the argument for the bound understated by an order of magnitude.

#### F's decision, landed 2026-09-06 on the same branch

The second slice is the query and the judgement, still with nothing driving either:
`buildSendbackWatchJql`, `src/watch/decide.ts`, and the two settings the decision is bounded by.
1995 tests; seventeen mutations applied and seventeen caught, but only after the run found two
guards that were not guards.

**The trigger is keyed on the field, not on the changelog's author, which is a departure from
§7b.** The plan proposed reading who made each change. That inherits the shared-account ambiguity
the poster already has — it writes through an MCP session on a human's Atlassian account — and it
breaks the day somebody else holds the credential. Keying on _which field moved_ is immune to
both. `BLOCKER_CLEARING_FIELDS` is an **allowlist** (`description`, `summary`, `attachment`,
`environment`) rather than a list of the fields this service writes, and the direction of the
error is the argument: a denylist reads a sprint assignment or a rank drag as "the reporter
responded", which does not merely buy a paid run but spends the ticket's whole
`MAX_RETRIAGE_PER_TICKET` budget on board grooming, so the watch is exhausted by the time the
reporter actually answers. Silent and free beats loud and expensive. The known gap is stated
rather than papered over: a board-specific acceptance-criteria custom field is the single most
likely real trigger and is not in the set, and inventing a name for it would read as coverage.

**A watch that cannot be counted is refused rather than started.** The bound is a _receipt_ — read
back from comments this service already posted — so a ticket with none has no bound at all, and
re-triaging it would pay for a run whose failed post hands back a free run every tick forever.
That is D3's marker rule arriving in a second loop. It costs the hand-labelled case, where a human
adds `agent:watching` themselves and gets a refusal instead of a look; that is a visible refusal
with a one-command remedy.

**§7c contradicted itself and the query resolves it toward seeing more.** The section asks both
that closed tickets be unsubscribed and that the query exclude them — but a ticket the query hides
is a ticket nothing can unsubscribe. So `buildSendbackWatchJql` deliberately omits
`statusCategory != Done`, mirroring `buildInFlightJql`'s existing argument, and `closed` is the
first branch of the decision. Mutation-tested: add the filter back and a test fails.

**Two of the eleven mutations survived, and the reason is worth more than the fix.** The
self-trigger guard — the one Verification names as _"invisible in review and obvious on the
invoice"_ — could be deleted with the suite staying green, and so could the strictness of the
comparison beside it. Each was masking the other: `spokeAt` is the maximum over our _own_
comments, so under a strict `at > spokeAt` nothing of ours can match whether or not it was
skipped, and with the skip in place nothing can sit exactly on the boundary either. **Two
redundant guards, each making the other untestable, and the house rule reporting green.** The fix
was not to delete one but to make the pair asymmetric: a tie now counts as somebody else in both
loops, which makes the skip the only thing holding the self-trigger and improves the answer — a
reporter commenting in the same millisecond is now seen rather than missed. The general rule both
loops follow came out of it and is written at the call site: **our own activity is excluded by
kind, never by clock** — comments by the sentinel, field writes by the allowlist. Neither loop
needs the timestamp for that job, so neither should give a tie away.

This is the closest thing yet to a counter-example to the house rule as usually stated. _A guard
is not shipped until a test fails when it is unplugged_ assumes guards are unplugged one at a
time; two guards covering the same case pass that test individually and defend nothing that the
other does not. It cost nothing to find here because the mutations were run. It would have cost a
recurring charge to find in production.

**What was left in F when this was written**, kept because the ordering it describes is what
happened: the changelog read on the Jira client (authorised 2026-09-06, and the second amendment to
the discovery-only rule after `updateLabels` — `ARCHITECTURE.md` §12 needs both); `watch:once <KEY>
[--write]`; §7c's unsubscribe wired to a real label write; `buildFitnessNote`; and the daemon loop.
All but the last two have landed in the sections below. `MAX_RETRIAGE_PER_TICKET` is now read, by
the counter label; **`WATCH_ENABLED` is still read by nothing**, which stays deliberate — it bounds
a loop, and there is no loop.

#### F's read half and `watch:once`, landed 2026-09-06 — and the sentinel did not survive the wire

The third slice is `fetchActivity` on the Jira client, `toWatchSignals`, and a command that reports
what the watcher would do while doing none of it. 2011 tests; twenty-five mutations caught across
the three slices. **It writes nothing and there is no `--write` flag**, which is the phase boundary
rather than an omission: a re-triage and the unsubscribe are not built, and a flag implying
otherwise is this project's own defect class in its own command line. It is the same argument
`solve-once.ts` made for having no `--dry-run` while only one mode existed.

**The identity check would have matched nothing, and only running it against a real payload said
so.** `FOOTER_SENTINEL` is written `_🤖 Generated by intake-triage · re-run the command to
refresh._` The poster sends markdown; **Jira stores ADF**, so the underscores become an `em` mark
and stop being characters; `renderAdf` puts marks back as `*…*`, because that is the one spelling
it emits. So `text.includes(FOOTER_SENTINEL)` is false for every comment this service has ever
posted. Every watched ticket would have read as having no comment of ours — refused as
`uncountable` on the current code, and under the version of this design that did not have that
refusal, re-triaged forever at $1.56 a go. `isOurComment` now keys on `FOOTER_TEXT`, derived from
the sentinel by stripping the delimiters so the two cannot drift.

Three things about how it was found are worth more than the fix:

- **The doc comment asserting it was fine was written before the test.** `toWatchSignals` says the
  sentinel survives the trip _because_ `renderAdf` is the same function the poster's output went
  through. That is true and it is not the same claim; the round trip preserves the words and not
  the markup. Prose that is true of something adjacent, read as coverage — the same shape as the
  `fix/review-chain-sleep` banner.
- **It is a seam defect, and both sides were individually convincing.** `decide.ts` is tested
  against literal strings containing the sentinel and passes; `renderAdf` is tested against ADF and
  passes. Nothing crossed the two until `signals.test.ts` did, which is why that file builds a real
  `em`-marked payload rather than a string.
- **The same reasoning is what caught the status name.** `closed` compares
  `statusCategory.key === "done"` and not the status name, because this board is Norwegian and its
  done status is not called `Done` — a comparison that would pass every test written in English and
  produce a watch that never ends on the only board this runs against.

**The client refuses a partial read rather than truncating.** The cheap implementation is one
request with `expand=changelog` and `fields=comment`; it lets Jira decide how much of each list to
return, which makes the count of our own comments — the entire bound on what a ticket may cost — a
count of _some_ of them, undercounting in the direction that hands back a free re-triage per tick.
So both lists are paged to completion and hitting the cap (500) throws. `MAX_RETRIAGE_PER_TICKET`
is a bound on a number that must be read whole or not at all, which is the marker rule from D3
arriving one layer below the place F already applied it.

**`WATCH_ENABLED` is deliberately not consulted by the command**, inverting how the master switch
works everywhere else. The switch exists so nothing is spent while nobody is watching; this command
spends nothing and is what an operator uses to decide whether the switch is safe to turn on.
Gating it would mean the only way to find out is to arm the loop first.

**What the command is for before anything writes.** `plausible` has been landing on tickets since
the first slice with nothing reading it, so a population of watched tickets exists and has never
been looked at. `pnpm watch:once` prints the decision against each one, which is how
`BLOCKER_CLEARING_FIELDS` gets checked against what reporters on this board actually edit — before
a mistake there costs a re-triage rather than a line of output. That is Phase A's argument, applied
to F: **the field can be wrong for weeks at no cost while nothing reads it, and how often it is
wrong is the only thing that decides whether the watcher is worth arming.**

#### The first live run, SSX-3830, 2026-09-06 — and the calibration question was masked by the population it was asked about

Driven by hand in three steps, each one `pnpm watch:once SSX-3830` against the real board, and the
ordering was the point: the ticket was read **before** anything was done to it, then after a
comment, then after a description edit.

| state of the ticket     | comments | changes | decision                                           |
| ----------------------- | -------- | ------- | -------------------------------------------------- |
| untouched since triage  | 1        | 3       | `quiet`                                            |
| a human commented       | 2        | 3       | `RETRIAGE` — a comment from somebody else at 02:59 |
| description also edited | 2        | 4       | `RETRIAGE` — **the comment again**                 |

**The first row is the one that had never been proved.** One comment, ours, sitting on the ticket,
and the watcher declined to spend. That is the self-trigger guard — the mutation this file calls
_invisible in review and obvious on the invoice_ — firing against a comment the poster really wrote
and Jira really round-tripped, rather than against the hand-built `em` fixture that found the
sentinel bug. The two halves of that seam are now closed from both ends.

**The third row is a defect in the command, not in the decision.** `decideWatch` reads comments
before the changelog and returns on the first trigger, so the field that moved is never named on
any ticket somebody also commented on — which is precisely the ticket a reporter answering a
sendback produces. The one question `watch:once` exists to answer is therefore invisible on the
whole population it was pointed at, and it looked like a pass. The debug line now dumps every
distinct field name in the changelog, unfiltered and regardless of age, because **a list filtered
by `BLOCKER_CLEARING_FIELDS` can only ever confirm the guess it was filtered by.**

With that, SSX-3830 answers it: `description`, `labels`, `resolution`, `status`. So `description`
is spelled exactly that on this board and the allowlist is right — a guess, now an observation.

**`labels` is the finding, and it is load-bearing in a way only the live names revealed.** This
service writes labels constantly — `triaged`, `dor:*`, the whole `agent:*` machine, and F's own
unsubscribe. Every one is a changelog entry on a watched ticket, and the comment-kind exclusion
**cannot see them**, because they are not comments. What stops them re-triggering the watch is only
that `labels` is not allowlisted. So the allowlist is doing two jobs at once: relevance filter, and
the changelog's entire self-trigger defence. The general rule was already written down — _our own
activity is excluded by kind, never by clock_ — and this is its concrete instance, which turns it
into a constraint on anyone widening the set later: **a field this service writes must never be
allowlisted**, which rules out `labels` permanently rather than by luck.

**One open divergence, found by reading the first row.** `MAX_RETRIAGE_PER_TICKET` counts every
comment of ours, and the original triage comment is one. So §7b's _"after three attempts the watch
is dropped"_ buys two re-triages, not three, and a ticket re-triaged by hand three times during
development reads `exhausted` on sight. Both readings are arguable — the first triage was a paid run
— but the prose and the behaviour disagree, which is this project's own defect class. Decide it
before the watcher spends, not after.

#### F's first write, landed 2026-09-06 — the brake before the engine

`watch:once --unsubscribe` takes `agent:watching` off a ticket the decision dropped, and comments
when the reason calls for one. 2031 tests; seven mutations caught. **The re-triage is still
unbuilt, and the flag is named for what it does rather than for the phase.**

**Unsubscribe first is an ordering argument, not an easier-first one.** It is the only action in F
that _reduces_ what the watcher can spend — every write it makes takes a ticket off the list, and
it cannot put one on. So it makes `decideWatch`'s two runaway terminals reachable before there is
anything to run away: `exhausted` and `uncountable` exist to stop a loop that does not exist yet,
and shipping them inert would have meant arming the loop and the brake in the same change.

**It is `--unsubscribe` and not `--write`.** Three outcomes, one writer: a `--write` flag would
silently do nothing on `retriage`, the outcome that matters most, while reporting a clean run —
this file's own defect class, spelled as a flag. It is renamed when it means it — **which happened
the same day the engine landed**, along with the guard that makes the rename safe.

Three guards, each of which can fail while everything around it succeeds:

- **`unsubscribeEdit` returns `null`, not an empty edit, on a ticket that is not watched.** Jira
  accepts a removal of an absent label; it changes nothing and still bumps `updated`, which is what
  the solve queue orders by and what a human reads as _somebody touched this_. Reachable rather
  than theoretical, because `watch:once <KEY>` deliberately accepts an unlabelled ticket and a
  closed one among those decides `unsubscribe`.
- **`unsubscribeNote` returns `null` for `closed`.** Closing is how nearly every watch will end and
  a comment is a $0.40 session, so commenting on all three reasons would put a recurring charge on
  the commonest outcome to tell a reporter what they just did themselves. The two that give up on a
  ticket that is _still open_ do pay for it, because there the silence actively misleads: a
  reporter who answers afterwards reads it as the tool having seen the answer and declined it.
- **The label comes off before the comment goes on.** Reversed, a failed label write leaves a
  ticket that has been told nobody is watching it and is still on the list — so it is told again
  every sweep, indefinitely, a bot repeating a goodbye at a session a time. This way the worst case
  is a ticket correctly unsubscribed and one person uninformed. Same rule as the review cursor's
  reserve-before-the-pass: **when two writes can fail independently, do the one that stops the loop
  first.** A failed comment therefore does not throw, since the watch is already off and there is
  nothing left to retry.

**`endWatch` lives in `src/watch/end.ts` rather than in the command**, for the reason
`watch-args.ts` exists — `watch-once.ts` ends in a top-level `await`, so anything in it runs on
import and cannot be tested. That is not filing preference: the ordering above is exactly the kind
of guard D4e recorded shipping unguarded, because the only place it was used was a command file.

**`fetchActivity` also reads `labels` now**, which is what lets the no-op case be told from the
real one. Still read-only, still the same request.

#### The budget divergence above, decided 2026-09-06 — the behaviour moved, not the prose

`decideWatch` counts `ours.length - 1`. The sendback is the reason the watch exists rather than an
attempt to end it, so `MAX_RETRIAGE_PER_TICKET=3` now buys the three re-triages its name and every
description of it already promised. Chosen over rewriting the prose because the setting is a
number a person picks in `.env` and a number that means one less than it says is a trap that
survives being documented. The subtraction is at the count rather than a `+ 1` at the comparison,
so the arithmetic says what it is bounding. Mutation: `ours.length` instead, and a ticket is
dropped one re-triage early — caught.

**Superseded within the day, and the off-by-one turned out to be the smaller half.** The count moved
off comments entirely once the poster's in-place rewrite was found, so there is no sendback to
subtract: the counter names re-triages and nothing else. The decision above still holds where it
matters — the setting buys what its name says — and the fix is now structural rather than
arithmetic.

#### The relevance pre-check, landed 2026-09-06 — the cheapest session in the tree

`decideWatch` answers _did somebody move_. It cannot answer _did they move in the direction we
asked for_, and the two come apart constantly: a reporter promising to get to it next sprint, a PM
linking a duplicate, a typo fixed in the summary. Each trips the trigger, and each would have
bought a ~$2 triage to be told the ticket is still missing the same thing. So a re-triage is gated
on a session that reads the sendback and the new activity and answers one boolean.

**It has no tools — not a narrow allowlist, none.** Every input is in the prompt, so there is
nothing for a tool to fetch and no reason to reach the network, the repository or Jira. It is also
the only session here with `requiredMcpServers: []`, and the empty list is an assertion rather than
an omission: naming `atlassian` would make the check fail whenever a server it never calls is down,
and a failed check reads as _do not spend_, so the watch would quietly stop working for a reason
unrelated to anything it does.

**It fails closed, and closed means does not spend.** Absent, malformed, truthy-but-not-`true`, or
a yes with no reason are all `false`. The last of those is the one worth naming: the reason field
is the only evidence the question was engaged with rather than agreed to, and it guards the branch
that costs money. A wrong no waits for the next thing to happen on the ticket; a wrong yes is $2
and a comment on somebody's bug repeating itself.

**It judges what was _supplied_, not whether the ticket is ready.** Readiness is triage's call and
triage has the vault, the scorecard and the DoR rules. Asking for it here would be a second, worse
triage whose disagreements with the real one nobody would ever see. The prompt says so explicitly,
and a test pins it. A promise is called out by name because it is the commonest false positive
there is: _"will add the logs tomorrow"_ mentions every blocker and supplies none.

**The one thing it costs is not money.** A `no` is silent, and silence does not clear the trigger.
The loop is self-limiting only because a re-triage posts a comment, which moves the high-water mark
and quiets the ticket until somebody speaks again. A ticket whose latest comment is irrelevant
stays triggered and is re-judged every sweep, on identical content, forever — §7b's infinite loop
one layer up and two orders of magnitude cheaper per lap.

That bound belongs to the daemon and needs no disk state: remember the newest foreign timestamp
already judged, **in memory**. §1 refuses on-disk state because losing it causes a double claim;
losing this costs one cheap re-check per restart, so the argument does not carry over. `watch:once`
has no loop and cannot run away, which is why the check can land before the bound does. Seven
mutations, seven caught.

#### The poster updates its own comment in place, and both of F's bounds were built not knowing it

Found 2026-09-06 while mapping the triage entry path for the re-triage hand-off — by reading
`poster.ts`, not by a test, and no test in `src/watch/` could have found it. `buildPostPrompt`
tells the session, even when the action is `create`, to look for a comment carrying both its own
authorship and the exact footer sentinel and **update that one instead**; `gate.ts` requires the
footer for the stated reason that without it _"a re-run could not update it in place and would post
a second copy instead"_. So the considerate behaviour is deliberate, documented, and it silently
disabled the two mechanisms F rests on.

**The high-water mark never advanced.** One comment of ours, `created` pinned to the first triage
however many runs follow. A mark built from `created` alone says this service last spoke days
before it did, every foreign comment since stays newer than it forever, and the watch re-triages
the same unchanged activity on every sweep. That is §7b's infinite paid loop arriving through the
one write path nobody thought to ask about.

Fixed: `updated` is read from Jira, carried through `JiraComment` → `WatchComment`, and both sides
of every comparison go through one `touchedAt` — the later of the two timestamps, `NaN` if either
will not read, because a partially-readable comment resolving to its earlier stamp is a mark that
is plausibly too early and too early is the direction that spends. Four mutations caught. It also
closes a blind spot recorded when `decide.ts` was written, by accident: a reporter who answers by
editing their own earlier comment used to be invisible, and once `updated` is on the wire for our
comments, withholding it from theirs would be choosing to keep missing the answers.

**The count is the worse half and it is not fixed.** `ours.length - 1` only counts re-triages if a
re-triage leaves a comment. It does not, so the number is zero forever and `MAX_RETRIAGE_PER_TICKET`
cannot fire — the mark at least fails toward refusing, while a count stuck at zero fails toward
paying. The arithmetic is kept, with its comment rewritten to say plainly that the brake cannot
currently fire: it is correct over the quantity it names, it does fire on the cases that produce a
second comment of ours (a pasted sentinel, a hand-posted verdict), and deleting a brake because the
odometer is broken is how the odometer stays broken.

**So the engine was blocked on where the count comes from — answered the same day, in the next
section.**

**The general lesson, which is the third instance and now a rule.** Every fixture in `src/watch/`
builds its own comments, so the poster's idempotency was a fact about a different module that this
module's tests quietly assumed away. After `client.test.ts`'s hand-copied label list and
`solve-args.test.ts`'s hand-copied rung list: **a fixture that models another module's output is a
test that cannot see that module change.**

#### The slice the check is shown, landed 2026-09-06

`retriageContext` is the pure half of the pre-check: everything foreign since we last spoke, and
nothing else. It is separate from `relevance.ts` for the reason `decide.ts` is separate from
`signals.ts` — the module that spawns a paid session should not also decide what goes into the
prompt, because then the prompt can only be tested by paying.

**It cannot reuse the decision's answer, which is why it exists.** `decideWatch` returns on its
first trigger, correctly: one reason to look is enough. On a ticket with both a new comment and a
description edit it names the comment and never mentions the edit, so anything reading the
decision's own trigger string would be judging half the activity.

**It imports `lastSpokeAt` and `touchedAt` rather than dating comments itself.** Two functions
computing _when we last spoke_ from the same comments would eventually disagree, and the
disagreement is invisible until a comment triggers the look and then does not appear in the prompt
— a paid session asked to explain an empty page. Both dating mutations are caught, and one of them
was live in this file for an hour before the import: the sendback was looked up by `created`, which
stops matching the instant the poster rewrites the comment, and the check would have been handed an
empty ask.

**Ten comments, newest kept, the dropped count stated outside the fence.** Every one of these is
attacker-controlled text going into a prompt, so it is bounded; and a check told it is seeing
everything while seeing ten of forty is answering a different question from the one it was asked.
The note is outside the fence because inside it is one more line a hostile comment could imitate.

**The field list is filtered where the debug log is deliberately not.** Both halves are the same
calibration lesson pointing opposite ways: a filtered _log_ can only confirm the guess it was
filtered by, and an unfiltered _prompt_ is an invitation to reason from noise.

#### The counter moved into a label, landed 2026-09-06 — and the gate was already guarding it

`agent:retriage-<n>`, one label, its suffix the number, superseded in the same delta so a board
shows one counter rather than a pile. `decideWatch` reads it instead of counting comments, and the
two facts are now unrelated — which is the test: three comments of ours and a full budget in the
same fixture.

**It is a reservation, not a receipt, which is why it can be a label and not a comment.** §6.3
settled the same question for the review marker: written after the run, a failed write hands back a
free run on every sweep, forever, on the loop that spends with nobody having asked. A comment body
cannot be a reservation, because writing one costs a paid session. `updateLabels` is REST, free, and
applied as a server-side delta with no read-modify-write window, so the write can precede the spend.

**The objection that looked fatal was already answered by code written for something else.** §11
lets a re-triage clear `agent:*`, which would be the run resetting its own counter — except that
`assertPostable` refuses any triage mutation touching an `agent:` label outside
`TRIAGE_OWNED_AGENT_LABELS`, and that set is `agent:solvable` and `agent:watching`. The protection
is mechanical, in the gate, and it now has a test that fails if the counter namespace is ever added
to that set. Nothing in `INTAKE_INSTRUCTIONS.md` needed to change; the prose is wider than the gate
and the gate is what runs.

**`null` is not zero, in three places.** A malformed counter refuses the ticket, a reservation from
an unreadable base is refused rather than written, and the top of the four-digit range refuses
rather than writing a label it could not read back. Losing a count and starting again from one is
how a bounded loop quietly becomes an unbounded one, and a pasted label must not be able to buy a
fresh budget. Several readable counters resolve to the highest instead of refusing, because that
shape has one ordinary cause — an add that landed and a remove that did not — and the maximum is the
reading that spends least. Five mutations, five caught.

**One refusal changed its reason rather than going away.** A ticket with no comment of ours used to
be refused because there was nothing to count. It is countable now and still refused, because it has
no high-water mark: every look would read as new and the first re-triage would judge the sendback
against the conversation that produced it. The note on the board says the new reason, and the test
name says which of the two it is pinning.

#### The engine, landed 2026-09-06 — reserved before it is paid for, and the flag renamed to match

`runRetriage` is the thing every other module in `src/watch/` was built to bound, and the order it
does five things in is the design rather than an implementation detail: slice, reserve on paper,
ask whether the movement was an answer, write the reservation, run the triage. The first two are
pure and free, so a missing high-water mark or an unreadable counter costs nothing; the check costs
cents; the label write is the last free act before the dollars. Four refusals, four mutations, and
the one that moves the groom above the reservation fails three tests at once.

**Step 4 before step 5 is §6.3's rule arriving in the second loop.** A count written after the work
is a receipt, and a failed receipt hands back a free run every sweep forever. A count written
before is a reservation, and its worst case — an attempt spent on a run that then failed — is a
number that moved on the board rather than a charge that repeats off it.

**It deliberately does not take `agent:watching` off.** §7c's hand-off is a _triage_ decision, and
the triage this function pays for already owns both that label and `agent:solvable` through
`TRIAGE_OWNED_AGENT_LABELS`. A second writer here would be this service deciding a ticket's fitness
from outside the component that assesses it, and the two would eventually disagree. A triage that
leaves the label on costs nothing: its own new comment is the new mark, so the ticket reads quiet.

**`--unsubscribe` became `--write`, and the rename needed a guard to be safe.** `watchKey` filters
anything beginning with `-` out of the positionals, so an operator's muscle memory would otherwise
have produced a silent dry run reporting a clean sweep — the divergence the rename closes, arriving
through the rename. `watchWrites` now refuses any flag it does not know and names the old one in
the message.

**A re-triage posts, and `WRITE_BACK` does not get a vote.** The watch is self-limiting only
because a re-triage moves the mark it measures from, and the mark is our own comment. A paid run
that analysed and posted nothing would leave the ticket triggered on identical content and buy the
same run next sweep — §7b's infinite loop restored by a value in `.env` rather than by any code.
`triage:once` reached the same conclusion from the other direction.

**Three copies of a fabricated ticket became one.** `triage:once` and `bot:once` each built their
own synthetic `TicketRef` for single-run mode and the re-triage needed a third. That is the fourth
instance of the rule this file already has: **a literal that models another module's input is a
copy that stops agreeing the day that module changes.** `src/triage/single.ts` now holds
`syntheticTicket` and `toTriageResult`, and its five tests pin the part that matters — the
fabricated fields are left empty rather than filled with something plausible.

**One gap, stated rather than papered over.** `watch-once.ts` ends in a top-level `await`, so the
loop that chooses `runRetriage` over `endWatch` has no test, exactly as `runSolveRungs` has none.
Everything either side of it is covered — `describeRetriage` in `watch-args.test.ts`, the engine in
`retriage.test.ts` — and the wiring between them is not. Same gap D4e recorded, now with a second
caller waiting on the harness E needs anyway.

#### The check could not see the answer, found by the first live `--write` run, 2026-09-06

The run reported: _"the description edit's content isn't shown, so nothing asked-for is verifiably
present."_ That sentence is the feature's main path failing, written by the thing failing it, in a
tone of good judgement.

**`BLOCKER_CLEARING_FIELDS` is four content fields and the content of none of them was being
fetched.** `fetchActivity` asked for `?fields=status,labels`, and `JiraFieldChange` keeps `created`
plus the field names, dropping Jira's `fromString`/`toString`. So a reporter who answered a sendback
the way reporters actually answer — by editing the description — reached the relevance check as the
nine-character string `description`. There is no answer to _does this supply what was asked for_
from a field name, and the check fails closed, so it said no. It will say no on every such ticket
forever, cheaply, with a well-argued reason each time.

**Second instance of the same masking on the same ticket population.** Last week a comment masked
the field _name_ in the debug log — a filtered list confirming the guess it was filtered by. This
masked the field _content_ in the prompt. The tell is identical both times: the output was
articulate about the thing it could see and silent about the thing it could not.

The fix is the fields' **current contents**, not the changelog's diff. Jira's before/after answers a
narrower question than the one being asked — a reporter may supply half an answer in one edit and
half in another, and what matters is whether the asked-for thing is on the ticket now. The prompt
says which reading it is in as many words, because a check that took these for diffs would read an
unchanged paragraph as newly written.

**Content only for the fields that moved.** Handing over the whole ticket would be less code and a
worse question: a description that has said the same thing since triage is not evidence anybody
responded, and a check shown it will find the sendback's words in it and say yes. Same filter
argument the field _names_ already carried, one level down.

**Three bounds, all of them because this is attacker-controlled text going into a prompt.**
`MAX_FIELD_CHARS` at 4000 — generous, because an answer is usually appended to an already-long
description — with the truncation notice **outside** the fence, beside the omitted-comments notice
and for the same reason. `MAX_CONTEXT_ATTACHMENTS` at 20. And attachments as **names, types and
sizes only**: no bytes are fetched, and the copy in `signals.ts` is field by field so the day that
changes it is a visible edit rather than a widening arriving by inheritance.

**An emptied field still gets a section**, saying it is empty. Dropping it would leave the check
reading a ticket where nothing appeared to change — this exact blindness, arriving through an
omission instead of a missing fetch.

**And the fifth instance of the literal-copy rule was avoided rather than caught.** Bounding the
field wanted `shorten`, which lived in `src/solve/feedback.ts`; the easy move was a second one in
`src/watch/`. It is now `src/text.ts` with its tests, beside `duration.ts`. A copy here would have
been the one guarding the prompt.

The read widening is recorded in `ARCHITECTURE.md` §12 as a **widening, not a third amendment** —
four read-only fields on a request already being made, against a write and a new endpoint. 2134
tests.

#### The watch became a loop, 2026-09-06, and the whole of the work is one bound

`WATCH_ENABLED` had been in `src/settings.ts` since F was built and was read by nothing:
`src/index.ts` held two loops, and a sent-back ticket somebody answered was looked at only when an
operator typed `watch:once`. `createWatchLoop` is the third, built the way `createReviewLoop` is
and for the same reason — `index.ts` runs `main` at import, so a decision made inside it cannot be
asserted about without starting a service.

**The cadence is `WATCH_POLL_MS`, six hours**, and it is deliberately the slowest thing here. The
grooming loop's trigger is a ticket being filed and the review loop's is a reviewer answering; this
one's is a person changing their mind, which is measured in days. Checking it every few minutes
buys nothing and pays per watched ticket every time.

**What made this more than wiring is that a relevance check that says _no_ writes nothing.** Every
other brake in this service works because the action it bounds leaves a mark: the claim is a label,
the round is a marker comment, the re-triage counter is written before the run it authorises. A
declined check leaves the ticket exactly as triggered as it was, on identical content — so the next
sweep asks again, and the next. `watch:once` is safe from that because it has no next sweep. **The
daemon is the next sweep**, and it is the case §7b named and could not close from the command line.

So `src/watch/memo.ts`: in memory, keyed by ticket, holding the newest activity it has paid to
decline, never remembering anything but a decline and never expiring. In memory rather than on disk
because §1's refusal of disk state was about a **double claim**, and losing this costs a repeated
cheap read — the failure directions are not comparable, and a memo file would be the one piece of
watch state that could disagree with the board.

**It cannot be keyed on `WatchDecision.at`, and that is the subtle half.** `decideWatch` returns on
its _first_ trigger in list order, because one reason to look is enough — so `at` is _some_
triggering item, not the latest. A memo remembering it would see everything after it as unjudged on
the very next sweep and re-ask forever, which is the loop the memo exists to close. Hence
`newestForeignAt` in `decide.ts` rather than beside the memo: the _foreign_ predicate — not ours,
after our last comment, and for a field edit only on `BLOCKER_CLEARING_FIELDS` — now has exactly one
definition. A second copy drifting would advance the memo past a reporter's real answer, silently,
on the population this feature exists for.

**The sweep was extracted rather than reimplemented**, into `src/watch/sweep.ts`, and this is the
fifth instance of the literal-copy rule caught before it happened. The two callers differ in exactly
the way that makes divergence invisible: one is run by a person reading the output, the other by
nobody. They differ in two things and the code says which — `acting`, absent entirely on a dry run
so the refusal is structural, and `memo`, fresh per invocation for the command because a person
typing it again is the bound.

**The memo is a parameter of `createWatchLoop`, not something it builds**, and the choice is about
which mutations are reachable. Closed over, the failure is one line moving inside `runCycle`, after
which the loop pays for the same refusal every sweep forever while every test still passes — a test
that runs one tick cannot see it. Handed in, that mutation has to ignore an argument, and two ticks
do see it. `index.ts` owns the lifetime because `index.ts` is what has one.

**Three mutations, all confirmed by unplugging them.** Build the memo per cycle — caught. Drop the
`declined` write — caught. Move the gate after `runRetriage` — caught, and only by
`src/watch/sweep.test.ts`, which is why it exists: the loop's own test cannot reach the checker to
count it, and the sweep swallows a re-triage failure, so a late gate looks identical from outside.
The first draft of that assertion lived in `watch-loop.test.ts`, passed against its own mutation,
and was moved rather than kept. 2160 tests.

~~**What is still not wired is the solve half.**~~ **Wired the same day — see below.**

#### The daemon claims, 2026-09-06, and the whole of the work is one counter

`runSolveClaims` is thirty lines and twenty-nine of them are `runWriteRungs`. The claim half of a
daemon tick reads the queue with `runSolveCycle`, walks `cycle.planned` — already capped by
`MAX_CONCURRENT_SOLVES`, counted from the board rather than from anything this process
remembers — and climbs the same ladder `solve:once` climbs, to the same rung. A second copy of
claim-solve-publish-release in a loop nobody watches is the sixth instance of this repository's own
defect, and the fifth was avoided nine hours earlier by extracting `runWatchSweep`.

**It is one tick's sequence rather than a fourth loop, and that is §6's rule made structural.**
Advance, then claim. Two loops on two cadences cannot promise an order at all: whichever fires
first wins, and at `MAX_CONCURRENT_SOLVES=1` losing that race spends the only slot on a new ticket
while a pull request a human is waiting on goes unread for another tick — every tick, for as long
as the queue has anything in it. Swap the two `await`s and nothing else fails, because both halves
succeed either way, which is exactly why there is now a test that reads the order of the two
queries off a recording client.

**The counter is the only genuinely new thing, and it closes the runaway D4c named as E's own.**
The label machine bounds every outcome that _decides_ a ticket's fate. Three deliberately write no
label — `refused` by the diff gate, `failed`, and `abandoned` for a transient reason — on the
argument that they say nothing about whether the ticket is solvable, and that labelling them would
turn a slept laptop into something only a human can undo. That argument is still right, and the
price of it is that `runRelease` restores the ticket **exactly as it found it, `agent:start`
included**. So the queue offers it again on the very next tick, at full solve cost, with no
condition that ever clears. Manual mode does not save it: the go-ahead comes back with the rest of
the labels, which is the property that makes a hand-driven rehearsal repeatable.

`createAttemptLedger` is a `Map<string, number>` and `MAX_SOLVE_ATTEMPTS_PER_TICKET`, default 3,
consulted before the claim rather than after the outcome — the count is a reservation, for the same
reason the review marker's is, because a run that crashes on its way to a verdict has still spent
an attempt. It is in memory for the same trade the watch's memo makes, and the trade is recorded
there: losing it costs one extra attempt per ticket after a restart, which is the behaviour of the
day before it existed, re-bounded the moment the process has ticked once. A label would survive a
restart and be human-clearable, and is deliberately not what this is — a write per attempt on the
path §3a's clobber risk is worst on, and a fourth `agent:` name, for a bound whose whole job is to
stop a loop that only exists while a loop is running.

Hand-driven runs never consult it. An operator running the same ticket three times is a decision,
and a harness that refused the fourth would be answering a question nobody asked.

**The exit code is captured and thrown away, which is a real difference between a command and a
service.** `runWriteRungs` sets `process.exitCode` at twelve sites because it was written to answer
_what should `$?` be_. A daemon's exit status answers _did the service stop cleanly_, and letting
one refused diff gate at 3am decide it makes every later stop report a failure that was already
logged, handled and released. So it is saved, logged as a field, and restored — restored rather
than ignored, because leaving it set means the next tick cannot tell its own failure from the last
one's.

**Four mutations confirmed by unplugging them.** Swapping the two `await`s fails the ordering test;
deleting the claim step fails two; `>` for `>=` in `exhausted` fails four, and that one is the
quiet kind — an off-by-one in a spend bound reads as the bound working; and building the queue
dependencies inside the tick fails the mode test, for the reason below.

**The mode question was asked from outside and the answer was wrong.** Asked 2026-09-06 — _does the
daemon respect manual versus auto?_ — and the queue half was right by construction: `createSolveDeps`
builds `buildSolveQueueJql` from `solveMode(settings)`, so manual asks for `agent:start` and auto
drops it and takes `SOLVE_AUTO_ISSUE_TYPES` instead. The claim half is right too, and by the
stronger route: `eligibility` re-checks locally what the JQL filtered for, and `SELF_AUTHORISING` is
an allowlist of `auto` and `named` rather than a `!== "manual"` test, so any authority nobody
thought about lands on the side that asks a person. The daemon passes `queueDeps.mode` and never
`named`, which is the one value that would skip the human gate on the one path with no human on it.

**What the question exposed is that the first draft built `SolveDeps` per tick.** `wiring.ts` builds
both queries eagerly and says why in a comment — a malformed one _"should stop the process at
startup rather than on whichever cycle first happens to reach the board"_ — and calling it from
inside `runCycle` defeats that from the outside while the file asserting it stays perfectly true of
itself. `SOLVE_MODE=automatic` was a cycle that threw every two minutes and backed off to the cap,
reported only as `cycle_failed`, which is the exact failure `createReviewLoop`'s own header argues
against for `VAULT_PATH` three paragraphs above the line that reintroduced it. Now built beside
`runDeps` and passed in, which also means the query and the claim read the setting once between
them rather than once each.

**And the first mutation written for it was a no-op**, the second time this session: it added a
second `createSolveDeps` call inside the tick while leaving the eager one in place, and reported
green. Recorded because a mutation that does not remove the guard is not evidence about the guard,
and the failure mode is that it reads as one.

#### The watch had no outbound half, and it was one `return null`

Found by tracing the chain end to end rather than by a test, which is the point of tracing it.
`buildFitnessNote` returned `null` for every verdict but `ready-ish`, and **`plausible` is only ever
true below `ready-ish`**, by the gate's own rule that the two are alternatives. So the block listing
what to fill in was suppressed on exactly the tickets the watch subscribes to.

What that produces is worse than a missing comment. The label goes on, the six-hourly sweep runs,
the relevance check is paid for on whatever the reporter happened to guess — and the reporter was
never told the ticket was being watched, or by what condition it would stop being. **A machine
waiting for an answer to a question it never asked**, at a cost nobody can attribute.

The suppression had an argument and the argument was written before `plausible` existed: _"below it
the fitness answer is trivially 'no, the ticket is not ready', which the verdict already says
louder"_. True of an ordinary send-back, and still true — `plausible: false` renders nothing, which
is the original judgement kept. False of a watched one, where this file's own header is the
counter-argument: _the blockers are not an explanation, they are a to-do list_, and kept off the
ticket that list reaches nobody. **This repository's defect class, in the file whose header argues
against it**, which is now the third time that sentence has been written here.

The block says two things the `ready-ish` one deliberately does not: that someone will look again
without being asked, and that the list is the whole of what is being waited for. The first is a fact
about the queue rather than a promise — the `ready-ish` block promises nothing because a solvable
ticket still waits for a human to opt it in, and copying that caution across would leave a reporter
with a to-do list and no reason to do it. One mutation, three tests.

**And the gap is the one D4e already recorded, now with a third caller waiting on it.** There is no
test harness for `runWriteRungs`, so `runSolveClaims`'s own body — that the ledger is read before
the claim rather than after the outcome, that a thrown ticket does not abandon the queue, that the
exit code is restored — is covered by argument and by the ledger's unit tests, not by a test of the
call site. D4e measured the same hole and called it _"the clearest argument yet for `runSolveRungs`
growing a test harness before E"_. E is here and it did not grow one.

---

#### The whole chain, unattended, on SSX-3834 — 2026-09-06, and the ticket was written to fail first

The first ticket to travel the entire system: created, triaged, **sent back**, answered, re-triaged,
`agent:solvable`, claimed, solved, published, reviewed twice, undrafted, `agent:review-done`. A
person typed two things — the reply answering the send-back, and `agent:start`. Claim to draft pull
request was 5m36s; the whole run cost two review rounds on top of the solve.

It was built as a controlled experiment, the same way SSX-3833 was. The defect
(`formatIntegerWithThousandSeparatorAndKr(0) → " kr"`) was found and verified by hand first, so the
right answer was known before anything ran, and the ticket was written **deliberately short of DoR**
so the send-back path had something real to carry.

**Triage's three blockers were not the three that were designed in, and the difference is the
finding.** The ticket was written expecting failures on acceptance criteria, evidence, and value. It
asked instead for acceptance criteria, **the scope of the fix**, and value — blocker 2 being _may the
`if (!value)` guard change, given it flips other call sites, or must the fix stay in the wrapper?_
That is the actual trap in the defect, found from the ticket text alone with no source access, and
it was found by hand only because someone went looking for it. **The send-back produced a better
question than the person who wrote the ticket had.**

**And it paid off three steps downstream.** Copilot's round-1 review claimed the `NaN` regression was
_"a likely user-visible regression"_, which is false — no caller can reach it. The round did not
repeat that claim and did not need to; it argued from the scope boundary the answer to blocker 2 had
established: _"Only the two zero rows in the ticket's acceptance table change behaviour now, which is
what the ticket scoped."_ A written scope let a true claim with an inflated conclusion be acted on
for the right reason. That is the clearest evidence so far that the watch loop produces better
tickets rather than merely slower ones.

**The AC was still wrong, and in this project's own defect class.** `if (!value)` was a catch-all: it
absorbed `null`, `undefined`, `''`, `0` **and `NaN`**. The acceptance table enumerated the first
three and forgot the fourth, so the solver — implementing the list exactly and faithfully — made
`NaN` render as the string `"NaN"`. **An enumerated acceptance criterion that replaces a catch-all
guard is only as complete as the enumeration**, and this is the same prose-versus-behaviour
divergence the project exists to catch, arriving in a third position: not a comment drifting from
code, but a _specification_ drifting from the code it supersedes. Recorded against the ticket's
author, not the solver.

Copilot caught it inside four minutes, from the diff alone, reasoning about the deleted code —
_"previously it returned an empty string via the truthiness guard"_. **This is the first known-answer
probe run against the reviewer**: the defect was found, its reachability established, and the catch
predicted as difficult, all before the review landed. Every prior assessment of Copilot was
after-the-fact reading of whatever it happened to say.

**The regression test is not decorative, and that is the first time.** #1413 and #2661 both shipped
tests whose names described something they did not check, which was called a pattern with a stated
cause. The third sample breaks it:

```js
it("should return empty string for NaN without swallowing non-numeric strings", () => {
  expect(formatIntegerWithThousandSeparator(NaN)).toBe("");
  expect(formatIntegerWithThousandSeparator("abc")).toBe("abc");
});
```

Both halves of the name are asserted. Round 2 then verified, unprompted and in public, that the
suite _"fails against the naive 'just delete the falsy guard' fix (which would render `\"null\"`)"_ —
the house rule applied by the solver to its own test, which is exactly what `SOLVE_INSTRUCTIONS.md`
§2 asks for and had never been observed doing. It could do it because the acceptance criteria named
the plausible wrong fix in writing. **Naming the wrong fix in the ticket is cheaper than any
mechanism that could detect it.**

**A formatted approval costs one terminal round per pull request.** Copilot's approval is a
non-empty body with review `state: "COMMENTED"`, never `"APPROVED"`, so the general discriminator is
unusable for this reviewer. `delivery.ts:858` reads a non-empty comment list as actionable, reserves
a round, and pays for a pass whose input is "looks good". It is bounded — the round changes nothing,
so the no-change rule undrafts — and here it was not even wasted, since it produced the verification
above. But it is a fixed per-pull-request cost and belongs in the cost-per-ticket-per-day number. The
cheap fix is unavailable for the reason the `Suppressed comments` block was left unparsed: an
approval and a summary-only review carrying real feedback (#1413 exactly) are indistinguishable on
the wire without reading the prose, and reading the prose is what the paid pass is for.

**Four smaller findings from the same run:**

- **`poller.ts:340` logs `"dry run — no label was written"` immediately before writing labels.** True
  while `solve:once` was the only caller; false the moment `runSolveClaims` became the second, which
  is every daemon claim. This file's subject, in this repository's own poller, found by reading the
  log of the run that first made it false.
- **Branch slugs drop `ø` and `å` rather than transliterating.** "Beløp på" became `bel-p-p-`. On a
  Norwegian board that is every branch the bot will ever cut.
- **The review tick re-reads every open bot pull request.** Four here; three (`#2660`, `#1413`,
  `#2661`) returned `threads: 0` and exist only because nobody has merged them. Per-tick work scales
  with _unmerged_ pull requests, not active ones — an argument for merging promptly, and a second
  input to the cost number.
- **`formatIntegerWithThousandSeparatorAndKr(NaN)` still returns `" kr"`**, since `??` catches only
  `null` and `undefined`. The ticket's own symptom for a different input, unchanged by this pull
  request and unreachable from any caller. A follow-up ticket, deliberately not scope creep on this
  one.

## Phasing

| Phase   | Scope                                                                                                                           | New privilege                                      | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A**   | `agentFitness` schema + gate rule + `agent:solvable`                                                                            | none                                               | built                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **B1**  | Second poller, both queries, label machine, `solve:once`                                                                        | none                                               | built, verified live                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **B2**  | The claim write + read-back-and-verify, release, comment                                                                        | Jira label writes                                  | built, driven by hand                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **C**   | Real solver: worktree, recon, edit, mechanical verification, diff gate                                                          | `Write`/`Edit` — **not `Bash`**                    | built, driven by hand                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **D1**  | Push, draft PR, request review                                                                                                  | `git push`, `gh`                                   | built; real PRs merged                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **D2**  | Wire `advance` — the `--advance` mode                                                                                           | the bot pushes to an existing PR unprompted        | done                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **D3**  | Inline comments + review cursor + reply comment + thread resolution                                                             | the bot answers and closes a reviewer's comment    | done                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **D4a** | The label slice — the four coordinated edits                                                                                    | the bot moves a ticket through its whole lifecycle | done                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **D4b** | **Both reviewers (§6.2)** — `origin`, the `waiting` gate, round classification, the marker's second count, `reviewer-exhausted` | none beyond D2                                     | **built 2026-09-05, `feat/review-human-rounds`.** 1872 tests; twelve mutations caught. **Half-driven live 2026-09-06 on PR #2662**: `origin` classified both rounds as `reviewer` and the `waiting` gate admitted a formatted approval as actionable — see below. The **human** path is still undriven; no person has commented on a bot pull request while the loop was listening, so uncapped human rounds and the mixed-batch rule remain tested and unobserved                    |
| **D4c** | The bail terminal — `agent:failed` plus the reason                                                                              | the bot closes a ticket against itself             | done                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **D4d** | `--review`, the fifth rung — the whole chain in one command                                                                     | the first loop with nobody between iterations      | done                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **D4e** | Every outcome reports on the ticket                                                                                             | none; removes a silence                            | done                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **E**   | **Run it from the daemon**                                                                                                      | **runs unattended**                                | **built and claiming 2026-09-06.** 2176 tests. The review half on `feat/daemon-review`; the claim half beside it in the same tick, `runSolveClaims`, bounded by a per-ticket attempt ledger so the outcomes that release without labelling cannot be re-bought every two minutes forever                                                                                                                                                                                              |
| **F**   | Sendback subscription (§7)                                                                                                      | re-triage spend with nobody asking                 | **built and looping 2026-09-06, `feat/sendback-watch`.** 2160 tests. `watch:once --write` unsubscribes and re-triages; the attempt is reserved on a label before anything is paid for, and the check is shown what the edited fields now say. The daemon runs the same sweep on `WATCH_POLL_MS`, six hours, bounded by a memo of what it has already declined — and since 2026-09-06 the ticket carries the list of what would end the watch, which is the half a reporter can act on |

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

pnpm watch:once                    # every watched ticket, dry
pnpm watch:once SSX-3830           # one ticket, dry, labelled or not
pnpm watch:once SSX-3830 --write   # ... and act: unsubscribe, or re-triage
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

**`pnpm start` claims nothing, and that is what the rule now means.** A ticket claimed, solved and
PR'd by hand is a demonstration; the same sequence on a five-minute timer is a deployment. The
review sweep was let past that rule on 2026-09-06 because it does not start work — every round it
can run is one a person already authorised by opening the pull request, the look is free, and the
spend is bounded per tick and per pull request. A claim has none of those properties, so it stays
behind the blockers below.

### E's review half, landed 2026-09-06 on `feat/daemon-review`

`createReviewLoop` (`src/review-loop.ts`) composes the second `runLoop`; `index.ts` awaits both in
a `Promise.all`. Four decisions, and each is a test in `src/review-loop.test.ts`:

- **Two loops, not two steps of one tick.** `TRIAGE_TIMEOUT_MS` is twenty minutes per issue and a
  reviewer answers in two and a half to four, so a shared tick would tie the review cadence to the
  slowest thing grooming can do — a timeout setting quietly becoming a review policy. Separate
  loops also mean separate backoff, which **answers the blocker below about what a solve failure
  does to `loop.ts`**: a review sweep that throws backs off the review side and grooming does not
  notice. No new notion of failure kind was needed.
- **The switch is read before the dependencies are built.** `createSolveRunDeps` throws on a
  missing `VAULT_PATH`; built above the switch, a grooming-only daemon would refuse to start for
  want of a path it never reads. `SOLVE_ENABLED` off returns `null` rather than a loop that does
  nothing, so the log says it once at startup instead of every two minutes forever.
- **The dependencies are built before the loop starts.** Inside the tick, one misconfiguration is
  a cycle that fails identically forever and reports itself as "the cycle threw". `runReviewSweep`
  therefore takes them as a parameter, which is the same argument one level down — it now has two
  callers and both are loops.
- **`REVIEW_ROUND_USD` is exported from `review-cycle.ts`** rather than written twice. The $0.94
  was about to be encoded in both `--watch`'s banner and the daemon's startup log, and a number
  telling an operator what a tick may spend is exactly the kind that gets updated in one of them.

**Verified live, twice, at zero cost.** `SOLVE_ENABLED=false … --for 6s` logged
`review.loop.disabled` and stopped with `reviewCycles: "off"`. Then `SOLVE_ENABLED=true
MAX_REVIEW_ROUNDS_PER_TICK=0 … --for 60s` logged `review.loop.start {intervalMs: 120000,
maxRoundsPerTick: 0, worstCasePerTickUsd: 0}`, ran the review JQL, and returned
`review.cycle {watched: 3, acted: [], settled: 2, ended: [], unlooked: 0, deferred: 1}` in 6.2
seconds. Both runs used a throwaway `STATE_PATH` and `--skill mock-triage`, so the real cursor was
untouched and nothing was posted. **`deferred: 1` is the interesting number:** with the per-tick
bound at zero, it means there is real actionable review work on the board that a daemon with the
bound at its default would have paid for on its first tick.

### What E still needs that does not exist yet

- ~~Its own cadence, slower than `POLL_INTERVAL_MS`.~~ **Built: `reviewIntervalMs` reads
  `REVIEW_POLL_MS`, floored at 1.** Two minutes rather than five, and _faster_ than grooming rather
  than slower, which is the opposite of what this line predicted. The prediction assumed the
  daemon's review work was a queue like the others; it is a question about a state whose answer is
  worth having within the time a reviewer takes to reply.
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
- ~~A decision about what a failed solve cycle does to the daemon's backoff — a solve failure is
  not the same event as a Jira outage, and `loop.ts` knows only the latter.~~ **Answered by the
  two-loop shape, 2026-09-06, and the answer is that `loop.ts` needs no change.** The two events
  are not the same, and they are also not in the same loop: a failing review sweep backs off the
  review side alone. What is still open is the _solve_ side of it, which is the attempt count
  below rather than a backoff question — a solve that fails deterministically should stop being
  attempted, not be attempted more slowly.
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
  **`runWatch`, `runReviewSweep` and the two halves it builds are in the same position**, and the
  gap now covers a refusal rather than only a predicate: the `SOLVE_ENABLED` guard that stops
  `--watch` reporting an empty watched set as _nothing is under review_ has no test that fails when
  it is unplugged. Everything decidable was pushed into pure functions that do — `describeReviewSweep`,
  `endedState`, `completionLabelFor`, the parser, `createReviewCycleDeps` — which narrows the
  untested part to the wiring and does not close it.

  **The daemon's own wiring took the same treatment rather than joining the gap**, 2026-09-06:
  every decision E adds lives in `createReviewLoop`, which is a module and not `index.ts`, so all
  six of them have tests that fail when unplugged. What is still untested is `runReviewSweep`'s new
  `signal` parameter — nothing constructs its dependencies, which is this bullet, one level down.

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
