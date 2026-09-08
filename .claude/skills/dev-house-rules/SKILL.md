---
name: dev-house-rules
description: Development discipline for the-jira-police — writing the plan before the work, navigating this codebase, the dev/test/run/human/reevaluate loop, making failures verbose, giving every capability a command, how to guard and phase a privilege, branch and dead-code hygiene, and keeping README.md, ARCHITECTURE.md and PLAN.md true. Also how to amend these rules after a defect gets through. Use for any change to this repository, code or prose.
---

# House rules

This skill is **not** staged into any solve pass. `prepareSkillRoot` copies only `agent-solve` into
a root that must contain nothing else, so nothing here reaches a model the service runs. It is for
whoever is developing the service.

**These rules were not designed.** Each one is the generalisation of a defect that got through, and
the incident is kept — in [INCIDENTS.md](INCIDENTS.md), linked from the rule it produced — because
the story is what makes the rule stick. When a rule seems expensive, the story is the argument.

**So none of this is finished, and no instruction here is final.** Every section is the current best
generalisation of a finite set of incidents, and the next one may sharpen it, narrow it or retire
it. When something escapes, the incident is worked back into these rules rather than just fixed;
[propose the amendment and say why before editing](FINISHING.md#always-propose-before-editing).
Read each rule as a hypothesis that has survived so far, not as a settled fact — that is the same
posture the rules themselves demand of the code.

---

## The four phases

The document is split the way a change is: what you do before the first edit, while writing, while
proving, and on the way out. **Load the phase you are in.** They are short and disjoint, and each
links to the next.

| phase                           | load it for                                                                                                                                                                      |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1** [STARTING](STARTING.md)   | the four-document contract · writing the plan before the work · finding your way around · phasing a privilege · picking a branch                                                 |
| **2** [BUILDING](BUILDING.md)   | the defect class · two questions that agree today · fail closed · state in the remote system · untrusted input · failures that explain themselves · bailing honestly · dead code |
| **3** [PROVING](PROVING.md)     | mutation-testing a guard · tests that stop testing · measure don't assume · **the loop** · every capability gets a command                                                       |
| **4** [FINISHING](FINISHING.md) | the commands to run · the checklist · the postmortem · how to amend these rules                                                                                                  |
| [INCIDENTS](INCIDENTS.md)       | the evidence. Cited from the rules; **not on the reading path** for doing work                                                                                                   |

**If you read one section, read [the loop](PROVING.md#the-loop-dev-test-run-human-reevaluate).**
Everything else is craft that stops known problems recurring. The loop is what found them in the
first place, and it is the only one whose absence is invisible — skip it and everything still looks
green.

---

## The two that are not advisory

Everything else is recoverable if you get it wrong. These are not, and both are enforced by
`.claude/hooks/` rather than by your good intentions:

1. **Never work on `main` or any protected branch.** Branch first. One implementation branch per
   reviewable unit of privilege. Do not look for a way around the hook — ask.
2. **A human merges. Always.** This service has no merge path and neither do you. Opening a pull
   request is the end of your side of the work.

If you change a hook, run `pnpm test:hooks`. It caught a branch name containing a `"` breaking the
denial JSON, which made the guard fail _open_ while still looking installed.

---

## The shortest possible version

- Write the plan before the work; delete it when it ships.
- Prose falsified by a change is rewritten in the **same** commit. All four documents are source.
- A guard is not shipped until a test fails when it is unplugged — against the _plausible wrong
  implementation_, not the bug.
- A green suite is a statement about the tests. **Run it against something real.**
- Every capability gets a one-line command, in the same commit.
- Every failure explains itself on the first run, because there may not be a second.
- Delete what your change orphaned, now, including the branch.
