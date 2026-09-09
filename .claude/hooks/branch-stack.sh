#!/usr/bin/env bash
#
# PreToolUse: fires when a new branch is being created, and puts a deep stack in
# front of a human rather than refusing it.
#
# It returns "ask", not "deny", deliberately. Stacking is sometimes right — a
# phase that edits code the phase below it is the first to call has nowhere else
# to go. What is never right is stacking *without anyone deciding to*. So this is
# a guard in BUILDING.md's "except guards" sense: it fails open, and its job is
# to make the decision visible at the moment it is being made.
#
# The threshold is 3 from evidence rather than taste: three phases stacked on one
# base here once forced the plan to record that the bottom one's end-to-end test
# gated all three — an incremental plan degrading into a waterfall, visible in
# advance and accepted anyway.

set -uo pipefail

# shellcheck source=lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

repo="${CLAUDE_PROJECT_DIR:-$PWD}"
threshold="${BRANCH_STACK_MAX:-3}"
base="$(stackBase "$repo")"

# It gates itself on the command rather than relying on the settings matcher to
# do it. Two reasons, and the second is the one that decides it: the matcher
# selects on tool name, so narrowing to branch creation needs a per-hook
# condition and this then works under any wiring; and a hook that prompts on
# every Bash call once the stack is deep trains the human to approve without
# reading, which costs more than the stack it was warning about.
#
# Guarded on a tty so that running this by hand in a terminal reports the stack
# instead of hanging on `cat`. The runtime always pipes JSON in, so the guarded
# branch is the only one that matters in production; the other one is what makes
# the hook inspectable, which is how the stack count gets checked by a person.
payload=""
if [ ! -t 0 ]; then
  payload="$(cat 2>/dev/null || true)"
fi

if [ -n "$payload" ]; then
  command_text="$(
    printf '%s' "$payload" | node -e '
      let s = "";
      process.stdin.on("data", (d) => (s += d)).on("end", () => {
        try {
          const j = JSON.parse(s);
          process.stdout.write(String((j.tool_input && j.tool_input.command) || ""));
        } catch {
          process.stdout.write("");
        }
      });
    ' 2>/dev/null || true
  )"

  # `git branch <name>` is included and `git branch -d`, `--list`, `-a` and a
  # bare `git branch` are not, because only the first creates one.
  if ! printf '%s' "$command_text" | grep -Eq \
    'git[[:space:]]+(switch[[:space:]]+(-[^[:space:]]*[[:space:]]+)*-c|checkout[[:space:]]+(-[^[:space:]]*[[:space:]]+)*-b|worktree[[:space:]]+add|branch[[:space:]]+[A-Za-z0-9])'; then
    exit 0
  fi
fi

branches="$(unmergedBranches "$repo" "$base")"
count="$(countLines "$branches")"

if [ "${count:-0}" -ge "$threshold" ]; then
  # `paste -sd ', '` reads its -d argument as a *cycling list* of delimiters, not as one
  # two-character separator, so it joined three branches as "a,b c" — comma, then space, then comma.
  # awk is used rather than a `sed 's/,/, /g'` repair because a git ref may legally contain a comma,
  # and that repair would rewrite the branch name it was printing.
  list="$(printf '%s\n' "$branches" | grep -ve '^$' |
    awk 'NR > 1 { printf ", " } { printf "%s", $0 } END { if (NR) print "" }' 2>/dev/null || true)"
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"%s branches are already unmerged into %s (%s). Each unmerged base gates everything stacked above it, and the review of the bottom one gates the lot. Merge or close some before adding another, or approve to proceed deliberately."}}\n' \
    "$count" "$(jsonEscape "$base")" "$(jsonEscape "$list")"
fi

exit 0
