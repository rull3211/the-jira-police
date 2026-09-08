---
name: dev-house-rules
description: Development discipline for the-jira-police — writing the plan before the work, navigating this codebase, the dev/test/run/human/reevaluate loop, making failures verbose, giving every capability a command, how to guard and phase a privilege, branch and dead-code hygiene, and keeping README.md, ARCHITECTURE.md and PLAN.md true. Also how to amend these rules after a defect gets through. Use for any change to this repository, code or prose.
---

# House rules

This skill is **not** staged into any solve pass. `prepareSkillRoot` copies only `agent-solve` into
a root that must contain nothing else, so nothing here reaches a model the service runs. It is for
whoever is developing the service.

These rules were not designed. Each one is the generalisation of a defect that got through, and the
war story is kept beside the rule because the story is what makes it stick. When a rule seems
expensive, the story is the argument.

**So this document is never finished.** When something escapes — a bug on `main`, a feature built
wrongly, a paid run that taught nothing — the incident is worked back into these rules rather than
just fixed. **Propose the amendment and say why before editing it** (§16). The rules matter more as
the project grows, not less: everything here scales with the number of things nobody has re-read
lately.

**If you read one section, read §7.** The rest is craft that stops known problems recurring; §7 is
the loop that found them in the first place, and it is the only one whose absence is invisible —
skip it and everything still looks green.

---

## 0. The document contract, which is the one that is always in force

Four documents describe this service and how it is built, and **all four are treated as source**:

|                   | what it answers                                 | goes stale when                                         |
| ----------------- | ----------------------------------------------- | ------------------------------------------------------- |
| `README.md`       | how do I run it, what do the commands do        | a flag, script or setting changes                       |
| `ARCHITECTURE.md` | how does it work and why is it shaped this way  | any module, invariant or setting changes                |
| `PLAN.md`         | what is **not** built yet, and what was learned | work **starts**, anything ships, or anything is learned |
| **this skill**    | how we work, and what went wrong last time      | **a defect gets through that it does not cover** (§16)  |

**Rules, in order of how often they are broken:**

1. **Prose falsified by a change is rewritten in the same commit.** Not the next one. A commit that
   makes a sentence false and leaves it is the defect this project exists to catch, committed by
   the person catching it.
2. **`PLAN.md` records what is not built.** When something ships, its entry is **deleted**, not
   struck through. The exception is a lesson that lives nowhere else — that moves to the "learned"
   section. A plan that accumulates completed work stops being read, and a plan nobody reads is
   how two people build the same thing twice.
3. **Numbers in prose are facts and rot like facts.** Test counts, costs, line counts, "46 settings"
   — grep for them after any change that moves them. Today's deletion moved a test count cited in
   two documents.
4. **When a document and your reasoning disagree, the document might be right.** See §6.

**Before finishing any change, ask which of the four you just falsified.** Usually one. Often two.

### The plan is written before the work, not after it

Rule 2 fires on the way out: something ships, its entry is deleted. That is a rule for the context
that _finishes_ a piece of work, and for a long time it was the only one — which left nothing at all
for the context that **starts** one.

So, before beginning anything that is not a one-line fix: **write it into `PLAN.md` first.** What is
being attempted, why now, what it would let the service do that it cannot do today, and what would
make it the wrong idea. Then do the work. The entry is deleted when it ships, exactly as rule 2 says
— the two halves are the same rule seen from both ends.

**The reason is specific to how this project is built, and it is not tidiness.** Work here is done by
agents in sessions that end, compact, and are replaced. A session that holds the intent only in its
own context is one compaction away from losing it, and the next context inherits a diff and a branch
name. A diff says what changed; it never says what was being attempted or what had already been
ruled out. Written down, the next context — human or agent — starts from the argument instead of
reverse-engineering it.

The evidence is the session that produced this paragraph. The guard hooks, `CLAUDE.md` and the
enforcement layer were built end to end without a single line in `PLAN.md` describing them. The work
was fine; the record was that a branch called `chore/agent-guardrails` appeared with five new files
in it. Everything about _why_ lived in one conversation, and that conversation had already been
compacted once.

Two failure modes it closes, both of which have happened here:

- **Two contexts build the same thing twice**, because neither could see the other's intent. Rule 2
  names this for shipped work; it is worse for unshipped work, where there is no code to collide
  with and the duplication is only found later.
- **A decision gets re-litigated from scratch**, because the argument against the obvious
  alternative was made once, in a session that is gone. `PLAN.md` is full of these — the sections
  explaining why the daemon is last, why `--advance` is not a rung, why state lives in Jira — and
  every one of them exists because someone wrote the reasoning down before building against it.

**A plan entry is a hypothesis, not a commitment.** It is expected to be wrong in places; that is
what makes it worth writing, because the run that refutes it (§7) has something to refute. An entry
that only ever gets deleted intact was not a plan, it was a description written in advance.

---

## 1. The defect class

**Prose that describes behaviour the code no longer has.** Everything below is a special case.

It is worth naming precisely because it is _invisible to every tool_. Types, lint and tests all
pass; the comment is the only thing that is wrong, and it is the thing the next reader trusts most.

Three forms, hardest last:

- **Plainly false.** Five files said the Jira credential was "discovery only" long after
  `updateLabels` shipped — including `wiring.ts`, the module that calls it.
