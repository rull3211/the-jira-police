# Phase 1 — Starting

**Before the first edit.** The contract you are working under, how to find your way around, and what
shape the change should take. All of it is cheap, and all of it is what time pressure removes first.

Next: [BUILDING.md](BUILDING.md) · Index: [SKILL.md](SKILL.md) · Evidence:
[INCIDENTS.md](INCIDENTS.md)

---

## The document contract, which is the one that is always in force

`README.md`, `ARCHITECTURE.md`, `PLAN.md` and this skill are **all treated as source**; what each
answers is listed in `CLAUDE.md`. Only the staleness triggers live here: `README.md` on a flag,
script or setting, `ARCHITECTURE.md` on any module or invariant, `PLAN.md` when work **starts** or
is pushed, this skill **when a defect gets through that it does not cover**.

Four rules, in order of how often they are broken:

1. **Prose falsified by a change is rewritten in the same commit**, not the next one. A commit that
   makes a sentence false and leaves it is the defect this project exists to catch, committed by the
   person catching it.
   [→ five files that said "discovery only"](INCIDENTS.md#the-credential-that-stopped-being-discovery-only)
2. **`PLAN.md` records what is not built**, gaining an entry when work _starts_ and losing it **in
   the last commit before you push** — **deleted**, not struck through, no exception. Not at merge:
   the reviewer is the one misled. A plan that accumulates finished work stops being read. **It is
   not where lessons live**: what a run taught goes into the rule it changes, into
   [INCIDENTS.md](INCIDENTS.md), or nowhere.
   [→ the escape hatch that grew a 409-line sink](INCIDENTS.md#the-lesson-store-that-was-the-incident-it-was-written-to-fix)
   · [→ deleted too early, then kept too late](INCIDENTS.md#four-lessons-written-down-carefully-and-filed-where-nothing-loads-them)
3. **Numbers in prose are facts and rot like facts** — grep for them after any change that moves
   them. `docs:check` is a floor — no checker sees a noun nobody listed, and a rewrite can _invent_ a
   figure. **The fix that holds is not stating it:** let the dated list be the count.
   [→ the check the formatter could switch off](INCIDENTS.md#the-check-the-formatter-could-switch-off)
4. **When a document and your reasoning disagree, the document might be right.**
   [→ measure, do not assume](PROVING.md#measure-do-not-assume-and-the-assumption-is-usually-about-your-own-code)

**Before finishing, ask which of the four you just falsified** — usually one, often two; the list is
in [FINISHING.md](FINISHING.md).

### The plan is written before the work, not after it

Rule 2 fires on the way out; this is the same rule from the other end. **Before beginning anything
that is not a one-line fix, write it into `PLAN.md` first** — what is being attempted, why now, what
it would let the service do that it cannot do today, and what would make it the wrong idea. **Open
the entry with a bold `Branch:` label** naming the branch, on its own line under the heading:
`CLAUDE.md` sends a resuming context to the entry belonging to its current branch, and an entry
naming no branch is also the signature of work abandoned rather than shipped.

**This is not bookkeeping.** Sessions here end, compact and are replaced, and a diff never says what
was being attempted or what had been ruled out — so intent held only in one context is lost with it,
and the next one rebuilds the work or re-litigates the decision. Both have happened here.
[→ the guardrails built with nothing in the plan](INCIDENTS.md#the-guardrails-built-with-nothing-in-the-plan)

**A plan entry is a hypothesis, not a commitment**, expected to be wrong in places — that is what
gives the run something to refute.

---

## Finding your way around

The budget goes here, and so do the confident mistakes: the failure is rarely _not finding_
something but **finding something adjacent and believing it**.

### ARCHITECTURE.md is the map, and this section is only how to read one

**Structural facts — the module map, the entry points, the composition — belong in
`ARCHITECTURE.md` and are cited from here, never restated here.** A count or a filename copied into
a second document is a fact with **two homes and one maintainer**, and rule 3 says how that ends.
The narrow exception is a number `pnpm docs:check` verifies everywhere it appears, which can no
longer drift silently; cite-don't-copy is a rule about facts nothing checks. So it runs both ways,
and the second half is the one that decays quietly:

- **Check a structural claim against the map before acting on it**, including a claim in this file.
  If they disagree, one of them is stale and finding out which is the work.
- **When implementation moves, the map moves in the same commit** — a module added, renamed, split
  or deleted, a new entry point, a changed composition. It is only ever skipped once per document
  before nobody trusts it again.

### Technique

**Start from an entry point, not from a filename.** They are listed in the map, and each is a
program that actually runs, so _what actually happens when…_ is answered by starting at the one that
does it and following the calls. A name search tells you what something is _called_; an entry point
tells you whether it _runs_.

**Capability is a question about the composition, not about the module.** Privilege here is granted
by wiring, deliberately — components are built inert and composed later, so granting one is a
visible change in a single place a reviewer knows to read. "Can this component reach Jira?" answered
from the component's own source is answered wrongly, with confidence.
[→ the read tools the header said were denied](INCIDENTS.md#the-read-tools-the-header-said-were-denied)
· [→ a refusal reasoned from the wrong tool
surface](INCIDENTS.md#the-fitness-call-that-was-refused-three-times-for-two-wrong-reasons)

**Module headers carry the argument** — the reasoning, the rejected alternatives, the measurement
that settled it — so skimming for the signature discards what took longest to acquire. They can also
be stale: where a doc comment and a test disagree, prefer the test.

### Read wide in a subagent; decide in the main context

**Anything whose output is much larger than its conclusion goes to a subagent** — "which files
mention X", the audit across a directory. Sweeping thirty files for the three that matter spends the
budget on twenty-seven permanently, because the answer and the noise compact together. Anything
whose output _is_ the conclusion, you read yourself.

**What a subagent returns is a claim, not a result, and it is checked before it is used.** An
adversarial audit here was primed with the verdict it was invited to reach, duly reached it, was
relayed at full strength, and was wrong.
[→](INCIDENTS.md#the-audit-that-found-eight-things-and-got-three-of-them-wrong-on-the-way)
The check is cheap and it is not optional:

- **Spot-check the load-bearing claims against the tree yourself** — the ones the decision turns on.
  A file:line that does not say what the report says invalidates the report, not just the row.
- **Verify the diagnosis separately from the findings.** They fail independently, and the diagnosis
  is the half believed without checking, because it arrives as an explanation rather than as
  evidence. An audit of this repository's `§N` references got every count right and its causal story
  wrong.
  [→ citations to sections that were never written](INCIDENTS.md#thirty-nine-citations-to-sections-that-were-never-written)
- **Prime for evidence, not for a verdict** — say which answer is expected and acceptable, because a
  prompt that only rewards findings will be given findings.
- **Relay at the strength you verified, and say which half that was.** "Confirmed at these three
  lines; the rest is the subagent's count, unchecked" is usable; passing the whole report through as
  fact is how the wrong finding shipped.

**Deciding is the part that cannot be delegated**, and so is being accountable for what you repeat.

### The failure mode to design against: a search that confirms

**Searching for a symbol answers a question about the name, not about the behaviour**, and it has
got through here three times — a precondition that looked unreferenced and had two enforcers
[→](INCIDENTS.md#the-precondition-with-no-references-and-two-enforcers), an audit whose `grep -c`
returned the number its own predicted finding wanted
[→](INCIDENTS.md#the-audit-that-found-eight-things-and-got-three-of-them-wrong-on-the-way), and —
an hour later, in prose about that second instance — a `grep -c` counting mentions of an action at
three times its rate
[→](INCIDENTS.md#the-compaction-finding-that-counted-the-string-instead-of-the-call). A count is the
most confirmable thing a search can return, and **it is checked least when it agrees with a rule
already believed**. So:

- **Search for the behaviour as well as the identifier.** If a symbol looks unused, search for what
  it would _do_ — the error it raises, the label it writes.
- **An unreferenced declaration is evidence about a name, not about a guarantee.** Trace to the code
  that would break; if nothing would, say so.
- **Count the event, never the string that describes it.** A log, a plan, a summary and a commit
  message all contain the name of the thing; only one is the thing. If the corpus is structured,
  parse it and count the records.
- **Cite `file:line`, never a recollection, and verify with a tool where one exists** — a dry run, a
  test, `pnpm check-types`. A symbol you believe is dead is a proposal the type checker grades for
  free.
- **`git log -- <path>` is part of discovery.** Deleted code is often the answer to "was this
  tried?", and this repository deletes rather than commenting out.

**A document, a comment and a test are three different kinds of claim about the code, and only one
of them is executed.**

---

## Phase a privilege, and drive it by hand first

Every capability ships in its own reviewable commit, in this order:

1. **Built but inert** — nothing constructs its dependencies, so the refusal is structural rather
   than promised.
2. **Dry run** — does everything, changes nothing, and writes its report to a file to be judged.
3. **One named target**, chosen by a person, behind a flag that must be typed.
4. **The loop, last.** It adds no capability; it only removes the person — add that after every
   other property has been watched.

Each of those first three steps is
[a command](PROVING.md#every-capability-gets-a-one-line-command-and-it-pays-for-itself-immediately),
which makes the ordering enforceable rather than aspirational.

**One branch per privilege, never `main`; a human always merges.** Both have guards, argued in
`CLAUDE.md` and `ARCHITECTURE.md` §16; neither rule is less binding when nothing is watching.

**Do not stack branches deeply** — each unmerged branch gates the ones above it. When the stack
grows, ask for the base to be merged rather than building another floor on it, and delete the local
branches that already merged; auto-delete-on-merge cleans the remote only.
[→ three phases stacked on one branch](INCIDENTS.md#the-three-phases-stacked-on-one-branch)

---

## Before the first edit

- [ ] **Is this in `PLAN.md`?** If it is not a one-line fix, write the entry first, opening with the
      `Branch:` label — what is being attempted, why now, and what would make it the wrong idea. The
      session that does the work is not the session that inherits it.
- [ ] **What branch does this belong on, and how deep is the stack?** One per reviewable unit of
      privilege, never `main`; if the stack is already deep, ask for a merge instead of another
      floor, and delete the local branches that already merged.

→ [BUILDING.md](BUILDING.md)
