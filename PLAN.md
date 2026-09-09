# the-jira-police — bug-squashing agents

> **Progress, 2026-09-08.** Phases A through F are built. The service discovers a ticket, triages
> it, gates the result, posts a verdict, claims a solvable one, solves it in an isolated worktree,
> opens a pull request, answers the reviewer, keeps the branch current with its base, labels the
> ticket for whatever happened, and watches the ones it sent back for an answer. **2367 tests in 64
> files**, no build step.
>
> **It loops, and it claims.** `src/index.ts:247` is a `Promise.all` over three loops — grooming,
> review and watch — and the review loop advances _and then_ claims in one tick
> (`review-loop.ts:114`), gated only on `SOLVE_ENABLED`. Earlier revisions of this header said the
> solve half was "still a person typing a command" and that "nothing loops". Both were false, and
> they were the two most important facts in the file.
>
> **A human always merges. The bot has no merge path.**
>
> This file is now the _residue_: what is not built, what was learned at a cost worth not paying
> twice, and what no other file records. The built system is described in `ARCHITECTURE.md`; how to
> run it is in `README.md`. Anything that is finished has been deleted from here rather than struck
> through, because a plan that keeps its own history is a plan nobody can read the open items out of.

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

### 1. Which model runs which task, and nothing chooses today

Requested 2026-09-06, and **the first fact is that there is no setting to change.** `--model`
appears nowhere in this tree. Six task kinds spawn a subprocess — the triage analyst and the poster
(`triage/runner.ts`, `triage/poster.ts`), the solve passes (`solve/runner.ts`), and the ticket
commenter (`solve/commenter.ts`) — and every one of them inherits whatever `storecode` happens to
default to. Three argument builders, one flag each: the mechanism is trivial and the policy is the
whole of the work.

**Two changes, and only the second is the feature.** _Recording_ which model a pass ran under costs
nothing and should not wait for the choosing. Every cost figure in this file — triage $1.56, poster
$0.45, recon $1.58, the ticket comment $0.40, a review round $0.94 — is a measurement of an unnamed
model. None of them can be reproduced, compared, or defended, and the cost-per-ticket-per-day
number in §2 would inherit that at a larger scale and with nobody watching.

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

Three known inputs to it that are already measured or argued and have never been added up: the
chain rebuilds its worktree every round, so twenty rounds is twenty installs; the review tick
re-reads every open bot pull request, so per-tick work scales with _unmerged_ pull requests rather
than active ones; and a formatted approval costs one terminal round per pull request (§8).

### 3. The review round has no `verifyBase`

`verifyBase` is called from `solveTicket` and nowhere else, so `resolveReview`'s `failed` is not
relative to a base anyone proved green. On the solve path a red build before the change is
`unusable-base` and says so; on a review round the same redness is attributed to the round. Now
that the base is merged in every round, a base that is broken upstream lands in the branch and the
round takes the blame for it. Recorded, not fixed.

### 4. Attachment bytes, and the decision that is the operator's rather than mine

The watch check is handed attachments as **names, types and sizes only**: no bytes are fetched, and
the copy in `signals.ts` is field by field so the day that changes it is a visible edit rather than
a widening arriving by inheritance. `MAX_CONTEXT_ATTACHMENTS` is 20 and `MAX_FIELD_CHARS` is 4000 —
generous, because an answer is usually appended to an already-long description — with the
truncation notice **outside** the fence, beside the omitted-comments notice and for the same reason.
All three bounds exist because this is attacker-controlled text going into a prompt.

**The open question is whether fetching the bytes is authorised**, and it is not mine to answer.
The Jira REST credential is **no longer discovery-only**, and that matters for how this question is
framed. It writes `agent:*` labels through `updateLabels` — REST, atomic `update.labels` add/remove,
wired into the claim (`wiring.ts:545`), the retriage counter, `end.ts` and `retriage.ts` — because
MCP's `editJiraIssue` has set semantics and cannot add one label without rewriting all of them. So
the rule is not a wall, it is an amendment process: `updateLabels`, the changelog
read, and adding `summary,description,environment,attachment` to `fetchActivity`'s GET were each
authorised individually. Attachment _content_ is a further widening and a new untrusted-bytes path.
It is also the thing that would close the SSX-3822 class of failure, where a ticket names an asset
the solver cannot fetch and the solver reconstructs a lookalike from the description's adjective
(§9). Not to be widened without being asked.

