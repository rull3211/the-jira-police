# the-jira-police

A TypeScript service that grooms Jira tickets and, for the subset of bugs an agent can fix safely,
solves them: triage, claim, fix in an isolated worktree, draft PR, answer the review. Node ≥24 with
type-stripping, pnpm, **no build step**.

## Read this before changing anything

**`.claude/skills/dev-house-rules/SKILL.md` is the working contract for this repository** — how to
guard a change, how to phase a privilege, how to make failures legible, and how to keep the
documentation true. It is not optional reading and it is not a style guide; every rule in it is the
generalisation of a defect that already got through here.

Load it at the start of any task that touches this repository, code or prose. If you have read it
this session, you do not need to read it again.

## Where the truth lives

| file                                      | answers                                                 |
| ----------------------------------------- | ------------------------------------------------------- |
| `README.md`                               | how to run it, what each command does                   |
| `ARCHITECTURE.md`                         | how it works, why it is shaped this way, the module map |
| `PLAN.md`                                 | what is **not** built yet, and what was learned         |
| `.claude/skills/dev-house-rules/SKILL.md` | how we work, and what went wrong last time              |

**All four are treated as source.** Prose falsified by a change is rewritten in the same commit, not
the next one. Structural facts — modules, entry points, the composition — live in `ARCHITECTURE.md`
and are cited from elsewhere, never copied.

## Two rules that are not advisory

Everything else in the house rules is recoverable if you get it wrong. These two are not.

1. **Never work on `main` or any protected branch.** Branch first — `feat/`, `fix/`, `chore/`,
   `docs/`, `refactor/`. One implementation branch per reviewable unit of privilege. A hook enforces
   this; do not look for a way around it, ask instead.
2. **A human merges. Always.** This service has no merge path and neither do you. Opening a pull
   request is the end of your side of the work.

**Do not stack branches deeply.** Each one that sits unmerged gates the ones above it, and three
stacked here once turned an incremental plan into a waterfall — recorded in `PLAN.md` at the time
and still the best argument against it. When the stack grows, stop and ask for the base to be
merged rather than building another floor on it.

Both rules are enforced mechanically by `.claude/hooks/`, and the guards have their own suite:
`pnpm test:hooks`. Run it if you change one. It caught a branch name containing a `"` breaking the
denial JSON, which made the guard fail _open_ while still looking installed.

## Before you start

**Write it into `PLAN.md` first** — what is being attempted, why now, and what would make it the
wrong idea. Then do the work; the entry is deleted when it ships. This is not bookkeeping. Work here
is done in sessions that end and compact, and a session that holds the intent only in its own
context leaves the next one a diff and a branch name. A diff never says what was being attempted or
what was already ruled out. See §0.

Then pick the branch: one per reviewable unit of privilege, and delete local branches that have
already merged — auto-delete-on-merge cleans the remote only.

## Working style

- **Run it.** A green test suite is a statement about the tests. Every defect of consequence in this
  project was found by driving a command against a real target, not by the suite — see §7.
- **Make it runnable.** Every capability gets a one-line command in the same commit — see §8.
- **Say what you want to change, and why, before you change it.** That applies to the house rules
  themselves, which are amended from incidents rather than from theory — see §16.
- **Leave nothing orphaned** — a symbol, a setting, a merged branch. Cleanup belongs to the change
  that caused it, not to a later sweep — see §15.
