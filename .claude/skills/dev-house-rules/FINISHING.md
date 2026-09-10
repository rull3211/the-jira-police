# Phase 4 — Finishing

**The commands, the checklist, and what to do when something got through anyway.** The last is what
keeps this skill worth reading: it is amended from defects, never from theory.

Previous: [PROVING.md](PROVING.md) · Index: [SKILL.md](SKILL.md) · Evidence:
[INCIDENTS.md](INCIDENTS.md)

---

## Re-read the phase file, never recall it

**Open this file when you reach this phase, even if you are sure you know what is in it.** A
remembered checklist keeps the **executable** part — the commands with exit codes — and drops the
part with no exit code behind it, so it feels complete because everything in it is green. The risk
is highest **after a compaction**, in a context holding a confident account of rules it never read.
[→](INCIDENTS.md#four-lessons-written-down-carefully-and-filed-where-nothing-loads-them)

**Two hooks now inline these four questions**: `session-brief.sh` on `trigger=compact`, and
`commit-brief.sh` on the `git commit` about to run (`ARCHITECTURE.md` §16 for both). Neither refuses
anything and neither carries the reasoning, so treat an injected copy as a prompt to open this file
rather than a substitute for it. The rate at which compaction actually lands here is not known — an
attempt to measure it produced four-for-four from a transcript that says one-for-four.
[→](INCIDENTS.md#the-compaction-finding-that-counted-the-string-instead-of-the-call)

**If you compact on purpose, say what to preserve**: the branch and what it is stacked on, the
`PLAN.md` entry in force, the paths under edit, and what has already been ruled out.

---

## Run these

```
oxfmt <changed docs> && pnpm check-types && pnpm lint && pnpm test && pnpm docs:check
```

If the change touched `.claude/hooks/`, add `pnpm test:hooks` — vitest does not cover those guards,
and they are the only mechanical enforcement of the two rules that are not advisory. CI runs all of
it against the pushed ref, plus one check nobody runs by hand: the pull request body must carry a
`Rules owed:` line, below. Do not soften a red check; a check that cannot fail the run reports
rather than guards.

---

## The checklist

**Four questions that nothing above already asks you**, each a separate act rather than a
restatement of a rule:

- [ ] **Any comment _near_ the change that is now true of something else?** Not the ones you edited —
      the ones you did not. This is the form of the defect class that survives review indefinitely.
- [ ] **If this fails at 3am, what does it leave behind?** Walk each exit path and name the artifact.
      "The exception propagates" is not an answer; neither is a log line that has scrolled.
- [ ] **What did the run refute?** Write it down. Nothing refuted means no prediction was recorded,
      or the run was too small.
- [ ] **Did something get through that these rules do not cover?** Then the rules are the thing to
      fix, not just the code. **This is the one that gets skipped in silence**, so it is answered in
      the pull request body either way:
      [`Rules owed:`](#the-rules-you-owe-are-written-down-or-they-are-not-owed).

**And the rules you have already read, one line each:**

- [ ] Documents falsified → rewritten in **this** commit
- [ ] Anything shipped → its `PLAN.md` entry deleted
- [ ] Structure moved →
      [the map](STARTING.md#architecturemd-is-the-map-and-this-section-is-only-how-to-read-one)
      with it
- [ ] A cited number or a heading moved → `pnpm docs:check` is green
- [ ] Each new guard → the mutation you watched fail, named in the message
- [ ] Driven against a real target, not only its tests
- [ ] **A person has _used_ it.** Nudge; never block.
      [→](PROVING.md#step-4-is-the-one-that-gets-dropped-and-dropping-it-is-invisible)
- [ ] One command, in `package.json` and in
      [`USAGE`](PROVING.md#every-capability-gets-a-one-line-command-and-it-pays-for-itself-immediately)
- [ ] The command handed over, safe form first, with what would falsify it
- [ ] Orphans deleted here — symbol, setting, replaced mechanism
- [ ] Any merged branch deleted, **including the local ref**

**Commit messages carry the argument, not the summary.** The diff shows what changed; the message is
the only place _why_ survives, including the reasoning that was wrong on the way.

---

## The rules you owe are written down, or they are not owed

The fourth question above has no exit code behind it, and it is skipped in silence — nobody decides
not to answer it. **So the answer is an artifact.** Every pull request body carries one of:

```
Rules owed: none
Rules owed: <what, and where it is being written>
```

**CI fails a pull request whose body has no such line.** That does not make the answer correct; it
makes it a **claim**, visible to a reviewer, which is the only kind of error this project reliably
catches. It cannot tell a true `none` from a false one, and it is the only part of this that fires
without the agent choosing to comply.

**Produce the line from a context that did not do the work**: hand a fresh context the diff and the
rules, ask which rules the change touches and which are unsatisfied, and **prime it with nothing
else**. The pass that skipped a rule concludes that no rule was skipped, and an adversarial subagent
handed a verdict was once talked into alleging invention — relayed at full strength, and wrong.
[→](INCIDENTS.md#the-audit-that-found-eight-things-and-got-three-of-them-wrong-on-the-way)
· [→](STARTING.md#read-wide-in-a-subagent-decide-in-the-main-context)

**What none of this catches:** a rule silently reinterpreted, where `Rules owed: none` is written in
good faith. That class surfaced because a human asked twice.
[→](INCIDENTS.md#four-lessons-written-down-carefully-and-filed-where-nothing-loads-them)

---

## This skill is a living document, and it is amended from defects

**Why every rule here exists is in [`INCIDENTS.md`](INCIDENTS.md).** So this document goes stale in
one way — **a defect gets through that it does not cover** — and that is the moment to amend it.

**The trigger is any of these:**

- a bug reached `main` without being caught
- something was implemented wrongly and the mistake survived tests, review and a run
- a run was paid for and [taught nothing](BUILDING.md#a-failure-must-explain-itself-on-the-first-run)
- a rule here was **followed** and the defect happened anyway — the highest-value case
- a rule here was skipped, and would have caught it

### The postmortem, in three questions

1. **Why did it happen?** The mechanism, not the blame. "The model hallucinated" is not a mechanism;
   "the pass was handed a summary and nothing marked it as inferred" is.
2. **What was the actual fault?** Rarely the proximate one. The favicon shipped wrong because nobody
   compared the artifact to the specification, not because the solver was careless.
   [→](INCIDENTS.md#the-favicon-reconstructed-from-an-adjective)
3. **What would have caught it, and does that generalise?** A fix for one case belongs in the code.
   A rule belongs here only if it would have caught a _class_.

**Then record what actually caught it**, as the `**Found by**` line an incident carries second from
last, above `**The rule**`. Question 3 is a counterfactual and this is not: one is the guard worth
building, the other is the practice that is already paying, and the gap between them is the only
honest measure of whether these mechanisms fire. Answer it when the answer is unflattering — "a user
noticed" and "nothing; it was found while reading for something else" are the two most useful values
it can take.

**A rule with one instance is a hypothesis.** Write the case down and wait — an
[INCIDENTS.md](INCIDENTS.md) entry closing `**No rule yet**`, or the module's own header. **Not
`PLAN.md`.** This repository named the literal-list rule on its **third** instance.
Premature rules are not free: they dilute the earned ones and lengthen the document until it stops
being read. [→](INCIDENTS.md#the-literal-lists-that-named-a-types-members)

### Always propose before editing

**State what you want to change and why, and get agreement.** Every time. The proposal is four
things:

- the **change**, in a sentence
- the **defect** that motivates it, concretely — which run, which commit, what shipped
- **where it goes**: which phase file it amends, or why it genuinely needs a new section
- **what it would have caught**, and honestly, what it would not

This is not ceremony. The developer holds context the transcript does not — what was tried before,
what a rule cost last time it was enforced, whether the incident is representative — so a correction
from them is evidence, and the right response to one is to
[**check before agreeing**](PROVING.md#measure-do-not-assume-and-the-assumption-is-usually-about-your-own-code),
not to fold.

### Where an amendment goes

Route it by phase: [STARTING.md](STARTING.md) for the plan and the branch,
[BUILDING.md](BUILDING.md) for the code, [PROVING.md](PROVING.md) for guards and commands, this file
for the checklist, [INCIDENTS.md](INCIDENTS.md) for the story.

**The incident goes in `INCIDENTS.md`, dated, and the rule links to it.** Never the other way round:
a rule that has swallowed its own war story grows without limit, and a story with no rule attached
is an anecdote.

### Keeping it honest as it grows

- **Prefer amending a section to adding one.** Two sections making one argument is
  [two questions that agree today](BUILDING.md#two-questions-that-agree-today-are-still-two-questions),
  and the split made it easier to commit, because the second section can now live in another file
  where nothing puts the two side by side.
- **Delete rules that stopped being true.** Same rule as `PLAN.md`. A rule about a subsystem that no
  longer exists makes the rest look optional.
- **Keep the war story linked, and keep only the claim beside the rule.** A rule stripped of its
  incident is an opinion. `pnpm docs:check` fails on a link that no longer resolves, which is the
  only reason the stories were safe to keep in a separate file at all.
- **Watch for survivorship bias.** Every rule here came from a defect that was _caught_, so **the
  absence of a section is not evidence of the absence of a problem**.
