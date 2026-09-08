# Phase 1 — Starting

**Before the first edit.** Three things: the contract you are working under, how to find your way
around, and what shape the change should take. Everything here is cheap and everything here is
skipped under time pressure, which is why it is the first file rather than an appendix.

Next: [BUILDING.md](BUILDING.md) · Index: [SKILL.md](SKILL.md) · Evidence:
[INCIDENTS.md](INCIDENTS.md)

---

## The document contract, which is the one that is always in force

Four documents describe this service and how it is built, and **all four are treated as source**:

|                   | what it answers                                 | goes stale when                                         |
| ----------------- | ----------------------------------------------- | ------------------------------------------------------- |
| `README.md`       | how do I run it, what do the commands do        | a flag, script or setting changes                       |
| `ARCHITECTURE.md` | how does it work and why is it shaped this way  | any module, invariant or setting changes                |
| `PLAN.md`         | what is **not** built yet, and what was learned | work **starts**, anything ships, or anything is learned |
| **this skill**    | how we work, and what went wrong last time      | **a defect gets through that it does not cover**        |

**Rules, in order of how often they are broken:**

1. **Prose falsified by a change is rewritten in the same commit.** Not the next one. A commit that
   makes a sentence false and leaves it is the defect this project exists to catch, committed by
   the person catching it.
   [→ five files that said "discovery only"](INCIDENTS.md#the-credential-that-stopped-being-discovery-only)
2. **`PLAN.md` records what is not built.** When something ships, its entry is **deleted**, not
   struck through. The exception is a lesson that lives nowhere else — that moves to the "learned"
   section. A plan that accumulates completed work stops being read, and a plan nobody reads is
   how two people build the same thing twice.
3. **Numbers in prose are facts and rot like facts.** Test counts, costs, line counts, settings
   counts — grep for them after any change that moves them. `pnpm docs:check` asserts the ones that
   can be counted mechanically; it is a floor, not a substitute for looking, and it needed a guard
   of its own before it was worth anything.
   [→ the check the formatter could switch off](INCIDENTS.md#the-check-the-formatter-could-switch-off)
4. **When a document and your reasoning disagree, the document might be right.** See
   [Measure, do not assume](PROVING.md#measure-do-not-assume-and-the-assumption-is-usually-about-your-own-code).

**Before finishing any change, ask which of the four you just falsified.** Usually one. Often two.
The list is in [FINISHING.md](FINISHING.md).

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
[→ the guardrails built with nothing in the plan](INCIDENTS.md#the-guardrails-built-with-nothing-in-the-plan)

Two failure modes it closes, both of which have happened here:

- **Two contexts build the same thing twice**, because neither could see the other's intent. Rule 2
  names this for shipped work; it is worse for unshipped work, where there is no code to collide
  with and the duplication is only found later.
- **A decision gets re-litigated from scratch**, because the argument against the obvious
  alternative was made once, in a session that is gone. `PLAN.md` is full of these — why the daemon
  is last, why `--advance` is not a rung, why state lives in Jira — and every one exists because
  someone wrote the reasoning down before building against it.

**A plan entry is a hypothesis, not a commitment.** It is expected to be wrong in places; that is
what makes it worth writing, because the run that refutes it has something to refute. An entry that
only ever gets deleted intact was not a plan, it was a description written in advance.

---

## Finding your way around this codebase

Discovery is where an agent spends most of its budget and makes most of its confident mistakes. The
failure is rarely "could not find it" — it is **finding something adjacent and believing it**.

### ARCHITECTURE.md is the map, and this section is only how to read one

**Structural facts belong in `ARCHITECTURE.md` and are cited from here, never restated here.** It
carries the module map, the entry-point table and the reasoning behind the composition; this section
carries technique. The distinction is not tidiness — a count or a filename copied into a second
document is a fact with **two homes and one maintainer**, and rule 3 above says how that ends. This
paragraph replaced three such copies in its own first draft.

**The exception, and it is narrow.** A number that `pnpm docs:check` verifies in every place it
appears has stopped being a fact with one maintainer, because drift can no longer be silent. Cite,
don't copy, is a rule about facts nothing checks.

So the rule runs both ways, and the second half is the one that decays quietly:

- **Check a structural claim against the map before acting on it**, including a claim in this file.
  If they disagree, one of them is stale and finding out which is the work.
- **When implementation moves, the map moves in the same commit.** A module added, renamed, split or
  deleted, a new entry point, a changed composition — the map is wrong the moment the commit lands,
  and every later reader inherits it. This is the maintenance that makes discovery cheap, and it is
  only ever skipped once per document before nobody trusts it again.

### Technique

**Start from an entry point, not from a filename.** The entry points are listed in the map; each is
a program that actually runs, and each has a command. Any question of the form _what actually
happens when…_ is answered by starting at the one that does it and following the calls. A file found
by name search tells you what something is _called_; an entry point tells you whether it _runs_.

**Capability is a question about the composition, not about the module.** Privilege here is granted
by wiring, deliberately — components are built inert and composed later, so that granting one is a
visible change in a single place a reviewer knows to read. "Can this component reach Jira?" answered
from the component's own source will be answered wrongly, with confidence.
[→ the read tools the header said were denied](INCIDENTS.md#the-read-tools-the-header-said-were-denied)
· [→ a refusal reasoned from the wrong tool
surface](INCIDENTS.md#the-fitness-call-that-was-refused-three-times-for-two-wrong-reasons)

**The doc comments are the argument, and that makes them worth reading in full.** Unusually for a
codebase, module headers here carry the reasoning, the rejected alternatives and the measurement
that settled it. Skimming for the signature discards the part that took longest to acquire. **And
then the defect class applies**: prose can be stale, and the dangerous form is the sentence that is
true of something other than what it appears to describe.

**Tests are the executable half of the specification.** A module's test file is the fastest
statement of what it is for and which edge cases were judged real, and a commit message naming the
mutations it caught tells you which guards are load-bearing. Where a document and a test disagree,
the test is the one that has been executed recently.

### The failure mode to design against: a search that confirms

**Searching for a symbol answers a question about the name, not about the behaviour.** This is not
hypothetical — it happened during the writing of these rules.
[→ the precondition with no references and two
enforcers](INCIDENTS.md#the-precondition-with-no-references-and-two-enforcers)

So:

- **Search for the behaviour as well as the identifier.** If a symbol looks unused, search for what
  it would _do_ — the error it raises, the label it writes, the phrase a document would use.
- **An unreferenced declaration is evidence about a name, not about a guarantee.** Trace to the code
  that would break, and if nothing would break, say that instead.
- **Cite `file:line`, never a recollection.** A memory of a codebase is a claim you have already
  stopped checking, and it degrades silently as the project grows.
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

## Phase a privilege, and drive it by hand first

Every capability ships in its own reviewable commit, in this order:

1. **Built but inert** — nothing constructs its dependencies. The refusal is structural, not
   promised, and wiring it later is a visible diff in the place a reviewer looks.
2. **Dry run** — does everything, changes nothing, and writes a report to a file, because stdout
   scrolls away and a dry phase exists to be judged.
3. **One named target**, chosen by a person, behind a flag that must be typed.
4. **The loop, last.** It adds no capability; it only removes the person. Add that property after
   every other one has been watched.

Each of those first three steps is
[a command](PROVING.md#every-capability-gets-a-one-line-command-and-it-pays-for-itself-immediately),
which is what makes the ordering enforceable rather than aspirational.

**One branch per privilege, never `main`.** A human always merges; this service has no merge path
and neither do you. Guards for the first are written and tested — `.claude/hooks/`, suite
`pnpm test:hooks`, run it if you change one — but nothing registers them yet and the second has no
guard at all (`PLAN.md` §12). Neither rule is any less binding for that; the only difference is
that breaking one will not be caught.

**Do not stack branches deeply.** Each unmerged branch gates the ones above it. When the stack
grows, stop and ask for the base to be merged rather than building another floor on it, and delete
the local branches that already merged — auto-delete-on-merge cleans the remote only.
[→ three phases stacked on one branch](INCIDENTS.md#the-three-phases-stacked-on-one-branch)

**Predict before you run.** Write down what you expect, then run it. The most valuable runs are the
ones that refute the prediction, and you only get that if the prediction was recorded first.

---

## Before the first edit

- [ ] **Is this in `PLAN.md`?** If it is not a one-line fix, write the entry first — what is being
      attempted, why now, and what would make it the wrong idea. The session that does the work is
      not the session that inherits it.
- [ ] **What branch does this belong on, and how deep is the stack?** One branch per reviewable unit
      of privilege, never `main`. If the stack is already deep, ask for a merge rather than building
      another floor — and delete the local branches that already merged.

→ [BUILDING.md](BUILDING.md)
