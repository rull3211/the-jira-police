# Incidents

**The evidence base for the house rules.** Nothing in those rules was designed; each one is the
generalisation of something that got through, and this is where the something lives.

**Read direction: rules cite incidents.** `STARTING.md`, `BUILDING.md`, `PROVING.md` and
`FINISHING.md` link here from the rule an incident produced. This file links back so that
[a rule being deleted](FINISHING.md#keeping-it-honest-as-it-grows) can be checked against what it
rested on — but nothing needs to read this file top to bottom, and it is not on the path of doing
any work.

**Append-only, and dated.** New incidents go at the bottom. An entry is never edited to make it look
better; if a later run refutes it, that is a new entry, because a corrected story loses the thing
that made it worth keeping. Entries are removed only when the subsystem they describe is gone.

**Why the stories are kept at all.** A rule stripped of its incident is an opinion, and the next
person under time pressure will correctly identify it as one. When a rule looks expensive, the story
is the argument for paying.

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

A cycle report printed `capacity: 0`, and that was recorded in the plan as the thing gating an
end-to-end run. It was not. `runSolveCycle` computes capacity, and the hand-driven path is called
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
it was the first to call. The cost was recorded in the plan at the time, in the plan's own words:
_"D4a's end-to-end test gates all three."_

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

The commands CI runs are the same four a developer runs by hand, and that is the point — it is not a
new standard, it is the existing one moved somewhere it cannot be skipped. What changes is that they
run against the pushed ref, on a machine nobody is logged into, whether or not anyone remembered.

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