### 5. The wiring that has no test, now with three callers waiting on it

Measured, not assumed: putting the wrong predicate back at `runWriteRungs`'s call site leaves the
whole suite green, because nothing constructs its dependencies. **`runWatch`, `runReviewSweep` and
the two halves it builds are in the same position**, and the gap now covers a refusal rather than
only a predicate: the `SOLVE_ENABLED` guard that stops `--watch` reporting an empty watched set as
_nothing is under review_ has no test that fails when it is unplugged. Everything decidable was
pushed into pure functions that do — `describeReviewSweep`, `endedState`, `completionLabelFor`, the
parser, `createReviewCycleDeps` — which narrows the untested part to the wiring and does not close
it.

**The daemon's own wiring took the same treatment rather than joining the gap**, 2026-09-06: every
decision E adds lives in `createReviewLoop`, which is a module and not `index.ts`, so all six of
them have tests that fail when unplugged. What is still untested is `runReviewSweep`'s new `signal`
parameter — nothing constructs its dependencies, which is this bullet, one level down.

Two more callers sit on the same hole. `watch-once.ts` ends in a top-level `await`, so the loop
that chooses `runRetriage` over `endWatch` has no test; everything either side of it is covered —
`describeRetriage` in `watch-args.test.ts`, the engine in `retriage.test.ts` — and the wiring
between them is not. And `runSolveClaims`'s own body — that the ledger is read before the claim
rather than after the outcome, that a thrown ticket does not abandon the queue, that the exit code
is restored — is covered by argument and by the ledger's unit tests, not by a test of the call
site. D4e measured this hole and called it _"the clearest argument yet for a test harness before
E"_. E is here and it did not grow one.

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

**What is still owed is a consumer**, and `sessionDenials` at `triage/session.ts:357` currently has
none. A fix pass that abandons for `judgement` while the harness watched its `Write` be vetoed is
reporting `environment`, whatever it says, and wiring that means widening `PassRunner.run`.

### 7. A transient/deterministic split, and the half of the attempt count that did not ship

`refused` and `failed` still release, so a ticket whose diff the harness would not judge can be
spent on repeatedly. The **ledger shipped** — `AttemptLedger` and `MAX_SOLVE_ATTEMPTS_PER_TICKET`
bound it per ticket, in memory, which is the right trade because losing the poll cursor causes a
double claim and losing this causes one extra attempt. **The split did not.** A solve that fails
deterministically should stop being attempted, not be attempted more slowly, and nothing yet tells
the two apart. This is also the only answer to D4e's stacking problem, where a re-claimed ticket is
re-commented nightly.

### 8. Four findings from the SSX-3834 run, three of them still open

- **`poller.ts:340` logs `"dry run — no label was written"` immediately before writing labels.** True
  while `solve:once` was the only caller; false the moment `runSolveClaims` became the second, which
  is every daemon claim. This file's subject, in this repository's own poller, found by reading the
  log of the run that first made it false.
- **Branch slugs drop `ø` and `å` rather than transliterating.** "Beløp på" became `bel-p-p-`
  (`worktree.ts:150-158`). On a Norwegian board that is every branch the bot will ever cut.
- **The review tick re-reads every open bot pull request.** Four here; three (`#2660`, `#1413`,
  `#2661`) returned `threads: 0` and exist only because nobody has merged them. Per-tick work scales
  with _unmerged_ pull requests, not active ones — an argument for merging promptly, and a second
  input to the cost number.