- **Superseded.** A doc comment promising a precondition that moved elsewhere. See §6's story.
- **True of behaviour it was not describing.** `runReviewChain` printed _"Ctrl-C is safe: nothing is
  held open between rounds"_ directly above a `.unref()`. The sentence reads as a description of
  the unref and is not — what makes an interrupt safe is that no worktree or lock is held. The
  unref was deleted as a bug; the sentence stayed true and still reads as coverage of it. **This
  form survives review indefinitely,** because a reviewer checks whether the sentence is true.

---

## 2. A guard is not shipped until a test fails when it is unplugged

Write the guard, then **break it deliberately and watch a test go red.** If the suite stays green,
you have shipped a decoration and a false sense of coverage, which is worse than shipping nothing.

State the mutation in the commit message. "Nine mutations caught" is the unit of work here.

**Unplug the _plausible wrong implementation_, not the bug.** This is the refinement, and it was
measured rather than reasoned. Replaying seven shipped assertions:

| the new assertions go red against | count      |
| --------------------------------- | ---------- |
| the **original** bug              | **7 of 7** |
| the **plausible wrong fix**       | **1 of 7** |

Classic red-green was fully satisfied by a suite that was six-sevenths decorative. Red-green unplugs
the _defect_; this rule unplugs the _almost-correct change_. Only the second catches anything.

**A mutation that no test can kill but the type checker does is fine** — say so where it would
otherwise look like a gap.

**Some properties belong to a program, not a function.** _The event loop stays alive_ cannot be
observed from inside a test runner that is itself holding the loop open. Run a child process and
assert on its exit code.

**None of this is the safety net — see §7.** This section stops you re-breaking what you already
understand. It has never once caught a defect of the kind that actually escaped here, and read on
its own it will leave you trusting a green suite.

---

## 3. Tests that stop testing

- **A literal list naming a type's members is a test that stops testing** on the day the type
  changes. Derive it — `Object.keys(AGENT_LABELS)`, `PHASES`, `AdvanceOutcome["kind"]`. Three
  instances before this was named, including, in one file, the test whose stated purpose was
  catching exactly that drift.
- **A fixture that models another module's output is a test that cannot see that module change.**
  Build the fixture with the real function.
- **A test whose name describes something it does not check.** The solver has shipped two: a
  timezone test comparing against the system default (so it separates fix from bug only on a
  non-UTC JVM), and a "does not depend on the run date" block where every case used a 31-day month.
  Both passed. Both guarded nothing. **Read the test back against the wrong implementation** — §2.

---

## 4. Two questions that agree today are still two questions

The most productive rule in the repository, and always tempting to violate because the code looks
duplicated.

`terminalLabelAfter` is deliberately not spelled `!isFailureExit`, though today they coincide
exactly. One asks _did this produce a usable answer_ (for an exit code); the other asks _is this
ticket's fate decided_ (for a queue). Derive one from the other and a future change to an exit code
silently relabels tickets on a live board. Same for `reviewStageAfter` reading the draft flag rather
than `pushed`, and `silent` not being `!stop`.

**The converse is also a rule, and the tension is resolved by the question, not the shape.** Two
identical literals answering the _same_ question must be collapsed — when reviewing came to replace
solving, two label lists genuinely became one and staying separate would have been the bug.

> Ask what each expression is _for_. Same purpose, one copy. Different purpose, two — and a comment
> saying they agree today and why that is a coincidence.

---

## 5. Fail closed, except guards, which fail open

- **A setting that grants a privilege defaults off.** A typo must not arm anything.
- **A setting that only reports defaults on**, and reads `!== "false"` rather than `=== "true"`.
  A typo must not silently _withdraw a guard_. `FAIL_FIRST_CHECK` is the only setting in the file
  shaped this way, and the asymmetry is the point.
- **An allowlist gets no fallback at all.** A default for `SOLVE_REPOS` would be a write privilege
  that survives being deleted from configuration — an operator revoking access would have it handed
  straight back, editable only in source. Unset means nothing is allowed.
- **Every ambiguous read resolves to `null`.** Two `svc:` labels, or none, or one that fails the
  name pattern, all mean _unknown_. A value that decides which repository gets written to must never
  be a contradiction resolved into a decision.
- **An unrecognised enum value is a startup error, not a fallback.** Guessing guesses toward more
  privilege.
- **Write the brake before doing the work.** The round counter is a _reservation, not a receipt_:
  bump and persist it before the pass runs. Post it afterwards and a failed write hands back a free
  round, every tick, forever.

---

## 6. Measure, do not assume — and the assumption is usually about your own code

Every significant correction in this project came from running something, not from thinking harder.

