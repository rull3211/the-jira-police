---
name: scaffolding-audit
description: Audits this repository's scaffolding — the house rules, the skills, the hooks, the checks and the CI steps — rather than its product code. Answers two questions with evidence instead of reading: how confident an agent should be working here, and whether that confidence survives a long session through several compactions. Carries the probe protocol, the failure class this tree is systematically bad at (a green check answering a narrower question than everyone thinks it is asking), the dimensions a verdict must cover including the shape of the skillsets themselves, and a list of findings already known so an audit cannot spend its budget rediscovering them. Forbids fixing anything. Use when asked how trustworthy the scaffolding is, before relying on any guard or check, or when a fresh session wants to know what it is actually standing on.
---

# Auditing the scaffolding

**Two questions, and the second is the one nobody asks.**

1. **How confident should an agent be working here**, and on what evidence?
2. **Does that confidence survive a long session through several compactions**, or is it a
   property of a fresh context reading a good README?

This skill is about the scaffolding — `CLAUDE.md`, the skills, `.claude/hooks/`, `docs:check`,
the vitest suite, the CI steps — and not about whether the service grooms tickets correctly.

## Stikkprøver, not reading

**A claim you got from a document is not a finding.** Every document here is prose written by an
agent that believed it. The recorded history of this tree is largely agents summarising the rules
correctly and then breaking them, or documenting a guard that was never wired. Reading `CLAUDE.md`
and reporting that the rules are clear is the null result, and it is the result every audit here
produces if it is not stopped.

**Spot-check by running things.** For each claim you intend to repeat, find the cheapest command
that would refute it and run that. Most of your budget belongs here.

**Pre-commit every probe.** Before running one, write down what each outcome will mean —
including the outcome you expect. A probe whose diagnosis is decided afterwards confirms whatever
you already thought. This is not hypothetical: the work that registered these hooks made the same
mistake seven times, and the sharpest instance read a silent hook as a wrong exit code when the
real cause was that nothing had invoked it. A silent guard has two causes and a pre-committed
probe is what makes you name both.
[→](../claude-validation-work/SKILL.md)

**Predict the number, then measure it.** The most valuable finding of the last audit came from
predicting a count would fall by four and measuring two. A prediction that matches teaches you
little; the gap is the entire signal. Do this at least three times, on things you believe are
already checked.

**Report what each run refuted.** If nothing was refuted, the probe was too small or the
prediction was never recorded — report that as a failed probe, not as a pass.

## Point it here first

Start with the class this tree is systematically bad at: **a green check answering a narrower
question than everyone thinks it is asking.** Three instances are on record, all green for days
or weeks:

- a hook-suite fixture whose payload could not parse, so the assertion passed on the wrong
  refusal and hid a live hole in `branch-guard.sh`;
- a documentation check that verified the number phrasings somebody had thought to write down,
  and silently ignored the rest;
- a cross-document reference resolver that pools section ids from every document into one set, so
  a dead reference resolves against a different file's live section.

For every mechanical check here, answer two things: **what question does it actually answer, and
what does everyone believe it answers?** Then unplug it and confirm something goes red. A check
nobody has watched fail has no demonstrated relationship to the thing it is named after.
[→](../dev-house-rules/PROVING.md)

## The dimensions to reach a verdict on

Each needs an explicit verdict. A description is not a verdict.

**Capability, and the size of the scaffolding.** How much machinery is here relative to what it
protects? Name what is load-bearing, what is ceremony, and what has been superseded but not
deleted. Include the cost side — latency added per tool call, tokens injected per session, human
minutes per commit. Scaffolding that does not earn its cost is a finding, and so is scaffolding
that is only justified by an incident nobody can still reproduce.

**Guard quality.** For each guard: what it refuses, what it lets through, whether it fails open or
closed, whether it has been observed acting in the live runtime rather than only in its own
harness, and whether its false-positive rate is low enough that nobody will turn it off. A guard
proven by its own suite is proven to _emit_, not to _enforce_.

