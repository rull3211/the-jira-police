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
# It also fires with source=compact, which is the real win. A compaction drops
# whatever was not summarised, and the house rules are the first thing to go.
# This puts them back.
#
# Output is plain stdout, which the runtime injects as context.

set -uo pipefail

# shellcheck source=lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

repo="${CLAUDE_PROJECT_DIR:-$PWD}"

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