| assumed                              | measured                                                                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--allowedTools` restricts the model | It restricts **nothing** for builtins; it is an auto-approve list. Every triage run ever made had `Bash`, while three comments claimed otherwise |
| a ticket costs $0.11                 | **$3.99**, and that is the _cheap_ path — a bail before any code is written                                                                      |
| a `labels NOT IN` clause is fine     | Real gotcha on this board; proved with a control group in the same query                                                                         |
| an extra review round costs ~$0.60   | **$0**, refuted by the very run meant to confirm it                                                                                              |

**Probe with a control.** A negative result means nothing unless you have shown the setup was one
clause away from a positive.

**And the newest one, because it is the subtlest.** A reachability sweep found
`REQUIRED_MCP_SERVERS` unreferenced, whose comment promised _"servers that must report `connected`
before the run is trusted"_. It was written up as a promise nothing kept. It was enforced the whole
time — `assertMcpReady` throws on the init event — and `ARCHITECTURE.md` said so in two places,
including a table recording it firing for real. The constant had merely been superseded by a
per-call option.

> **An unreferenced declaration is evidence about a name, not about a guarantee.** Trace the
> guarantee to the code that would break without it.

Two more of the same shape: a "dead" function with 21 assertions turned out to be a thin wrapper
over something with three live call sites — so the assertions were redirected, not deleted. And
"no read tools" was true of the MCP allowlist and false of the session, written by someone who
checked the allowlist and read it as describing the whole surface.

**When you are corrected, check before agreeing.** Both times the user was right this session, but
the value came from verifying and finding _why_, which changed the fix.

---

## 7. The loop: dev → test → run → human → reevaluate

**This is the section that earned the low escape rate, and it is the one most likely to be skipped,
because the four sections above it look like the mechanism and are not.**

### The tests did not catch the interesting bugs. Running it did.

Not an opinion — the record is one-sided:

| defect                                                         | the suite said                          | what actually caught it                            |
| -------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------- |
| `.unref()` killed the one loop whose job is waiting            | green, all of it                        | running it once; the process exited 13 immediately |
| `attachWorktree` refused the reuse that happens every real run | green                                   | the first `--advance` against a real pull request  |
| the tool allowlist restricts nothing                           | green for the project's life            | a four-probe experiment with a control             |
| a local hook vetoing `Write`, silently                         | green                                   | a $4.50 run that produced nothing                  |
| an icon reconstructed from an adjective                        | green, **plus two reviews and a human** | comparing the artifact to the ticket, days later   |
| a ticket costs $0.11                                           | n/a                                     | one real invoice, wrong by 14×                     |

Every one of those shipped with tests passing and mutations caught. A green suite means **no test
disagrees with the code**, which is a statement about the tests. It is not evidence about reality,
and the defects that matter most live exactly where no test was pointed.

> Tests protect what you already understood. Running it is how you find out what you did not.

So the discipline in §2 and §3 is necessary and is **not** the safety net. It stops regressions in
things you have already learned. The loop below is what does the learning.

### One turn of the loop

**dev → test → run → human → reevaluate**, and every turn is as small as you can make it.

1. **dev** — the smallest change that can be driven end to end. Not the smallest change that
   compiles.
2. **test** — the guard, and the mutation that proves it (§2). Then stop trusting it.
3. **run** — dry first, because it is free, then against one named real target. Machine-checked:
   read exit codes and artifacts, never a model's claim that it worked. **A run that can fail
   without saying why is not a turn of this loop** — it is a charge with no lesson attached (§12).
4. **human** — a person **uses the feature**: runs it, looks at what it produced, tries the case the
   ticket describes. Functional testing, not review. See below; this is the step that gets dropped.
5. **reevaluate** — write down what the run taught, fix the prose it falsified, and re-plan the next
   turn from what you now know rather than from what you assumed at the start.

**Small turns are not a style preference, they are what makes step 5 possible.** A run that fails
tells you _which change broke it_ only if there was one change. When three phases stacked on one
branch here, the plan itself had to record that "D4a's end-to-end test gates all three" — that is
the loop degrading into a waterfall, visible in advance and accepted anyway.

**Cadence beats rigour.** Five cheap turns find more than one thorough one, because four of the five
teach you something you would not have thought to check.

### Step 4 is the one that gets dropped, and dropping it is invisible

**Reading the code is not step 4. Exercising the behaviour is.** On the favicon pull request, two
automated reviews and a person all read the diff and argued about link ordering. The icon that
shipped was not the attached asset — it had been reconstructed from an adjective in the description.
**Nobody loaded the page and looked at the favicon.** One glance at a running browser tab would have
settled in a second what three careful code reviews missed entirely.

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
icon looks right. So the obligation is to _ask_, and to ask well:

- **Name the exact command**, copy-pasteable, with the real ticket or target filled in — §8 is how
  to make sure one exists, and what the handover should contain.
- **Say what to look at** and what would falsify it — "the tab icon should be the attached SVG, not a
  red block T" beats "please check the favicon works".
- **Say what has not been observed yet**, plainly.

**Ask when any of these is true**, without waiting to be prompted:

- a feature just became drivable for the first time
- several turns have gone by with no real run — code has accumulated on the strength of green tests
- a privilege is about to widen, or a loop is about to run unattended
- something is about to be committed that has only ever been exercised by its own tests

**Then continue.** This is a nudge and never a gate:

- do not withhold work, refuse to commit, or make the test a precondition for the next turn
- do not ask twice in one turn, and do not repeat it in every message — say it once, clearly
- press harder as the gap widens, and hardest immediately before something runs unattended, since
  that is the moment the person stops being available to notice
- **record the debt where it will be seen** rather than only in conversation. This repository has a
  "Still unobserved" section in `PLAN.md` for exactly this — a live list of things that work in
  theory and have never been watched working. An unobserved feature is not a failure; an unobserved
  feature nobody has written down is.

The person may have reasons to skip it, and skipping it deliberately with the risk stated is a
legitimate decision. Skipping it because nobody mentioned it is not.

### Step 5 is where it compounds

A run that is not written up is a run paid for twice. The output of step 5 is concrete:

- the prose the run falsified, fixed **now** (§0)
- what was learned, into the plan's learned section if it lives nowhere else
- **the prediction you got wrong**, and why — this is the highest-value artifact of the whole loop
  and the only one that improves the _next_ prediction

**Predict before step 3, in writing.** A run that confirms what you expected teaches almost nothing;
a run that refutes it teaches the most, and you only collect that if the guess was recorded first.
The `~$0.60 per round` estimate was refuted by the very run meant to confirm it, and that only
counted as a finding because the number had been written down beforehand.

---

## 8. Every capability gets a one-line command, and it pays for itself immediately

**A feature with no command cannot be run, and a feature that cannot be run cannot complete steps 3
and 4 of §7.** So this is not ergonomics — it is the precondition for the only thing that has ever
caught a real defect here. Build the command with the feature, in the same commit, never "later".

The service's whole surface is hand-drivable and that is deliberate:

```
pnpm poll:once                       pnpm solve:once                  # whole queue, dry
pnpm triage:once <KEY> [--write]     pnpm solve:once <KEY>            # one ticket, dry
pnpm watch:once <KEY> [--write]      pnpm solve:once <KEY> --claim|--solve|--pr|--review
                                     pnpm solve:once <KEY> --advance  # a separate mode
                                     pnpm bot:once <KEY> --review
