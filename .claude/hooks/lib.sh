#!/usr/bin/env bash
#
# Shared by branch-stack.sh and session-brief.sh, which both have to answer one
# question: how many branches are stacked up unmerged. It is one fact, so it has
# one implementation — two copies of a count is the shape STARTING.md warns
# about, and here the two would drift in opposite directions.
#
# Nothing in here is a guard. It is measurement, and every function fails soft:
# a repository this cannot read reports zero rather than refusing, because the
# callers use the number to inform a human, not to block anything.

# The branch to measure against, in order of preference:
#
#   1. BRANCH_STACK_BASE, if the operator set it
#   2. origin/main, the remote-tracking ref
#   3. main, the local branch
#
# The order is the whole point of this file. Measuring against local `main` was
# wrong in a way that took a real cleanup to expose: local `main` was twenty
# commits behind `origin/main`, so nine branches that had been merged and had
# their remotes deleted still counted as stacked. The hook reported eleven, the
# true number was two, and it kept reporting eleven after the operator fixed it.
# A stale local ref is not a fact about the project, and a guard reading one
# tells a human to go and do work that is already done.
#
# It deliberately does NOT fetch. A hook runs ahead of every matching tool call,
# so a network round trip there is a hang waiting for a bad connection, and an
# offline session would stop being able to edit files. The cost is that the
# number is as fresh as the last fetch, which is the right trade: being wrong in
# the direction of "you have fewer branches than you think" is recoverable, and
# blocking on the network is not.
stackBase() {
  local repo="$1"

  if [ -n "${BRANCH_STACK_BASE:-}" ]; then
    printf '%s' "$BRANCH_STACK_BASE"
    return 0
  fi

  if git -C "$repo" rev-parse --verify --quiet origin/main >/dev/null 2>&1; then
    printf 'origin/main'
    return 0
  fi

  printf 'main'
}

# Branch names not merged into the base, one per line, excluding the base itself
# and the branch currently checked out.
#
# HEAD is excluded because the caller is always standing on it: counting the
# branch you are working on as part of the backlog you should clear means the
# number can never reach zero, and a threshold that cannot be satisfied is a
# prompt people learn to dismiss.
unmergedBranches() {
  local repo="$1" base="$2" head
  head="$(git -C "$repo" rev-parse --abbrev-ref HEAD 2>/dev/null || printf '')"

  git -C "$repo" branch --no-merged "$base" --format='%(refname:short)' 2>/dev/null |
    grep -ve '^$' |
    grep -vxF "${base#origin/}" |
    grep -vxF "$head" ||
    true
}

countLines() {
  printf '%s\n' "$1" | grep -cve '^$' || true
}

# Branch names go into a JSON string, so they are escaped rather than trusted.
# Git permits `"` in a ref name; unescaped, one such branch makes the whole
# decision unparseable and the runtime drops it — a guard failing open while
# still looking installed. Found by testing, not by reading.
jsonEscape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '%s' "${s//$'\n'/ }"
}