**Persistence through compaction.** The hard one, and the reason this skill exists. A compacted
context inherits an account of the work rather than the work. Establish empirically which parts
survive: what is re-injected, what is extracted from a file at runtime, and what lives only in a
transcript that is about to be summarised. Then find the rules with no mechanical trigger at all —
those are precisely what a compaction deletes without trace. Judge whether the recovery path
reconstitutes _position_ or only _narrative_.

**Structure, content and shape of the skillsets.** Be direct here; this is the part that gets
softened. Is the phase split the right decomposition, or does it separate things an agent needs
together? Is the volume readable under pressure, or does its length guarantee skimming at exactly
the moment it matters most? Does it distinguish the rules that must be obeyed from the reasoning
behind them, or bury the first inside the second? Is any of it stale, wrong, or contradicted
elsewhere in the tree — check, do not assume; two documents disagreeing about the same fact with
nothing to make them disagree loudly is a recorded failure here, not a hypothetical one. And ask
whether the war-story style is earning its length or is the reason nobody finishes the page.

**Guidance toward consistent, iterative, stable change.** Does the contract produce small
reviewable units, or large ones with good commit messages? Use the history as evidence rather than
the rules: branch sizes, commits per branch, how often scope grew mid-branch, how often a guard or
a shared test harness was modified inside a commit that was about something else. Whether the
rules _say_ the right thing is the easy half. Whether agents following them _behaved_ that way is
what decides the verdict.

## What the report must contain

- **A confidence position and its basis.** "Moderately confident" is not an answer. State what you
  would and would not do unsupervised here, and name the single piece of evidence that would move
  it most.
- **Findings ranked by severity**, each with the probe that produced it and the failure it
  predicts. Label every one as _confirmed by a run_ or _inferred from reading_, and keep the two
  visibly apart.
- **What should be deleted.** An audit that only adds has not made a judgement. A rule with no
  incident behind it, a check nobody has seen fail, and a document with no reader are all
  findings.
- **What you could not determine, and why** — blocked, too expensive, or needs a human. Do not
  convert an unknown into a reassurance.

## Constraints

- **This is an audit. Do not fix anything.** Findings go in the report. If something is serious
  enough to fix immediately, say so and stop for a decision. The audit that produced this skill
  was authorised to fix five findings and shipped rather more, each addition defensible on its own
  and the aggregate still drift.
- Obey the two non-negotiable rules while auditing them: never work on a protected branch, and
  never merge. **Do not test a guard by doing the thing it forbids.**
- If a safety block fires, report it — including whether it was a true or a false positive, which
  is a finding either way — and do not re-spell the command.
- Treat `CLAUDE.md` and the phase files as hypotheses that have survived so far, which is what
  they ask to be treated as.

## Already known — re-finding these is not a result

State in one line whether each still holds, then move past it.

- The hook configuration file is refused for writing and for shell access, and is readable with
  the file-reading tool. Three documents once got this wrong in the same direction, generalising
  from two blocked routes to a third nobody had tried.
- `pnpm test:hooks` proves each script _emits_ a decision, never that the runtime acts on one.
  `deny` and `additionalContext` have each been watched working once, by hand. `ask` has never
  been observed at all, and a whole class of fail-open guards rests on it — `PLAN.md` §17.
- `PLAN.md` §19: the section resolver pools ids across documents, so `KNOWN_DANGLING` and the
  reference cleanup are both measuring a smaller population than anyone thinks. Open, unfixed.
- The four questions in `FINISHING.md` have no mechanical check. They are carried by a reminder
  hook that cannot verify anything and a CI step that reads the pull request body.

**This list rots, and a stale one suppresses real findings.** If a probe contradicts an entry
here, that is a result and the entry is wrong. Novel findings are the deliverable; finishing with
only the above confirmed is itself a verdict, and a better one than a padded list.
