# the-jira-police — bug-squashing agents

> **Progress, 2026-09-18.** Phases A through F are built. The service discovers a ticket, triages
> it, gates the result, posts a verdict, claims a solvable one, solves it in an isolated worktree,
> opens a pull request, answers the reviewer, keeps the branch current with its base, labels the
> ticket for whatever happened, watches the ones it sent back for an answer, and renders its log to a
> reader; run by hand, `pnpm sweep:once` sweeps the skill roots and staged images its own abandoned
> runs left behind.
> **3073 tests in 95 files**, no build step.
>
> **It loops, and it claims.** `main` in `src/index.ts` awaits a `Promise.all` over three loops — grooming,
> review and watch — and `runCycle` in `review-loop.ts` advances _and then_ claims in one tick,
> gated only on `SOLVE_ENABLED`.
>
> **A human always merges. The bot has no merge path.**
>
> This file holds **what is not built, and nothing else.** The built system is described in
> `ARCHITECTURE.md`; how to run it is in `README.md`; what a run taught goes into the rule it changes
> in `dev-house-rules`, or into `INCIDENTS.md`, or nowhere. Anything finished is deleted from here
> rather than struck through, because a plan that keeps its own history is a plan nobody can read the
> open items out of — and a "what was learned" section that only ever took deposits reached 409 lines
> before a human asked why the file kept growing.

## Context

The service grooms tickets: it discovers new SSX issues over Jira REST, runs `/intake-triage`
headlessly, gates the result, and posts a verdict. On top of that it solves the subset a fitness
assessment marks safe. Two things drove the design and still do:

1. **The solver needs `Write` and `Edit`.** No component in this service had ever had either. That
   is a real privilege escalation and gets isolation and mechanical — not model-asserted —
   verification.
2. **Triage cannot read source code.** The fitness call is made from the ticket plus the knowledge
   vault only. It is a _candidate_ signal, not a guarantee, so the solver re-checks against real
   code and is allowed to bail before writing anything.

Default posture is **manual**: nothing is solved until a human adds a label.

---

## What is not built

**The numbers are identifiers, not an ordering, so they are never reused and the sequence has
holes.** Other documents cite `PLAN.md §N`, and renumbering on every deletion would silently
repoint every one of them — the failure §14 exists about. A missing number almost always means that
entry shipped and was deleted. **Two of them did not ship**, and they are named with the holes below
rather than here, because the qualifier is worth nothing without the case: a hole list that flattens
"built" and "abandoned" sends somebody into the git history looking for a feature nobody wrote. The settled half of the two guardrail entries now lives in `architecture/guardrails.md` §16,
every file that cited them has been repointed there, and what is still open from them is §17.

<!-- refs:off -->

**The holes are §4, §7, §12, §15, §16, §18, §19, §20, §21, §22, §23, §25, §26, §27, §28, §29, §30, §32, §34, §35, §36, §37, §38, §40, §41, §42, §43, §44, §45, §49, §50, §51, §52, §53 and §55, and this line names them rather than
citing them.** A catalogue of deleted sections dangles by construction — the targets are gone and can
never be repointed — so it belongs in a `refs:off` region rather than in `KNOWN_DANGLING`, which
holds a debt still and would be holding entries nobody could ever pay.

**Each of them shipped and was deleted, except as noted here.** For the rest, `git log -- PLAN.md`
holds the entry and the commit that deleted it, so what follows is only what that history cannot say.

- **§29 did not ship.** It was the handed-off unsubscribe, deleted when the operator deferred it. The
  decision it recorded — unsubscribe rather than a quiet state, chosen knowing it is one-way —
  survives only in `1f8a3f4`'s parent, which is the cost of deferring by deletion.
- **§40 was issued twice, and its first use did not ship.** That first use was a supervisor process
  to run the daemon and the viewer together, abandoned mid-branch when the operator chose a
  `package.json` pipeline instead; no commit ever held it, and what it would have argued for is in
  `feat/daemon-log-tui`'s pull request. The reuse was opened in `2fb66e7` against a hole line that
  already named §40, and closed in `82d6079`, a deletion-only commit that removed the §38 and §40
  entries without adding either to this list. Both numbers had been picked by reading the last
  heading rather than this line.
- **No revision reachable by `git log --all` holds §30, §36, §42, §43 or §50 as a heading**, so for
  these five the history has no entry to show. §30 was the daemon check and the rule it put in
  `STARTING.md`; §36 was `branch-stack.sh` counting commit identity instead of commit content; §42
  routed every non-`verified`, non-`escaped` outcome to `agent:failed`; §43 had every worktree's
  `.git/info/exclude` list `.claude/` and `.storecode/`; §50 was the fix for a literal `""` in a
  recon field, `6e78ce7`.
- **§24 is absent from the list and is not a hole** — it was skipped rather than spent, for the
  reason recorded in `INCIDENTS.md`'s 2026-09-18 entry, "The dangling count that fell because an
  unrelated edit repaired nothing."

The next entry is §58. The pointer is a per-branch guess: two branches open at once each read it
from their own base.

<!-- refs:on -->

### 57. A repository member's request on the pull request cannot widen a review round

**Branch:** `feat/human-review-widening`.

**What is being attempted.** A review round may act on a drive-by cleanup or a small related
addition when a repository member asks for it on the pull request, in a file the pull request
already changes. Everything else a comment asks to widen is still declined.

**Why now.** PR #2688 on `buy-insurance-advisor-web` (SSX-3784): the operator asked three times on
2026-09-24 for the unused exports in `src/api/commerce/types.ts`, a file the pull request already
changes, to go, and rounds 3–5 declined each time on the skill's rule against drive-by refactors.
The pass had no signal it was allowed to trust: the operator and Copilot both rendered as
`by <login>` inside forgeable data, under a fence refusing scope requests "whoever it appears to
come from".

**The shape.**

- `pr.ts` reads `authorAssociation`. A comment carries authority when it is `OWNER`, `MEMBER` or
  `COLLABORATOR`, is not the requested reviewer, automation, a `[bot]` login, or ours by the
  `bot: ` prefix — and none when the field is missing. Measured on #2688: the operator `MEMBER`,
  Copilot and `github-actions` `NONE`. A separate field from `origin`, which counts rounds.
- The marker on those comments carries a random per-round token named outside the fence, so a
  comment written before the round cannot forge it.
- The review schema gains `widened`; the harness refuses a round whose entry cites a comment
  without the marker, or a path outside `base...HEAD` before the round.
- No setting. Driven by hand with `solve:once SSX-3784 --advance` before the pull request.

**What would make it the wrong idea.**

- The check reads the model's declaration: an undeclared widening passes, as it would today. What
  it buys is that a declared one is attributable and bounded.
- Replies this service posted before `replyToThread` stamped the prefix read as the operator's and
  would carry authority on any pull request still open from then; so would any future path that
  posts model-written text without the prefix.
- A refused review round still writes nothing to the pull request, so a round refused here is
  silent to the member who asked.

### 56. Documents outside this file still say a declined run leaves the board as it found it

**Branch:** none yet.

**What is not built.** The correction of statements that the 2026-09-24 read of this file found false
elsewhere and left alone, because each rewords an invariant, an architecture argument or a house
rule rather than a plan:

- `architecture/invariants.md` invariant 14 says a crash, a bail, a failed verification and a
  refused push "leave the board exactly as they found it". Half of that is still true. Since
  `65a9143`, `terminalLabelAfter` gives every outcome but `verified` and `escaped` the
  `agent:failed` label, which the solve queue excludes, so a bail, a failed verification and a
  crash reported as the `crashed` outcome are labelled. What `runWriteRungs` still releases as found
  is a run with no outcome to label — an exception out of the solver, or a refusal before it
  starts — and a verified run whose publish fails, since `verified` has no terminal label.
- `architecture/overview.md`'s failure table, in its `no-worktree` and `PreToolUse` rows, and the
  paragraph under it that opens "Three outcomes deliberately write no terminal label", say
  `no-worktree`, `refused`, `failed` and a transient `abandoned` are released unlabelled. All four
  are labelled.
- `architecture/module-map.md` and `daemon:status`'s message say the skill root is staged per pass;
  `prepareSkillRoot` runs once per run or round.
- In the house rules, which change only by proposal: `INCIDENTS.md`'s "Thirty-nine citations to
  sections that were never written", and the example `STARTING.md` draws from it, rest on the
  reading §14 held until 2026-09-24, that the dangling sites were never written. 23 of the 40 were
  `PLAN.md` headings that `96998cc` deleted. §14's own heading still says it.

