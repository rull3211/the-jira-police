# Phase 4 — Finishing

**The commands, the checklist, and what to do when something got through anyway.** The last of those
is the one that keeps this skill worth reading: it is amended from defects, never from theory, so
finishing a change is also when the rules themselves get their evidence.

Previous: [PROVING.md](PROVING.md) · Index: [SKILL.md](SKILL.md) · Evidence:
[INCIDENTS.md](INCIDENTS.md)

---

## Re-read the phase file, never recall it

**Open this file when you reach this phase, even if you are sure you know what is in it.** One file
read, every time.

`STARTING.md` already says a memory of a codebase is a claim you have stopped checking. A remembered
checklist is the sharpest case of that, because what memory keeps is the **executable** part — six
commands with exit codes — and what it drops is the part with no exit code behind it. The remembered
version of this page is _run the commands_, and it feels complete, because everything it contains is
green.

The risk is highest exactly where it is least visible: **after a compaction**, in a context that
inherited a summary of the work rather than the work. That context has a confident account of the
rules and has never read them.
[→](INCIDENTS.md#four-lessons-written-down-carefully-and-filed-where-nothing-loads-them)

**The mechanism is worth naming, and the rate is not known.** Compaction fires when context is
exhausted; context is most exhausted at the end of a unit of work; the end of a unit of work is when
this page is supposed to run. So the most rule-dense moment in the workflow tends to be reached by
the most degraded context available. That is an argument, plus one measured instance — an attempt to
turn it into a rate produced four-for-four out of a transcript that says one-for-four, which is its
own entry. The `SessionStart` hook now inlines the four questions below when it fires with
`trigger=compact`, on the reasoning that a pointer is exactly what such a context discounts.
**Treat that injection as a prompt to open this file, not as a substitute for it** — it carries four
of the checks and none of the reasoning.
[→](INCIDENTS.md#the-compaction-finding-that-counted-the-string-instead-of-the-call)

---

## Run these

```
oxfmt <changed docs> && pnpm check-types && pnpm lint && pnpm test && pnpm docs:check
```

If the change touched `.claude/hooks/`, add `pnpm test:hooks` — those guards are not covered by
vitest, and they are the only mechanical enforcement of the two rules that are not advisory.

CI runs those commands against the pushed ref, which is the only reason they are ever run when
nobody remembered, plus one check that is not a command anybody runs by hand: the pull request body
must carry a `Rules owed:` line — see below. Do not soften a red check; a check that cannot fail the
run reports rather than guards.

---

## The checklist

**Four questions that nothing above already asks you.** These are the ones worth slowing down for,
because each is a separate act rather than a restatement of a rule:

- [ ] **Any comment _near_ the change that is now true of something else?** Not the ones you edited —
      the ones you did not. This is the form of the defect class that survives review indefinitely.
- [ ] **If this fails at 3am, what does it leave behind?** Walk each exit path and name the artifact.
      "The exception propagates" is not an answer; neither is a log line that has scrolled.
- [ ] **What did the run refute?** Write it down before starting the next turn. If nothing was
      refuted, either the prediction was not recorded or the run was too small to be informative.
- [ ] **Did something get through that these rules do not cover?** Then the rules are the thing to
      fix, not just the code. Propose the amendment, with the incident attached — see below. **This
      is the one that gets skipped in silence**, so its answer is written into the pull request body
      either way: [`Rules owed:`](#the-rules-you-owe-are-written-down-or-they-are-not-owed).

**And the rules you have already read, one line each:**

- [ ] Documents falsified → rewritten in **this** commit
- [ ] Anything shipped → its `PLAN.md` entry deleted, not struck through
- [ ] Structure moved →
      [`ARCHITECTURE.md`'s map](STARTING.md#architecturemd-is-the-map-and-this-section-is-only-how-to-read-one)
      moved with it
- [ ] A cited number moved, or a heading was renamed → `pnpm docs:check` is green
- [ ] Each new guard → the mutation you watched fail, named in the commit message
- [ ] Driven against a real target, not only its own tests
- [ ] **A person has _used_ it** — run the command, opened the page, looked at the board. Nudge;
      never block on it. [→](PROVING.md#step-4-is-the-one-that-gets-dropped-and-dropping-it-is-invisible)
- [ ] The capability is reachable by one command, in `package.json` and in
      [`USAGE`](PROVING.md#every-capability-gets-a-one-line-command-and-it-pays-for-itself-immediately)
- [ ] The command handed over, safe form first, with what would falsify it
- [ ] Orphans deleted in this commit — a symbol, a setting, a mechanism it replaced
- [ ] Any merged branch deleted, **including the local ref**

**Commit messages carry the argument, not the summary.** The diff shows what changed; the message is
the only place _why_ survives. Record the reasoning that was wrong on the way, too — a decision
whose rejected alternatives are lost gets relitigated every six months.

---

## The rules you owe are written down, or they are not owed

The fourth question above — _did something get through that these rules do not cover?_ — is the only
item on this page with no exit code behind it, and it is skipped in silence. Nobody decides not to
answer it; it simply is not answered, and nothing anywhere records that.

**So the answer is an artifact.** Every pull request body carries one of:

```
Rules owed: none
Rules owed: <what, and where it is being written>
```

This does not make the answer correct. It makes it a **claim**, visible to a reviewer, which is the
only kind of error this project reliably catches. It is the same move `PLAN.md` §13 argues for on the
count class: force a judgement call to be written down rather than made silently.

**CI fails a pull request whose body has no such line.** It cannot tell a true `none` from a false
one — it guarantees the question was answered, nothing more. That is deliberately the whole of its
job, and it is the only part of this that fires without the agent choosing to comply.

**Produce the line from a context that did not do the work.** Self-audit in the pass that wrote the
change shares the blind spot that caused the omission: the same reasoning that skipped a rule
concludes that no rule was skipped. Hand a fresh context the diff and the rules and ask it which
rules the change touches and which are unsatisfied — and **prime it with nothing else**. Offering it
a verdict to reach is how an adversarial subagent was once talked into alleging invention; the
finding was relayed at full strength and was wrong.
[→ priming, and what to check before relaying](STARTING.md#read-wide-in-a-subagent-decide-in-the-main-context)
· [→](STARTING.md#the-failure-mode-to-design-against-a-search-that-confirms)

**What none of this catches**, stated because the gap is the point: a rule silently reinterpreted,
where `Rules owed: none` is written in good faith. The class this rule comes from surfaced because a
human asked twice. Nothing here replaces that reader; it lowers how often they must think to ask.
[→](INCIDENTS.md#four-lessons-written-down-carefully-and-filed-where-nothing-loads-them)

---

## The commit is where you choose to compact

**A compaction you did not choose happens at the worst available moment.** It fires when the context
is exhausted, and the context is most exhausted in the middle of the largest change — halfway
through an edit, with the intent held nowhere but here. What survives is then whatever a summariser
judged important, which is reliably the narrative and not the file paths.

So take the decision instead of receiving it. **A commit has just made the context disposable**: the
work is on disk, `PLAN.md` holds the intent, the branch holds the position. That is the cheapest
moment in the whole cycle to lose everything else, and it is the one moment you can see coming —
which is the same argument `CLAUDE.md` makes for running `pnpm hooks:brief` off the commit rather
than off a compaction. If a unit has just landed and the next one is large, compact **there**, on
purpose.

**Say what to preserve, because the default keeps the wrong half.** Name the things that are
expensive to recover and cheap to state: the branch and what it is stacked on, the `PLAN.md` entry
in force, the paths under edit, and what has already been ruled out. A summariser left to itself
will keep an account of the session — which reads as though the work is understood, and is exactly
[the inheritance that makes a resuming context misjudge its own position](STARTING.md#the-plan-is-written-before-the-work-not-after-it).

**None of this is a substitute for the files.** If compacting at a chosen point would lose something,
that thing belonged in `PLAN.md` or in a doc comment before the commit, and the fix is to write it
down rather than to compact more carefully. The test is worth applying deliberately: **if this
context vanished now, what would the next one not be able to reconstruct?** Anything on that list is
a gap in the tree, not a gap in the summary.

---

## This skill is a living document, and it is amended from defects

**Nothing in these files was designed.** Every rule is a generalisation of something that got
through, which means the document can only ever be as good as the last postmortem — and it goes
stale in one specific way: **a defect gets through that it does not cover.** That is not a failure
of the document, it is the only moment it can be improved with real evidence rather than theory.

The corollary is that this is never finished, and neither is any single instruction in it. A rule
here is the current best generalisation of a finite set of incidents; the next incident may
sharpen it, narrow it, or retire it. Treat every section as provisional and every number in it as a
measurement that can be re-taken.

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
   compared the artifact to the specification — not because the solver was careless. The wrong fix
   is nearly always available and nearly always addresses the symptom.
   [→](INCIDENTS.md#the-favicon-reconstructed-from-an-adjective)
3. **What would have caught it, and does that generalise?** A fix for one case belongs in the code. A
   rule belongs here only if it would have caught a _class_.

**Then record what actually caught it**, as the `**Found by**` line the incident entry ends with.
Question 3 is a counterfactual and this is not: one is the guard worth building, the other is the
practice that is already paying. They are usually different, and the gap between them is the only
honest measure of whether the mechanisms here work. Answer it even when the answer is unflattering —
"a user noticed" and "nothing; it was found while reading for something else" are the two most
useful values this field can take, because they are the ones that say the mechanisms did not fire.

**A rule with one instance is a hypothesis.** Write the case down, in `PLAN.md` or in the module's
own header, and wait. This repository named the literal-list rule on its **third** instance and
"our best reasoning goes to the channel nobody reads" on its **third** — both were obvious in
retrospect and neither was safe to generalise from one. Premature rules are not free: they dilute
the earned ones and lengthen the document until it stops being read.
[→](INCIDENTS.md#the-literal-lists-that-named-a-types-members)

### Always propose before editing

**State what you want to change and why, and get agreement.** Every time. The proposal is four
things:

- the **change**, in a sentence
- the **defect** that motivates it, concretely — which run, which commit, what shipped
- **where it goes**: which phase file it amends, or why it genuinely needs a new section
- **what it would have caught**, and honestly, what it would not

This is not ceremony. The developer holds context the transcript does not — what was tried before,
what a rule cost last time it was enforced, whether the incident is representative. A correction
from them is evidence, and the right response to one is to
[**check before agreeing**](PROVING.md#measure-do-not-assume-and-the-assumption-is-usually-about-your-own-code),
not to fold. Silently rewriting a rule destroys the argument that justified it, which is the same
defect class this whole document is about, applied to the document itself.

### Where an amendment goes

| the change is about                                  | the file                     |
| ---------------------------------------------------- | ---------------------------- |
| the plan, the branch, orienting, phasing a privilege | [STARTING.md](STARTING.md)   |
| what to write and what to delete                     | [BUILDING.md](BUILDING.md)   |
| guards, tests, measurement, the loop, commands       | [PROVING.md](PROVING.md)     |
| the checklist and amending the rules                 | this file                    |
| **the story** behind any of the above                | [INCIDENTS.md](INCIDENTS.md) |

**The incident goes in `INCIDENTS.md`, dated, and the rule links to it.** Never the other way round:
a rule that has swallowed its own war story grows without limit, and a story with no rule attached
is an anecdote. The link is what lets a rule be argued with — and deleted, when the argument stops
holding.

### Keeping it honest as it grows

- **The rules matter more as the project grows, not less.** Everything here scales with the number
  of things nobody has re-read lately, which is the only honest answer to "is this worth it".
- **Prefer amending a section to adding one.** Two sections making one argument is a violation of
  [two questions that agree today](BUILDING.md#two-questions-that-agree-today-are-still-two-questions)
  — and the split made it easier to commit, because the second section can now be in another file
  where nothing puts the two side by side. Check for contradiction with what is already here.
- **Delete rules that stopped being true.** Same rule as `PLAN.md`. A rule about a subsystem that no
  longer exists is noise that makes the rest look optional.
- **Keep the war story linked, and keep only the claim beside the rule.** A rule stripped of its
  incident is an opinion, and the next person under time pressure will correctly identify it as one.
  So the rule carries the one-line claim and the link; `INCIDENTS.md` carries the story. Re-telling
  the story in both places is the cite-don't-copy rule broken by the file that states it, and it is
  the failure this split is most likely to drift back into. `pnpm docs:check` fails on a link that no
  longer resolves, so renaming a heading in `INCIDENTS.md` cannot quietly disconnect the rule that
  cites it — which is the only reason the stories were safe to keep in a separate file at all.
- **Watch for survivorship bias.** Every rule here came from a defect that was _caught_. The ones
  that escaped unnoticed wrote no rule and left no trace, so **the absence of a section is not
  evidence of the absence of a problem** — which is the strongest argument for the loop and for
  making failures explain themselves, the two rules whose whole purpose is finding out what you did
  not know to look for.