```

There is no `--plan` flag and there should not be: the bare form _is_ the first rung, which is the
dry-by-default rule showing up in the argument parser rather than in a doc comment.

That block is an illustration of the _shape_, not the reference — the commands are owned by
`README.md` and by each parser's own `USAGE` string, which is what a new rung must update (§14).

### The command outlives the phase that needed it

**Treat the command as a deliverable, not as scaffolding for a test you are about to do.** The
strongest evidence for this is that the commands built purely to make a phase verifiable turned out
to be the tools an operator reaches for afterwards, on real work, with no development in progress.

`pnpm triage:once <KEY>` is the clearest case. It exists because §9 requires every phase to be
drivable by hand against one chosen ticket — that is the only reason it was built. It has since been
used repeatedly, as itself: **re-triage this one ticket, now, because I want its verdict.** The
daemon can only offer "wait for the poller to notice"; the flag offers a chosen ticket on demand,
which is a different and more useful thing.

That reframes the cost argument. A command is not overhead recovered later through cheaper
debugging — it is frequently **the most-used thing the phase produces**, and the queue that
motivated it is the part nobody interacts with. So when the command feels like a detour from the
"real" feature, that instinct has been wrong every time it has been tested here.

It follows that the command deserves the care given to a feature: a usable name, honest `USAGE`
text, a report worth reading, and an exit code. Not a debug entry point left where it fell.

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
  the one most often missed. `--advance` attaches to the existing branch and worktree instead of
  redoing the solve.
- **Report to a file, not just stdout**, because stdout scrolls away and a dry run exists to be
  judged after the fact.
- **A machine-readable exit code**, so a run can be judged without reading its prose.
- **Fail before the expensive part.** The chain stops before the claim when triage says the ticket is
  not solvable, and returns before the model runs when there is nothing in the inbox.

### The economics, measured on this project

| you can run                    | it costs                    |
| ------------------------------ | --------------------------- |
| the whole queue, dry           | **$0**                      |
| a review round on an open PR   | **$0.94**                   |
| an advance with an empty inbox | **$0**, and 2.5 seconds     |
| a full solve to a bail         | **$3.99**, the _cheap_ path |

**Without a rung for the step you are debugging, every attempt costs the whole chain.** The review
loop was iterated on at $0.94 a round precisely because `--advance` existed; through `--solve` each
of those turns would have re-solved the ticket first. And the cost of learning something slowly is
real: a wrong fitness call was paid for **three times at $1.97** before it was diagnosed.

The time argument is the same argument. A command turns "set up the state, then reproduce the bug"
into one line you can run twenty times while you work, which is what makes §7's cadence affordable
at all.

### Finish every feature by handing over the command

**The last thing an implementation produces is the line that runs it.** Not a description of what
changed — the command, copy-pasteable, with a real target filled in, and one sentence on what to
look at. §7 says to ask for the human run; this is what the ask is made of, and a feature is not
handed over until it exists.

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

This is also the cheapest correction available for the failure §7 describes. The favicon shipped
wrong because nobody loaded the page — and nobody loaded the page partly because doing so meant
reconstructing how. **A person who is handed the command will usually run it; a person who has to
work out the command usually will not.** The gap between those two is most of step 4.

---

## 9. Phase a privilege, and drive it by hand first

Every capability ships in its own reviewable commit, in this order:

1. **Built but inert** — nothing constructs its dependencies. The refusal is structural, not
   promised, and wiring it later is a visible diff in the place a reviewer looks.
2. **Dry run** — does everything, changes nothing, and writes a report to a file, because stdout
   scrolls away and a dry phase exists to be judged.
3. **One named target**, chosen by a person, behind a flag that must be typed.
4. **The loop, last.** It adds no capability; it only removes the person. Add that property after
   every other one has been watched.

Each of those first three steps is a command (§8), which is what makes the ordering enforceable
rather than aspirational.

**One branch per privilege**, never `main`. A human always merges; this service has no merge path
and neither do you.

**Predict before you run.** Write down what you expect, then run it. The most valuable runs are the
ones that refute the prediction, and you only get that if the prediction was recorded first.

---

## 10. State lives in the remote system

Dedupe, cursors and counters live on the ticket or the pull request, never in `state/`. They then
survive a restart, a wiped state directory and a second instance, and **a human can read them.**
Losing a counter _releases_ a spend brake, which is the wrong direction for the one number deciding
whether to pay for another pass.

The cost is that a read-modify-write can clobber a concurrent edit. Mitigate it — read back and
verify, nothing between the read and the write, not even a log line — and **write the residual risk
down** rather than implying it is closed.

---

## 11. Untrusted input, and the channel it arrives on

Ticket text, comment bodies, reviewer output and anything a model wrote are **data, not
instruction**. Treat structure you did not create as forgeable: collapse whitespace, cap lengths,
cut on word boundaries and mark the cut.

- **Prefer the structured channel to parsing prose.** Read review threads over scraping a summary.
  When a model must return several things, give it _several fields_ and let the renderer build the
  layout — one field asked for two things is why a bail arrived as four thousand characters with no
  line break in it.
- **Do not put an instruction in a prompt that the API will violate.** "Verbatim, byte for byte"
  cannot survive a server-side format conversion, and teaching a model that this prompt's rules are
  approximate is the last thing to teach it.
- **Our own activity is excluded by kind, never by clock.** Key it on a sentinel the writer controls.
  There is often no identity to key on — this service posts as the operator's own account.
- **A field this service writes must never be allowlisted** as evidence that something changed.

---

## 12. A failure must explain itself on the first run

**In ordinary software you re-run with more logging. Here you frequently cannot.** A run costs real
money, takes minutes to tens of minutes, and is not reproducible — the model, the reviewer and the
board have all moved on by the time you look. So the first failure is usually the only sample you
get, and a failure that produced no diagnostic has to be **bought twice**: once to fail silently,
once to fail again after you have added the instrumentation that should have been there the first
time.

That sequence — fail, learn nothing, go build logging and visibility and ticket write-back, then
re-run the expensive thing to find out what happened — has been the single largest recurring cost in
this project. Not wrong answers. **Failures that charged full price and returned nothing.**

| the failure                                           | what it left behind                                                                                 | what the retry cost                                          |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| a local policy hook denied the write pass its `Write` | **nothing** — every label released byte for byte, no comment; the board matched an untouched ticket | claim, worktree, base verify, triage, recon, fix — ~$4.50    |
| a recon bail                                          | `agent:failed` was built, tested and had **no writer**, so a declined ticket read as an untried one | in auto mode, re-bought every tick, with nothing to clear it |
| the laptop slept mid-pass                             | a timeout kill and a worktree kept as evidence of nothing                                           | the whole pass                                               |
| `unresolved` computed and then dropped                | the one honest signal — that a shipped regression test was vacuous — discarded unread               | the decorative test shipped and is still there               |

What these share is the important part: **each one already had the information and threw it away.**
None needed a new source of truth. All four needed a channel and about one line of code.

### Instrument the failure path first

The happy path announces itself and can be checked against the artifact. The failure path is the
only one you will ever be debugging, and it is reliably the one written last and exercised least.

- **The place that knows the reason is the place that must write it.** A caller two frames up has the
  fact of a failure and not its cause. `writeRejection` exists for precisely this — _"the gate
  throws, and a throw carries only its message, so without this the one artifact an operator needs to
  decide whether the refusal was correct is destroyed at the moment it becomes interesting."_
- **Say which kind of failure it is**, because they route to different people and different retries:
  _this ticket cannot be solved_, _this harness is broken_, _the environment is broken_. Collapsing
  them writes a terminal label a human must clear because a laptop went to sleep.
- **Preserve the evidence, not the summary.** Keep the worktree, write the refused payload, record
  the inputs the decision was made from. A heuristic you cannot audit is one you end up disabling.
- **Report that the run happened even when there is no outcome to report.** _Did this run spend a
  claim_ is a different question from _is this ticket's fate decided_ (§4), and fusing the two is
  exactly what made the hook denial invisible. **A gap in the record is indistinguishable from the
  tool being switched off.**
- **Report the decision, not only the inputs to it.** A cycle report printing `capacity: 0` was read
  for two days as the reason a hand-driven run was blocked, by a path that never consults it. A
  number on a page invites an inference about what it controls.

### Verbose is not volume, and this is the half that gets overcorrected

Both failure directions have happened here, and the second is not the safe one:

- A bail reached a ticket as **four thousand characters with no line break in it.** Every word was
  correct and nobody was ever going to read it. The fix was structural — several schema fields and a
  renderer, a cap on each, cut on a word boundary and mark the cut — not more prose.
- The `unusable-base` headline says _"the repository's own build does not pass before any change"_
  and drops the two qualifiers the code itself is careful to keep: _in a fresh worktree_, and _or
  this harness_. A reader concludes `main` is broken. **It misled the author of the plan within an
  hour of being written.**

So state the claim as narrowly as the evidence supports, give the reader structure instead of
paragraphs, and put the actionable half last, where someone who skims will still land on it. A
message that overstates its scope is worse than silence, because silence is not acted on.

**The one reporter you cannot lean on is the model itself** — see §13.

---

## 13. Bail honestly, and put the reasoning where it will be read

**An honest "I cannot do this" beats a plausible artifact.** A ticket named an attached asset; the
solver could not fetch it, so it reconstructed one from an adjective in the description. That diff
survived two reviews and a human. Everyone was reading the code; nobody compared the artifact to the
specification. A capable agent will always produce _something_ that matches the prose.

Corollary: **a capable session will not report being blocked while it has any other way through.**
Do not rely on it self-reporting — narrow the surface instead.

**This service repeatedly produced its best reasoning on the channel nobody reads.** A terminal, a
dropped field, an operator-only response. Three instances before it was named. When something is
worth saying, ask who reads that channel; if the answer is nobody, it is not said.

**Rejecting a bad argument is not the same as rejecting the claim.** A reviewer's mechanism was
inverted and its conclusion was still right for a reason it never gave. A loop taught only the first
move will talk itself out of real bugs with excellent reasoning.

---

## 14. Finding your way around this codebase

Discovery is where an agent spends most of its budget and makes most of its confident mistakes. The
failure is rarely "could not find it" — it is **finding something adjacent and believing it**.

### `ARCHITECTURE.md` is the map, and this section is only how to read one

**Structural facts belong in `ARCHITECTURE.md` and are cited from here, never restated here.** It
carries the module map, the entry-point table and the reasoning behind the composition; this section
carries technique. The distinction is not tidiness — a count or a filename copied into a second
document is a fact with **two homes and one maintainer**, and §0.3 says exactly how that ends. This
paragraph replaced three such copies in its own first draft.

So the rule runs both ways, and the second half is the one that decays quietly:

- **Check a structural claim against the map before acting on it**, including a claim in this file.
  If they disagree, one of them is stale and finding out which is the work.
- **When implementation moves, the map moves in the same commit** (§0.1). A module added, renamed,
  split or deleted, a new entry point, a changed composition — the map is wrong the moment the
  commit lands, and every later reader inherits it. This is the maintenance that makes discovery
  cheap, and it is only ever skipped once per document before nobody trusts it again.

### Technique

**Start from an entry point, not from a filename.** The entry points are listed in the map; each is
a program that actually runs, and each has a command (§8). Any question of the form _what actually
happens when…_ is answered by starting at the one that does it and following the calls. A file found
by name search tells you what something is _called_; an entry point tells you whether it _runs_.

**Capability is a question about the composition, not about the module.** Privilege here is granted
by wiring, deliberately — components are built inert and composed later, so that granting one is a
visible change in a single place a reviewer knows to read. "Can this component reach Jira?" answered
from the component's own source will be answered wrongly, with confidence. The map names the file.

**The doc comments are the argument, and that makes them worth reading in full.** Unusually for a
codebase, module headers here carry the reasoning, the rejected alternatives and the measurement
that settled it. Skimming for the signature discards the part that took longest to acquire. **And
then §1 applies**: prose can be stale, and the dangerous form is the sentence that is true of
something other than what it appears to describe.

**Tests are the executable half of the specification.** A module's test file is the fastest
statement of what it is for and which edge cases were judged real, and a commit message naming the
mutations it caught tells you which guards are load-bearing. Where a document and a test disagree,
the test is the one that has been executed recently.

### The failure mode to design against: a search that confirms

**Searching for a symbol answers a question about the name, not about the behaviour.** This is not
hypothetical here — it happened during the writing of this skill. `REQUIRED_MCP_SERVERS` had no
references, so it was written up as an unenforced precondition being deleted. Two documents in fact
described that precondition **in prose, without ever naming the symbol**, and the enforcement lived
in `assertMcpReady`, reached through a per-call option. Zero grep hits, entirely wrong conclusion.

So:

- **Search for the behaviour as well as the identifier.** If a symbol looks unused, search for what
  it would _do_ — the error it raises, the label it writes, the phrase a document would use.
- **An unreferenced declaration is evidence about a name, not about a guarantee.** Trace to the code
  that would break, and if nothing would break, say that instead.
- **Cite `file:line`, never a recollection.** A memory of a codebase is a claim you have already
  stopped checking, and it degrades silently as the project grows (§6).
- **Verify with a tool rather than a reading where one exists** — `pnpm check-types`, a dry run, a
  test. Deleting a symbol you believe is dead is a proposal the type checker will grade for free.
- **`git log -- <path>` is part of discovery.** Deleted code is often the answer to "was this
  tried?", and this repository deliberately deletes rather than commenting out.

**Delegate breadth, keep depth.** Sweeping many files for a naming convention is worth handing to a
parallel search; the file that the decision actually rests on should be read directly and quoted. A
summary of the file that matters is where the adjacent-and-plausible error gets in.

**When the codebase and your reasoning disagree, the codebase is the evidence** — but check which
one you are actually looking at. A document, a comment and a test are three different kinds of claim
about the code, and only one of them is executed.

---

## 15. Dead code is a symptom before it is clutter

**Remove it in the change that orphaned it, not in a sweep.** A sweep is what you run when this
discipline has already failed. This repository has just run one, and every item in it was free to
delete at the time and expensive to adjudicate a month later, because by then nobody remembers
whether the absence of a caller was an oversight or a decision.

Tidiness is the weakest reason to care. The sweep's real finding was that **the most expensive dead
code here was the code that looked shipped.**

`agent:failed` had a definition, an entry in the queue-exclusion list, an entry in the outcome
labels, a transition function and passing tests. Nothing ever called the branch that wrote it. So a
ticket the agent had examined and declined was released byte for byte and read exactly like a ticket
nobody had tried — and under auto mode it would be re-bought every tick, with no condition in
existence that could clear it. That is not clutter. **It is a production hole wearing the costume of
a finished feature, and the tests were part of the costume.**

### An unreferenced symbol is a question, and the answer decides the action

| why it is dead                                            | what it really is                                  | do                                               |
| --------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------ |
| built but never wired                                     | **a bug** — the plan says shipped, nothing runs it | wire it, or move it back to `PLAN.md` as unbuilt |
| superseded by another mechanism                           | leftover                                           | delete, and delete the mechanism it replaced too |
| speculative — built ahead of an access or a second caller | a guess that aged                                  | delete; `git log` keeps it                       |
| computed deliberately and not consumed yet                | a decision                                         | keep, and **write the reason where it is**       |

The last two rows are the interesting ones, because they look identical in a grep.

**Speculative:** the Slack canvas sink. Renderers and edit-request builders, written before the
access they needed was confirmed. It never arrived, so for the life of the project the module had no
caller outside its own tests, and it was kept as an interface "to make the swap cheap". **An
abstraction whose second implementation is unreachable is not proven flexible, only untested** — and
this one had quietly drifted out of everything that would have noticed.

**Deliberate:** several fields here are computed and not read, on purpose, and that is fine _because
someone wrote down why_. The counter-example is the same shape with no note: `unresolved` was
computed and dropped on every successful round, and on the first round where it carried a real
defect it was the only place that defect appeared. Identical in the code; the difference is entirely
whether a reason is recorded next to it.

### Deleting is a change like any other, so verify it like one

- **The confident reading is the wrong one.** `isEligible` was flagged as a tested guard with zero
  callers. It was a thin wrapper over a live function with three call sites, and its 21 assertions
  were the only coverage the real one had. They were **redirected, not deleted**: removing a symbol
  must never remove the evidence.
- **Say what would break, not what has no references** (§14). `REQUIRED_MCP_SERVERS` was correctly
  deleted and incorrectly written up — the guarantee its name implied was real and enforced
  elsewhere, and "no references" said nothing about it.
- **Delete; do not comment out.** `git log -- <path>` is the archive, and a commented block is worse
  than deletion in every dimension: no tool checks it, and every future reader re-adjudicates it.
- **Let the type checker grade the proposal.** It is free and it is not persuadable.

### While implementing

- **Do not build ahead of an access, a decision or a second caller you do not have.** Ship the one
  implementation. Add the seam when the second arrives and its shape is known rather than imagined.
- **When you replace a mechanism, delete the replaced one in the same commit.** Two mechanisms for
  one job is §4's converse — one question with two answers — and the stale one will be found by
  someone who has no way to tell it is stale.
- **A setting, flag or label with nothing that reads it is the same defect in configuration**, and
  harder to spot, because nothing type-checks a string.

### The same rule applies to branches, and they are the copy everyone forgets

A branch whose work is merged is dead code that happens to live outside the tree. **Delete it when
it merges**, in the same spirit as deleting the mechanism you replaced — and delete the local one,
because that is the copy no automation touches. Auto-delete-on-merge is a GitHub setting: it cleans
the remote and leaves every local ref exactly where it was.

It matters more here than in a repository with one author, for two reasons that compound:

- **The stack is a real cost and it is measured mechanically.** `.claude/hooks/branch-stack.sh` puts
  a deep stack in front of a human before another branch is created, and the threshold is three from
  evidence (§7). A backlog padded with branches that merged weeks ago makes that prompt fire on a
  stack that does not exist, and **a guard that cannot be satisfied is one people learn to click
  past** — which costs the guard, not just the accuracy.
- **A stale branch is a plausible-looking wrong answer to "what is in flight".** That is §1's defect
  class applied to the repository itself, and the branch name is the part that makes it convincing.

**The incident, 2026-09-08.** The operator deleted ten remote branches and enabled auto-delete, and
the hook's count went _up_. Twenty-six local branches were already merged into `origin/main` with
their remotes gone, and local `main` was twenty commits behind — so the hook, which measured against
local `main`, counted nine merged branches as stacked and kept counting them after the cleanup. Two
defects in one number: the branches should not have existed, and the base should have been the
remote-tracking ref. The fix was both — `stackBase` in `.claude/hooks/lib.sh` prefers `origin/main`,
and the merged locals were deleted.

The general form is worth more than the fix: **a measurement taken against a ref that only moves when
a human remembers to move it is not a measurement of the project.** Prefer the ref that tracks
reality. Where that is impossible, say in the output which ref was read — the brief prints the base
it measured against for exactly this reason, and printing it is what made the bug legible.

---

## 16. This skill is a living document, and it is amended from defects

**Nothing in this file was designed.** Every rule is a generalisation of something that got through,
which means the document can only ever be as good as the last postmortem — and it goes stale in one
specific way: **a defect gets through that it does not cover.** That is not a failure of the
document, it is the only moment it can be improved with real evidence rather than theory.

**The trigger is any of these:**

- a bug reached `main` without being caught
- something was implemented wrongly and the mistake survived tests, review and a run
- a run was paid for and taught nothing (§12)
- a rule here was **followed** and the defect happened anyway — the highest-value case
- a rule here was skipped, and would have caught it

### The postmortem, in three questions

1. **Why did it happen?** The mechanism, not the blame. "The model hallucinated" is not a mechanism;
   "the pass was handed a summary and nothing marked it as inferred" is.
2. **What was the actual fault?** Rarely the proximate one. The favicon shipped wrong because nobody
   compared the artifact to the specification — not because the solver was careless. The wrong fix
   is nearly always available and nearly always addresses the symptom.
3. **What would have caught it, and does that generalise?** A fix for one case belongs in the code. A
   rule belongs here only if it would have caught a _class_.

**A rule with one instance is a hypothesis.** Write the case down, in `PLAN.md` or in the module's
own header, and wait. This repository named the literal-list rule on its **third** instance and
"our best reasoning goes to the channel nobody reads" on its **third** — both were obvious in
retrospect and neither was safe to generalise from one. Premature rules are not free: they dilute
the earned ones and lengthen the document until it stops being read.

### Always propose before editing

**State what you want to change and why, and get agreement.** Every time. The proposal is four
things:

- the **change**, in a sentence
- the **defect** that motivates it, concretely — which run, which commit, what shipped
- **where it goes**: which existing section it amends, or why it genuinely needs a new one
- **what it would have caught**, and honestly, what it would not

This is not ceremony. The developer holds context the transcript does not — what was tried before,
what a rule cost last time it was enforced, whether the incident is representative. A correction
from them is evidence, and the right response to one is to **check before agreeing**, not to fold
(§6). Silently rewriting a rule destroys the argument that justified it, which is the same defect
class this whole document is about, applied to the document itself.

### Keeping it honest as it grows

- **Prefer amending a section to adding one.** Two sections making one argument is §4's violation
  committed by the file that contains §4. Check for contradiction with what is already here.
- **Delete rules that stopped being true.** Same rule as `PLAN.md` (§0.2). A rule about a subsystem
  that no longer exists is noise that makes the rest look optional.
- **Keep the war story attached.** A rule stripped of its incident is an opinion, and the next person
  under time pressure will correctly identify it as one.
- **Watch for survivorship bias.** Every rule here came from a defect that was _caught_. The ones
  that escaped unnoticed wrote no rule and left no trace, so **the absence of a section is not
  evidence of the absence of a problem** — which is the strongest argument for §7 and §12, the two
  sections whose whole purpose is finding out what you did not know to look for.

---

## 17. Starting, and finishing

### Starting

Two questions, before the first edit rather than after the last one:

- [ ] **Is this in `PLAN.md`?** If it is not a one-line fix, write the entry first — what is being
      attempted, why now, and what would make it the wrong idea (§0). The session that does the work
      is not the session that inherits it.
- [ ] **What branch does this belong on, and how deep is the stack?** One branch per reviewable unit
      of privilege, never `main` (§9). If the stack is already deep, ask for a merge rather than
      building another floor — and delete the local branches that already merged (§15).

### Finishing

```
oxfmt <changed docs> && pnpm check-types && npx oxlint src/ && pnpm test
```

If the change touched `.claude/hooks/`, add `pnpm test:hooks` — those guards are not covered by
vitest, and they are the only mechanical enforcement of the two rules that are not advisory.

Then:

- [ ] Which of `README.md` / `ARCHITECTURE.md` / `PLAN.md` did this falsify? Fix in **this** commit.
- [ ] Is anything shipped still described in `PLAN.md` as unbuilt? Delete it.
- [ ] Did the **structure** move — a module added, renamed, split or deleted, an entry point, a
      changed composition? Then `ARCHITECTURE.md`'s map moves in this commit (§14), because every
      later reader's discovery starts there.
- [ ] Did a cited number move — tests, cost, settings count?
- [ ] For each new guard: which mutation did you watch fail?
- [ ] Any comment near the change that is now the §1.3 kind — true, but of something else?
- [ ] **If this fails at 3am, what does it leave behind?** Walk each exit path and name the artifact
      (§12). "The exception propagates" is not an answer; neither is a log line that has scrolled.
- [ ] **Did you run it?** Green is a statement about the tests (§7). If nothing was driven against a
      real target, the turn is not finished — it is untested in the only way that has ever mattered.
- [ ] Is the new capability reachable by one command, and is that command in `package.json` and its
      `USAGE` text (§8)? A feature only its own tests can invoke is not finished.
- [ ] Has a person **used** it — run the command, opened the page, looked at the board? If not, end
      the turn with the command itself, safe form first, and what would falsify it (§8). Nudge; do
      not block on it.
- [ ] **Did this change orphan anything** — a symbol, a setting, a mechanism it replaced? Delete it
      now, in this commit (§15). A sweep later costs more and decides worse.
- [ ] **Did a branch merge?** Delete it, including the **local** ref — auto-delete-on-merge cleans
      the remote only, and the leftovers are what make the stack guard cry wolf (§15).
- [ ] What did the run refute? Write that down before starting the next turn.
- [ ] **Did something get through that these rules did not cover?** Then the rules are the thing to
      fix, not just the code (§16). Propose the amendment, with the incident attached.

**Commit messages carry the argument, not the summary.** The diff shows what changed; the message is
the only place _why_ survives. Record the reasoning that was wrong on the way, too — a decision
whose rejected alternatives are lost gets relitigated every six months.