**What would make it the wrong idea.** The overview paragraph is the argument the attempt ledger
exists for, and a rewrite that drops the ledger with the sentence would be wrong: the endings that
still release a ticket as found — an exception, a refusal before the solve, a failed publish — are
what the ledger now bounds. The correction is to the ledger's reason, not to whether it has one.

### 54. A dependency bump in a Node repository is still refused, because the pass cannot write the lockfile

**Branch:** none yet.

**What is not built.** The `pom.xml` exception (`architecture/solve.md` §15) has no Node
counterpart. A version bump there changes `package.json` and the lockfile together, and the pass
has no shell, so it cannot produce the lockfile; `verify` installs with the lockfile pinned, so a
hand-edited `package.json` alone fails at install. Both files stay refused, and a Node ticket that
needs a newer library is a bail.

**The shape it would take.** The judge would allow a `package.json` change that only moves the
version of an existing entry in `dependencies` or `devDependencies`, and the harness — not the
model — would regenerate the lockfile with the repository's own package manager before `verify`,
reporting the lockfile diff as the harness's in the pull request. That makes the harness run an
install with a manifest the model edited, which is new privilege and the reason this is its own
entry rather than a line in the Maven one.

**What would make it the wrong idea.** A regenerated lockfile can move far more than the one
version asked for — every transitive range resolves afresh — and no reviewer reads a lockfile
diff. If that is the cost, a narrower form updates only the named package's entries in the
lockfile and refuses when anything else would move.

### 46. Nothing can say which code a running daemon is executing

**Branch:** none yet.

**What is not built.** Any way to ask what a live daemon is actually running. `pnpm daemon:status`
matches processes on their command text (`node … src/index.ts`) and reports a count; it cannot say
which checkout a process was started from, nor which commit that checkout was on at the time.

**Why it is owed, with the cost already paid.** Node loads `src/index.ts` and its imports once, at
process start. Every commit, merge and branch switch afterwards changes the tree and not the running
process. The skill root is the exception, and it makes the situation worse rather than better:
`prepareSkillRoot` re-copies `.claude/skills/agent-solve/` from the tree on **every run and every
round**, so a long-lived daemon runs old TypeScript against new markdown — two halves from
different commits inside a single run. On 2026-09-21 a daemon started before PR #64 merged kept raising the `parseSimplify`
contradiction that #64 had already removed. `daemon:status`'s own message — "a branch switch changes
what the next tick runs" — is true only of the markdown, and it sent that session to the wrong
diagnosis twice before the error string was grepped for in the tree and found not to be there.

**The shape of the fix.** Record the HEAD sha and the checkout path when the daemon starts —
`state/` is the precedent — and have `daemon:status` compare both against the current tree: _running
code from `77ff859` in `/…/the-jira-police`, tree is at `6272103`, four commits behind; restart to
pick them up._ That is a check rather than a reminder, which is the distinction `CLAUDE.md` draws
about its own hooks. The cheap variant compares process start time against the newest mtime under
`src/` and needs no daemon change, at the cost of being a heuristic.

**What would make it the wrong idea.** A staleness warning that fires on every ordinary edit is one
that gets ignored, and this repository's working copy _is_ the running service's program text, so
divergence during development is the normal state rather than the exception. It should report, never
refuse, and the wording has to survive being seen constantly.

### 47. `createWorktree` salvages a colliding worktree but not a colliding branch

**Branch:** none yet.

**What is not built.** Any handling for the case where the branch a solve wants already exists and
its worktree does not. The reverse is handled: a worktree at the target path is detached, moved to a
`-salvaged-<timestamp>` sibling and its branch deleted, so that collision heals itself. With no
worktree there is nothing to salvage, and `git worktree add -b` fails outright — `exit 255: a branch
named 'fix/ssx-3944-…' already exists`.

**Why it is owed.** That state is precisely what hand-cleanup leaves behind, because removing a
worktree is the obvious half and deleting its branch is not. Observed on SSX-3944, 2026-09-21:
removing both worktrees while leaving the branch turned a self-healing situation into a hard refusal
and the run never started. The branch there carried no commits of its own — its tip was already
contained in `origin/main` — so nothing would have been lost by treating it the way the worktree
salvage already treats its branch.

**What would make it the wrong idea.** A branch that _does_ carry commits is somebody's unpushed
work, and deleting it to make room is the one outcome worse than refusing. Any fix must establish
that the branch adds nothing over its upstream before touching it, and refuse loudly when it does.

### 48. `docs:check` cannot see a count written as a word, and its blind spot is shared by the sweep meant to cover it

**Branch:** none yet.

**What is not built.** Two things, and the fix is worth little without both. `FACTS` in
`docs-check.ts` and `COUNTED_NOUNS` in `count-phrases.ts` both anchor on `(\d[\d,]*)`, so a count
spelled `six` rather than `6` matches nothing. And `"passes"` is not a counted noun, so even the
digit form would go unwatched.

**Why it is owed, with the cost already paid twice.** The two halves of this checker are supposed to
back each other up: a `FACT` pins a declared number to a computed one, and `count-phrases.ts` sweeps
for numbers nobody declared — the second exists precisely because the first only sees the phrasing
it was written for. **They share the digit assumption, so the backstop has the same blind spot as
the thing it backs up.** Measured: adding `repair` to `PASSES` on 2026-09-21 falsified "The five
passes" in `architecture/solve.md`, "Five passes, five sessions" in `README.md`, "four of the five
passes" in the same file, and a hand-copied `PASSES = [...]` literal inside the paragraph that
exists to record the _previous_ instance of this exact drift. All four survived a review and a run
with all six CI gates green — the drift is not something the gates caught late, it is something no
gate can see. The same class went unnoticed on 2026-09-08, which is what that paragraph was written
about; it is now written about twice.

**What it would let the service do.** Fail a pull request that leaves a word-count stale, which is
the only reason any of the numeric facts here are trustworthy today.

**What would make it the wrong idea.** Number-words are ordinary English and the false-positive rate
is the whole risk: "the five minutes it takes", "one of the two rules". `COUNTED_NOUNS` is the
existing answer to exactly that — it is a deliberate allow-list, and this stays safe only if word
support is confined to the same list rather than widened to any `<word> <noun>` shape. A second
trap is that the counter is the cheap half. On 2026-09-21 the pass table was also short a row, and
no count check would have said so; a green counter that reads as "the docs are current" would be a
worse outcome than the honest silence there is now.

### 1. Which model runs which task, and nothing chooses today

Requested 2026-09-06, and **the first fact is that there is no setting to change.** `--model`
appears nowhere in this tree. **Every task kind that spawns a subprocess** — the triage analyst and
the poster (`triage/runner.ts`, `triage/poster.ts`), one solve pass per entry in `PASSES`
(`solve/runner.ts`), all of them through the one `runSession` in `solve/passes.ts`, the ticket
commenter (`solve/commenter.ts`) and the sendback-watch relevance check (`watch/relevance.ts`) —
inherits whatever `storecode` happens to default to. Five argument builders, one flag each: the
mechanism is trivial and the policy is the whole of the work. **This sentence names `PASSES` rather
than counting it, having been wrong about the count twice** — the unnamed task is the hazard, since
a per-task setting that forgets one silently leaves it on the default.

**Two changes, and only the second is the feature.** _Recording_ which model a pass ran under costs
nothing and should not wait for the choosing. Every cost figure in this file — triage $1.56, poster
$0.45, recon $1.58, the ticket comment $0.40, a review round $0.94 — is a measurement of an unnamed
model. None of them can be reproduced, compared, or defended, and the cost-per-ticket-per-day
number in §2 would inherit that at a larger scale and with nobody watching.

**The default has already moved once, and nothing recorded it.** Measured from the session
transcripts: every solve pass through 2026-09-17 ran on `claude-opus-5`, and every pass from
2026-09-21 on `claude-sonnet-5`, with no change in this tree. The likeliest cause is the operator's
own global CLI setting, `opusplan`, which is Opus only in plan mode — inferred, not proven. The
effect is measured: recon and fix passes mostly stopped opening `SOLVE_INSTRUCTIONS.md` — 2 of the
34 run from 2026-09-21 to SSX-3918's failure on 2026-09-24, against nearly every one before — so
its proceed criteria and the gate's path list stopped reaching the model, and SSX-3918 paid a fix
pass for a `pom.xml` edit the gate then refused unconditionally.
"Unset means today's behaviour" below is a behaviour nobody in this repository controls.

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

