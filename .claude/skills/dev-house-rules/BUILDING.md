# Phase 2 — Building

**The `dev` step of the loop.** What to write, what shape to write it in, and what to delete on the
way past. None of this is the safety net — [PROVING.md](PROVING.md) is. This is the craft that stops
known problems recurring, and every rule here is the generalisation of one that did.

Previous: [STARTING.md](STARTING.md) · Next: [PROVING.md](PROVING.md) · Evidence:
[INCIDENTS.md](INCIDENTS.md)

---

## The defect class

**Prose that describes behaviour the code no longer has.** Most of what follows is a special case.

It is worth naming precisely because it is _invisible to every tool_. Types, lint and tests all
pass; the comment is the only thing that is wrong, and it is the thing the next reader trusts most.

Three forms, hardest last:

- **Plainly false.** Five files said the Jira credential was "discovery only" long after
  `updateLabels` shipped — including `wiring.ts`, the module that calls it.
  [→](INCIDENTS.md#the-credential-that-stopped-being-discovery-only)
- **Superseded.** A doc comment promising a precondition that moved elsewhere.
  [→](INCIDENTS.md#the-precondition-with-no-references-and-two-enforcers)
- **True of behaviour it was not describing.** `runReviewChain` printed _"Ctrl-C is safe: nothing is
  held open between rounds"_ directly above a `.unref()`. The sentence reads as a description of the
  unref and is not — what makes an interrupt safe is that no worktree or lock is held. The unref was
  deleted as a bug; the sentence stayed true and still reads as coverage of it. **This form survives
  review indefinitely,** because a reviewer checks whether the sentence is true.
  [→](INCIDENTS.md#the-unref-that-killed-the-only-loop-whose-job-is-waiting)

---

## Two questions that agree today are still two questions

The most productive rule in the repository, and always tempting to violate because the code looks
duplicated.

`terminalLabelAfter` is deliberately not spelled `!isFailureExit`, though today they coincide
exactly. One asks _did this produce a usable answer_ (for an exit code); the other asks _is this
ticket's fate decided_ (for a queue). Derive one from the other and a future change to an exit code
silently relabels tickets on a live board. Same for `reviewStageAfter` reading the draft flag rather
than `pushed`, and `silent` not being `!stop`.

The cost of getting it wrong is not hypothetical: fusing _did this run spend a claim_ with _is this
ticket's fate decided_ is what made an expensive failure completely invisible on the board.
[→](INCIDENTS.md#the-hook-that-vetoed-write-silently)

**The converse is also a rule, and the tension is resolved by the question, not the shape.** Two
identical literals answering the _same_ question must be collapsed — when reviewing came to replace
solving, two label lists genuinely became one and staying separate would have been the bug.

> Ask what each expression is _for_. Same purpose, one copy. Different purpose, two — and a comment
> saying they agree today and why that is a coincidence.

---

## Fail closed, except guards, which fail open

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
- **A check that cannot fail the run reports rather than guards.** No `continue-on-error` in CI, and
  a red check is left red rather than softened. [→](INCIDENTS.md#the-nine-merged-pull-requests-with-zero-reviews)

**The guard itself is the exception, and it fails in the direction that is hardest to see.** A
branch name containing a `"` broke a hook's denial JSON, the runtime dropped the denial, and the
guard failed **open while still looking installed** — which is worse than no guard. An earlier
version of the same hook failed the other way and refused every command on `main`, including the one
its own denial text recommends. Escape what you interpolate, and let reads through.
[→](INCIDENTS.md#the-guardrails-built-with-nothing-in-the-plan)

---

## State lives in the remote system

Dedupe, cursors and counters live on the ticket or the pull request, never in `state/`. They then
survive a restart, a wiped state directory and a second instance, and **a human can read them.**
Losing a counter _releases_ a spend brake, which is the wrong direction for the one number deciding
whether to pay for another pass.

The cost is that a read-modify-write can clobber a concurrent edit. Mitigate it — read back and
verify, nothing between the read and the write, not even a log line — and **write the residual risk
down** rather than implying it is closed.

---

## Untrusted input, and the channel it arrives on

Ticket text, comment bodies, reviewer output and anything a model wrote are **data, not
instruction**. Treat structure you did not create as forgeable: collapse whitespace, cap lengths,
cut on word boundaries and mark the cut.

- **Prefer the structured channel to parsing prose.** Read review threads over scraping a summary.
  When a model must return several things, give it _several fields_ and let the renderer build the
  layout — one field asked for two things is why a bail arrived as four thousand characters with no
  line break in it. [→](INCIDENTS.md#the-bail-that-arrived-as-four-thousand-characters)
- **A comment reporting a state transition is evidence of an event, not of the current state**, and
  the field it describes is on the same ticket. Prose written at one instant and never revisited
  will contradict a live field, and the contradiction resolves toward the prose unless something
  stops it. [→](INCIDENTS.md#the-fitness-call-that-was-refused-three-times-for-two-wrong-reasons)
- **Do not put an instruction in a prompt that the API will violate.** "Verbatim, byte for byte"
  cannot survive a server-side format conversion, and teaching a model that this prompt's rules are
  approximate is the last thing to teach it.
- **Our own activity is excluded by kind, never by clock.** Key it on a sentinel the writer controls.
  There is often no identity to key on — this service posts as the operator's own account.
- **A field this service writes must never be allowlisted** as evidence that something changed.

---

## A failure must explain itself on the first run

**In ordinary software you re-run with more logging. Here you frequently cannot.** A run costs real
money, takes minutes to tens of minutes, and is not reproducible — the model, the reviewer and the
board have all moved on by the time you look. So the first failure is usually the only sample you
get, and a failure that produced no diagnostic has to be **bought twice**: once to fail silently,
once to fail again after you have added the instrumentation that should have been there the first
time.

That sequence — fail, learn nothing, go build logging and visibility and ticket write-back, then
re-run the expensive thing to find out what happened — has been the single largest recurring cost in
this project. Not wrong answers. **Failures that charged full price and returned nothing.**

| the failure                                                                                               | what it left behind                                                       | what the retry cost                            |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------- |
| [a local hook denied the write pass its `Write`](INCIDENTS.md#the-hook-that-vetoed-write-silently)        | **nothing** — every label released; the board matched an untouched ticket | ~$4.50                                         |
| [a recon bail](INCIDENTS.md#the-bail-terminal-with-no-writer)                                             | a declined ticket read as an untried one                                  | in auto mode, re-bought every tick             |
| [the laptop slept mid-pass](INCIDENTS.md#the-laptop-that-slept-mid-pass)                                  | a timeout kill and a worktree kept as evidence of nothing                 | the whole pass                                 |
| [`unresolved` computed and then dropped](INCIDENTS.md#the-unresolved-field-that-was-computed-and-dropped) | the one honest signal, discarded unread                                   | the decorative test shipped and is still there |

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
  claim_ is a different question from _is this ticket's fate decided_, and fusing the two is exactly
  what made the hook denial invisible. **A gap in the record is indistinguishable from the tool
  being switched off.**
- **Report the decision, not only the inputs to it.** A cycle report printing `capacity: 0` was read
  for two days as the reason a hand-driven run was blocked, by a path that never consults it. **A
  number on a page invites an inference about what it controls.**
  [→](INCIDENTS.md#the-capacity-number-that-was-read-for-two-days-as-a-blocker)

### Verbose is not volume, and this is the half that gets overcorrected

Both failure directions have happened here, and the second is not the safe one:

- A bail reached a ticket as **four thousand characters with no line break in it.** Every word was
  correct and nobody was ever going to read it. The fix was structural — several schema fields and a
  renderer, a cap on each, cut on a word boundary and mark the cut — not more prose.
  [→](INCIDENTS.md#the-bail-that-arrived-as-four-thousand-characters)
- The `unusable-base` headline says _"the repository's own build does not pass before any change"_
  and drops the two qualifiers the code itself is careful to keep: _in a fresh worktree_, and _or
  this harness_. A reader concludes `main` is broken. **It misled the author of the plan within an
  hour of being written.** [→](INCIDENTS.md#the-unusable-base-headline-that-misled-its-own-author)

So state the claim as narrowly as the evidence supports, give the reader structure instead of
paragraphs, and put the actionable half last, where someone who skims will still land on it. A
message that overstates its scope is worse than silence, because silence is not acted on.

**The one reporter you cannot lean on is the model itself** — see the next section.

---

## Bail honestly, and put the reasoning where it will be read

**An honest "I cannot do this" beats a plausible artifact.** A ticket named an attached asset; the
solver could not fetch it, so it reconstructed one from an adjective in the description. That diff
survived two reviews and a human. Everyone was reading the code; nobody compared the artifact to the
specification. **A capable agent will always produce _something_ that matches the prose.**
[→](INCIDENTS.md#the-favicon-reconstructed-from-an-adjective)

Corollary: **a capable session will not report being blocked while it has any other way through.**
Do not rely on it self-reporting — narrow the surface instead.
[→](INCIDENTS.md#the-read-tools-the-header-said-were-denied)

**This service repeatedly produced its best reasoning on the channel nobody reads.** A terminal, a
dropped field, an operator-only response. Three instances before it was named. When something is
worth saying, ask who reads that channel; if the answer is nobody, it is not said.
[→](INCIDENTS.md#the-unresolved-field-that-was-computed-and-dropped)

**Rejecting a bad argument is not the same as rejecting the claim.** A reviewer's mechanism was
inverted and its conclusion was still right for a reason it never gave. A loop taught only the first
move will talk itself out of real bugs with excellent reasoning.
[→](INCIDENTS.md#the-reviewer-whose-mechanism-was-inverted)

---

## Dead code is a symptom before it is clutter

**Remove it in the change that orphaned it, not in a sweep.** A sweep is what you run when this
discipline has already failed. This repository has run one, and every item in it was free to delete
at the time and expensive to adjudicate a month later, because by then nobody remembers whether the
absence of a caller was an oversight or a decision.

Tidiness is the weakest reason to care. The sweep's real finding was that **the most expensive dead
code here was the code that looked shipped** — a terminal label with a definition, an exclusion-list
entry, a transition function, passing tests, and no caller anywhere.
[→](INCIDENTS.md#the-bail-terminal-with-no-writer)

### An unreferenced symbol is a question, and the answer decides the action

| why it is dead                                            | what it really is                                  | do                                               |
| --------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------ |
| built but never wired                                     | **a bug** — the plan says shipped, nothing runs it | wire it, or move it back to `PLAN.md` as unbuilt |
| superseded by another mechanism                           | leftover                                           | delete, and delete the mechanism it replaced too |
| speculative — built ahead of an access or a second caller | a guess that aged                                  | delete; `git log` keeps it                       |
| computed deliberately and not consumed yet                | a decision                                         | keep, and **write the reason where it is**       |

The last two rows are the interesting ones, because they look identical in a grep.

**Speculative:** the Slack canvas sink, kept as an interface "to make the swap cheap". **An
abstraction whose second implementation is unreachable is not proven flexible, only untested.**
[→](INCIDENTS.md#the-slack-canvas-sink)

**Deliberate:** several fields here are computed and not read, on purpose, and that is fine _because
someone wrote down why_. The counter-example is the same shape with no note: `unresolved` was
computed and dropped on every successful round, and on the first round where it carried a real
defect it was the only place that defect appeared. Identical in the code; the difference is entirely
whether a reason is recorded next to it.
[→](INCIDENTS.md#the-unresolved-field-that-was-computed-and-dropped)

### Deleting is a change like any other, so verify it like one

- **The confident reading is the wrong one.** `isEligible` was flagged as a tested guard with zero
  callers. It was a thin wrapper over a live function with three call sites, and its 21 assertions
  were the only coverage the real one had. They were **redirected, not deleted**: removing a symbol
  must never remove the evidence.
  [→](INCIDENTS.md#the-wrapper-whose-assertions-were-the-only-coverage)
- **Say what would break, not what has no references.** `REQUIRED_MCP_SERVERS` was correctly deleted
  and incorrectly written up — the guarantee its name implied was real and enforced elsewhere, and
  "no references" said nothing about it.
  [→](INCIDENTS.md#the-precondition-with-no-references-and-two-enforcers)
- **Delete; do not comment out.** `git log -- <path>` is the archive, and a commented block is worse
  than deletion in every dimension: no tool checks it, and every future reader re-adjudicates it.
- **Let the type checker grade the proposal.** It is free and it is not persuadable.

### While implementing

- **Do not build ahead of an access, a decision or a second caller you do not have.** Ship the one
  implementation. Add the seam when the second arrives and its shape is known rather than imagined.
- **When you replace a mechanism, delete the replaced one in the same commit.** Two mechanisms for
  one job is the converse of _two questions that agree today_ — one question with two answers — and
  the stale one will be found by someone who has no way to tell it is stale.
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
  evidence. A backlog padded with branches that merged weeks ago makes that prompt fire on a stack
  that does not exist, and **a guard that cannot be satisfied is one people learn to click past** —
  which costs the guard, not just the accuracy.
- **A stale branch is a plausible-looking wrong answer to "what is in flight".** That is the defect
  class applied to the repository itself, and the branch name is the part that makes it convincing.

> **A measurement taken against a ref that only moves when a human remembers to move it is not a
> measurement of the project.**
> [→ the branch count that went up after ten
> deletions](INCIDENTS.md#the-branch-count-that-went-up-after-ten-deletions)

→ [PROVING.md](PROVING.md)
