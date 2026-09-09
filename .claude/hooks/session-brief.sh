#!/usr/bin/env bash
#
# SessionStart: states the working contract and the repository's current shape,
# unconditionally, at the top of every session.
#
# Why this exists rather than relying on the skill being invoked: a skill is
# model-invoked. Nothing guarantees it is read, and the case where it is least
# likely to be read is a narrow prompt in a long session — which is exactly the
# case where the rules matter most. A SessionStart hook is the only mechanism
# that injects text whether or not the model asks for it.
#
# It also fires with trigger=compact, and that case is handled separately below
# because a pointer is not enough there. See "the compact case".
#
# Output is plain stdout, which the runtime injects as context.

set -uo pipefail

# shellcheck source=lib.sh
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$here/lib.sh"

repo="${CLAUDE_PROJECT_DIR:-$PWD}"

# Reading stdin is conditional because this hook is also run directly by
# test-hooks.sh and by hand, and an unconditional `cat` blocks forever on a
# terminal — which would turn a diagnostic into a hang.
#
# `[ ! -t 0 ]` alone was not enough, and this is the second version. It tells a
# tty from a pipe and nothing else: a pipe that is open but never written is not
# a tty, so `cat` sat on it forever. That took the test suite with it, because
# the suite invokes this hook without redirecting stdin — green by luck on a
# developer's terminal, hung indefinitely anywhere stdin is an idle pipe, which
# is a plausible shape for CI. So the read is bounded as well as conditional.
# `-d ''` keeps the newlines the JSON does not need but a human reading a
# diagnostic does; the timeout is the whole point and returns non-zero on
# expiry, which is not an error here.
payload=""
if [ ! -t 0 ]; then
  IFS= read -r -d '' -t 1 payload || true
fi

# The field is `trigger`, with values startup|resume|clear|compact|fork. This
# file documented it as `source` for as long as it existed, which cost nothing
# until this change started branching on it.
#
# `trigger` is taken from documentation read by a subagent, not from a payload
# anyone here has observed, and `source` is the field name PreCompact uses — a
# plausible thing to have conflated in either direction. Accepting both costs
# one `||` and removes the case where this whole branch is silently dead code.
# Do not narrow it to one until a real payload has been seen.
#
# `node` rather than `jq`, matching branch-guard.sh: this project already
# requires Node and jq is not a stated dependency. A parse failure yields an
# empty string, which falls through to the unconditional brief — the safe
# direction, since the cost of a wrong guess here is text nobody needed.
trigger=""
if [ -n "$payload" ]; then
  trigger="$(
    printf '%s' "$payload" | node -e '
      let s = "";
      process.stdin.on("data", (d) => (s += d)).on("end", () => {
        try {
          const j = JSON.parse(s);
          process.stdout.write(String(j.trigger || j.source || ""));
        } catch {
          process.stdout.write("");
        }
      });
    ' 2>/dev/null || true
  )"
fi

branch="$(git -C "$repo" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
dirty="$(git -C "$repo" status --porcelain 2>/dev/null | grep -c . || true)"
base="$(stackBase "$repo")"
unmerged="$(countLines "$(unmergedBranches "$repo" "$base")")"

cat <<BRIEF
This repository has a working contract: .claude/skills/dev-house-rules/SKILL.md.
Read it before changing code or prose. It is not a style guide — every rule in it
generalises a defect that already shipped here, and each one links to the incident
that produced it in INCIDENTS.md. SKILL.md is an index: the rules are split by phase
into STARTING, BUILDING, PROVING and FINISHING, so load the one you are in rather
than all four. CLAUDE.md states what is non-negotiable; the skill has the reasoning.

Repository state: branch '$branch', $dirty uncommitted file(s), $unmerged branch(es) unmerged into $base.
BRIEF

# ---------------------------------------------------------------------------
# The compact case.
#
# Why a compacted context is the one worth spending tokens on: it inherited a
# summary of the work rather than the work, so it holds a confident account of
# the rules and has never read them. FINISHING.md said that before this hook
# did, from an incident rather than from theory.
#
# Read the incident for how strong that claim is and is not. It was first
# written here as a measured near-certainty — every compaction boundary
# followed straight into a commit — and that measurement was wrong, in the
# direction its author was looking. One boundary of four fits it. So this block
# is justified by the mechanism and by one case, not by a rate, and no number
# appears in what it injects: a dated war story pasted into a shell script is
# read by every future session as current.
#
# Two consequences for what it says. It names committing, because the brief
# above says "before changing code or prose" and committing is neither. And it
# carries the checklist itself rather than a pointer to it, because a pointer is
# precisely what a compacted context discounts — it reads "go and read the
# rules" as already satisfied.
#
# The checklist is EXTRACTED from the source files, never copied into this one.
# Copying it would create a fact with two homes and one maintainer, which is the
# rule STARTING.md states and the drift PROVING.md's literal-list rule is about.
# Extraction also fails loudly: rename the heading and this prints nothing,
# which test-hooks.sh asserts against.
#
# Budget, because the fix has an obvious failure mode: a brief that grows gets
# skimmed exactly like the pointer it replaced. Measured against this tree at
# the time of writing, the compact brief is 34 lines. Past roughly sixty it has
# become the thing it was fixing — cut something rather than append.
# ---------------------------------------------------------------------------
if [ "$trigger" = "compact" ]; then
  # Each item wraps across several lines, so a continuation (`^ +\S`) is taken
  # with the line that opened it. Matching only the first line of each looked
  # right in the file and cut every sentence in half on the way out — found by
  # running it, which is the only way this class of defect is ever found.
  rules="$(awk '/^## Two rules that are not advisory/{f=1;next} f&&/^## /{exit}
                f&&/^[0-9]+\. /{p=1} f&&p&&/^$/{p=0} f&&p{print}' \
    "$repo/CLAUDE.md" 2>/dev/null || true)"
  checklist="$(awk '/^## The checklist/{f=1;next} f&&/^\*\*And the rules/{exit}
                    f&&/^- \[ \]/{p=1} f&&p&&/^$/{p=0} f&&p{print}' \
    "$repo/.claude/skills/dev-house-rules/FINISHING.md" 2>/dev/null || true)"

  echo
  echo "This context was just compacted. You inherited a summary of the rules, not the rules. What a"
  echo "summary keeps is the half with an exit code behind it — the commands — and what it drops is"
  echo "the judgement half, which is the half that is never green or red and so never missed."

  if [ -n "$rules" ]; then
    echo
    echo "The two that are not advisory, from CLAUDE.md:"
    printf '%s\n' "$rules"
  fi

  if [ -n "$checklist" ]; then
    echo
    echo "Before your next commit, these are the four questions with no command behind them"
    echo "(FINISHING.md, 'The checklist' — re-read it there rather than working from this copy):"
    printf '%s\n' "$checklist"
  fi

  echo
  echo "If you are mid-task, re-read the phase file for the phase you are in before continuing."
fi

if [ "$branch" = "main" ] || [ "$branch" = "master" ]; then
  cat <<'ONMAIN'
You are on a protected branch. Do not edit anything here: branch first with
git switch -c feat/<slug> (or fix/, chore/, docs/, refactor/). A PreToolUse hook
will refuse writes and it is not to be worked around.
ONMAIN
fi

if [ "${unmerged:-0}" -ge "${BRANCH_STACK_MAX:-3}" ]; then
  echo "The branch stack is $unmerged deep. Ask for some to be merged or closed before starting another; each unmerged base gates everything above it."
fi

exit 0