This is the largest unbuilt block in the file, and the recording half is a prerequisite for the
next item.

### 2. Cost per ticket per day

A triage run was long quoted at $0.11 and that is wrong by 14×: a single bailed ticket measured
**$3.99**, and a review round $0.94. A _completed_ solve has never been costed at all. Three
changes turned single-shot costs into recurring ones, so a per-run number is no longer enough.
**The most overdue item in this file.**

Two known inputs to it that are already measured or argued and have never been added up: the
chain rebuilds its worktree every round, so twenty rounds is twenty installs; and the review tick
re-reads every open bot pull request, so per-tick work scales with _unmerged_ pull requests rather
than active ones (§8).

### 3. The review round has no `verifyBase`

`verifyBase` has exactly one call site outside its own tests — `runPipeline`, reached only from
`solveTicket` — so `resolveReview`'s `failed` is not relative to a base anyone proved green. On the
solve path a red build before the change is `unusable-base` and says so; on a review round the same
redness is attributed to the round. Now that the base is merged in every round, a base that is
broken upstream lands in the branch and the round takes the blame for it. Recorded, not fixed.

**The conflict round has the same hole and this entry did not say so**: `runConflictRound` reaches
the plain `verify` by the same path `runReviewRound` does, and neither checks the base first.
`runReconOnly` also skips it, but deliberately and with a comment saying why, so that one is not a
gap — which is the distinction to preserve if this is ever fixed by making the check unconditional.

### 5. The wiring that has no test, now down to two callers and an empty queue

Measured, not assumed: putting the wrong predicate back at `runWriteRungs`'s call site leaves the
whole suite green, because nothing constructs its dependencies. `runWatch` is in the same position —
one caller, `solve-once.ts`, and no test naming it. The gap also covers a refusal rather than only a
predicate: the `SOLVE_ENABLED` guard that stops `--watch` reporting an empty watched set as
_nothing is under review_ has no test that fails when it is unplugged, and neither does the exit
code it sets. Everything decidable was pushed into pure functions that do — `describeReviewSweep`,
`endedState`, `completionLabelFor`, the parser, `createReviewCycleDeps` — which narrows the untested
part to the wiring and does not close it.

**Two of the four callers this entry named have since been closed, and the entry did not notice for
ten days.** `review-loop.test.ts` mocks nothing at all: it builds `createReviewLoop` against a fake
`JiraClient` and awaits `runCycle`, so the real `runReviewSweep` and the real `runSolveClaims` both
execute, and unplugging either fails on the order of the two JQL searches. The `runRetriage`-versus-
`endWatch` choice is no longer in `watch-once.ts`'s top-level `await` either — it moved into
`runWatchSweep` in `watch/sweep.ts`, which has four tests, including that one ticket's throw does
not end the sweep. What is left in `watch-once.ts` is only its dependency construction.

**What the remaining coverage does not reach is the loop body, because the fake client returns an
empty queue.** `runSolveClaims` is entered and asserted on, but `for (const candidate of
cycle.planned)` never iterates, so the three facts this entry cares about — that the ledger is read
before the claim rather than after the outcome, that a thrown ticket does not abandon the queue,
that the exit code is restored — are still covered by argument and by the ledger's unit tests rather
than by an executed line. The same is true of `runReviewSweep`'s `signal`: it is forwarded, and
nothing aborts one through it, so deleting the parameter at the `createReviewCycleDeps` call leaves
the suite green. **A test that calls a function is not a test that exercises it**, and the cheap fix
here is one non-empty queue rather than a harness. D4e called this hole _"the clearest argument yet
for a test harness before E"_; E is here, it did not grow one, and half the hole closed anyway as a
side effect of moving decisions into modules.

### 6. The second gate has no consumer

The solve subprocess inherits the operator's `PreToolUse` hooks, and one denied a write pass its
`Write` tool. `runner.ts` reasons about `--allowedTools`/`--disallowedTools` and concludes the
solver has `Write`; a hook this harness never sees can veto that per call. **`sessionDenials` makes
the veto visible, 2026-09-06.** Probed: a denial arrives mid-stream as an ordinary `tool_result`
with `is_error: true`, told apart from a file that did not exist only by
`tool_result_meta[].non_execution_kind`, and the `result` event repeats the set in
`permission_denials` — while still reporting `subtype: "success"` and `is_error: false`, which is
the whole reason nothing here saw it. Every run now warns `session.denied` with the count and the
tools, and the label already names the pass and the ticket.

Three things it does not do, each for a measured reason. It does not attribute a denial to a hook:
hooks, deny rules and don't-ask mode share one tag, only free text names a hook, and some hooks emit
no prefix, so the attempt would undercount in the direction of reassurance. It does not fail the
run: this service's own D4c commenter was denied an Atlassian tool, routed around it, and posted the
right comment. And it cannot see the quieter half at all — a hook that **allows but degrades**,
which is how a `Grep` came back useless on SSX-3832, leaves no structural signal, because both
denial-bearing fields are gated on the call not executing.

**What is still owed is a consumer**, and `sessionDenials` in `triage/session.ts` currently has
none: its only reader is the `session.denied` warn a few lines below it. A fix pass that abandons
for `judgement` while the harness watched its `Write` be vetoed is reporting `environment`, whatever
it says, and wiring that means widening `PassRunner.run`, which still returns only the parsed
structured output.

### 8. Three findings from the SSX-3834 run, still open

- **`src/solve/poller.ts` logs `"dry run — no label was written"` immediately before writing
  labels.** True while `solve:once` was the only caller; false the moment `runSolveClaims` became the
  second, which is every daemon claim. This file's subject, in this repository's own poller, found by
  reading the log of the run that first made it false.
- **Branch slugs drop `ø` and `å` rather than transliterating.** `slugify` in `worktree.ts` maps
  every non-`[a-z0-9]` run to `-`, so run against real Norwegian summaries it gives
  `Beløp på` → `bel-p-p` and `Feil i årsavslutning` → `feil-i-rsavslutning`. On a Norwegian board
  that is every branch the bot will ever cut. **This bullet said `bel-p-p-` until it was run**; the
  trailing hyphen is stripped, twice, and the tests carry no non-ASCII letter to have shown it.
- **The review tick re-reads every open bot pull request.** Four here; three (`#2660`, `#1413`,
  `#2661`) returned `threads: 0` and exist only because nobody has merged them. Per-tick work scales
  with _unmerged_ pull requests, not active ones — an argument for merging promptly, and a second
  input to the cost number.

### 9. The fail-first check cannot answer a question about CI

The probe is cut on the machine the harness runs on. A test whose
vacuity is environment-dependent — one reading `ZoneId.systemDefault()`, say — gets opposite
verdicts on a UTC runner and a developer's laptop. **A probe that runs in the operator's
environment cannot answer a question about CI's.**

**"Inherits" was the wrong word and the right conclusion**, which is worth the correction because it
narrows the fix. `childEnv` is an allowlist, `ENV_PASSTHROUGH` in `solve/exec.ts`, and it already
forces `CI=1` and `NO_COLOR=1` — so a test branching on `CI` is answered correctly today. `TZ` is not on the list and
nothing sets it, so the child resolves the _machine's_ zone, which is exactly the
`ZoneId.systemDefault()` case. The gap is one unset variable in a list, not a missing sandbox.

### 10. Still unobserved

- **The repair round has been watched twice, both times on SSX-3944, and `--repair` has never
  promoted one.** The 2026-09-22 round, honest on inspection (`architecture/solve.md` §15),
  predates `repair-rounds.md`; a 2026-09-23 round is the page's one real row, still `unread`. Both
  are on the ticket the pass was designed against, the weakest evidence there is. Nothing has
  opened a pull request from a repair: the two-commit history and the notice `pr-text.ts` puts
  above the fold exist only in their tests until
  `REPAIR_ROUND=true pnpm solve:once <KEY> --pr --repair` runs on a ticket that fails verification
  — not SSX-3944, which now solves cleanly. **`REPAIR_PUBLISH` should stay off until that pull
  request has been opened and read**: the loop only removes the person, and nobody has yet been
  the person. Re-driving a ticket the solver has already tried means
  adding `agent:start` and clearing `agent:failed` first; both refusals are free, and the CLI says
  so on the way out.

