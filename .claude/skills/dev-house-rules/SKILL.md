---
name: dev-house-rules
description: Development discipline for the-jira-police — writing the plan before the work, navigating this codebase, the dev/test/run/human/reevaluate loop, making failures verbose, giving every capability a command, how to guard and phase a privilege, branch and dead-code hygiene, and keeping README.md, ARCHITECTURE.md and PLAN.md true. Also how to amend these rules after a defect gets through. Use for any change to this repository, code or prose.
---

# House rules

**Why these rules exist, and why no instruction here is final:** [INCIDENTS.md](INCIDENTS.md) opens
with it, and the evidence is underneath. Read each rule as a hypothesis that has survived so far,
and when one of them is wrong,
[propose the amendment and say why before editing](FINISHING.md#always-propose-before-editing).

---

## The four phases

The document is split the way a change is: what you do before the first edit, while writing, while
proving, and on the way out. **Load the phase you are in.** They are short and disjoint, and each
links to the next.

| phase                           | load it for                                                                                                                        |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **1** [STARTING](STARTING.md)   | the four-document contract · the plan before the work · phasing a privilege · branching                                            |
| **2** [BUILDING](BUILDING.md)   | the defect class · fail closed · state in the remote system · untrusted input · failures that explain themselves · dead code       |
| **3** [PROVING](PROVING.md)     | mutation-testing a guard · measure don't assume · **the case your check does not cover** · **the loop** · a command per capability |
| **4** [FINISHING](FINISHING.md) | the commands · the checklist · the postmortem · amending these rules                                                               |
| [INCIDENTS](INCIDENTS.md)       | the evidence; **not on the reading path** for doing work                                                                           |

**If you read one section, read [the loop](PROVING.md#the-loop-dev-test-run-human-reevaluate).** It
is the only rule here whose absence is invisible — skip it and everything still looks green.

---

## The two that are not advisory

Everything else is recoverable if you get it wrong. These are not: assume your own compliance is the
whole of the enforcement, whatever the guards are doing (`ARCHITECTURE.md` §16, and step 0 of
[`claude-validation-work`](../claude-validation-work/SKILL.md#step-0--is-branch-guardsh-actually-firing-right-now)
if you need the answer today):

1. **Never work on `main` or any protected branch.** Branch first. One implementation branch per
   reviewable unit of privilege. Do not look for a way around this — ask.
2. **A human merges. Always.** This service has no merge path and neither do you. Opening a pull
   request is the end of your side of the work.

If you change a hook, run `pnpm test:hooks` — it caught a branch name containing a `"` that broke
the denial JSON and made the guard fail _open_ while still looking installed. It proves the scripts
emit, never that anything runs them, and until `8ad1a31` it proved that only on [one
laptop](INCIDENTS.md#the-suite-that-was-a-statement-about-one-laptop).

**How much of this to believe is its own skill.**
[`scaffolding-audit`](../scaffolding-audit/SKILL.md) audits the rules, guards and checks by running
probes rather than by reading — reading them and reporting that they are clear is the null result.

---

## The shortest possible version

- Write the plan before the work; delete it in the last commit before you push, not when it merges.
- Prose falsified by a change is rewritten in the **same** commit. All four documents are source.
- A guard is not shipped until a test fails when it is unplugged — against the _plausible wrong
  implementation_, not the bug.
- A green suite is a statement about the tests. **Run it against something real.**
- Every capability gets a one-line command, in the same commit.
- Every failure explains itself on the first run, because there may not be a second.
- Delete what your change orphaned, now, including the branch.
