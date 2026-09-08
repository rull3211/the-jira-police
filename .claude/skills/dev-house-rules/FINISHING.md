# Phase 4 — Finishing

**The commands, the checklist, and what to do when something got through anyway.** The last of those
is the one that keeps this skill worth reading: it is amended from defects, never from theory, so
finishing a change is also when the rules themselves get their evidence.

Previous: [PROVING.md](PROVING.md) · Index: [SKILL.md](SKILL.md) · Evidence:
[INCIDENTS.md](INCIDENTS.md)

---

## Run these

```
oxfmt <changed docs> && pnpm check-types && pnpm lint && pnpm test && pnpm docs:check
```

If the change touched `.claude/hooks/`, add `pnpm test:hooks` — those guards are not covered by
vitest, and they are the only mechanical enforcement of the two rules that are not advisory.

CI runs the same commands against the pushed ref, which is the only reason they are ever run when
nobody remembered. Do not soften a red check; a check that cannot fail the run reports rather than
guards.

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
      fix, not just the code. Propose the amendment, with the incident attached — see below.

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
