# Phase 3 — Proving

**The `test` and `run` steps, and they are not the same thing.** Tests protect what you already
understood. Running it is how you find out what you did not.

**If you read one section in this skill, read [the loop](#the-loop-dev-test-run-human-reevaluate).**
The rest is craft that stops known problems recurring; the loop is what found them in the first
place, and it is the only one whose absence is invisible — skip it and everything still looks green.

Previous: [BUILDING.md](BUILDING.md) · Next: [FINISHING.md](FINISHING.md) · Evidence:
[INCIDENTS.md](INCIDENTS.md)

---

## A guard is not shipped until a test fails when it is unplugged

Write the guard, then **break it deliberately and watch a test go red.** If the suite stays green,
you have shipped a decoration and a false sense of coverage, which is worse than shipping nothing.

State the mutation in the commit message. "Nine mutations caught" is the unit of work here.

**Unplug the _plausible wrong implementation_, not the bug.** This is the refinement, and it was
measured rather than reasoned: replaying seven shipped assertions, all seven went red against the
original bug and **one** against the plausible wrong fix. Classic red-green unplugs the _defect_ and
was fully satisfied by a suite that was six-sevenths decorative; this rule unplugs the
_almost-correct change_, and only it catches anything.
[→ the fail-first replay](INCIDENTS.md#the-fail-first-replay)

**A mutation that no test can kill but the type checker does is fine** — say so where it would
otherwise look like a gap.

**Count what your claim quantifies over, and mutate every one of them.** A comment saying _both of
these are derived, not pasted_ is a claim about two sites; three assertions covering one of them
leave the other free to rot, and the comment reads as if it were covered. Measured here: pasting a
stale copy over the unwatched half left all 87 assertions green. The same diff had an assertion
named for a case it did not exercise — _empty stdin does not hang_, run against stdin **closed**,
while the state that actually hung was stdin open and silent. Both are one habit: coverage written
for the example in front of you rather than for the set the sentence names.
[→ the half of the extraction that nothing
watched](INCIDENTS.md#the-half-of-the-extraction-that-nothing-watched)

**Some properties belong to a program, not a function.** _The event loop stays alive_ cannot be
observed from inside a test runner that is itself holding the loop open. Run a child process and
assert on its exit code.
[→](INCIDENTS.md#the-unref-that-killed-the-only-loop-whose-job-is-waiting)

**Commit before you mutate, or mutate something you have not written.** Unplugging a guard means
deliberately damaging the tree and then restoring it, and the restore is a blunt instrument:
`git checkout <file>` reverts the whole file, not the line you added. Run that against a file
holding uncommitted work and the mutation test destroys the work it was verifying. It happened here
on 2026-09-09 — two new `docs:check` facts were mutation-tested by appending to `README.md`,
`settings.ts` and `PLAN.md`, and the third `git checkout` deleted an hour of unrelated `PLAN.md`
edits that were still in the working tree.
[→](INCIDENTS.md#the-mutation-test-that-reverted-the-file-it-was-testing)

**None of this is the safety net.** This section stops you re-breaking what you already understand.
It has never once caught a defect of the kind that actually escaped here, and read on its own it
will leave you trusting a green suite.

---

## Tests that stop testing

- **A literal list naming a type's members is a test that stops testing** on the day the type
  changes. Derive it — `Object.keys(AGENT_LABELS)`, `PHASES`, `AdvanceOutcome["kind"]`. Three
  instances before this was named, including, in one file, the test whose stated purpose was
  catching exactly that drift.
  [→](INCIDENTS.md#the-literal-lists-that-named-a-types-members)
- **A fixture that models another module's output is a test that cannot see that module change.**
  Build the fixture with the real function. Two tests hand-wrote the `bot: ` prefix their own writer
  was failing to send, and stayed green while the loop they asserted against ran in public.
  [→](INCIDENTS.md#the-two-tests-that-proved-the-loop-terminates-while-it-did-not)
- **A test whose name describes something it does not check.** The solver has shipped two, both
  green, both guarding nothing. **Read the test back against the wrong implementation.**
  [→](INCIDENTS.md#the-two-regression-tests-that-guarded-nothing)
- **A test can be a real guard by a route nobody wrote down**, which is the same defect wearing the
  other face: a suite that catches the bug through an incidental fixture in an unrelated block will
  stop catching it silently, while the test named for it stays green.

---

## Measure, do not assume, and the assumption is usually about your own code

Every significant correction in this project came from running something, not from thinking harder.

| assumed                              | measured                                                                                                                                                                                                 |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--allowedTools` restricts the model | It restricts **nothing** for builtins; it is an auto-approve list. Every triage run ever made had `Bash`, while three comments claimed otherwise [→](INCIDENTS.md#the-allowlist-that-restricted-nothing) |
| a ticket costs $0.11                 | **$3.99**, and that is the _cheap_ path — a bail before any code is written [→](INCIDENTS.md#the-ticket-that-cost-fourteen-times-its-estimate)                                                           |
| a `labels NOT IN` clause is fine     | Real gotcha on this board; proved with a control group in the same query [→](INCIDENTS.md#the-jql-clause-that-excludes-on-absence)                                                                       |
| an extra review round costs ~$0.60   | **$0**, refuted by the very run meant to confirm it [→](INCIDENTS.md#the-round-that-refuted-its-own-cost-estimate)                                                                                       |

**Probe with a control.** A negative result means nothing unless you have shown the setup was one
clause away from a positive.

**State which case your check does not cover, before you quote it as evidence.** A green check is a
statement about the case it ran, and the gap between that and the claim made from it is the
most-recorded cause in `INCIDENTS.md` — **seven** occurrences, not seven entries; count headings
there and you get a different number. Read it with its own gap stated, because it is an instance of
the rule: all seven happened on 2026-09-09, and the entries predating the convention were never
re-read for this shape. The discipline is one sentence written next to the evidence: _this measures
X; it does not measure Y._ If you cannot write that sentence, you do not yet know what your check
proved.

Three things make it hard to remember, and each is an instance:

- **Knowing the mechanism is not the same as checking the case.** `session-brief.sh` was registered
  with no matcher, deliberately, _so that no trigger value could be missed_ — and the same session
  then read a silent hook as proof that its exit code was wrong, never considering that nothing had
  invoked it [→](INCIDENTS.md#the-silent-guard-that-was-diagnosed-before-anyone-checked-whether-it-had-run).
- **Owning the check is not the same as running it.** A branch count was quoted from a list of
  merged pull requests while the command that measures it sat three lines above, put there by an
  earlier instance of the same mistake
  [→](INCIDENTS.md#the-dead-step-that-was-alive-from-a-merge-list-read-instead-of-a-count).
- **Deciding the outcome in advance does not tell you which case you are in.** Pre-registering both
  branches of a probe stops you rationalising the result. It does nothing about a third cause you
  never listed, and the probe that introduced this rule hit exactly that.

**The direction cuts both ways, and the rarer direction is worse.** Six of the seven overstated a
guard's coverage, which review can catch. The seventh _under_stated it — a working, testable guard
was written down as untestable, with a note saying its silence "means nothing at all". That retires
a check quietly, and nothing goes red when it happens
[→](INCIDENTS.md#the-dead-step-that-was-alive-from-a-merge-list-read-instead-of-a-count).

**This rule's own history is the caution, not the vindication.** `INCIDENTS.md` held it as a
candidate "awaiting a third instance" and shipped it at seven — but the candidate was proposed at
13:19 on 2026-09-09, met three by 13:51, and became a rule at 16:04. Two hours is not a failed
amendment process. What did fail is the counting: one day's work on the checks kept turning up the
same shape, each sighting was filed as fresh evidence, and nothing asked whether the seven were
independent. Collecting is not amending, and **seven sightings from one sitting are not seven
instances.** When the threshold is met, change the rule.

**An unreferenced declaration is evidence about a name, not about a guarantee.** Trace the guarantee
to the code that would break without it. Two more of the same shape: a "dead" function with 21
assertions turned out to be a thin wrapper over something with three live call sites, and "no read
tools" was true of the MCP allowlist and false of the session, written by someone who checked the
allowlist and read it as describing the whole surface.
[→](INCIDENTS.md#the-read-tools-the-header-said-were-denied)

**When you are corrected, check before agreeing.** The value is in verifying and finding _why_,
which usually changes the fix. Folding is not agreement, it is the loss of one data point.

---

## The loop: dev, test, run, human, reevaluate

**dev → test → run → human → reevaluate.**
**This is the section that earned the low escape rate, and it is the one most likely to be skipped,
because everything before it looks like the mechanism and is not.**

### The tests did not catch the interesting bugs. Running it did.

Not an opinion — the record is one-sided:

| defect                                                                                                                                    | the suite said                          | what actually caught it                            |
| ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------- |
| [`.unref()` killed the one loop whose job is waiting](INCIDENTS.md#the-unref-that-killed-the-only-loop-whose-job-is-waiting)              | green, all of it                        | running it once; the process exited 13 immediately |
| [`attachWorktree` refused the reuse every real run needs](INCIDENTS.md#the-worktree-reuse-that-every-real-run-needs-and-the-code-refused) | green                                   | the first `--advance` against a real pull request  |
| [the tool allowlist restricts nothing](INCIDENTS.md#the-allowlist-that-restricted-nothing)                                                | green for the project's life            | a four-probe experiment with a control             |
| [a local hook vetoing `Write`, silently](INCIDENTS.md#the-hook-that-vetoed-write-silently)                                                | green                                   | a $4.50 run that produced nothing                  |
| [an icon reconstructed from an adjective](INCIDENTS.md#the-favicon-reconstructed-from-an-adjective)                                       | green, **plus two reviews and a human** | comparing the artifact to the ticket, days later   |

Every one of those shipped with tests passing and mutations caught. A green suite means **no test
disagrees with the code**, which is a statement about the tests. It is not evidence about reality,
and the defects that matter most live exactly where no test was pointed.

> Tests protect what you already understood. Running it is how you find out what you did not.

So the discipline above is necessary and is **not** the safety net. It stops regressions in things
you have already learned. The loop below is what does the learning.

### One turn of the loop

**dev → test → run → human → reevaluate**, and every turn is as small as you can make it.

1. **dev** — the smallest change that can be driven end to end. Not the smallest change that
   compiles.
2. **test** — the guard, and the mutation that proves it. Then stop trusting it.
3. **run** — dry first, because it is free, then against one named real target. Machine-checked:
   read exit codes and artifacts, never a model's claim that it worked. **A run that can fail
   without saying why is not a turn of this loop** — it is a charge with no lesson attached, so
   [instrument the failure path first](BUILDING.md#instrument-the-failure-path-first).
4. **human** — a person **uses the feature**: runs it, looks at what it produced, tries the case the
   ticket describes. Functional testing, not review. See below; this is the step that gets dropped.
5. **reevaluate** — write down what the run taught, fix the prose it falsified, and re-plan the next
   turn from what you now know rather than from what you assumed at the start.

**Small turns are not a style preference, they are what makes step 5 possible.** A run that fails
tells you _which change broke it_ only if there was one change.
[→ three phases stacked on one branch](INCIDENTS.md#the-three-phases-stacked-on-one-branch)

**Cadence beats rigour.** Five cheap turns find more than one thorough one, because four of the five
teach you something you would not have thought to check.

### Step 4 is the one that gets dropped, and dropping it is invisible

**Reading the code is not step 4. Exercising the behaviour is.** On the favicon pull request, two
automated reviews and a person all read the diff and argued about link ordering. The icon that
shipped was not the attached asset. **Nobody loaded the page and looked at the favicon.**
[→](INCIDENTS.md#the-favicon-reconstructed-from-an-adjective)

> **Step 4 asks: does it actually do the thing?** Run the command. Open the page. Look at the board.
> Check the output against what the ticket asked for — by using it, not by reading about it.

This gets harder the more capable the producer is, because a capable producer always emits something
plausible enough to survive a code review. Plausibility is what defeats review, and plausibility is
what capability buys. **Working software is the only thing plausibility cannot fake.**

Where it applies is wider than a UI: run the CLI and read the report it wrote; look at the ticket on
the real board and see whether the labels moved; open the pull request and see what a reviewer will
see. Anything with a user-visible surface has a way of being _used_, and that is the test.

### Ask for it — and nudge, never refuse

**An agent cannot perform step 4.** No browser, no eyes on the board, no judgement about whether the
icon looks right. So the obligation is to _ask_, and to ask well: **hand over the command itself**,
in [the form below](#finish-every-feature-by-handing-over-the-command) — the exact line with the
real target filled in, what would falsify it, and what it has never done.

**Ask when any of these is true**, without waiting to be prompted:

- a feature just became drivable for the first time
- several turns have gone by with no real run — or **no product code has changed at all**, which is
  the case that looks like progress and reads as green
- a privilege is about to widen, or a loop is about to run unattended
- something is about to be committed that has only ever been exercised by its own tests

**Then continue.** This is a nudge and never a gate:

- do not withhold work, refuse to commit, or make the test a precondition for the next turn
- do not ask twice in one turn, and do not repeat it in every message — say it once, clearly
- press harder as the gap widens, and hardest immediately before something runs unattended, since
  that is the moment the person stops being available to notice
- **record the debt where it will be seen** rather than only in conversation. `PLAN.md` has a "Still
  unobserved" section for exactly this — a live list of things that work in theory and have never
  been watched working. An unobserved feature is not a failure; an unobserved feature nobody has
  written down is.

The person may have reasons to skip it, and skipping it deliberately with the risk stated is a
legitimate decision. Skipping it because nobody mentioned it is not.

### Step 5 is where it compounds

A run that is not written up is a run paid for twice. The output of step 5 is concrete:

- the prose the run falsified, fixed **now**
- what was learned, into **the rule it changes** in this skill — or into [INCIDENTS.md](INCIDENTS.md)
  if it changes no rule, or nowhere at all. Never into `PLAN.md`, which tracks unbuilt work and is
  read by nobody looking for a lesson.
  [→](INCIDENTS.md#the-lesson-store-that-was-the-incident-it-was-written-to-fix)
- **the prediction you got wrong**, and why — this is the highest-value artifact of the whole loop
  and the only one that improves the _next_ prediction

**Predict before step 3, in writing.** A run that confirms what you expected teaches almost nothing;
a run that refutes it teaches the most, and you only collect that if the guess was recorded first.
[→ the round that refuted its own cost
estimate](INCIDENTS.md#the-round-that-refuted-its-own-cost-estimate)

---

## Every capability gets a one-line command, and it pays for itself immediately

**A feature with no command cannot be run, and a feature that cannot be run cannot complete steps 3
and 4.** So this is not ergonomics — it is the precondition for the only thing that has ever caught
a real defect here. Build the command with the feature, in the same commit, never "later".

The service's whole surface is hand-drivable and that is deliberate. The rungs themselves are owned
by [`README.md`](../../../README.md#commands) and by each parser's own `USAGE` string, which is what
a new one must update — not repeated here, where a copy would rot out of sight.

There is no `--plan` flag and there should not be: the bare form _is_ the first rung, which is the
dry-by-default rule showing up in the argument parser rather than in a doc comment.

### The command outlives the phase that needed it

**Treat the command as a deliverable, not as scaffolding for a test you are about to do.** The
strongest evidence is that the commands built purely to make a phase verifiable turned out to be the
tools an operator reaches for afterwards, on real work, with no development in progress.

`pnpm triage:once <KEY>` is the clearest case. It exists only because every phase must be drivable
by hand against one chosen ticket. It has since been used repeatedly, as itself: **re-triage this
one ticket, now, because I want its verdict.** The daemon can only offer "wait for the poller to
notice"; the flag offers a chosen ticket on demand, which is a different and more useful thing.

That reframes the cost argument: a command is not overhead recovered later through cheaper
debugging, it is frequently **the most-used thing the phase produces**. So give it the care given to
a feature — a usable name, honest `USAGE` text, a report worth reading, an exit code — not a debug
entry point left where it fell.

### The rules that make a command worth having

- **A positional target.** Operate on the thing _you_ chose, not on whatever the queue surfaces. A
  command you cannot point is a command you cannot use to reproduce anything.
- **Dry by default; every mutation behind a flag that must be typed.** Dry runs cost nothing, so the
  first version of any feature should be free to run and therefore run constantly.
- **Cumulative flags**, so the escalation reads as the escalation it is. When a mode genuinely is
  _not_ a later step of the same run, make it a separate mode and have the parser refuse to combine
  it, rather than bending the ladder — `--advance` acts on a pull request a previous run created, so
  implying `--solve` would re-solve the ticket from scratch, the opposite of what the word says.
- **Resumable from what the last run left behind.** This is the rule that saves the most money and
  the one most often missed — and getting it wrong is invisible to tests.
  [→](INCIDENTS.md#the-worktree-reuse-that-every-real-run-needs-and-the-code-refused)
- **Report to a file, not just stdout**, because stdout scrolls away and a dry run exists to be
  judged after the fact.
- **A machine-readable exit code**, so a run can be judged without reading its prose.
- **Fail before the expensive part.** The chain stops before the claim when triage says the ticket is
  not solvable, and returns before the model runs when there is nothing in the inbox.

### The economics, measured on this project

The whole queue dry is **$0**; an advance with an empty inbox is **$0** and 2.5 seconds; a review
round on an open pull request is **$0.94**; a full solve to a bail is **$3.99**, and that is the
cheap path. Every one of those was measured on a real run, and each is
[recorded where it was measured](INCIDENTS.md#the-ticket-that-cost-fourteen-times-its-estimate).

**Without a rung for the step you are debugging, every attempt costs the whole chain.** The review
loop was iterated on at $0.94 a round precisely because `--advance` existed; through `--solve` each
of those turns would have re-solved the ticket first. And the cost of learning something slowly is
real: a wrong fitness call was paid for **three times at $1.97** before it was diagnosed.
[→](INCIDENTS.md#the-fitness-call-that-was-refused-three-times-for-two-wrong-reasons)

The time argument is the same argument. A command turns "set up the state, then reproduce the bug"
into one line you can run twenty times while you work, which is what makes the cadence above
affordable at all.

### Finish every feature by handing over the command

**The last thing an implementation produces is the line that runs it.** Not a description of what
changed — the command, copy-pasteable, with a real target filled in, and one sentence on what to
look at. The ask for a human run is made of this, and a feature is not handed over until it exists.

```
pnpm solve:once SSX-3833 --pr
  → opens a draft PR. Look at the diff: the icon should be the attached SVG,
    not something reconstructed from the description.
```

Three things it must do, and the second is the one usually skipped:

- **Name the safe form first.** If there is a dry rung, hand that over before the one that writes,
  so the first thing the person runs cannot cost or change anything.
- **Say what would falsify it**, not what success looks like. "The labels should move" invites
  agreement; "if `agent:solving` is still there afterwards, the release did not run" invites a look.
- **Say what the command has never done.** A command being new is exactly when its output is least
  trustworthy, and that is not visible from the command line.

This is also the cheapest correction available for the step-4 failure. The favicon shipped wrong
because nobody loaded the page — and nobody loaded the page partly because doing so meant
reconstructing how. **A person who is handed the command will usually run it; a person who has to
work out the command usually will not.** The gap between those two is most of step 4.

→ [FINISHING.md](FINISHING.md)