- **A review round on a pull request that carries a dependency bump has never run.** The first
  such pull request exists, storebrand-digital/insurance-commerce-rest-api#1459, opened 2026-09-24
  with the notice above everything the model wrote. Every later round gates the pull request's
  whole diff, so the bump reaches the judge again on each one; that path is tested, not watched.
  The pull request body is written once, so a bump a later round introduces would not be named in
  it.

- **Nobody has looked at `pnpm logs` on a terminal that is not mine.** The screen has been driven
  headlessly and under a pty, and the restore path verified by the bytes it leaves — but the
  property the layout rests on is that six code points render two columns wide, and
  `logs/glyphs.ts` asserts that against a hard-coded table rather than against any terminal. A
  terminal disagreeing about one of them shears every column to its right, and no test here can
  see it. **What would show it:** one real run in iTerm, Terminal.app and a Linux console, looking
  only at whether the filter rows and the message column stay aligned.
- **The mixed-batch rule.** No round has yet read a human and a reviewer comment in the same batch.
  Both origins have been driven individually and the `some` → `every` mutation is caught, so this is
  a live-run gap rather than a coverage one.
- **The `MERGED → agent:done` arrow**, which needs a human to merge.
- **The `poll.order` head has never truncated in the wild.** The line itself is observed: the first
  daemon cycle with `TRIAGE_STATUS_PRIORITY` set, 2026-09-10, emitted it for a real seven-ticket
  queue with the three `Mottatt` ahead of the four older `On Hold` ones, and reported each status by
  name rather than falling back to its id — which also confirms `statusName` survives normalisation
  against the live API. What that run could not exercise is the cap: seven against a limit of ten.
  Both the truncation and the id fallback are covered by tests now, so this is a live-run gap rather
  than a coverage one, and a first run or a post-outage backlog is what would close it.
- **The compact brief has never been seen firing.** `pnpm hooks:brief` renders it on demand and its
  suite covers the extraction, but nobody has observed the runtime deliver a `SessionStart` payload
  after a compaction — so neither the field name it branches on nor the fact of registration is
  confirmed from a session's own vantage point (`architecture/guardrails.md` §16). It accepts both `trigger`
  and `source` for that reason.
- **The analyst's denial list is a list of strings, and only four of its names have ever been
  measured** (`ANALYST_DENIED_TOOLS` in `triage/runner.ts`). The probe that measured them named four other built-ins; `WebFetch`,
  `WebSearch` and `Task` rest on the same mechanism and were not in it, and the effect of the list
  on MCP names is unverified. A test asserts the three reach `--disallowedTools`, which is a claim
  about this service's command line and not about what the subprocess does with it. If a future MCP
  server offers a fetch under another name, nothing here would notice — and this is the denial the
  staged-image path was made safe by, so it is the one worth probing rather than asserting.
- **A model has read a staged image, once, and the proof of it is not the one that was planned.**
  The stager itself is observed on three real tickets: SSX-3822 took the SVG-only path and staged
  nothing, SSX-3917 met the caps on eight PNGs and staged six, and SSX-3918 staged its single image
  and rendered the omission list empty. On 2026-09-17, `TRIAGE_IMAGES=true pnpm triage:once SSX-3918
--write` reached the thing the staging is for: the posted verdict quotes a field label and a date
  (`Afg. årsag`, `15 09 26`) that are in the image and nowhere in the ticket's own text, which is the
  mechanical evidence the run was written to produce — by a different string than the one predicted,
  which
  [`INCIDENTS.md`, 2026-09-17](.claude/skills/dev-house-rules/INCIDENTS.md#the-fail-first-prediction-that-named-the-wrong-string)
  records as a false dichotomy. `refused`, the byte cap and the recon image path (built but not
  yet run against a real ticket) still have no real ticket behind them. **A run leaves its only
  durable record in `groomed/`, which is gitignored, and in whatever the operator's own Jira
  account posted** — this
  entry was corrected only because both were checked by hand against the live ticket and the staged
  file itself, which is exactly the check that caught this entry claiming a first run that was
  actually the third, the last time this bullet was wrong. A session starting fresh still cannot see
  any of this from the repository alone.

### 11. Loose ends recorded in no other file

Four things that exist in neither `architecture/*.md`, `README.md` nor the source, and were being kept
alive only by being carried forward in conversation. A fifth — the `dev-lens.md` calibration row
scoring the SSX-3801 fix as failed — is closed: the row carries a dated annotation naming the
`git-commit-id` harness failure and pointing at the `verified` re-run beneath it, and the file now
states the rule that produced that shape, which is that a recorded verdict is never edited.

- **A post-merge vacuous-test sweep.** Two shipped tests guard nothing: #1413's timezone test and
  #2661's run-date block. `checkFailFirst` is a one-shot at solve time and misses both, for two
  different reasons — #2661 is `guarded` and sound (7/7 red against the real bug; only the
  _plausible wrong fix_ separates it, which is prose, not mechanism), and #1413 is
  environment-dependent (§9). What that argues for is a slow sweep re-running the experiment against
  merged bot pull requests in a CI-like environment. It is **not** part of F: F's trigger is a
  reporter editing a ticket, its subject is ticket text before a solve, and its channel is Jira
  re-triage, whereas this is post-merge, about code, on GitHub. Folding it in would make
  `agent:watching` mean two unrelated things. What it shares with F is the _cadence_ — days rather
  than minutes, and money spent with nobody having asked. So it hangs off F's schedule as its own
  sweep, gated on the cost work in §2, since it buys an install and a test run per pull request
  revisited.
- **The triage poster has the commenter's read-tool defect, and has had it longer.**
  `architecture/triage.md` says it is "not given the research tools — no vault, no Confluence, no
  `Grep`/`Glob`, no `search`", and `poster.ts`'s own header says "given no skill, vault or search".
  `POSTER_DENIED_TOOLS` is `DENIED_BUILTIN_TOOLS` plus two Atlassian mutators — **no `Read`, no
  `Grep`, no `Glob`, no `Task`**. Both sentences describe `POSTER_TOOLS`, which the 2026-09-04 probe
  established denies nothing. The fix is the one applied to the commenter, whose deny list names
  `Read`, `Grep`, `Glob`, `WebFetch`, `WebSearch` and `Task` explicitly — including `Task`, because a
  subagent's tool surface is not the parent's list — and it is _more_ urgent by
  exposure: the poster runs on every triage, the commenter only on a terminal outcome. **`poster.test.ts`
  pins the defect in place**: it asserts only that the allowlist omits those names, which is the
  assertion that passes while nothing is denied, where `commenter.test.ts` asserts the deny list
  contains them. **The analyst
  cannot take the same fix** — reading the vault is its job — so its own header should be checked
  against the same question rather than assumed clean.
- **Stale Jira comments that no MCP tool can delete.** One stale triage comment on SSX-3822, plus the
  two Automation for Jira comments that caused the wrong fitness call in §9's story. `addCommentToJiraIssue`
  takes a `commentId` and updates in place, so _our own_ comment can be rewritten — but deletion is
  unavailable, and the automation comments are not ours. A board this service can be blocked by and
  cannot unblock is a fact about the tool surface that the daemon should be known to have.