- **A formatted approval costs one terminal round per pull request.** Copilot's approval is a
  non-empty body with review `state: "COMMENTED"`, never `"APPROVED"`, so the general discriminator
  is unusable for this reviewer. `delivery.ts:858` reads a non-empty comment list as actionable,
  reserves a round, and pays for a pass whose input is "looks good". It is bounded — the round
  changes nothing, so the no-change rule undrafts. The cheap fix is unavailable for the reason the
  `Suppressed comments` block was left unparsed: an approval and a summary-only review carrying real
  feedback (#1413 exactly) are indistinguishable on the wire without reading the prose, and reading
  the prose is what the paid pass is for.

### 9. The fail-first check cannot answer a question about CI

The probe is cut on the machine the harness runs on and inherits its environment. A test whose
vacuity is environment-dependent — one reading `ZoneId.systemDefault()`, say — gets opposite
verdicts on a UTC runner and a developer's laptop. **A probe that inherits the operator's
environment cannot answer a question about CI's.**

### 10. Still unobserved

- **The mixed-batch rule.** No round has yet read a human and a reviewer comment in the same batch.
  Both origins have been driven individually and the `some` → `every` mutation is caught, so this is
  a live-run gap rather than a coverage one.
- **The `MERGED → agent:done` arrow**, which needs a human to merge.

### 11. Loose ends recorded in no other file

Four things that exist in neither `ARCHITECTURE.md`, `README.md` nor the source, and were being kept
alive only by being carried forward in conversation.

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
- **The triage poster has the commenter's read-tool defect, and has had it longer.** Its header says
  it is not given the vault, Confluence, `Grep`, `Glob` or `search`, and that it has "no filesystem".
  `POSTER_DENIED_TOOLS` is `DENIED_BUILTIN_TOOLS` plus two Atlassian mutators — **no `Read`, no
  `Grep`, no `Glob`, no `Task`**. Both sentences describe `POSTER_TOOLS`, which the 2026-09-04 probe
  established denies nothing. The fix is the one applied to the commenter, and it is _more_ urgent by
  exposure: the poster runs on every triage, the commenter only on a terminal outcome. **The analyst
  cannot take the same fix** — reading the vault is its job — so its own header should be checked
  against the same question rather than assumed clean.
- **`dev-lens.md` holds a calibration row scoring the SSX-3801 fix as failed.** That fix passed 4562
  tests; the build never compiled it, for the `git-commit-id` reason since fixed. The row is bad
  evidence feeding the fitness assessment and should be corrected, not deleted.
- **Stale Jira comments that no MCP tool can delete.** One stale triage comment on SSX-3822, plus the
  two Automation for Jira comments that caused the wrong fitness call in §9's story. `addCommentToJiraIssue`
  takes a `commentId` and updates in place, so _our own_ comment can be rewritten — but deletion is
  unavailable, and the automation comments are not ours. A board this service can be blocked by and
  cannot unblock is a fact about the tool surface that the daemon should be known to have.

### 12. The development guardrails are built, and registering them is not this repository's to do

Requested 2026-09-08, from a question worth restating because it is the one this whole item answers:
_how do we make sure the agent follows the house rules the moment it steps into this project?_ Until
now the answer was that nothing did. The rules existed in a skill that is **model-invoked**, so
whether they were read depended on whether the model chose to read them, and the case where that is
least likely — a narrow prompt late in a long session — is the case where they matter most.

**Built, on `chore/agent-guardrails`:** `CLAUDE.md`, which auto-loads every session and carries the
two non-negotiable rules and the pointer to the working contract; `.claude/hooks/branch-guard.sh`
(deny writes and pushes on a protected branch, and deny `gh pr merge` from any branch),
`branch-stack.sh` (ask a human when the stack is deep), `session-brief.sh` (state the contract and
the repository's shape at session start, including after a compaction), `lib.sh`, and
`test-hooks.sh` — 74 assertions behind `pnpm test:hooks`; eleven mutations watched to fail when it
was first written, five more when rule 2 was guarded.

**Registration is not in this repository, and that is the arrangement rather than a gap.** Hook
configuration belongs to the operator and is held outside this tree; the environment refuses the
agent both read and write access to it, which is the correct way round — anything that could
register the guards that constrain it could also unregister them. So no commit here makes a guard
fire, and no commit here can report whether one does. **Behave as though they are unregistered**:
the two rules in `CLAUDE.md` bind on their own authority, never on a guard's. What was once filed
here as pending work is closed as out of scope, and the prose that described it as pending has been
corrected.

**Which leaves the one thing genuinely open: nothing in this tree can verify enforcement.** Claude
Code snapshots hook configuration at session start, so the check must be run by a person in a
_fresh_ session:

```
git switch -c test/wiring-probe   # expect a prompt if the stack is deep (branch-stack)
git switch main                   # then ask the agent to edit any file
                                  # expect a refusal naming 'main' (branch-guard)
```

If the first is silent in a fresh session, the configuration is not being read at all and nothing
else is worth testing. **`pnpm test:hooks` proves the scripts; only that probe proves the
enforcement**, and the distinction is the same one BUILDING.md draws about a guard that looks
installed. Note how narrow the first half was until recently: those assertions borrowed the
developer's git identity, so they passed on one laptop and could not run anywhere else at all. CI
caught it the first time it ran them, which was `1e64ed4` — the commit that added the CI step.

One thing deliberately not built, because it was offered and declined: a `Stop` hook gating a turn
on verification. Recorded so that "we considered it" survives the session that considered it.

A general drift reporter comparing prose against code was declined here too, and **the narrow half
of it shipped anyway** on 2026-09-08 as `pnpm docs:check`. The distinction is worth keeping: what
was declined was a reporter that judges whether prose is _true_, which is a model call on every
document; what was built checks the handful of prose facts that are _countable_, which is a regex
and an exit code. The rest is still declined.

**A fourth guardrail shipped on 2026-09-09, and it does not guard the code.** CI's `Rules owed` step
fails a pull request whose body does not answer `FINISHING.md`'s fourth question. It is the only
check in that workflow with no hand-run equivalent, because what it reads is the pull request body
rather than the tree, and it is worth being exact about how little it proves: **it cannot tell a
true `Rules owed: none` from a false one.** It guarantees the question was answered. Everything
above it in this section guards the repository; this one guards a habit, and a habit that had failed
four times in two sessions before anyone noticed.

**Its disposal condition, written while it is still new.** If the fresh-context audit that produces
that line ever returns `none` on a diff that plainly owes something, the step is worse than nothing —
it will have made an unexamined omission _look_ examined — and it should be deleted rather than
tuned. A rule with a stated way to die is one somebody can actually retire.

Three more declined on the same day, recorded so they are not re-argued. **A rule making a blocked
command an incident to write up**: rejected because "record what it taught you before you re-attempt
or reword" reads as blessing the reword, and a rule that can be read as permission will be. **A
`docs:check` rule failing a bare SHA cited without an incident anchor**, and **a CI check requiring
"What was learned" to grow whenever a numbered entry is deleted**: both would have caught a real
defect from this session, and both are mechanism ahead of evidence at one instance each. The second
is the more tempting and the more dangerous — it would fire on every ordinary deletion.

---

### 13. What an audit of the house rules against the tree left open

Run 2026-09-08 against the rules on this branch, by spot-check rather than by reading: drive every
command, then test each falsifiable claim the rules make about the repository. **Eight findings;
six held, one was wrong, one was overstated in a way that would have destroyed evidence.** Both
failures are recorded below, because the way they were reached is more useful than the findings.

**What the audit confirmed first**, so the defects are read in proportion: all five checks green;
plan-before-work followed in `af61f41`/`1e64ed4` with the entry written and then deleted; every
symbol `BUILDING.md` names present, including `FAIL_FIRST_CHECK`'s `!== "false"` asymmetry; the
literal-list rule derived at the sites it names; six entry points exactly. Of eighteen incidents
sampled, thirteen trace to a SHA whose diff or message carries the incident's own details, and **no
claimed defect turned out never to have existed.**

The three defects that were only prose have been corrected on this branch, which is why they are no
longer listed here: the four sentences claiming a mechanical guarantee, the module map's test-file
count, and two citations that named the wrong document. What is below is what a document edit could
not reach.

**Open, and not this branch's job:**

- **The count class, not the instance.** A fourth `FACT` now pins the bare-count phrasing, but that
  is one site, not the class. Measured across tracked markdown on 2026-09-08 — a number followed by
  up to two words and a count noun — there are **17 distinct such phrases against 4 declared
  sites**, and the next new phrasing drifts exactly as the module map's did.
  Two things learned while pinning it argue for the class fix rather than more instances. First,
  provenance: `96998cc` wrote 65 and 64 **in the same commit**, and its message claims _"that count
  is cited as fact in two documents and was updated in both."_ The contradiction was born
  complete-looking; it never drifted, so no amount of watching-for-drift would have caught it.
  Second, the new `FACT` failed on its first run against **this entry**, which was describing the
  wrong count rather than asserting it — prose about a number and prose claiming one are
  indistinguishable to a regex, and here the call was made by rewording. The class fix is
  `expectSites` one level up: every count-noun phrase must be either a declared site or an
  explicitly listed historical figure, which forces that current-versus-war-story call to be written
  down instead of made silently. §12's hook-assertion count is current and uncited — and duly went
  stale within a day of being named here, twice; `ARCHITECTURE.md:1863`'s "1245 passing tests" is
  history.
- **`docs-check.ts` has no test.** 331 lines enforcing prose discipline, and `PROVING.md`'s central
  rule is not satisfied for it. The class check above is not hand-watchable, so these two are one
  unit: whoever writes the class check writes `docs-check.test.ts` with it.
- **`docs:check` is narrower than three documents claim.** Only `.md`-suffixed links; `CLAUDE.md`'s
  own routing table is backticks, so deleting a phase file keeps it green; the repository's real
  cross-reference system — **87 `§N`/`invariant N` references** — is unchecked entirely.
- **Cost figures are facts with many homes.** `$0.94` in five files, `$0.11` in five, `$3.99` in
  three, `$4.50` in three, outside the `docs:check` exemption rule 3 grants.
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
- **Nothing here can be watched working.** Registration is the operator's and outside this tree
  (§12), so every guard in it is built inert; the whole of the evidence is `pnpm test:hooks` and
  hand-fed payloads, never an observed refusal.

**A checklist item that cannot be satisfied by the check a reader would reach for.** _"Any merged
branch deleted, including the local ref"_ — the mechanical way to find one is `git branch --merged`,
which is **blind to every squash- and rebase-merged branch**. `chore/agent-guardrails` has an
identical patch-id and tree to `6a8cba7` and `--merged` cannot see it, so it needs `-D`. That is how
these accumulate, and it is one instance of a possible rule rather than a rule.

**Four method failures, recorded and deliberately not generalised** — each is one instance, and
each is a defect this repository already has an incident for, committed while auditing for it:

- **A search that confirms.** `grep -c STATE_PATH` returned 1, which is what a setting documented in
  a shared row looks like, and it was read as a missing row because a finding had predicted one.
  Row-counting also assumed one setting per row. Deriving the answer — iterate `SETTINGS`, check
  each name — gives 46 of 46 present. `STARTING.md`'s "finding something adjacent and believing it".
- **A number that invited an inference about what it controls.** `git rev-list --count main..HEAD`
  is 3 and `branch-stack.sh`'s threshold is 3, so the hook was said to be at its limit. It counts
  unmerged branches into `origin/main` — currently **one**. The `capacity: 0` incident exactly.
- **An adversarial subagent returns what it was primed for.** The prompt offered `SUSPECTED
RETROFIT` as a verdict and named an untraceable commit as evidence of it; the report came back
  alleging invention, and it was relayed at full strength. The evidence supported "not in
  `PLAN.md`". `STARTING.md` already covers this — _delegate breadth, keep depth_ — and depth was
  delegated on the two sharpest accusations.
- **A line number read without its context**, and the only one of the four that reached `main`. It
  is therefore the only one that outlives this entry: the record is under
  [what was learned](#a-citation-can-be-exact-and-still-be-read-wrongly-and-that-one-shipped), so
  that deleting §13 does not delete a correction to something shipped.

**What would make this the wrong idea.** Two things. The prose corrections that already shipped
read, at a glance, as weakening the rules — they are not: _never work on `main`_ and _a human
merges_ stay absolute, and only the claim about what enforces them changed. The honest objection was
that if wiring the hooks were imminent, those edits would be churn; the counter is that the prose had
been false for as long as it had existed, and a rule that overstates its own enforcement teaches a
reader to stop checking the other ones. For what remains: every item above is a check on documents,
and this repository's own evidence is that checks on documents catch less than driving a command
does. If the next session has budget for exactly one of these, the guard hardening is worth more than
the whole `docs:check` list, and the wiring is worth more than the guards.

---

## What was learned, and is recorded nowhere else

### A citation can be exact and still be read wrongly, and that one shipped

Rescued from §13's method failures, which are deleted when that entry closes. This one survives
because it is the only one of the four that reached `main`, and a correction to something shipped
must outlive the audit that found it.

The claim was that `test-hooks.sh:93` **asserted** the bare-push hole, by listing a push among the
commands that must stay silent. It does not. Twelve lines above it the fixture switches to
`feat/ordinary`, where allowing a push is correct and the assertion says so. The hole was never
asserted or denied — it was simply that no case exercised a protected branch.

Shipped to `main` in `e9483c1`, corrected the next day in `a94c005`, and found by **running the
guard rather than re-reading the file**.

**What it sharpens.** `STARTING.md` says _cite `file:line`, never a recollection_, and the failure
here is that rule's other direction: the citation was exact, and the reading of it was wrong. A
precise line number is evidence about **one line** and carries no information about the twelve above
it that set up the state it runs in — while looking, in a report, exactly like a verified claim. The
rule as written defends against vagueness; it says nothing about a precise reference read without
its context, which is the more convincing of the two failures.

One instance, so it stays here rather than becoming a rule. The second instance would earn an
amendment to that bullet in `STARTING.md`.

### The war stories are the asset, and length pressure comes for them first

From the 2026-09-02 survey that produced the phased house rules. Two numbers, and they point in
opposite directions:

- Vendor guidance is **`CLAUDE.md` under 200 lines and a skill body under 500**. `SKILL.md` was
  **884**, with the finishing checklist — the most-used thing in it — behind eight hundred lines of
  argument.
- Of **257 rule files sampled across the popular collections, four contain the word "because"**.

So the obvious response to the first number is to cut the reasoning, and the second number says the
reasoning is the only genuinely differentiated thing here. They move; they do not shrink. That is
why `INCIDENTS.md` exists and why it is append-only and off the reading path — and why
`pnpm docs:check` verifies the links into it, since a rule that loses its link to an incident has
quietly become an opinion.

The layout decision is worth keeping too: the phase files are **flat siblings** of `SKILL.md`, not a
`references/` subdirectory, because `intake-triage/` and `agent-solve/` are already flat and a
layout used by one skill in three is a layout somebody has to learn.

### Two redundant guards, each making the other untestable, with the suite reporting green

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

### A fixture that models another module's output is a test that cannot see that module change

Every fixture in `src/watch/` builds its own comments, so the poster's idempotency was a fact about
a different module that this module's tests quietly assumed away. After `client.test.ts`'s
hand-copied label list and `solve-args.test.ts`'s hand-copied rung list, that is the third instance
and now a rule.

### SSX-3830, the first live watch run — and the calibration question was masked by the population it was asked about

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

### The whole chain, unattended, on SSX-3834 — and the ticket was written to fail first

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

### The daemon's review loop, verified live at zero cost

`SOLVE_ENABLED=false … --for 6s` logged `review.loop.disabled` and stopped with
`reviewCycles: "off"`. Then `SOLVE_ENABLED=true MAX_REVIEW_ROUNDS_PER_TICK=0 … --for 60s` logged
`review.loop.start {intervalMs: 120000, maxRoundsPerTick: 0, worstCasePerTickUsd: 0}`, ran the
review JQL, and returned
`review.cycle {watched: 3, acted: [], settled: 2, ended: [], unlooked: 0, deferred: 1}` in 6.2
seconds. Both runs used a throwaway `STATE_PATH` and `--skill mock-triage`, so the real cursor was
untouched and nothing was posted. **`deferred: 1` is the interesting number:** with the per-tick
bound at zero, it means there is real actionable review work on the board that a daemon with the
bound at its default would have paid for on its first tick.

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
- **terminal** — a `MERGED` or `CLOSED` pull request must not produce another round.
- **label pairing** — moving `agent:done` without making `agent:reviewing` replace `agent:solving`
  must fail a test, and so must the reverse. Two mutations, because the half-changes fail in
  opposite directions and one test will only catch one.
- **sendback self-trigger** — the bot's own comment must not qualify as "the ticket changed".
  Invisible in review and obvious on the invoice.

## Out of scope

Auto-merge. Multi-repo. Cross-repo _changes_ — reads landed 2026-09-07 and the two are not the same
grant: a pass may read every checkout on the machine and may write to one worktree, which is now
watched rather than merely asserted. Reopening `agent:done` tickets. Bot-noise tickets
(CVE/GHSA/SNYK/dependency bumps) — currently discarded at intake, and the most agent-fixable class
there is, so worth revisiting once the pilot has a track record.

## Open, deliberately

`bugFastPath` (default OFF) is the existing hook for bug-specific behaviour and is in direct
tension with this feature: it short-circuits a `Feil` to a one-line note with no scorecard — and
therefore no dev lens and no fitness call. If it is ever switched on, these two need reconciling.
Flagged, not solved.
