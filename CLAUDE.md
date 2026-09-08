# the-jira-police

A TypeScript service that grooms Jira tickets and, for the subset of bugs an agent can fix safely,
solves them: triage, claim, fix in an isolated worktree, draft PR, answer the review. Node ≥24 with
type-stripping, pnpm, **no build step**.

## Two rules that are not advisory

Everything else is recoverable if you get it wrong. These two are not, so they are stated here
rather than routed to.

1. **Never work on `main` or any protected branch.** Branch first — `feat/`, `fix/`, `chore/`,
   `docs/`, `refactor/`. One implementation branch per reviewable unit of privilege. Do not look for
   a way around this; ask instead.
2. **A human merges. Always.** This service has no merge path and neither do you. Opening a pull
   request is the end of your side of the work.

**Assume nothing mechanical is holding either of these, because you cannot check.** Both now have
guards written and tested in `.claude/hooks/` — `branch-guard.sh` refuses writes and pushes on a
protected branch, and refuses `gh pr merge` from every branch — with their own suite,
`pnpm test:hooks`, which you run if you change one. But whether anything ever _registers_ them is
not decided in this repository: hook configuration belongs to the operator, lives outside this tree,
and is deliberately neither readable nor writable from here. No commit can tell you whether a guard
will fire, and the agent a guard constrains is the last one who should be wiring it — so this is not
a gap waiting on a file, it is the arrangement. Both rules bind exactly as hard as if they were
enforced; the only difference is that breaking one may not be caught. `PLAN.md` §12 records what is
built and what it does not cover.

**Do not stack branches deeply** — three stacked here once turned an incremental plan into a
waterfall. The rule and the story are in
[`dev-house-rules/STARTING.md`](.claude/skills/dev-house-rules/STARTING.md#phase-a-privilege-and-drive-it-by-hand-first).

## The working contract, by phase

**`.claude/skills/dev-house-rules/` is the working contract for this repository.** It is not
optional reading and it is not a style guide; every rule in it is the generalisation of a defect
that already got through here. It is split the way a change is — **load the phase you are in**:

| you are about to                          | load                                                  |
| ----------------------------------------- | ----------------------------------------------------- |
| start anything that is not a one-line fix | `dev-house-rules/STARTING.md`                         |
| write or delete code                      | `dev-house-rules/BUILDING.md`                         |
| add a guard, a test, or run the thing     | `dev-house-rules/PROVING.md`                          |
| commit, or amend the rules themselves     | `dev-house-rules/FINISHING.md`                        |
| ask _why_ a rule exists                   | `dev-house-rules/INCIDENTS.md` — cited from each rule |

`dev-house-rules/SKILL.md` is the index and the shortest possible summary. Start there if you do not
know which phase you are in.

**Every rule in there is provisional.** They are amended from incidents rather than from theory, so
read each as a hypothesis that has survived so far. If one is wrong, say so and propose the change
before making it.

## Where the truth lives

| file                              | answers                                                 |
| --------------------------------- | ------------------------------------------------------- |
| `README.md`                       | how to run it, what each command does                   |
| `ARCHITECTURE.md`                 | how it works, why it is shaped this way, the module map |
| `PLAN.md`                         | what is **not** built yet, and what was learned         |
| `.claude/skills/dev-house-rules/` | how we work, and what went wrong last time              |

**All four are treated as source.** Prose falsified by a change is rewritten in the same commit, not
the next one. Structural facts — modules, entry points, the composition — live in `ARCHITECTURE.md`
and are cited from elsewhere, never copied. `pnpm docs:check` enforces the part of that which is
mechanical — the counts cited in prose, and every cross-document link.

## Before you start

**Write it into `PLAN.md` first** — what is being attempted, why now, and what would make it the
wrong idea. Then do the work; the entry is deleted when it ships. This is not bookkeeping. Work here
is done in sessions that end and compact, and a session that holds the intent only in its own
context leaves the next one a diff and a branch name. A diff never says what was being attempted or
what was already ruled out.

Then pick the branch: one per reviewable unit of privilege, and delete local branches that have
already merged — auto-delete-on-merge cleans the remote only.

## Working style

- **Run it.** A green test suite is a statement about the tests. Every defect of consequence in this
  project was found by driving a command against a real target, not by the suite.
- **Make it runnable.** Every capability gets a one-line command in the same commit.
- **Say what you want to change, and why, before you change it.** That applies to the house rules
  themselves.
- **Leave nothing orphaned** — a symbol, a setting, a merged branch. Cleanup belongs to the change
  that caused it, not to a later sweep.