- **`sectionReferences()` may be an orphan, and this is rehomed from an entry that shipped.** It
  counts `§N` tokens across the tree's TypeScript, and the section resolver that landed in PR #21
  resolves the same
  tokens rather than counting them. Its single caller is the `FACTS` table in the same file.
  **The churn half of this bullet is closed**: the function now masks `refs:off` regions, so the
  "106 → 141 on fixtures alone" failure cannot recur, and what is left is only the question of
  whether a count nobody reads earns its `docs:check` line beside a resolver that checks the same
  tokens. **Propose before deleting**: an
  unreferenced-looking function here has twice turned out to be load-bearing, so trace the guarantee
  to a caller rather than trusting the name (`PROVING.md`, "an unreferenced declaration is evidence
  about a name").

### 13. What the house rules claim that nothing checks

Found by a spot-check audit of the rules against the tree on 2026-09-08, and narrowed by the guard
work that followed. The audit's own story — what it confirmed, and the three ways its method failed
while it ran — is an
[incident](.claude/skills/dev-house-rules/INCIDENTS.md#the-audit-that-found-eight-things-and-got-three-of-them-wrong-on-the-way),
not a plan item. What is left below is only what is still missing.

- **The count class is checked, but only for nouns somebody listed.** `count-phrases.ts` now closes
  the class: every count-noun phrase in tracked markdown must be a declared `FACT` site or an
  explicitly listed historical figure, so the current-versus-war-story call is written down instead
  of made by silence. The cost is stated in the module and repeated here because it is the next
  gap — **a count about a noun that is not in `COUNTED_NOUNS` is invisible to it.** Scoping to nouns
  is what took the population from 539 shape-matches to something small enough that every entry
  carries a reason, and the alternative found nothing better; but the check cannot report the phrase
  it was never taught to see, so growing that list stays a human act. Adding a noun is one line.
- **`docs-check.ts`'s own logic is still mostly untested.** **Six** of its checks have now been
  extracted so they could be — `pinned-prose.ts`, `count-phrases.ts`, `length-budget.ts`,
  `rule-citations.ts`, `scope-bounds.ts` and `section-refs.ts`, because importing `docs-check.ts`
  from a test
  runs `vitest list`, which spawns vitest inside vitest. What is left in the file itself is the part
  with no test: the `FACT` table's derivation of each count from the tree, the `expectSites` logic,
  the `HISTORICAL` table, and the link walker. There is still no `docs-check.test.ts`. The
  extraction is the pattern for closing the rest — take the pure decision
  out, leave the I/O behind — and nothing forces it, so it will happen the next time one of those
  three is edited or not at all. **Note what stayed behind**: `KNOWN_DANGLING` and `KNOWN_AMBIGUOUS`
  live in the untested file even though the resolver they gate was extracted into the tested one.
- **A duplicate `HISTORICAL` blessing is never reported as stale, and one sat here unnoticed.**
  `staleHistorical` asks whether each entry's `(file, value, noun)` key is present in the tree, so
  two identical entries are both satisfied by one phrase. `PLAN.md` carried a single "4562 tests" and
  `HISTORICAL` carried two blessings for it; the second was dead on arrival and stayed invisible
  until the phrase was deleted outright, at which point both reported at once. **The exemption list
  is the one place a silent duplicate is most expensive** — the bullet above says an outlived
  exemption is a hole a new count could fall into, and this is that hole, held open by a copy.
  Keying staleness by identity rather than by value would close it; nothing does today.
- **`docs:check` is narrower than three documents claim.** Only `.md`-suffixed links, so a reference
  to a directory rather than a file is still invisible to it — which is why the "where the truth
  lives" row for `dev-house-rules` had to be pointed at `SKILL.md` to be checked at all. The
  repository's real cross-reference system — **125 section references** in the tree's TypeScript, mostly
  into the two instruction skills — is no longer unresolved: `§N` tokens are now checked against the
  headings that define them, and **exactly 40 point at sections that do not exist** (below,
  "The citations that were never written down"). Which _document_ a bare citation meant, since almost
  none of them says, is checked too now — the story is
  [`INCIDENTS.md`'s `§N` checker entry](.claude/skills/dev-house-rules/INCIDENTS.md#the-n-checker-that-resolved-a-citation-against-any-document-that-happened-to-define-it):
  **118 resolve in more than one document with no name saying which**, held by `KNOWN_AMBIGUOUS`.
  `CLAUDE.md`'s own routing table was the third gap here and is now closed: its filenames are links,
  so deleting a phase file fails the check by name instead of keeping it green. The size of the
  system is now derived by `docs:check`; whether any of it resolves is still not.
- **An incident unreachable from a rule now fails `docs:check`; the reverse direction does not.**
  Closed by `rule-citations.ts`: every `###` entry in `INCIDENTS.md` must be cited from one of the
  six documents in `CITING_FILES`, or carry a `**No rule yet**` line that parses. 56 entries, 46
  cited, 10 declared. What is still missing is the direction this bullet used to claim was the one
  that mattered — **42 of the 74 rule paragraphs cite no incident**, and that number is printed in
  the summary and failed on by nobody. **Both figures in this bullet drifted while the guarded ones
  either side of them did not**, which is the bullet's own thesis arriving as evidence: a number
  `docs:check` prints but never fails on is a number that rots. It is not a debt to pay down blind: 18 of the 42 are file
  openers, reading pointers and section labels rather than rules, so the honest fix is a citation
  convention for rule paragraphs, which does not exist yet.
- **`docs:check` bounds one property of the prose — how long it is — and verifies no count stated
  _inside_ it.** `length-budget.ts` measures four documents and holds their bands in TypeScript;
  every other fact the run holds is a property of the tree — tests, settings, files. A sentence
  counting its own
  document is still invisible to it, and `INCIDENTS.md`'s preamble carried two such claims for two
  commits: that every entry _ends_ with `**Found by**`, and that "the seven that already answer the
  question are quoted above" when five were. Both were caught by a reader, twice, in the paragraph
  arguing that this class of claim cannot be taken on trust. Not obviously worth a mechanism —
  "seven quotes appear above this line" is a check with one site and a bespoke parser — but the
  gap is real and the alternative is to stop writing such sentences, which is the cheaper fix and
  is not currently a rule.
- **Cost figures are facts with many homes.** `$0.94`, `$0.11`, `$3.99` and `$4.50` occupy 18
  file-homes between them, outside the `docs:check` exemption rule 3 grants. The figures themselves
  are history and stay unchecked; the total is derived, so the class spreading further goes red —
  this bullet said "three" of `$4.50` while it was already in four, which is the drift it describes,
  happening to it. It rose again, 17 to 18, the day `ARCHITECTURE.md` split into `architecture/*.md`:
  `$0.11` had one home because §10 and §13 shared a file, and now has two because they don't.
  Splitting a file can grow this count on its own, with no new figure and no new claim.
- **A citation to a document outside the tree cannot be checked, and does not look different.**
  `docs:check` can only resolve what it can open, so an out-of-tree quotation is exempt by nature
  while reading exactly like a verifiable one — which is how two of them were misattributed to
  `PLAN.md` for as long as they existed. The convention now is to name the source and say it is
  outside the tree ([`INCIDENTS.md`](.claude/skills/dev-house-rules/INCIDENTS.md) header); the
  convention is prose, and nothing enforces it. The mechanical version would be a marker the check
  recognises, so an unmarked unresolvable citation fails rather than passing silently.
- **One guard hole is left, and it is the one enumeration cannot close.** On a protected branch
  every non-git write still passes: `sed -i`, `>`, `>>`, `tee`, `cp`, `mv`, `rm`, and any
  interpreter handed a script. `Edit`/`Write` are refused unconditionally, so this is the Bash-shaped
  way around them. It needs a decision nobody has made yet — how many false positives a floor may
  cost — and shipping half of it would be worse than leaving it named. The rule-1 flag bypasses and
  rule 2 itself were closed on 2026-09-09; this was deliberately not.
- **Rule 2 has a guard here now, and the layer above it still cannot be surveyed.** The operator's
  outer tooling refuses mutating GitHub API calls — observed, when a probe was blocked that was only
  ever going to be fed to a local script as a string. Whether it also covers `gh pr merge` cannot be
  established without running `gh pr merge`, so it is unknown and will stay unknown. Separately,
  ruleset 22571207 requires **0 approvals and no status checks**, so nothing on the GitHub side would
  refuse the merge if the command ever ran.
- **This one is closed, and is kept because it was wrong in a specific way.** It said registration
  was the operator's and outside this tree, so every guard was built inert and the whole of the
  evidence was `pnpm test:hooks` and hand-fed payloads, never an observed refusal. Registration moved
  into the tree as PR #23 and a refusal **was** observed on 2026-09-09 (`architecture/guardrails.md` §16). The
  narrower claim it was replaced with — "the agent still cannot read the settings file, so it can
  watch a guard refuse without ever confirming what is wired" — was wrong in turn, and that is the
  second correction this item has taken. The read is allowed; what stays true is only that reading a
  registration is not watching it work.

**A checklist item that cannot be satisfied by the check a reader would reach for.** _"Any merged
branch deleted, including the local ref"_ — the mechanical way to find one is `git branch --merged`,
which is **blind to every squash- and rebase-merged branch**. `chore/agent-guardrails` had an
identical patch-id and tree to `6a8cba7` and `--merged` could not see it, so it needed `-D`. That is how
these accumulate, and it is one instance of a possible rule rather than a rule.

**What would make this the wrong idea.** Every item above is a check on documents, and this
repository's own evidence is that checks on documents catch less than driving a command does. The
guard work that was worth more than the whole `docs:check` list has now shipped, so what is left
here is genuinely the cheaper half — and the thing still worth more than any of it is the wiring,
which is not ours (`architecture/guardrails.md` §16). If the next session has budget for exactly one, take the
class check with
its test: it is the only item whose absence has already produced two shipped contradictions.

### 14. The citations that were never written down

<!-- refs:off -->

**Every `§N` in this section is quoted, not cited**, which is why the whole section sits in a
`refs:off` region rather than just its table. The resolver reads this document; a section that names
eleven tokens in order to say they resolve to nothing would otherwise report itself as forty-odd
defects. That is the write-up perturbing the count it reports — a failure this file has now paid for
twice, and the reason the exemption is a marked region rather than a file-level opt-out.

**The resolver is built. The 40 fixes are not, and they were always the expensive half.** `docs:check`
now parses the headings of the eleven section-numbered documents and resolves every `§N` in markdown
_and_ in `.ts` per document, against a name where one is given, so "roughly 39" is **exactly
40**, held by `KNOWN_DANGLING` and compared with `!==` — fixing some fails the check as loudly as
adding one, because a ceiling would let the debt be paid down silently and then quietly regrow.
**Branch:** `fix/section-resolver` shipped the check;
`fix/section-scoped-resolver` made it per-document and added one more (below), and shipped and
deleted the entry that added a second — the fixes still need a branch of their own, off `main`.

**Regenerating the list is no longer the expensive part, and this entry was wrong to say it was.**
The table below used to be the residue of a subagent sweep plus a `git log --all` check, kept because
re-deriving it cost a full-tree audit. It does not: lowering `KNOWN_DANGLING` by hand makes
`docs:check` print every dangling site, file and line, from the resolver that already walks them —
one command, no judgement. The table is now a convenience for reading, not an artifact worth
protecting, and **the cheaper fix than maintaining it is a flag on `docs:check` that prints the list
without requiring the constant to be falsified first.** That flag is not built.

**40 dangling `§N` citations**, regenerated from the checker on 2026-09-18 rather than searched for.
The first diagnosis — that this file's own deletions stranded them — was right for 23 of them, and
this entry said the opposite until 2026-09-24. `§3a`, `§5b`, `§6.1`, `§6.1c`, `§6.2` and `§6.3` were
`PLAN.md` headings until `96998cc` deleted them on 2026-09-08, written `#### 3a.`, without the `§` a
citation uses. Only `§7b`, `§7c`, `§3c` and `§24` were never written down anywhere. `architecture/overview.md:200`
says "See PLAN.md §5b", the one citation naming its target, and the name was right: the deleted §5b
argued for the `PreToolUse` hook that sentence is about. `architecture/overview.md:356` cites `§24`
in a document whose own headings stop well short of it.
The extra one is a different shape:
[an incident](.claude/skills/dev-house-rules/INCIDENTS.md#a-permission-granted-to-a-human-read-as-a-permission-granted-to-the-agent)
writes "`PLAN.md` §12" to illustrate a citation that used to name a real section — the pooled
resolver read the qualifier as decoration and matched `§12` against `architecture/triage.md` instead,
so it was never checked against the document it actually named. Per-document resolution checks the
name, `PLAN.md` has no `§12` since it shipped and was deleted, and it is now correctly dangling. A
second instance of the same shape, in the resolver's own retired write-up, went with it when that
entry was deleted on shipping.

**The quieter half was worse, and the per-document resolver is what stopped it being silent.** Some
references are in range and repointed: five sites cite "§1's rule against state on disk", and a
dangling number failed when checked while a repointed one read correctly forever, because the pooled
resolver had no way to ask which document `§1` meant. Now it does: they are flagged `ambiguous`
rather than passing, held by `KNOWN_AMBIGUOUS` at 118. Flagged is not fixed, and **this entry's own
account of where to repoint them was wrong** — it said the rule "moved to `architecture/overview.md
§5`", which is the section describing `state/poll.json`, the on-disk state the service _does_ keep.
The rule those five cite has no numbered home anywhere in the tree, which is why nobody has repointed
them: there is nothing to repoint them to. `architecture/overview.md:315` is itself one of the five.
A defect a check cannot see is still worse than one it reports and nobody has gotten to yet.

**The root cause is structural.** `PLAN.md` numbers its sections and rule 2 deletes entries when
they ship, so every `§N` there named a slot guaranteed to be reused. **Half of that is now fixed by
convention rather than by mechanism:** numbers here are retired instead of reused, stated at the top
of "What is not built", so a deleted entry leaves a hole rather than handing its number to the next
one. That closes the reuse case and not the deletion case, which is worse and is the one this entry
had not named.

**The deletion case, found while retiring §12 and §15 on `fix/unverified-claims`.** Five files cited
"`PLAN.md` §12". Deleting §12 does not dangle any of them, because `§12` is still a heading in
`architecture/triage.md` — so `docs:check` stayed green while every one of those citations came to point at
"Local divergence from upstream" instead of the guardrail argument. The resolver's rule is _this
token is a heading in **some** document_, and that rule is blind by construction to a citation
becoming wrong by deletion elsewhere. They were repointed by hand, at `architecture/guardrails.md` §16, and
nothing would have failed if they had not been. **A check that cannot see the failure mode its own
document describes is the sharpest version of item 3's argument**, which is why item 3 is now
partly instanced rather than only recommended.

Three fixes were named; the first is done, the third matters most and has its first real instance:

1. ~~A resolver in `docs:check`.~~ Shipped. It needed the predicted exemption for references that
   are _quoted_ rather than made — this very entry names eleven dangling tokens in order to be useful —
   and that arrived as `refs:off` / `refs:on` markers rather than a file-level opt-out, so exempting
   a paragraph never quietly exempts the document around it. A guard that fires on its own
   documentation gets switched off.
2. Fix the 40. The 23 whose target `96998cc` deleted can be read at `96998cc^:PLAN.md` and repointed
   or quoted. The 16 citing `§7b`, `§7c`, `§3c` and `§24` need a human, since their target was never
   written, and deleting a comment that cites nothing sometimes destroys the only record of a
   decision. The quoted `§12` is an illustration, not a citation to fix.
3. **Stop citing `PLAN.md` by number from code.** Cite `architecture/*.md`, whose section numbers are
   stable and survived the split out of `ARCHITECTURE.md` unchanged — §1–16 are now spread across
   eight files, each keeping the number it had — or quote the reasoning where it is used. **First instance done:** the guardrail argument moved out
   of `PLAN.md` §12 into `architecture/guardrails.md` §16 precisely because five files were citing a plan entry
   as though it were a permanent home. The general form of the rule is that an argument other
   documents cite does not belong in the document whose entries are deleted on purpose.

**What the resolver still cannot catch, which is why item 2 is still a human's.** Per-document
resolution means `§7b` in `src/watch/decide.ts` — naming no target document — is checked
against `src/watch/decide.ts`'s own sections first (it has none), then against every other document
that defines `§7b` (none do), and correctly lands dangling. A qualified citation to a document that
does define the id, though, is trusted: `architecture/guardrails.md §16` resolves because §16 exists
there, not because that is provably where the author meant to point. The check shrinks the set that
needs a human read. It does not claim the set is empty.

**What would make this the wrong idea.** Item 2 is a large mechanical diff across `src/` with real
judgement in it, and a batch pass by an agent is how the 16 references to nothing got here. If
the answer to a dangling `§7b` turns out to be "delete the citation", then 40 comments get shorter
and nothing gets more correct. Read three of them before fixing any.

#### The sites, regenerated 2026-09-18, lines rechecked 2026-09-24

**Provenance, because it decides how far to trust each row.** Every row below came out of
`docs:check` itself, not out of a sweep: the resolver already visits each site to decide it dangles,
so lowering `KNOWN_DANGLING` makes it print them. The paths and lines are therefore the checker's,
generated the same way twice. Verified by hand afterwards: twelve sampled lines read as quoted, the
two `architecture/overview.md` rows say what they are quoted as saying, and `§7b` has never been a
heading in any revision of `PLAN.md` that `git log --all` reaches. The same check said so of `§3a`,
`§5b` and `§6.1c` as well, and was wrong (above). **Every path and line in the previous version of this table was wrong**, because the
table was written against `ARCHITECTURE.md` before it was split into `architecture/*.md` and against
`src/` before the comments above these citations were rewritten; nothing failed when it rotted,
which is the argument for not keeping it by hand.

Dangling, grouped by the token they cite. `§7b`, `§7c`, `§3c` and `§24` have never been a heading
anywhere. The rest were `PLAN.md` headings — `§12` until `2531bbb`, the others until `96998cc` — and
`§12` is still one in `architecture/triage.md`:

| token   | sites                                                                                                                                                                                  |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `§7b`   | `watch-loop.ts:33`, `cli/watch-once.ts:14`, `watch/counter.ts:4`, `watch/decide.ts:134,190,203`, `watch/decide.test.ts:183`, `watch/memo.ts:6`, `watch/relevance.ts:12`                |
| `§6.1c` | `solve/pr.ts:213,1235`, `solve/commenter.ts:3`, `solve/delivery.ts:215,221`, `cli/solve-outcome.ts:243,362`, `cli/solve-outcome.test.ts:687`                                           |
| `§6.1`  | `architecture/triage.md:321`, `cli/solve-outcome.ts:240`, `cli/solve-run.ts:489,829`, `jira/jql.ts:169`                                                                                |
| `§3a`   | `architecture/overview.md:319`, `solve/attempts.ts:5`, `solve/commenter.ts:7`, `solve/commenter.test.ts:51`                                                                            |
| `§6.3`  | `solve/delivery.ts:955`, `watch/counter.ts:8`, `watch/retriage.ts:6`, `watch/retriage.test.ts:138`                                                                                     |
| `§7c`   | `jira/jql.ts:198`, `watch/retriage.ts:9`, `triage/gate.test.ts:508`                                                                                                                    |
| `§3c`   | `cli/solve-outcome.ts:388,392`, `jira/jql.ts:172`                                                                                                                                      |
| `§6.2`  | `solve/delivery.ts:666`                                                                                                                                                                |
| `§5b`   | `architecture/overview.md:200` — **start here.** The only citation in the tree that names its target document; the name was right and the target was deleted                           |
| `§24`   | `architecture/overview.md:356` — `` `agent-solve` (§24) ``, in a document whose own headings are 1, 2, 5, 6, 8, 9, 11; intended target is almost certainly `architecture/solve.md` §15 |
| `§12`   | `.claude/skills/dev-house-rules/INCIDENTS.md:1058` — the quoted `` `PLAN.md` §12 `` above                                                                                              |

**`§24`'s row carries an in-range defect the checker cannot report.** The same sentence reads
`` `intake-triage` (§12) and `agent-solve` (§24) ``, and that `§12` resolves — to
`architecture/triage.md` §12, "Local divergence from upstream", which has nothing to do with the
skill it is labelling. One half of one sentence is loud and the other half is silent, for the reason
the deletion case above gives.

**In range and repointed — flagged `ambiguous` by the per-document resolver, not yet fixed:**

- "§1's rule against state on disk" — `solve/attempts.ts:5`, `solve/review-cycle.ts:11`,
  `watch/relevance.ts:12`, `watch/memo.ts:9`, `architecture/overview.md:315`. `PLAN.md §1` is the
  model question and `architecture/overview.md §1` is the credential split; **the rule itself is in
  neither**, so these five have no correct target to be given.
- "§6: advance, then claim" — `review-loop.ts:71`, `review-loop.test.ts:182`. Now
  `architecture/overview.md §2`, at L98; `PLAN.md §6` is the second gate. A third site, `index.ts:44`,
  is gone — the entry named it and nothing noticed it had left.

**Clean, and worth knowing so the resolver is not written to re-check them:** every `§14.N`
sub-reference resolves, uniquely, since only `architecture/invariants.md` defines them, and it
defines 14.1 through 14.17. The bare `invariant N` prose references are **not** part of the
resolver's vocabulary at all — it reads `§N`, not the word — so the previous claim that "all 7" of
them are correct was never something `docs:check` was checking, and six of the seven coordinates it
gave have since stopped existing. There are nine such phrases today, citing invariants 11, 13 and
14; they are prose, and only a reader checks them.

**The bare `§11` citations are the bulk of the ambiguous 118 and are worth a count, not a tilde.**
There are **28** of them in `src/triage/*`, pointing at
`.claude/skills/intake-triage/INTAKE_INSTRUCTIONS.md` §11; none names its target, `§11` is also a
heading in `architecture/overview.md` and in this file, and all 28 are flagged `ambiguous` rather
than passing silently. The same is true of the `SOLVE_INSTRUCTIONS.md` ones. **This entry said
"~57" and the tilde is why it survived the drift** — an approximate number cannot be falsified by a
recount, which is exactly what `STARTING.md` item 3 means by letting the dated list be the count.

**The legal vocabulary, which the resolver parses rather than being told, as of 2026-09-24:**
`architecture/overview.md` §1, 2, 5, 6, 8, 9, 11; `architecture/module-map.md` §7;
`architecture/triage.md` §3, 4, 12; `architecture/solve.md` §15; `architecture/configuration.md` §10;
`architecture/invariants.md` §14 plus §14.1–14.17; `architecture/not-built.md` §13;
`architecture/guardrails.md` §16 — §1 through §16 exactly once each, across eight files. Then
`PLAN.md`'s own entry numbers, less the ones it has retired; `INTAKE_INSTRUCTIONS.md` §0–12 with `1b`/`6b`;
`SOLVE_INSTRUCTIONS.md` §0–8 with `0a`/`2a`/`2b`/`2c`/`2d`. Ten of the eleven dangling tokens are in none
of them; `§12` is the exception, and the shape worth remembering — it exists, in
`architecture/triage.md`, and dangles only because the citation names `PLAN.md`.

<!-- refs:on -->

### 17. Two guardrail questions that outlived the entries they were written in

**Branch:** none yet. These came out of §12 and §15, which shipped and were deleted; the settled
half of both is now `architecture/guardrails.md` §16 and this is the half that is still open. They are here
rather than there because §16 describes what the guardrails **are**, and a document describing a
built thing is the wrong place to keep a defect nobody has fixed.

**1. Nobody has ever seen `ask` honoured.** `branch-stack.sh` returns
`permissionDecision: "ask"` on stdout with exit 0, and it is registered on `Bash` — that much can be
read. What has never been observed is the runtime acting on it. It was watched _not_ prompting once,
on `git switch -c fix/write-verb-audit` from `main` with three unmerged branches, while the same
payload fed to the script by hand emitted the correct `ask` and exited 0. `deny` on the same
transport was watched being honoured the day before, so the transport works for at least one
decision.

**Why it is worth more than it looks.** If `ask` is decorative, then every guard written in the
fail-open "make the human decide" style is decorative, and that is the style this repository reaches
for whenever a refusal would be too blunt. It is one measurement standing behind a whole class of
future guards.

**How to settle it, and why it has not been.** The probe needs three throwaway branches _carrying
commits_ — `git branch --no-merged origin/main` ignores a branch with nothing on it, and
`unmergedBranches` excludes HEAD besides — then a `git switch -c` from `main` with `BRANCH_STACK_MAX`
at its default. Confirm the count the hook will actually see first,
`. .claude/hooks/lib.sh && countLines "$(unmergedBranches "$PWD" "$(stackBase "$PWD")")"`, rather
than inferring it from open pull requests; an earlier revision of the old probe got exactly that
wrong and read a correct silence as a dead hook. What has stopped it is that it is real churn —
three branches and three commits created only to be deleted — against a single bit of information.
That is a defensible trade for one session and not for five, so the count of times this has been
deferred matters more than the argument.

**What would make measuring it the wrong idea:** nothing, except the cost. There is no
lower-churn version — a hook that only prompts under a condition needs the condition.

**2. The push check greps the whole command text.** `branch-guard.sh` anchors its `gh pr merge`
check to command position, with a comment explaining that this is "the difference between guarding
the act and censoring the words". The push check three lines below has no such anchor: it matches
`git push` anywhere in the text and then a protected branch name anywhere in the text, so a commit
message that merely _discusses_ pushing to `main` is refused as though it were one. Measured three
times now, twice on this repository's own commits and again on 2026-09-18 — `git commit -m "docs:
explain why git push to main is refused"` is still denied by the running script.

**It has a second half, found on 2026-09-18 and worse than the first.** `isProtected` was written to
end exactly this class, replacing what it counted as three copies of the list, and its comment says
"One list: a name refused by one hatch and accepted by another is the hole this guard exists to
close." **There were four copies.** The push check keeps its own inline `(main|master|develop)`, and
`isProtected` also protects `release/*`, so `git push origin release/1.2` is allowed — measured,
silent, from a feature branch. The false positive is embarrassing; this one is a hole, and it is in
the check whose comment claims the holes are closed.

**Why it is a defect and not a rough edge.** `BUILDING.md` has the rule: a false positive is how a
guard earns the contempt that gets it turned off, and this one fires precisely when somebody is
writing about the guard. The fix is both halves at once — the `gh_at_command_position` anchor the
`gh pr merge` check already uses, and `isProtected` in place of the inline list — plus assertions in
both directions. **Half of that pair already exists for the other check and not for this one:**
`test-hooks.sh` asserts `git commit -m 'docs: explain why gh pr merge is refused'` is SILENT, and has
no such case for a commit message naming a push, nor any push case naming `release/*`. The merge
check is anchored _and_ pinned in the prose direction; the push check is neither, and the missing
tests are why neither half has ever been missed.

**What would make it the wrong change:** anchoring narrows the guard, and rule 2 is the one rule
where narrowing is the expensive direction. `git push` inside `sh -c '...'` is the case to hold
onto; the substring floor is what covers it today and the fix must not remove that.

### 31. A claim stranded by a signal is stranded for ever

**Branch:** none yet.

**What is not built.** Any way for a `agent:solving` label to come back on its own — a TTL, a lease,
a startup sweep, or a reconciliation of "a pull request exists" against "the ticket still says
solving".

**Why it is owed.** `architecture/invariants.md` invariant 14 rests entirely on a `finally`, which every
stack-skipping exit misses: `process.exit(130)` on a second signal (`createShutdown` in
`src/index.ts`), `process.exit(1)` on an uncaught exception (`logUnexpectedExits` there), `SIGKILL`,
a slept laptop. There is no TTL,
lease or reaper in `src/`. With `MAX_CONCURRENT_SOLVES=1` one stranded claim halts the solve half
indefinitely, and the repair is a human editing the label field by hand — the exact operation
invariant 11 exists to have eliminated. A second, narrower window has the same shape, in
`src/cli/solve-run.ts`: `keepClaim = await runPublish(...)` returns, and `moveLabels(client,
issueKey, reviewTransition)` on the next branch is what hands the claim to the review queue, so a
death between them leaves an open pull request on a ticket marked `agent:solving`, which neither the
solve queue nor the review queue selects. **This pair was cited as `:1168` and `:1181` in a file 1072
lines long** — the two coordinates rotted together, which is the failure mode that makes naming the
calls the cheaper form even when the line is right on the day.

**Why it was not done here.** Found while establishing the mechanism behind the daemon check in
`STARTING.md`, on a branch whose whole diff is prose and one read-only command. A reaper writes to Jira on a schedule, which is a new
privilege and wants its own phased branch.

**What would make it the wrong idea.** Anything time-based can reclaim a ticket from a solve that is
merely slow, which produces two solvers on one ticket — strictly worse than the wedge it fixes. The
PR-exists reconciliation has no such hazard and is probably the half to build first.

### 33. Declining one item of a ticket requires ending the whole run

**Branch:** none yet.

**What is not built.** Any outcome between accepting every item of a ticket and ending the run over
one of them. A nine-file ticket with one questionable line yields zero files.

**Why it is owed.** Every outcome available ends the run. `injectionNoticed` is required in
`RECON_SCHEMA`, `REVIEW_SCHEMA` and `MERGE_SCHEMA` and parsed by each pass's parser, but nothing in
the run acts on it; its one reader is `recon:once`'s report. A bail is decided in recon, which has no
`Write` and no `Edit` (`RECON_DENIED_TOOLS` in `solve/runner.ts`), so it ends the run before the fix
pass and the diff gate is never reached. `plannedPathRefusals` holds recon's planned files against
the path lists, but only to stop a plan that needs a refused path; what goes into the plan is still
judgement about scope alone. The fix pass's `abandoned` ends the run as well, over everything it was
handed. A bail or an abandon writes `agent:failed` and comments on the ticket, so the ticket waits
for a human rather than returning to the queue, and all of it is declined over one item. Sampled
judgement probes on SSX-3894 put the bail rate at 2 of 4.

What is missing is a per-item outcome: complete the in-scope work, leave the rest undone, and state
which items were left and why on both the pull request and the ticket.

**Why it was not done here.** `fix/scopewidening-support` shipped the two prose-and-check phases
this entry was opened with — the scope prose stating a size bound deleted on 2026-09-06, and the
`docs:check` check that now holds that prose against the gate in both directions. Those removed the
false bound the judgement was being exercised against. They do not give a pass anywhere to put a
partial result: this changes what a pass may return and how `delivery.ts` reports it, which is a
behavioural change wanting its own branch, and a better measurement than a four-sample probe.

**What would make it the wrong idea.** Replacing a clear stop with a partial result is only an
improvement if the reviewer can tell the difference; a pull request that omits part of its ticket
while reading as finished is worse than none — the same reasoning that has plan entries deleted
before the push. It depends on the declined item being reported prominently enough that a reviewer
acts on it, and that is a claim about human attention nothing here can test.

### 39. Nothing keeps the log after the run that wrote it, and nothing can attach to a daemon already running

**Branch:** none yet.

**What is not built.** A sink. `logger.ts` writes to stdout and stderr and nothing else: no file, no
rotation, no `LOG_FILE`. `pnpm logs` reads the stream it is handed, so reading a run afterwards
means having thought to capture it — `pnpm start:daemon > run.ndjson 2>&1` — before it started. A
daemon somebody started without that redirect cannot be observed at all beyond `daemon:status`,
which reads `ps`, and `pnpm start`'s viewer keeps nothing once it closes.

**Why it is owed, and why it was not done alongside the viewer.** These are one question asked
twice: both are answered by the daemon holding a descriptor somebody else can open later — a file,
or a socket. The socket is the larger of the two and the one with privilege in it, because a socket
a viewer can read is a socket a viewer can eventually write, which is what `feed.ts`'s unused
`send` slot is shaped for. That is a phase with its own blast radius and does not belong behind a
read-only viewer.

**Half of this was closed on the way to `pnpm start`, and the half that is left is the sink.** Two
fixes were possible here and they were never the same: an `EPIPE` handler makes losing the log
survivable, and a sink makes the log outlive the run. The first shipped as `src/broken-pipe.ts`,
because making the viewer the default reader turned "the daemon dies when its reader quits" from an
opt-in trap into the standard path — measured first: with the pipe closed under a reader that left,
the `finally` releasing `agent:solving` did not run. So the service no longer dies because nobody is
listening. **It still keeps nothing**, which is what this entry is now only about: quit the viewer
and the run is gone.

**What would make it the wrong idea:**

- **The file sink may be the whole feature, and the socket a thing nobody asks for.** The entry this
  one replaces predicted the opposite — that live filtering was the need and replay the hedge — and
  the way to find out is which of `README.md`'s two forms gets used: `pnpm start`, which shows the
  run and keeps nothing, or `pnpm start:daemon > run.ndjson 2>&1`, which keeps it and shows nothing.
  If it is the redirected one, build the sink and stop.
- **A log file is an artifact with a lifetime**, and nothing here has ever had to rotate, expire or
  bound one. The service writes JSON lines at a cycle's rate into a directory nobody sweeps; the
  first unattended week is what would find that out, and `state/` is the only precedent.
- **A control socket is a second way in.** Every privilege this service holds is reached through one
  composition today. A socket that accepts a command is a second, and it would need its refusals
  worked out before its conveniences, not after.

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
- **terminal** — a `MERGED` or `CLOSED` pull request must not produce another round.
- **label pairing** — moving `agent:done` without making `agent:reviewing` replace `agent:solving`
  must fail a test, and so must the reverse. Two mutations, because the half-changes fail in
  opposite directions and one test will only catch one.
- **sendback self-trigger** — the bot's own comment must not qualify as "the ticket changed".
  Invisible in review and obvious on the invoice.

## Out of scope

Auto-merge. Cross-repo _changes_ — reads landed 2026-09-07 and the two are not the same grant: recon
may read the other checkouts `SOLVE_READ_DIRS` names, and a write pass writes to one worktree, which
is now watched rather than merely asserted. Reopening `agent:done` tickets. Bot-noise tickets
(CVE/GHSA/SNYK/dependency bumps) as a class — intake discards their prefixes as a signal of who owns
a ticket and triages them like any other, with nothing aimed at them, although they are the most
agent-fixable class there is; worth revisiting once the pilot has a track record.

## Open, deliberately

`bugFastPath` (default OFF), a switch the intake skill plans and nothing here implements, is in
direct tension with this feature: it would short-circuit a `Feil` to a one-line note with no
scorecard — and therefore no dev lens and no fitness call. If it is ever built and switched on,
these two need reconciling.
Flagged, not solved.
