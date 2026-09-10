# Incidents

**The evidence base for the house rules.** Nothing in those rules was designed against a theory;
every entry here is something that got through, and the rules that cite one are the generalisation
of it. Not every rule cites one — 42 of the 71 bold paragraphs in the four phase files name no
incident, and a good share of those are section prose rather than rules — so the honest claim is the
narrow one: where a rule names its evidence, the evidence is here, and `pnpm docs:check` fails if the
link stops resolving.

**Both directions are written, and only one of them is complete.** `STARTING.md`, `BUILDING.md`,
`PROVING.md` and `FINISHING.md` cite this file from the rule an incident produced — 39 of the 44
entries below are cited that way, and the other five each say in their own text that no rule has been
written yet. 28 entries also link the other way, from `**The rule**` at the end of the entry, so that
[a rule being deleted](FINISHING.md#keeping-it-honest-as-it-grows) can be checked against what it
rested on. Nothing needs to read this file top to bottom, and it is not on the path of doing any
work.

**Why the stories and not just the rules, measured.** Of **257 rule files sampled across the
popular collections on 2026-09-02, four contain the word "because"**. The reasoning is the only
genuinely differentiated thing in this corpus — and it is the first thing length pressure comes for,
because vendor guidance puts `CLAUDE.md` under 200 lines and a skill body under 500 while `SKILL.md`
stood at 884. So the war stories **move**; they do not shrink. That is what this file is: off the
reading path, unbudgeted, and linked from the rules so that
[a rule being deleted](FINISHING.md#keeping-it-honest-as-it-grows) can be checked against what it
rested on.

**Append-only, and dated.** New incidents go at the bottom. An entry is never edited to make its
conclusion look better; if a later run refutes it, that is a new entry, because a corrected story
loses the thing that made it worth keeping. Entries are removed only when the subsystem they
describe is gone.

**New entries carry a `**Found by**` line — what caught it, not what caused it.** One line naming
the mechanism, sitting immediately above `**The rule**` so the entry closes on what to do rather
than on how it turned up. It is the only field here that is not about the defect, and it exists
because the rules are amended from this file: without it there is no evidence for which practice is
productive, and so none for which guard to build next. `not recorded` is a legitimate answer, and so
are "a human noticed" and "it turned up while reading for something else" — those are the most
valuable ones it can carry, because they say the mechanisms did not fire.

**Most entries below do not have it, and that is deliberate.** The field landed on 2026-09-09 with
most of this file already written, and none of it was backfilled: the older stories are
unrecoverable without invention, and an invented provenance would corrupt the one measurement the
field exists to take. Plenty of them name what caught them anyway, in a sentence shaped some other
way — "The first machine that ever ran it without one was CI", "A human asked, twice". So the field
makes the answer countable rather than making it exist, and the tally is not worth reading until the
file has turned over.

**Some sources sit outside this tree, and must say so.** Several entries quote plan-mode planning
documents written before a phase: not `PLAN.md`, not in the repository, and `pnpm docs:check`
structurally cannot tell such a citation from one that resolves. An unverifiable citation that
announces itself is a known gap; one that reads like every other citation is a silent one, which is
this file's own subject applied to itself.
[`capacity: 0`](#the-capacity-number-that-was-read-for-two-days-as-a-blocker) and
[D4a](#the-three-phases-stacked-on-one-branch) said "the plan" and were read as meaning `PLAN.md`,
where neither string has ever appeared; corrected 2026-09-08 by naming the source, which is a
pointer being fixed rather than a story being softened.

---

## 2026-09-03

### The JQL clause that excludes on absence

`labels NOT IN (...)` excludes issues whose `labels` field is empty, which is a documented Jira
behaviour and reads like folklore until it is measured. It was measured on this board, with a
control group in the same query:

```
labels IS EMPTY                                    → 57 issues
labels IS EMPTY AND labels NOT IN (the three)      →  0 issues   ← excludes on absence
labels = "triaged"                                 → 46 issues
labels = "triaged" AND labels NOT IN (the three)   → 46 issues   ← no over-exclusion
labels = "triaged" AND labels NOT IN ("triaged")   →  0 issues   ← excludes on presence
```

The gotcha is real here, and the positive `labels = "agent:solvable"` clause in the queue is
therefore load-bearing rather than redundant — a future rewrite deleting it as tautological would
silently empty the queue. Recorded in the `jql.ts` doc comment with these numbers.

The control is the part worth copying. Rows two and four differ by nothing but the field being
empty; without row four a reader cannot tell over-exclusion from a query that matches nothing.

**The rule** — [Probe with a control](PROVING.md#measure-do-not-assume-and-the-assumption-is-usually-about-your-own-code).

---

## 2026-09-04

### The allowlist that restricted nothing

`--allowedTools` was believed to restrict the model's tool surface. It does not. It is an
auto-approve list: naming a tool pre-approves it, and omitting a tool does nothing at all. Four
probes, each narrowing an alternative explanation:

```
dontAsk + --allowedTools "Bash(git status:*)"  → scoped AND unscoped git commands both ran
dontAsk + --allowedTools "Read"                → Bash ran
--allowedTools "Read", no --permission-mode    → Bash ran
the same, run from /tmp rather than this repo  → Bash ran   (rules out repo settings.json)
```

The consequence was not confined to one phase. **Every triage run this service had ever made had
`Bash`, `Write` and `Edit` available**, while three comments in `runner.ts` and one in `poster.ts`
asserted that the allowlist was preventing exactly that. Fixed by adding `--disallowedTools`, which
does restrict properly — the tool never enters the model's list, so there is no call to permit.

**A qualifier was added 2026-09-05 and it matters.** A commenter run got
`mcp__atlassian__getAccessibleAtlassianResources was denied by don't-ask mode` from a session whose
`--allowedTools` named a different Atlassian tool, while `Read`, `Grep` and `Glob` stayed available
to the same session. So the allowlist **does** gate MCP names under `--permission-mode dontAsk` and
does not gate builtins: two rules for two kinds of tool. Read the 2026-09-04 finding as being about
builtins only.

**The rules** — [Measure, do not assume](PROVING.md#measure-do-not-assume-and-the-assumption-is-usually-about-your-own-code);
[capability is a question about the composition](STARTING.md#technique).

---

## 2026-09-05

### The ticket that cost fourteen times its estimate

A triage run had been quoted at **$0.11** throughout the plan, and every projection resting on it —
including the argument for a re-triage cap — inherited the figure. One real invoice, for SSX-3831:
triage **$1.56**, poster $0.45, recon $1.58, comment $0.40. **$3.99 for a single ticket that was
declined without a line of code being written.**

The direction is the uncomfortable part. $3.99 is the *cheap* path: a bail stops before the write
pass, before push, before any review round. A review round measured $0.94, and a pull request has
several.

**The rule** — [Measure, do not assume](PROVING.md#measure-do-not-assume-and-the-assumption-is-usually-about-your-own-code);
[the economics of a command](PROVING.md#the-economics-measured-on-this-project).

### The round that refuted its own cost estimate

An extra review round was argued to cost about $0.60, and that number was written down as the reason
to undraft one round earlier. The run meant to confirm it measured **$0**, in 2.5 seconds: `ready`
is decided before the pass runs, from the size of the inbox, so a tick that finds nothing never
reaches the model.

The estimate was wrong and the conclusion survived it for a better reason — the delay is
_unbounded_, so on a pull request people are still commenting on, the draft flag never clears and a
human reviews something whose own flag says it is unfinished. A correctness argument replaced a cost
argument that had been invented to support a decision already made.

It counted as a finding only because the guess had been written down first.

**The rule** — [Predict before step 3, in writing](PROVING.md#step-5-is-where-it-compounds).

### The unref that killed the only loop whose job is waiting

`sleep` called `.unref()`, so the poll timer did not hold the event loop open. The first time the
review chain found the reviewer silent it printed _"waiting 120s (1/10)"_ and Node exited
immediately with `Detected unsettled top-level await`, code 13. **One loop in this service waits,
and the single line doing the waiting had opted out of waiting.** Every test was green.

The unref bought nothing. Its comment justified itself by Ctrl-C — _"a Ctrl-C during the two-minute
wait should end the process, not be queued behind the timer"_ — and SIGINT terminates a process
whatever timers are pending. A `setTimeout` never queues ahead of a signal. The argument was for a
problem that does not exist and it cost the feature.

**The banner one line above it is the more interesting half.** `runReviewChain` prints _"Ctrl-C is
safe: nothing is held open between rounds"_, which reads as a description of the unref and is not.
What makes an interrupt safe there is that the worktree is removed and no lock is held between
rounds — both true, both unrelated to the timer. The unref was deleted as a bug and the sentence
stayed correct, still reading as coverage of the mechanism that had just been removed.

**The test has to be a child process.** A unit test cannot observe _the event loop stayed alive_
from inside a runner that is itself holding the loop open; Vitest's own timers keep the process up
whatever `sleep` does, and an in-process assertion passes against both versions. So the test runs a
program: import `sleep`, await it, print the elapsed time. Restore the unref and the child prints
nothing and exits 13, which is the second assertion, because that exit code is what a future reader
will search for.

**The rules** — [true of behaviour it was not describing](BUILDING.md#the-defect-class);
[some properties belong to a program](PROVING.md#a-guard-is-not-shipped-until-a-test-fails-when-it-is-unplugged);
[the suite said green](PROVING.md#the-tests-did-not-catch-the-interesting-bugs-running-it-did).

### The worktree reuse that every real run needs and the code refused

`attachWorktree` went straight to `worktree add --track -b` and refused a collision as _"a leftover
from an earlier run"_. That was wrong about the ordinary case: publishing **keeps** its worktree so a
human can read the diff, and `git worktree remove` never deletes a branch, so every successful
`--pr` leaves a clean checkout of the right branch at exactly the path a review round wants — and
the review round refused it. On the machine that opened the pull request, which is every hand-driven
run, attaching could not succeed once.

Green suite. Found by the first `--advance` against a real pull request.

It now reuses that checkout after proving it is on the expected branch, clean, and not ahead of
`origin`, fast-forwarding if behind, and refuses otherwise. `-B`, `reset --hard` and `add --force`
were all rejected because nothing may be discarded silently.

**The rule** — [running it is how you find out what you did not know](PROVING.md#the-tests-did-not-catch-the-interesting-bugs-running-it-did);
[resumable from what the last run left behind](PROVING.md#the-rules-that-make-a-command-worth-having).

### The hook that vetoed Write, silently

A local `PreToolUse` policy hook — one this harness never sees, belonging to the operator rather
than to the service — denied the write pass its `Write` tool. `runner.ts` reasons entirely about
`--allowedTools` and `--disallowedTools` and concludes the solver has `Write`; a hook vetoes per
call, ahead of permission resolution, so no permission mode the harness can pass evades it.

Two things make it worse than a missing capability. It is **content-based rather than path-based** —
the same denial reproduced from an unrelated directory on an unrelated repository with the same file
content — so it fires on what the solver is trying to write, unpredictably from the harness's side.
And it degraded a **read** tool in the same session before any write was attempted, which is the
quieter half: a pass that cannot `Grep` produces a worse answer rather than an error.

**What it left behind is the reason this is an incident and not a footnote.** The run had claimed
the ticket, written fifteen labels, cut a worktree, verified the base green on all four steps, and
paid for triage, recon and a fix pass — roughly **$4.50**. Then it released every label byte for
byte and posted nothing, because an `environment` abandon writes no terminal label. **The board was
identical to a ticket nobody had ever picked up**, and the only record was a terminal that had
scrolled.

The fix was not a new source of truth. Every withheld comment body already existed and its wording
was already pinned by tests; only the caller withheld them. `reportsToTicket` asks _did this run
spend a claim_, which is a different question from _is this ticket's fate decided_, and fusing the
two is what made the denial invisible.

**The rules** — [a gap in the record is indistinguishable from the tool being switched
off](BUILDING.md#instrument-the-failure-path-first);
[two questions that agree today](BUILDING.md#two-questions-that-agree-today-are-still-two-questions).

### The laptop that slept mid-pass

A recon pass was killed at `SOLVE_TIMEOUT_MS` because the machine slept for most of the thirty
minutes. The pass had done nothing wrong and the budget was never spent on it. What it left behind
was a timeout kill and a worktree kept as evidence of nothing; the retry cost the whole pass.

Hand-driven runs work around this with `caffeinate`, which is a person deciding to stay awake for
one run. A daemon has no such person, and the failure direction is the expensive one — a killed pass
is deliberately not retried, so every overnight sleep silently converts a claimed ticket into an
abandoned one.

It is also the clearest case for the failure-kind split: _the environment is broken_ must not be
collapsed into _this ticket cannot be solved_, because the second writes a terminal label a human
then has to clear because a laptop went to sleep.

**The rule** — [say which kind of failure it is](BUILDING.md#instrument-the-failure-path-first).

### The bail terminal with no writer

`agent:failed` had a definition, an entry in the queue-exclusion list, an entry in the outcome
labels, a transition function and passing tests. `completionTransition(labels, "failed")` was
reachable from one call site, which passed `"done"` or `"closed"`. **Nothing ever called the branch
that wrote it.**

So the first recon bail this service produced — a pass that read the code, found the ticket
underspecified in three named ways, and declined — released the ticket byte for byte. The release
log showed all fourteen labels back, `agent:solvable` among them. **A ticket the agent had examined
and declined read exactly like a ticket nobody had tried.**

The consequence divides on mode, and the division is why this was a blocker rather than a defect.
Manual mode survives it: re-claiming needs a human label, so a human is in the loop on every repeat.
Auto mode does not — the queue asks for `agent:solvable` and an issue type, nothing else, so a
bailed ticket is re-claimed next tick, pays for triage and recon, bails identically, releases, and
repeats, **with no condition in existence that could ever clear it**.

That is not clutter. It is a production hole wearing the costume of a finished feature, and the
tests were part of the costume.

**The rule** — [built but never wired is a bug](BUILDING.md#an-unreferenced-symbol-is-a-question-and-the-answer-decides-the-action).

### The bail that arrived as four thousand characters

The first bail to reach a ticket landed as roughly four thousand characters with no line break in
it. Every word was right; nobody was going to read it.

Two separate causes, and fixing either alone would have failed. `bailReason` was **one schema field
asked for two different things** — the diagnosis _and_ what would make the ticket solvable — so the
model had nowhere to put them but one string. And `safeText` collapses every whitespace run to a
space, which must stay, because structure this service did not create is structure an editable Jira
ticket could forge.

So the fix was to split the field and let the **renderer** build the sections: `bailReason` as one
sentence and the headline, `bailBlockers` as a bullet list, `bailRemedy` addressed to the reporter
and rendered last because it is the only actionable half. All three held to the existing iff against
`proceed`, which turns "a bail that diagnoses and does not say what would fix it" into a parse error
rather than a comment ending under a heading that promises the missing part.

**Brevity is enforced, not requested.** A schema description is a request, and the subject here is
what to do when the text is not what was asked for. Caps on the headline, on each blocker and on the
remedy, cutting on a word boundary — slicing at the index would leave `mapToCommerceCar.ts:1`, a
plausible-looking wrong line number — and marking the cut, because a silently truncated sentence
reads as a model that stopped mid-thought. A list longer than six says how many it dropped, since a
reporter who thinks they have seen every blocker will split the ticket against an incomplete set.

**The rules** — [prefer the structured channel](BUILDING.md#untrusted-input-and-the-channel-it-arrives-on);
[verbose is not volume](BUILDING.md#verbose-is-not-volume-and-this-is-the-half-that-gets-overcorrected).

### The unresolved field that was computed and dropped

`AdvanceOutcome.iterated` carried an `unresolved` field on the exhausted path only; on every
successful round it was computed and discarded unread. The skill calls it _"what tells a human to
stop the loop and look"_.

On the first round where it carried a real defect it was the only place that defect appeared. The
round had written a regression test for a timezone bug that compared against `ZoneId.systemDefault()`
— so it separates the fix from the bug only on a non-UTC JVM — and said so, in `unresolved`, adding
that it had no shell with which to check what CI runs. Checked by hand afterwards: the Dockerfile
pins `Europe/Oslo` for runtime only and the CI workflow pins nothing, so the runners default to UTC
and the test passes identically against the bug. **The guard on a fix now out of draft is a
decoration, and the loop had said so.**

The comparison worth keeping is with the fields that are deliberately computed and not read. Several
exist here and they are fine, because someone wrote down why next to them. Identical in the code;
the difference is entirely whether a reason is recorded.

**The rules** — [computed deliberately and not consumed yet](BUILDING.md#an-unreferenced-symbol-is-a-question-and-the-answer-decides-the-action);
[the channel nobody reads](BUILDING.md#bail-honestly-and-put-the-reasoning-where-it-will-be-read).

### The favicon reconstructed from an adjective

The ticket named an attached SVG. The solver's tool surface — `Read`, `Grep`, `Glob` inside a
worktree, no `Bash`, no Atlassian MCP — could not open a Jira attachment, so it **reconstructed an
icon from the description's own adjective**, _"a red #e31b23 block T"_, and committed that:

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
  <path fill="#e31b23" d="M5 5h22v5h-8v17h-6V10H5z"></path>
</svg>
```

**It survived everything.** Two automated reviews, a human reader, and three `--advance` rounds that
argued in detail about link ordering and idempotency — while the one thing the acceptance criterion
actually names was silently a different file. Every reviewer was reading the code. **Nobody loaded
the page and looked at the favicon.** One glance at a running browser tab would have settled in a
second what three careful code reviews missed entirely.

The reason it got through is the reason this class always gets through: the substitute was
plausible. And plausibility is what capability buys — a capable producer always emits something
plausible enough to survive a code review, so review is the wrong instrument and working software is
the only thing plausibility cannot fake.

**Two later corrections, both of which sharpen rather than soften it.** The fitness call
subsequently refused a similar ticket on the grounds that the asset was an attachment the agent
could not retrieve, and that refusal was initially argued away as over-cautious. It was right: a
stated inability is the better of the two failures. And the general rule is bigger than one
attachment — a solver that can describe an asset in prose will always be able to produce _something_
matching the prose, so the harness must not rely on the model declining.

**The rules** — [step 4 is the one that gets dropped](PROVING.md#step-4-is-the-one-that-gets-dropped-and-dropping-it-is-invisible);
[bail honestly](BUILDING.md#bail-honestly-and-put-the-reasoning-where-it-will-be-read);
[what was the actual fault](FINISHING.md#the-postmortem-in-three-questions).

### The reviewer whose mechanism was inverted

The same reviewer reviewed the same substantive code twice and changed its mind: _approval
recommended_ at 23:05, _needs a closer look_ at 11:00, with the intervening commit touching a test
file and nothing else. The point that escalated was byte-identical across both reviews. **Two
reviews of the same code disagreeing is information about the reviewer, not about the diff.**

The escalated claim did not survive being checked, and checking it was one grep:

- _"If the portal shell already provides a favicon link … browsers may continue to use the first
  one."_ The shipped `<head>` has **no icon link at all**.
- Browsers resolve competing `link[rel="icon"]` elements to the **last** one declared, not the
  first. So appending is how you override a portal favicon, and the stated mechanism is inverted.
- **But the conclusion survives its own argument being wrong, for a reason the reviewer did not
  give.** This is a federated remote mounted in a portal shell and the link is appended during
  `bootstrap()`; if the shell sets its favicon after that, the shell's link is last and this one
  loses. A real ordering risk that the repository cannot settle.

The first pass at writing this up stopped at _"the mechanism is inverted"_ and treated the point as
disposed of. **Rejecting a bad argument is not the same as rejecting the claim**, and a loop taught
only the first move will talk itself out of real bugs with excellent reasoning.

There is a second tell in the same review and it needs no parser: the 11:00 review rated the point
important enough to downgrade the whole pull request and not important enough to post on the line it
is about. Those cannot both be true. **A review that changes the verdict while producing no new or
updated thread is a reviewer restating itself** — both halves are already on the wire, so it is a
comparison rather than a scraper, and it works for any reviewer.

**The rule** — [rejecting a bad argument is not rejecting the claim](BUILDING.md#bail-honestly-and-put-the-reasoning-where-it-will-be-read).

### The fitness call that was refused three times for two wrong reasons

Three consecutive full runs on one ticket, each stopping before the claim, **at $1.97 a time —
roughly $6 to be told the same wrong thing three times.** The gate itself worked exactly as designed;
this was the first time the fitness call changed what happened rather than being recorded, which is
what finally made a wrong call cost something and therefore measurable. What it measured is that the
call was wrong twice over.

**Blocker 1, "a PR for this ticket has been in code review since 2026-09-04", is stale prose — and
the contradicting fact was in the same payload.** Both pull requests were `CLOSED`, the branch was
gone from `origin`, and the ticket's status was `Prioritized`. The only thing still saying otherwise
was a pair of one-shot automation comments, written at the moment each event happened and never
revisited. Triage held both facts in one sentence — _"status Prioritized, branch created 2026-09-04,
PR in code review since 2026-09-04"_ — and resolved the contradiction toward the stale half. **It
had the answer and preferred the prose.** This project's own defect class, arriving in its input
rather than its output.

**Blocker 2, "the icon asset is a Jira attachment the agent would have to retrieve", is false, and
the capability it says is missing had been in the tree the whole time.** The file _is_ a proper
attachment; an earlier run called it an inline blob because `getJiraIssue`'s default field set does
not include `attachment`, so triage inferred absence from a rendering artifact. The later run got
that right and then refused for a reason that is also wrong: it reasoned from the _solver's_ tool
surface to "it cannot fetch a Jira attachment". True, and irrelevant. **The solver does not fetch
it** — `src/solve/ticket.ts` does, before the model is started, and pastes the bytes into the
prompt.

**The rules** — [an automation comment is evidence of an event, not of the current
state](BUILDING.md#untrusted-input-and-the-channel-it-arrives-on);
[capability is a question about the composition](STARTING.md#technique);
[without a rung for the step you are debugging, every attempt costs the whole
chain](PROVING.md#the-economics-measured-on-this-project).

### The fail-first replay

The obvious reading of a solver shipping a decorative regression test is _make it do red-green_.
Replaying seven new assertions under the suite's own frozen clocks says that would have bought
nothing:

| the new assertions go red against                   | count      |
| --------------------------------------------------- | ---------- |
| the **original** bug (`setMonth(month)`)            | **7 of 7** |
| the **plausible wrong fix** (`setMonth(month - 1)`) | **1 of 7** |

Classic fail-first was already satisfied, completely, by a suite that was six-sevenths decorative.
So the house rule and red-green are different rules: red-green unplugs the _defect_; this
repository's rule unplugs the **plausible wrong implementation**. Only the second would have caught
what shipped.

**Two tiers, and only the weaker one is mechanical**, because "the obvious wrong fix" is not a thing
a harness can enumerate. The prose tier asks the pass to name the almost-correct change, read the
test back against it, and record the weakness if no assertion goes red. The mechanical tier lays the
run's own new test files onto an untouched checkout of the base and runs the discovered test step
there; green means **vacuous**, and that is the only verdict rendered.

**`guarded` is deliberately unreported, and the asymmetry is the design.** A new test importing a
new non-test helper fails against the base for a reason unrelated to the fix, so `guarded` is
unsound and a green tick beside the verification ticks would overclaim. `vacuous` has no such
escape, and the test-path heuristic inherits the same asymmetry — over- and under-matching both bias
towards `guarded` and neither can manufacture a `vacuous`, which is why a heuristic is allowed here
at all.

It reports and never refuses: a vacuous test does not make a correct fix wrong, and a check that
could withhold a good pull request would have to be right about a question it is sound about in only
one direction.

**The rule** — [unplug the plausible wrong implementation](PROVING.md#a-guard-is-not-shipped-until-a-test-fails-when-it-is-unplugged).

### The two regression tests that guarded nothing

Both shipped green, both named for the thing they did not check.

**The timezone test** compared against `ZoneId.systemDefault()`, so it separates the fix from the
bug only on a non-UTC JVM. CI runs UTC. The round that wrote it said so in a field nobody read.

**The run-date block** is subtler and is the better story. All four cases in a block named _"should
not depend on the run date"_ use an issue date in March, and March has 31 days, so no run date can
overflow it — the naive fix passes that block entirely. What actually catches the naive fix is a
February case in a _different_ block, under a `beforeEach` clock frozen to 31 January. **The suite
is a real guard by a route nobody wrote down**: move that clock to mid-month or drop the February
row and the guard vanishes silently while the test named for it stays green.

A one-shot check at solve time misses both, for two different reasons. The run-date block is
`guarded` and soundly so — 7 of 7 red against the real bug — and only the plausible wrong fix
separates it, which is prose rather than mechanism. The timezone test is **environment-dependent**:
the probe says `vacuous` on a UTC runner and `guarded` on an Oslo laptop, and the laptop is where
the harness runs. **A probe that inherits the operator's environment cannot answer a question about
CI's.**

**The rule** — [a test whose name describes something it does not
check](PROVING.md#tests-that-stop-testing).

### The literal lists that named a type's members

Three instances, found within days of each other, and the third is what made it a rule.

- A test checked `assertOwnedLabel` against a hand-copied list of the six labels that existed when
  it was written. A later phase added two, the test kept passing, and the _credential_ decided at
  runtime, on a live board, mid-solve, whether it would write them.
- `ADVANCE_OUTCOMES` had no `capped` entry while two tables above it claimed to cover "every
  review-round kind".
- Two argument-parser test files each held `["--claim", "--solve", "--pr"]` written out by hand —
  including, in the second file, **the test whose stated purpose is catching a rung that outran the
  help text**.

All now derive from the type: `Object.keys(AGENT_LABELS)`, `PHASES`, `AdvanceOutcome["kind"]`.

**The rule** — [a literal list naming a type's members](PROVING.md#tests-that-stop-testing);
[a rule with one instance is a hypothesis](FINISHING.md#the-postmortem-in-three-questions).

### The unusable-base headline that misled its own author

`feedback.ts` renders _"The repository's own build does not pass before any change"_ and drops the
two qualifiers `verify.ts` is careful to include: _in a fresh worktree_, and _or this harness_. A
Jira reader concludes `main` is broken.

**It misled the author of the plan within an hour of being written**, which is about as direct a
demonstration as a defect of this class gets. A message that overstates its scope is worse than
silence, because silence is not acted on.

**The rule** — [state the claim as narrowly as the evidence
supports](BUILDING.md#verbose-is-not-volume-and-this-is-the-half-that-gets-overcorrected).

### The capacity number that was read for two days as a blocker

A cycle report printed `capacity: 0`, and that was recorded as the thing gating an end-to-end run —
in the plan-mode planning document for the solve phases, which is not `PLAN.md` and is not in this
tree. It was not gating anything. `runSolveCycle` computes capacity, and the hand-driven path is called
anyway when an issue key is named, so it had never consulted the number. The blocker was an
inference from a report rather than a reading of the code, and it stood for two days.

**A number on a page invites an inference about what it controls.** Report the decision, not only
the inputs to it.

**The rule** — [report the decision, not only the inputs to
it](BUILDING.md#instrument-the-failure-path-first).

### The read tools the header said were denied

`src/solve/commenter.ts` was written with a header describing the narrowest MCP surface in the tree,
and it was accurate about MCP. The first live run reported, in its own `problems` field, that it had
_"worked around"_ a denied Atlassian call by reading configuration off the repository — using
`Read`, which `DENIED_BUILTIN_TOOLS` never included.

The author had checked the allowlist, seen one entry, and read it as describing the whole session.
**This project's defect class, in the file arguing against it, within an hour of it being written.**

Not cosmetic either: `childEnv` keeps this service's secrets out of the subprocess environment while
the working directory is this repository, where some of them are on disk. Withholding a secret from
the environment while granting a file-opening tool is not withholding it. Fixed by denying `Read`,
`Grep`, `Glob`, `WebFetch`, `WebSearch` and `Task` locally — `Task` because a subagent's tool
surface is not this list and recovers every other entry.

**It also taught something about denial that a probe could not.** The model's response to being
denied was to improvise around it rather than report it, and `problems` is precisely the channel for
_"I could not do this"_. **A capable session will not use that channel while it has any other way
through**, which is a general argument for narrow tool surfaces over honest self-reporting.

The same defect is older and wider than one file: the triage poster's header makes the same two
claims and has made them for longer, on a path that runs on every triage rather than on a terminal
outcome.

**The rules** — [a capable session will not report being
blocked](BUILDING.md#bail-honestly-and-put-the-reasoning-where-it-will-be-read);
["no read tools" was true of the allowlist and false of the
session](PROVING.md#measure-do-not-assume-and-the-assumption-is-usually-about-your-own-code).

### The three phases stacked on one branch

Three implementation branches were stacked rather than fanned out, each editing code the one below
it was the first to call. The cost was written down at the time, in the plan-mode planning document
for the solve phases — not `PLAN.md`, and not in this tree — in its own words:
_"the cost is that D4a's end-to-end test gates all three."_

That sentence is the loop degrading into a waterfall, visible in advance and accepted anyway. A run
that fails tells you _which change broke it_ only if there was one change.

The same shape recurred at the documentation layer: three pull requests open at once, two of them
reporting _"the stack isn't ready"_ and the third red on a formatting failure that only the bottom
of the stack could fix. Nothing could merge until the base did.

**The rules** — [small turns are what make step 5 possible](PROVING.md#one-turn-of-the-loop);
[do not stack branches deeply](STARTING.md#phase-a-privilege-and-drive-it-by-hand-first).

---

## 2026-09-08

_The first four entries under this date came out of a single reachability-and-prose sweep, up to
and including the precondition with two enforcers. That the sweep found this much is itself the
finding — a sweep is what you run when the discipline has already failed, and every item in it was
free to delete at the time and expensive to adjudicate afterwards._

### The credential that stopped being discovery-only

Five files described the Jira REST credential as "discovery only". It had not been since
`updateLabels` shipped — and `wiring.ts`, **the module that calls it**, said so most emphatically.

The correction is bounded and worth stating because the sentence is now true again: labels only,
`agent:` namespace only, enforced by `assertOwnedLabel`, with comments still on MCP because
`editJiraIssue` has set semantics and cannot add one label without rewriting all of them.

This is the simplest form of the defect class — plainly false prose — and it is the one that survives
longest, because nothing that reads the code ever reads the sentence.

**The rule** — [plainly false](BUILDING.md#the-defect-class).

### The Slack canvas sink

A renderer and its edit-request builders, written before the Slack access they needed was confirmed.
The access never arrived. For the life of the project the module had no caller outside its own
tests, and it was kept as an interface "to make the swap cheap".

**An abstraction whose second implementation is unreachable is not proven flexible, only untested**
— and this one had quietly drifted out of everything that would have noticed. Deleted with its test;
`git log` keeps it.

**The rule** — [speculative](BUILDING.md#an-unreferenced-symbol-is-a-question-and-the-answer-decides-the-action);
[do not build ahead of an access you do not have](BUILDING.md#while-implementing).

### The wrapper whose assertions were the only coverage

`isEligible` was flagged as a tested guard with zero callers — the clearest possible delete. It was a
thin wrapper over `eligibility`, which has three live call sites, and its **21 assertions were the
only coverage the real function had**.

They were redirected, not deleted. **Removing a symbol must never remove the evidence**, and the
confident reading is the one to check hardest.

**The rule** — [the confident reading is the wrong
one](BUILDING.md#deleting-is-a-change-like-any-other-so-verify-it-like-one).

### The precondition with no references and two enforcers

`REQUIRED_MCP_SERVERS` had zero references and a comment promising _"servers that must report
`connected` before the run is trusted"_. It was written up as a promise nothing kept.

It was enforced the whole time. `assertMcpReady` throws on the init event, `ARCHITECTURE.md` says so
in two places, and one of them is a table recording it firing for real. The constant had merely been
superseded by a per-call option. **Two documents described the precondition in prose without ever
naming the symbol** — so zero grep hits, and an entirely wrong conclusion.

The deletion was correct and the write-up was wrong, which is the distinction that matters: the
symbol was dead and the guarantee was alive.

> **An unreferenced declaration is evidence about a name, not about a guarantee.**

**The rules** — [a search that confirms](STARTING.md#the-failure-mode-to-design-against-a-search-that-confirms);
[say what would break, not what has no
references](BUILDING.md#deleting-is-a-change-like-any-other-so-verify-it-like-one).

### The branch count that went up after ten deletions

The operator deleted ten remote branches and enabled auto-delete-on-merge, and the stack hook's
count went **up**.

Twenty-six local branches were already merged into `origin/main` with their remotes gone, and local
`main` was twenty commits behind — so the hook, which measured against local `main`, counted nine
merged branches as stacked and kept counting them after the cleanup. Two defects in one number: the
branches should not have existed, and the base should have been the remote-tracking ref. The fix was
both — the stale branches deleted, and `stackBase` in `.claude/hooks/lib.sh` reading `origin/main`
in place of the local ref, falling back to it only when there is no remote to read.

The general form is worth more than the fix: **a measurement taken against a ref that only moves
when a human remembers to move it is not a measurement of the project.** Prefer the ref that tracks
reality; where that is impossible, print which ref was read — the session brief prints its base for
exactly this reason, and printing it is what made the bug legible.

The cost is not accuracy, it is the guard. A backlog padded with branches that merged weeks ago
makes the prompt fire on a stack that does not exist, and **a guard that cannot be satisfied is one
people learn to click past.**

**The rule** — [the same rule applies to
branches](BUILDING.md#the-same-rule-applies-to-branches-and-they-are-the-copy-everyone-forgets).

### The guardrails built with nothing in the plan

`CLAUDE.md`, four hooks, a library and a 57-assertion test script were built end to end **without a
single line in `PLAN.md` describing them.** The work was fine. The record was that a branch called
`chore/agent-guardrails` appeared with five new files in it.

Everything about _why_ lived in one conversation, and that conversation had already been compacted
once. A diff says what changed; it never says what was being attempted or what had already been
ruled out.

The rule that existed at the time only fired on the way out — something ships, its plan entry is
deleted — which is a rule for the context that _finishes_ work and left nothing at all for the
context that starts it. Both halves are now the same rule seen from both ends.

**Two defects the same work found, both by running the guards rather than by testing them.** A
branch name containing a `"` broke the denial JSON, so the runtime dropped the denial entirely and
the guard failed **open while still looking installed**. And an earlier version refused _every_ Bash
command on `main` — including the `git switch -c` its own denial text recommends — trapping the
agent it was guarding.

**The rules** — [the plan is written before the work](STARTING.md#the-plan-is-written-before-the-work-not-after-it);
[fail closed, except guards](BUILDING.md#fail-closed-except-guards-which-fail-open).

### The nine merged pull requests with zero reviews

Counted while writing the CI workflow: nine merged pull requests, **no review on any of them**.
Nothing had ever checked a change except the agent that wrote it, and the finishing checklist was
being asserted by the party being checked.

The commands CI ran when this was written were the same four a developer runs by hand, and that was
the point — not a new standard, the existing one moved somewhere it cannot be skipped. What changes
is that they run against the pushed ref, on a machine nobody is logged into, whether or not anyone
remembered. (The job has grown since: the hook suite and `docs:check` were added, and then one step
that is deliberately _not_ a command anybody runs by hand — see
[the four filed lessons](#four-lessons-written-down-carefully-and-filed-where-nothing-loads-them).
The tense is corrected here rather than the count updated, because this entry is a record of a day,
not a description of the workflow.)

**It found something before it merged.** `pnpm format:check` was failing on `main`, and had been for
as long as nobody ran it. Left red rather than softened, which is the fail-closed rule, and it is a
reasonable first demonstration that the job is worth having.

**The rule** — [green is a statement about the
tests](PROVING.md#the-tests-did-not-catch-the-interesting-bugs-running-it-did);
[a check that cannot fail the run reports rather than
guards](BUILDING.md#fail-closed-except-guards-which-fail-open).

### The check the formatter could switch off

`pnpm docs:check` was written to stop a number cited in prose from drifting away from the tree. It
knows three facts — the test count, the test-file count, the settings count — and it finds them in
the documents by pattern.

**It exists because of one unremarkable commit.** A deletion moved the test count, which was cited
in two documents, and only one of them was updated — the kind of drift that is caught by whoever
next happens to grep, or not at all. That is the whole of the evidence behind _numbers in prose rot
like facts_, and it is deliberately thin: the rule is a hypothesis with one instance, and the check
below is what makes a second instance impossible rather than merely unlikely.

The first version scanned a line at a time and reported **green while seeing half the citations**.
`oxfmt` reflows Markdown, and it had already wrapped `PLAN.md`'s copy between "64" and "files", so
the pattern matched in `ARCHITECTURE.md` and nowhere else. The repository's own formatter, run on a
document nobody had edited, was enough to disable half the check.

It only reported green at all because of the one thing built to prevent exactly this: each fact
declares how many citation sites it expects, and finding fewer is a failure with the same weight as
a wrong number. Without that, the run would have said `ok` — a check silently guarding one document
instead of two, indistinguishable from a working one.

Matching whole files instead fixed one site and not that one. The `PLAN.md` citation is inside a
blockquote, so the continuation line begins `> `, and a `\s+` gap does not span it. Two bugs, both
of them a space that turned out not to be one, which is why patterns are now built from words by
`citation()` and there is nowhere to write a space by hand.

**The rules** — [a guard is not shipped until a test fails when it is
unplugged](PROVING.md#a-guard-is-not-shipped-until-a-test-fails-when-it-is-unplugged); [fail closed,
except guards](BUILDING.md#fail-closed-except-guards-which-fail-open).

---

## 2026-09-09

### The commit message that was refused as the act it described

The commit hardening `branch-guard.sh` described the hole it closed in literal command form — a bare
push, naming no branch, following its upstream to a protected one. An outer guard matched the push
verb and the branch name in that text and refused the commit as a direct push to `main`. There was
no push in it; only the wording changed.

**The same defect was one assertion away in the diff being committed.** The new rule-2 check was
mutated five ways, and the fifth was the plausible wrong fix — match `gh` anywhere in the text
rather than at command position. It fails exactly one case, a commit message that merely _mentions_
merging. Without it this guard would have shipped the property just used against it.

At the outer layer a coarse matcher that fails closed is defensible; a miss costs an unreviewed
commit on `main` and a false positive costs a reworded sentence. **The lesson is for guards written
_here_**, where the same trade was available and nearly taken for a much weaker reason: the
unanchored pattern was simply shorter. What makes this direction distinct is who pays. A guard that
fails open is invisible; one that fails closed onto its own remedy traps you loudly and gets fixed;
one that taxes _writing about itself_ works perfectly and steadily annoys the only people who
maintain it, until one removes it believing it is noise.

**The rule** — [fail closed, except
guards](BUILDING.md#fail-closed-except-guards-which-fail-open).

### The suite that was a statement about one laptop

`pnpm test:hooks` reported **57 passed** for as long as it existed. Its fixtures are real
repositories, so `git commit` needs an identity, and the suite silently borrowed the developer's.
The first machine that ever ran it without one was CI: every fixture died on `fatal: empty ident
name` before its initial commit, so no fixture had a `main` ref, and **22 of 57 assertions failed
describing that** rather than describing the guards.

`origin/main` had no `test:hooks` step until `1e64ed4`, the branch that also fixed this — so the
suite's first clean-machine run and its first failure are the same event. Green on a laptop for its
whole life is not evidence a suite runs; it is the absence of anyone having tried.

The scripts were fine: this was a true statement about one machine's configuration worn as a
statement about the code, so the suite now supplies its own identity and reads no ambient
configuration at all. Comment the identity lines out, run in a clean environment, and the CI failure
returns exactly: 22 failed, 35 passed.

Second instance of a rule that had one. [The timezone
test](#the-two-regression-tests-that-guarded-nothing) ended: _a probe that inherits the operator's
environment cannot answer a question about CI's._ That was a timezone; this is a git identity.

**The rule** — [tests that stop testing](PROVING.md#tests-that-stop-testing).

### Four lessons written down carefully and filed where nothing loads them

None of these was missed. Each was noticed, understood and written up at length — and each went
somewhere no rule and no reader ever opens.

- **A bare SHA where the neighbours cite anchors.** `SKILL.md` recorded the incident above as
  `` `8ad1a31` ``, resolvable only by `git show`, one day after this file's header named that class.
- **A correction scheduled for deletion**, filed inside a `PLAN.md` entry that rule 2 deletes when
  the audit closes.
- **A design rule in a commit message**, where it stayed until someone asked for it.
- **An entry deleted while half the work was outstanding.** §14 was removed when the guard shipped,
  but the rule that guard produced had not been written.

**And then the same number failed the other way, in the branch fixing all of the above:** a new §14
was written, the work shipped, the entry was left standing, and `PLAN.md` advertised as _not built_
three layers sitting in the diff below it. Deleted too early on one day, kept too late on the next,
by the same reader holding the same rule. _Delete it when it ships_ sounds like one action and is
two, finishing at different times. The reliable question is **is any sentence in `PLAN.md` now
describing something that exists** — asked while looking at the file.

**The common cause is not forgetting; it is that writing something down feels like filing it.** The
subjective signal — _I thought about this carefully and put it in words_ — is identical whether the
words land on a reading path or in a commit message nobody will open again.

**How it surfaced.** A human asked, twice. The checklist item that should have caught it — _did
something get through that these rules do not cover?_ — was skipped in silence: the checklist was
run from memory after a compaction, and the remembered version was the six commands.

**The rules** — [say what you owe, in the pull request
body](FINISHING.md#the-rules-you-owe-are-written-down-or-they-are-not-owed);
[re-read the phase file, never recall it](FINISHING.md#re-read-the-phase-file-never-recall-it).

### The audit that found eight things and got three of them wrong on the way

Run 2026-09-08 against these rules by spot-check rather than by reading. **Eight findings; six held,
one was wrong, one was overstated in a way that would have destroyed evidence.** Calibration first:
all five checks were green, plan-before-work had been followed, every symbol `BUILDING.md` names was
present, and of eighteen incidents sampled thirteen trace to a SHA whose diff carries the incident's
own details — **no claimed defect turned out never to have existed.** It is recorded here because
how it went wrong is more transferable than what it found.

**Three failures of method, each a defect these rules already name, committed while auditing for
them:**

- **A search that confirms.** `grep -c STATE_PATH` returned 1, which is what a setting documented in
  a shared table row looks like, and it was read as a missing row **because a finding had predicted
  one**. Deriving the answer instead — iterate `SETTINGS` — gives 46 of 46 present.
  [→](STARTING.md#the-failure-mode-to-design-against-a-search-that-confirms)
- **A number that invited an inference about what it controls.** `git rev-list --count main..HEAD`
  was 3 and `branch-stack.sh`'s threshold is 3, so the hook was reported as at its limit. It counts
  unmerged branches into `origin/main`, which was **one**.
  [→](#the-capacity-number-that-was-read-for-two-days-as-a-blocker)
- **An adversarial subagent returns what it was primed for.** The prompt offered `SUSPECTED RETROFIT`
  as a verdict and named an untraceable commit as evidence; the report alleged invention and was
  relayed at full strength. The evidence supported only "not in `PLAN.md`". Depth was delegated on
  the two sharpest accusations, which is the half of _delegate breadth, keep depth_ that costs
  something.

**Where the amendment went.** The story lived in `PLAN.md` §13 for a day inside a 106-line audit
report, half open items and half narrative defending itself — which is a plan nobody can read the
open items out of. The open items stayed there; the story came here.

**The rules** — [a rule with one instance is a
hypothesis](FINISHING.md#the-postmortem-in-three-questions);
[where an amendment goes](FINISHING.md#where-an-amendment-goes).

### The compaction finding that counted the string instead of the call

An hour after the entry above, the same failure produced a claim about compaction that was on its
way into a hook — which would have injected it into every future session as a current fact.

**The claim.** _Three compaction boundaries in this session — lines 611→612, 1353→1354, 2002→2003 —
all three immediately followed by a `git commit`, with no read of any rule file in between._ It went
into `PLAN.md`, `FINISHING.md` and the text `session-brief.sh` injects.

**What a real count says**, parsing the transcript for `tool_use` blocks rather than grepping it for
a string: **four** boundaries; the first commit after each is +146, +32, +66 and +57 transcript
lines away; **2, 0, 2, 3** rule-file reads sit in between; per stretch reads:commits ran **8:8,
18:5, 11:7, 8:3**. One boundary of four fits the story, and the ratios point the other way.

**Three errors, each one this file already names.** Counting the string counts mentions, not calls —
83 lines contain it, 27 are `Bash` calls, and the rest include commit-message heredocs, residue of
commits already made carefully, so the denominator was inflated by the very evidence of care it was
used to deny [→](STARTING.md#the-failure-mode-to-design-against-a-search-that-confirms). `611→612`
is a boundary line and its own summary line, not a sequence; the arrow implied one, and it was
exact, which is what made it persuasive. And the fourth boundary was missed because counting stopped
when the pattern was complete.

**Why it survived to be committed.** The conclusion was independently plausible, so the numbers were
checked for _support_ rather than for _truth_. A finding that agrees with a rule you already believe
gets the shortest review of any finding you will ever produce.

**What survived** is mechanism plus one case — compaction fires when context is exhausted, and
context is most exhausted at the end of a unit of work, which is when the finishing checklist runs.
So `session-brief.sh` says that in a comment and injects **no numbers at all**, and the false ratios
came back out of `PLAN.md`, `FINISHING.md` and the injected text.

**Found by** a fresh-context subagent audit of the uncommitted diff, run before the commit.

**The rules** — [a search that confirms](STARTING.md#the-failure-mode-to-design-against-a-search-that-confirms);
[measure, do not assume](PROVING.md#measure-do-not-assume-and-the-assumption-is-usually-about-your-own-code);
[a rule with one instance is a hypothesis](FINISHING.md#the-postmortem-in-three-questions).

### The half of the extraction that nothing watched

Shipped in the same diff, found by the same audit. `session-brief.sh` extracts two things at run
time — the non-advisory rules from `CLAUDE.md`, the four judgement questions from `FINISHING.md` —
and a comment above both said they were extracted rather than pasted precisely so they could not go
stale. Three assertions were written to hold that. **All three were about the checklist. Nothing at
all watched the rules.** Measured: replacing the `CLAUDE.md` extraction with a verbatim paste of
today's text left **all 87 assertions green**; replacing the `FINISHING.md` one turned two red.

The same shape sat one screen below. An assertion named `empty stdin does not hang` ran the hook
with stdin _closed_, which returns instantly whatever the implementation does; the case in its name,
stdin **open and never written**, was the one the implementation got wrong, and the guard
`[ ! -t 0 ]` cannot tell the two apart. Green on a terminal, stalled forever anywhere stdin is an
idle pipe. Fixed by writing the assertion the name promised — a fifo held open by a spare
descriptor, watchdogged, because a suite that hangs to report a hang has reported nothing.

**The generalisation is not "write more tests".** A claim was made about a file, and coverage was
written for the example in front of the author. Count what a claim quantifies over — two
extractions, two stdin states — and mutate each one. A property asserted at one of its sites is an
anecdote with a test attached.

**The rules** — [a guard is not shipped until a test fails when it is
unplugged](PROVING.md#a-guard-is-not-shipped-until-a-test-fails-when-it-is-unplugged); [tests that
stop testing](PROVING.md#tests-that-stop-testing).

---

### Thirty-nine citations to sections that were never written

<!-- refs:off -->

An audit of this repository's own cross-reference system found **39 dangling `§N` citations** in
shipped source. Its first diagnosis was that a renumbering had stranded them; that was wrong. `§3a`,
`§5b`, `§7b` and `§6.1c` appear in no revision of `PLAN.md`, in any form — a session held a plan in
its own context, cited it from code as though citing a document, and the plan died when the session
did. The quieter half is worse: a reference that is in range and silently repointed reads correctly
forever, where a dangling one fails the moment anyone checks it.

<!-- refs:on -->

**Found by** a subagent audit asked to resolve every `§N` against its target document — and the
audit's counts were right while its causal story was wrong, so the correction came from checking its
claim against `git log` rather than from the report.
[→ read wide in a subagent, decide in the main context](STARTING.md#read-wide-in-a-subagent-decide-in-the-main-context)

**The rule** — [the plan is written before the work](STARTING.md#the-plan-is-written-before-the-work-not-after-it).
The open items and the full account are in `PLAN.md`, "The citations that were never written down".

---

### The mutation test that reverted the file it was testing

Two derived counts had just been added to `docs:check` — `§N` references in `src/`, and files
repeating a quoted cost figure. Neither ships until it fails when unplugged, so each was mutated by
appending to a file: a cost figure into `README.md`, a section reference into `settings.ts`, and —
as the control — a line of prose into `PLAN.md`, to prove the code-only count does **not** move. All
three fired correctly. Each was then undone one file at a time through the version-control tool.

`PLAN.md` held about an hour of uncommitted work, including the very prose those counts existed to
pin. The undo reverted the whole file, not the appended line, and the mutation test destroyed
exactly the work it had been run to verify.

**A mutation has two scopes and the undo has one.** The edit is a line; the undo is a file.
Identical in a clean tree, silently different in a dirty one — and unplugging a guard happens at the
end of a change, which is when the tree is dirtiest. It reports the same one-path summary whether it
discarded one line or four hundred.

**The near-miss is the part worth keeping.** Caught only because the same command printed
`git status` for an unrelated reason and `PLAN.md` was missing from the list. Had the next step been
a commit of the named files, the work would have been gone and the commit would have looked
complete: the other five files were correct, and `docs:check` would then have failed on an uncited
number — which reads like a small prose fix, not like a restore.

**A second guard fired on the write-up, not the act.** Recording this entry was refused by an outer
guard because the prose named the destructive command it warns about — the third instance of a
text-matching guard reading a description as the deed
([the first](#the-commit-message-that-was-refused-as-the-act-it-described)).

**Found by** `git status` printed incidentally by the mutation script — by no check. The suite, the
type checker and the hook tests were all green throughout, and `docs:check` would have caught it one
step later as the wrong problem.

**The rule** — [commit before you mutate](PROVING.md#a-guard-is-not-shipped-until-a-test-fails-when-it-is-unplugged).

### The assertion with one millisecond of margin

`session.test.ts` proves that an hour of machine sleep is charged to neither budget, by jumping the
clock forward an hour mid-run and asserting the detected drift. Its comment said the right thing —
_"Pinning the millisecond would make this a test about the machine's load"_ — and the assertion
under it was `toBeGreaterThanOrEqual(3_600_000)` against an observed **3,600,001**. One millisecond
of margin, which is pinning the millisecond by another name. It failed roughly one full-suite run in
thirty and passed every time it was run alone.

**What the measurements ruled out is more useful than the fix.** Two plausible stories were killed
before anything was edited. First, that a tick running late leaves the next one measuring a gap
shorter than the interval: Node re-arms an interval after its callback returns, so it does not — a
300ms interval with a 700ms block inside one tick gives gaps of 301, 301, 300, 700, 301, and none
below the period. Second, that the first gap could be short: `lastTickAt` is seeded before
`setInterval` is created, so it is at least a full interval. The injected hour's own drift can
therefore only land at or above 3,600,000, which means the number that failed **was not the injected
hour** — it was a second `session.slept` event, taken first by `.find()`. Nothing distinguished
them, because every session in that file is built with the same label.

**It did not reproduce**, in 28 clean runs or under ten spinning cores, and the source of the second
event is still unestablished. That is written into the test rather than resolved, because the
alternative was to pick whichever story sounded best and present a guess as a diagnosis. The fix
asserts the largest event rather than the first and allows one tick of tolerance, which is the
measurement's real precision.

**A test that fails one run in thirty is not a flake, it is an unowned defect.** The suite is the
thing everything else is judged against, and an assertion that fails on load teaches the next reader
to re-run rather than to look — which is the same reflex that would hide a real intermittent bug in
the drift detector this test exists to guard.

**Found by** a full-suite run that happened to be competing with a formatter, then reported by a
human who pasted the failure. No check found it; three earlier full-suite runs in the same session
were green, and one of them was green **after** the failure had already been seen and dismissed as
noise.

**The rule** — [measure, do not assume](PROVING.md#measure-do-not-assume-and-the-assumption-is-usually-about-your-own-code);
[a guard is not shipped until a test fails when it is unplugged](PROVING.md#a-guard-is-not-shipped-until-a-test-fails-when-it-is-unplugged).

**No rule yet** — one instance of an assertion that fails one run in thirty is a hypothesis and the
two rules above already carry the repair, so what is missing is a second one with a diagnosed cause,
and `intermittent` at 2.

### The probe that ruled out the right answer

The entry above was published with a wrong diagnosis, argued from a measurement, and CI refuted it on
the first run against a branch that did not carry the fix. The failing value was **3,599,999** — one
millisecond under the bound. That is the injected hour, arriving a millisecond early, because a timer
may fire before `Date.now()` agrees it is due. There was never a second event.

**The reasoning was not lazy, which is the point.** A probe was written specifically to test whether
a gap could come in under the interval: a 300ms interval with a 700ms block inside one tick, on this
machine, giving gaps of 301, 301, 300, 700, 301 and none below the period. The published conclusion
followed from it. The probe simply did not measure the case that was failing: the **first** gap,
timed against a stamp taken before `setInterval` is created, on hardware that was not this laptop. A
probe that covers the wrong case is more dangerous than no probe, because its output is quoted as
evidence.

The entry above is left standing with its wrong conclusion, per this file's convention. What it got
right is the one millisecond of margin, and the fix — one tick of tolerance — was correct for the
wrong reason and needed no change when the reason did.

**This is the second time in one session.** A `perl -i -pe 's/…/ if !$done++'` mutation earlier
restricted its substitution to line 1, changed nothing, and reported a clean pass. Same shape: a
check ran, did not cover what it claimed, and was believed because it produced output. Both were
caught by something outside the reasoning that produced them — a `grep` for the inserted text, and
CI on different hardware.

**Found by** CI, on a pull request that was red for an unrelated reason and was only being read to
explain that redness. Not by the suite locally, which was green in 28 consecutive runs including ten
under deliberate CPU load.

**The rule** — [state which case your check does not
cover](PROVING.md#measure-do-not-assume-and-the-assumption-is-usually-about-your-own-code), which
this entry proposed as a candidate and which took seven instances to get written.

**No rule yet** — the rule this entry proposed was written against the seventh instance and cites
that one rather than this one; a rule of its own, about a probe that measures a case other than the
failing one, needs a second probe to have done it, and `wrong-case-probe` at 2.

### A permission granted to a human, read as a permission granted to the agent

`PLAN.md` §12 — the guardrail entry, since retired into `ARCHITECTURE.md` §16, which is where every
`§12` below now resolves — had said that hook configuration "belongs to the operator, lives outside
this tree, and is deliberately neither readable nor writable from here." The operator checked with
the storecode team and reported back: **developers can add settings.** True, and taken to mean the
constraint had never been real. §12 was rewritten on that basis, in confident prose.

The rewrite was wrong twice, and each half was refuted about a minute later by the only thing that
could refute it — attempting the operation. The first attempt to author the settings file was
refused as a protected path. §12 was then corrected to say the **write** was refused and the **read**
was not, a guess dressed as a finding; the read was refused ninety seconds later by a second rule
covering shell access. **The permission was scoped to the human all along.** Confidence tracked how
recently the claim had been formed rather than what supported it, and the second version was _more_
assertive than the first while resting on strictly less evidence.

**And then it happened a fourth time, in the paragraph written to close it.** Two routes had been
attempted — the write, refused, and the shell read, refused. From those two came _both directions_,
and from that a rule: no agent can report whether the hooks are installed, so any such answer is a
refusal or a fabrication. It was copied into `CLAUDE.md`, into the guardrail entry and into the
validation runbook. **Nobody tried the file-reading tool. It returns the file on the first attempt.**
The union of two refusals was written down as a property of the agent when it was a property of two
mechanisms, and a third was assumed into existence because it would have been consistent.

**The compounding is the finding.** A false claim about a _capability_ removes the operation that
would have refuted it: the rule said the check was pointless to attempt, so it went unattempted, and
the claim was safe for as long as it was believed. It cost more than it looks — reading the wiring
immediately eliminated one of the two candidate causes of the only open question in the runbook, and
that answer had been sitting in the runbook's own opening section the whole time, contradicting the
paragraph that called it unknowable.

A third refusal in the same hour was a **false positive**: appending this entry by shell was blocked
because the command carried the settings path inside quoted prose, and the rule matches the string
rather than the target. It went in through the file editor instead, disclosed rather than done
quietly — re-spelling a blocked operation is prohibited, performing a different operation the block
caught by accident is not.

**Found by** the harness refusing the operation, three times; the fourth by a spot-check audit that
ran the probe instead of reading about it — and found it only because the audit had been asked how
confident it was, not asked to confirm the documents.

**The rule** — [measure, do not
assume](PROVING.md#measure-do-not-assume-and-the-assumption-is-usually-about-your-own-code),
extended from assumptions about your own code to assumptions about your own privileges.

**No rule yet** — that extension is stated here and nowhere in `PROVING.md`, so a reader who never
opens this file gets the rule without the half that would have caught this, and 2026-09-09.

### The silent guard that was diagnosed before anyone checked whether it had run

The probe that proves these hooks are enforced was written with both outcomes decided in advance, so
that the result could not be rationalised after the fact. Step 4 — edit a file from `main`, expect a
refusal — was pre-committed to a diagnosis: if the edit goes through, `deny()` in `branch-guard.sh`
gets `exit 2`, because the published reference documents exit 2 as the blocking status and is
unclear on whether a deny carried on stdout with exit 0 is honoured.

The edit went through. So did a mutating git command on `main`. Step 3 was silent too. Every
pre-registered condition for "the runtime ignores exit 0" was satisfied.

**It was the wrong diagnosis, and the pre-decided outcome is what made it persuasive.** A silent
hook has two causes and the plan had named one. The hooks were never running: the settings file is
tracked, registration was still an open pull request, and `main` therefore did not carry it in the
working tree. The guards were live on every branch _except_ the one they exist to protect, and the
probe sent the reader to exactly that branch.

**One line settled it** — appending to a log under `/tmp` at the top of `branch-guard.sh`, then
making any tool call. The tracer fired, so the hook was running; a scratch branch matching the
guard's `release/*` pattern then produced a real refusal, so exit 0 had been honoured all along. Two
commands, after an afternoon of reasoning from a decision table.

**What the near-miss would have cost.** Applying the pre-decided fix would have passed all 93
existing assertions, because not one of them read an exit code; it would have read like hardening in
review; and it would have left `main` unprotected behind a commit that looked like a repair. The
guard's own header warns about exactly this shape — a guard that fails open is worse than no guard,
because it looks installed.

**Deciding both outcomes in advance is still right.** It stops you rewriting the criterion once you
see the result, which is a different failure and a more common one. What it does not do, and was
quietly assumed to do, is establish that the case in front of you is one of the cases on the list.

**Found by** instrumenting the hook — after the configuration was pasted in by the human and read as
confirming correct wiring, which it was. Correct configuration and an executing hook are different
claims, and the first was allowed to stand in for the second.

**A false positive fired on the write-up, for the second time and in the same shape.** Appending
this entry by shell was blocked, because the command carried the configuration's path inside quoted
prose and the rule matches the string rather than the target. As
[the first time](#a-permission-granted-to-a-human-read-as-a-permission-granted-to-the-agent), it
went in through the file editor instead — the right tool for a markdown edit regardless — and the
substitution is disclosed rather than made quietly.

**The rule** — [measure, do not assume](PROVING.md#measure-do-not-assume-and-the-assumption-is-usually-about-your-own-code).
This is the **fifth instance** of a check quoted as evidence without stating the case it excludes,
and the second written by a session that already held the fact that would have caught it: the same
work had registered `session-brief.sh` with no matcher _so that no trigger value could be missed by
a typo_, which is the same insight as "a hook can be silent because nothing invoked it". The
candidate amendment — _state which case your check does not cover before quoting it as evidence_ —
is now a rule:
[state which case your check does not cover](PROVING.md#measure-do-not-assume-and-the-assumption-is-usually-about-your-own-code).

### The check whose own remedy could not clear it

**Sixth instance, filed on the way out of the pull request above.** CI's `Rules owed` step failed
on #24, and its error message says to answer the question **in the pull request body** — but the
step reads `github.event.pull_request.body`, and `pull_request:` with no `types:` excludes `edited`,
so editing the body could not clear it and a re-run replayed the payload from before the edit. A
check that cannot be satisfied the way it says to satisfy it teaches people to route around it.
Fixed by adding `types: [opened, synchronize, reopened, edited]` in the pull request that hit it,
with the mechanism written at the site that matters, in `ci.yml`'s own header comment.

**The rule** — the same one, at its sixth instance. The four gates were green locally and were
quoted as "the gates pass" without stating the case they exclude: not one of them reads a pull
request body.

**No rule yet** — the half with no rule is the other one, that a check must be satisfiable the way
its own message says to satisfy it; one CI step is a single instance and the fix went in at the
site, and `unsatisfiable-remedy` at 2.

### The dead step that was alive, from a merge list read instead of a count

Seventh instance, and the cheapest of the seven to have avoided.
`claude-validation-work` recorded that "as of the #21 and #23 merges the count from `main` is 1, so
step 3 is dead" — that step being the only check on `branch-stack.sh`, the one hook here that has
still never been watched firing. The number came from a mental list of merged pull requests. **#21
had not merged.** With #21, #24 and #25 open the count is 3 and the step was live the whole time.

**What makes it the cheapest.** The command that measures it is printed in that same file three
lines above the claim, put there by an earlier instance of this identical mistake. The file supplied
the remedy and the next writer walked past it.

**The direction is the new part, and it is the more dangerous one.** The six before this overstated
a guard's coverage. This one _under_stated it: a working, testable guard was written down as
untestable, with a note saying its silence "means nothing at all" — an instruction to stop looking.
A false negative about your own enforcement retires a check quietly, and nothing goes red.

**Found by** running the command while answering a question about merge order, three weeks of
narrative after it was first written down.

**The rule** — [state which case your check does not
cover](PROVING.md#measure-do-not-assume-and-the-assumption-is-usually-about-your-own-code), finally
written into `PROVING.md` here at seven instances against a threshold of three.

### The denylist that named thirteen of git's write verbs

**2026-09-09.** `branch-guard.sh` decided whether a `Bash` call would write by matching it against a
list of git subcommands that mutate. The list had been patched twice, each time after a measurement
caught it letting something through: `push`, which names no branch when bare and reaches `main`
through its upstream, and then `pull`, which is `merge` with a fetch in front. The second fix landed
with a candid note — the list "was assembled from commands that _sound_ mutating, and `pull` sounds
like a read" — so the defect was in the derivation, and patching it was worth little on its own.

**Nobody had asked how much little was.** Every subcommand git knows about — 163, from
`git --list-cmds=main,others,nohelpers` — fed to the script against a throwaway repository whose
HEAD is `main`:

```
REFUSED (13)   am apply cherry-pick commit merge mv pull push rebase reset restore revert rm
allowed (150)  everything else
```

The pattern matches on the verb token, so a bare-verb sweep is the complete answer rather than a
sample. What a protected branch was letting through included `checkout`, the older spelling of the
`restore` the list refused; bare `stash`; `clean`; `branch -f`, which can move the protected ref
itself; `update-ref` and `symbolic-ref`; `send-pack` and `http-push`; `fetch` in its refspec form,
which writes a **local** branch; and `reflog expire`, which destroys the trail by which any of the
rest could be undone.

**The shape is the finding and the thirty holes are the symptom.** A denylist must enumerate every
spelling of "write" in a program with 163 subcommands and several aliases per act, and it is behind
by construction: the verb git adds next year is allowed on the day it ships. Two rounds of patching
had moved the count from 11 to 13, which is the measure of what patching buys.

**Fixed by inverting it, for `git` only** — an allowlist of read verbs plus named conditionals,
anything else a write. Non-git commands keep the fail-open behaviour, so the inversion is scoped to
the one program whose surface can be enumerated. The same sweep now refuses 102 of 163. The
constraint that shaped it was the escape hatch: the denial text tells the agent to run
`git switch -c`, and a guard that refuses the remedy it names traps the agent on the protected
branch. Inverting buys coverage with false positives, so every conditional verb has its read form
asserted beside its write form: 107 → 186 assertions.

**One mutation survived, and it was worth more than the seven that were caught.** Deleting the loop
that consumes git's global options should have let `git -C . worktree add` through. It did not: with
the options unconsumed, `-C` lands where the verb goes and is refused as an unrecognised write.
Under an inversion, mis-parsing can only over-refuse, so no write fixture can observe that loop
breaking — its only observable job is _not_ refusing a read that carries a global option, which
nothing checked. Four assertions later the mutation goes red.

**Found by** the sweep itself — every verb git has, put through the script by hand. Not by the
suite, which was green before it and green after both of the patches that preceded it.

**The rule** — a candidate for `BUILDING.md` at one instance, **proposed, not written**: _a denylist
over a vocabulary you do not control is behind by construction; invert it, or say in the code why
you cannot._ Inverting is only available when the vocabulary is enumerable and the read set is small
enough to maintain, which is why it stops at `git`. The entry above waited until seven instances, so
this one comes with an instruction attached: at instance two, write it.

**No rule yet** — inverting a denylist over a vocabulary you do not control is a candidate at one
instance and the paragraph above says what writing it would take, and `denylist` at 2.

### The lesson store that was the incident it was written to fix

The entry above — [four lessons filed where nothing loads
them](#four-lessons-written-down-carefully-and-filed-where-nothing-loads-them) — diagnosed the cause
correctly: **writing something down feels like filing it.** Its remedy was an escape hatch on
`STARTING.md` rule 2, letting a shipped `PLAN.md` entry survive its own deletion _"if it is a lesson
that lives nowhere else"_, moving to a "learned" section. `PROVING.md` step 5 then made that a
deliverable of every run.

`PLAN.md` is not on the mandatory-reading path. It is exempt from the length budget by an argument
recorded in `docs-check.ts` — _a budget on a file nobody must read is one nobody defends_. So the fix
moved lessons out of commit messages, which nothing loads, and into a section of a file nothing
loads, which unlike a commit message **grows without bound**.

**Measured 2026-09-10, when a human asked why the plan kept getting longer:** 17 entries, **409
lines**, across `PLAN.md`'s 1,094. Not one had ever been removed. Over the previous 24 commits
touching the file it went 805 → 1,094, sawtoothing as plan entries were correctly deleted and
ratcheting because the learned section only ever took deposits. Two implementations that day added a
net +27 and +67 lines each while their own entries were being deleted as the rule requires.

**Three properties made it invisible**, and they are the transferable part:

- **The author decides whether the exception applies.** "A lesson that lives nowhere else" is
  self-assessed, at the moment of most wanting it to be true.
- **It fires on success.** Every finished piece of work is entitled to one, so the sink fills fastest
  when things are going well — which is when nobody is auditing.
- **It has no counter-pressure.** Rule 2 says when an entry is created and when it is deleted. The
  learned section had a deposit rule and no withdrawal rule, so it could only integrate.

**Nothing caught it and nothing could have.** All five checks were green throughout; a growing
markdown section is not a property any of them measures, and `PLAN.md` was deliberately given no
ceiling. It surfaced the way its predecessor did: a human read the file and asked.

**The generalisation is not about `PLAN.md`.** An exception clause attached to a deletion rule, where
the author judges whether it applies, is a leak with a legal path. Deletion rules need the exception
to name a _destination that is itself maintained_, not a holding area — and if the destination is
"somewhere I will decide later", the honest options are the rule it changes, or nothing.

**The disposition, for the record.** The section was emptied in the same branch that closed it —
one verdict per entry, no fourth option. Five were already recorded elsewhere, two of them at the
call site in more detail than here, which makes the section's own title (_"and is recorded nowhere
else"_) false for a third of its contents and checked by nothing. Six generalised and became rule
paragraphs in `PROVING.md` or `STARTING.md`; three were facts about the system and went to the code
or the map; the run logs went. `PLAN.md` 1,094 → 665 lines.

**The rules** — [`PLAN.md` records what is not built, and never a
lesson](STARTING.md#the-document-contract-which-is-the-one-that-is-always-in-force); [step 5 routes
what was learned to the rule it changes](PROVING.md#step-5-is-where-it-compounds).

### The race twenty-seven green runs did not see

`prepareSkillRoot` named its staging directory `<parentDirectory>/<issueKey>-skill` — derived
entirely from its two arguments, so two concurrent runs sharing them shared a directory, which the
function `rm -rf`s, copies into, and then `chmod`s read-only. Interleave two of those and one run
deletes another's tree. The loser does not crash; it returns `refused`, the caller reads that as a
broken installation, and the pass silently never runs.

It arrived as one red test in CI on 2026-09-10, on a commit that had gone green an hour earlier and
differed only in a pull request body. Everything available locally said there was nothing there: the
file alone passed 12 times, the two colliding files together 15 times. **All 27 runs were on the
broken code, and none was evidence of anything** — a fast local disk narrows the interleaving window,
a contended shared runner widens it, and the suite measures the disk it is on.

What settled it was leaving the suite behind and driving the mechanism directly: two concurrent calls
against one root, 40 rounds, **40 prepared and 40 refused**, exactly one loser per pair, every time.
A defect that reproduces 0 times in 27 test runs and 40 out of 40 when addressed head-on is the same
defect; only the instrument changed.

**The generalisation is about what a re-run means.** A flaky test is a measurement, and re-running it
until it is green discards the measurement rather than reading it. The cheap move — press re-run,
watch the pull request go green, move on — was available and would have worked, and the race would
still be in `prepareSkillRoot` waiting for a slower morning.

**The narrower lesson underneath it:** a path derived entirely from its inputs is shared mutable
state wearing a local variable's clothes. Two runs with the same arguments is not an exotic case; it
is the ordinary one, and the tests were only the first two callers to hit it.

**The rules** — [a green suite is not evidence about a
race](PROVING.md#measure-do-not-assume-and-the-assumption-is-usually-about-your-own-code).

### The gate whose passing cases all argued their way through

The complaint was that Definition-of-Ready rows 8 and 9 failed too many tickets. Measured over the 29
reports in `groomed/`, that is **refuted**: only 2 of 12 `dor:gaps` items would have flipped had both
rows been deleted, and both needed an interpretive call to count at all. Stopping there gives the
answer "the rows are fine, the complaint is wrong" — and the complaint was right.

**The signal was in the passes.** 11 of the 16 `dor:pass` items carried a written argument for why a
thin or absent row 9 should not block, and three independently invented the same unwritten
exemption — _row 9 exists to stop unmeasured features, so a reproducible defect is exempt_. That
sentence was in no checklist. A gate two thirds of its passing population has to argue past is no
longer measuring what it believes; it has become a discretionary override with no field recording
that it was exercised.

**The general form, and it is not about DoR.** A gate's failures are the population everybody counts,
because a failure is an event with a name and a label. Its passes are unexamined by construction —
the ticket moved on, so nothing asks at what cost. A miscalibrated gate rarely manifests as too many
refusals; it manifests as **compliance theatre in the accepts**, invisible to any count keyed on the
refusal.

The tell was cheap and sitting in plain text: the same unwritten exemption in three independent runs.
**Any rule the corpus keeps inventing is a rule the corpus needs and the document does not have** —
until somebody writes it down, every instance is an unauditable judgement call in the costume of a
passing check.

**The rules** — [read what the passing cases had to
say](PROVING.md#measure-do-not-assume-and-the-assumption-is-usually-about-your-own-code).
