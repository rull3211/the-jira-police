#!/usr/bin/env bash
#
# The guards' own test suite. Run it with `pnpm test:hooks`.
#
# These hooks are not covered by vitest, because what they are is shell scripts
# the Claude Code runtime pipes JSON through — the thing worth testing is the
# script as the runtime invokes it, not a function inside it. That is the same
# argument `src/cli/solve-run.test.ts` makes for spawning a child process to
# prove `sleep` holds the event loop open: the property belongs to a program.
#
# It exists because the JSON-escaping defect below was found by hand, once, in
# a terminal that then scrolled away. A guard with no repeatable test is a
# guard whose next regression is silent — and these two are the only mechanical
# enforcement of the rule that this repository never accepts work on `main`.
#
# Fixtures are built with `mktemp -d` and left behind deliberately: nothing here
# deletes a directory, so a failing case can be inspected afterwards.

set -uo pipefail

# The fixtures are real repositories, so `git commit` needs an identity — and
# for as long as this suite existed it borrowed the developer's. That made it
# 57-green on a laptop and unrunnable anywhere else. The first CI run that ever
# executed it died on `empty ident name`: no fixture reached its initial commit,
# so no fixture had a `main` ref, and 22 assertions failed describing that
# instead of describing the guards. The suite was never wrong about the hooks;
# it was only ever a statement about the machine it ran on.
#
# So it now supplies its own identity and reads no ambient configuration at all.
# Comment out the two identity pairs and run in a clean environment and the CI
# failure returns exactly — 22 failed, 35 passed — which is how this fix was
# checked.
#
# The two config-neutralising lines are reasoned rather than measured, and are
# marked as such deliberately: a developer's `commit.gpgsign`, `core.hooksPath`
# or `init.defaultBranch` would leak into fixtures that exist to make assertions
# about git state, but demonstrating that needs a hostile config file written to
# disk, which the operator's guards refuse. They are cheap and they fail safe;
# they are not evidence-backed the way the lines above them are.
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME='hook tests' GIT_AUTHOR_EMAIL='hook-tests@invalid'
export GIT_COMMITTER_NAME='hook tests' GIT_COMMITTER_EMAIL='hook-tests@invalid'

HOOKS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pass=0
fail=0

# Reads a hook's stdout and prints one word: DENY, ASK, SILENT, or BADJSON.
# BADJSON is a distinct outcome rather than an error because it is the failure
# this suite was written for — the runtime drops a decision it cannot parse, so
# an unparseable deny is indistinguishable from no guard at all.
decision() {
  node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      if (!s.trim()) return console.log("SILENT");
      try {
        console.log(JSON.parse(s).hookSpecificOutput.permissionDecision.toUpperCase());
      } catch {
        console.log("BADJSON");
      }
    });
  '
}

expect() {
  local name="$1" want="$2" got="$3"
  if [ "$got" = "$want" ]; then
    printf '  ok    %-46s %s\n' "$name" "$got"
    pass=$((pass + 1))
  else
    printf '  FAIL  %-46s want %s, got %s\n' "$name" "$want" "$got"
    fail=$((fail + 1))
  fi
}

# A scratch repository whose HEAD is whatever the caller asks for.
scratch() {
  local dir
  dir="$(mktemp -d)"
  git init -q -b main "$dir"
  git -C "$dir" commit -q --allow-empty -m init
  printf '%s' "$dir"
}

bash_payload() {
  printf '{"tool_name":"Bash","tool_input":{"command":"%s"}}' "$1"
}

echo "branch-guard.sh"

main_repo="$(scratch)"
expect "write on main is refused" DENY \
  "$(CLAUDE_PROJECT_DIR="$main_repo" "$HOOKS/branch-guard.sh" </dev/null | decision)"

# Git permits `"` in a ref name. Before the escaping fix this printed a deny
# that would not parse, so the runtime dropped it and the write went through:
# the guard failed open on the name of the branch it was guarding against.
git -C "$main_repo" switch -q -c 'release/a"b'
expect "quote in branch name still parses" DENY \
  "$(CLAUDE_PROJECT_DIR="$main_repo" "$HOOKS/branch-guard.sh" </dev/null | decision)"

git -C "$main_repo" switch -q -c 'feat/ordinary'
expect "write on a feature branch is allowed" SILENT \
  "$(CLAUDE_PROJECT_DIR="$main_repo" "$HOOKS/branch-guard.sh" </dev/null | decision)"

for target in "git push origin main" "git push origin HEAD:main" \
  "git push origin master" "git push -f origin develop"; do
  expect "refuses: $target" DENY \
    "$(bash_payload "$target" | CLAUDE_PROJECT_DIR="$main_repo" "$HOOKS/branch-guard.sh" | decision)"
done

# The word-boundary half of the regex. A substring match refuses all three of
# these, and a guard that blocks ordinary work gets switched off.
for target in "git push -u origin fix/domain" "git push -u origin feat/main-thing" \
  "git push -u origin feat/remaining" "git push"; do
  expect "allows: $target" SILENT \
    "$(bash_payload "$target" | CLAUDE_PROJECT_DIR="$main_repo" "$HOOKS/branch-guard.sh" | decision)"
done

expect "malformed stdin does not crash" SILENT \
  "$(printf 'not json' | CLAUDE_PROJECT_DIR="$main_repo" "$HOOKS/branch-guard.sh" | decision)"
expect "empty stdin does not crash" SILENT \
  "$(printf '' | CLAUDE_PROJECT_DIR="$main_repo" "$HOOKS/branch-guard.sh" | decision)"

# On a protected branch, a Bash call is judged on whether it writes. The escape
# hatch is the case that matters: the denial text tells the agent to branch, so
# refusing the branch command would leave it with no compliant move at all.
git -C "$main_repo" switch -q main
expect "on main: an Edit is refused" DENY \
  "$(printf '%s' '{"tool_name":"Edit","tool_input":{"file_path":"a.ts"}}' |
    CLAUDE_PROJECT_DIR="$main_repo" "$HOOKS/branch-guard.sh" | decision)"

for w in "git commit -m x" "git merge feat/x" "git rebase feat/x" "git revert HEAD" \
  "git reset --hard" "git cherry-pick abc123" "git rm f.ts"; do
  expect "on main refuses: $w" DENY \
    "$(bash_payload "$w" | CLAUDE_PROJECT_DIR="$main_repo" "$HOOKS/branch-guard.sh" | decision)"
done

# The bypasses the write-list missed until 2026-09-09, every one of them
# measured as allowed before the fix. The regex required the subcommand to sit
# immediately after `git`, so any global option in front of it walked past.
for w in "git -C . commit -m x" "git --no-pager commit -m x" \
  "git -c user.name=x commit -m x" "git -C /x -c a=b commit -m y"; do
  expect "on main refuses: $w" DENY \
    "$(bash_payload "$w" | CLAUDE_PROJECT_DIR="$main_repo" "$HOOKS/branch-guard.sh" | decision)"
done

# A bare push names no branch, so the push check above cannot see it, and it
# goes to `main` anyway through the upstream. It is caught as a write instead.
# The pair to this is "allows: git push" on a feature branch above: the command
# is identical and only the branch decides, which is the whole point.
expect "on main refuses: git push" DENY \
  "$(bash_payload "git push" | CLAUDE_PROJECT_DIR="$main_repo" "$HOOKS/branch-guard.sh" | decision)"

for r in "git switch -c feat/x" "git checkout -b feat/x" "git status" "git log" \
  "git diff" "git fetch origin" "pnpm test" "ls"; do
  expect "on main allows: $r" SILENT \
    "$(bash_payload "$r" | CLAUDE_PROJECT_DIR="$main_repo" "$HOOKS/branch-guard.sh" | decision)"
done

git -C "$main_repo" switch -q feat/ordinary
expect "off main: a commit is fine" SILENT \
  "$(bash_payload "git commit -m x" | CLAUDE_PROJECT_DIR="$main_repo" "$HOOKS/branch-guard.sh" | decision)"

# Rule 2: a human merges, always. Until 2026-09-09 nothing in this tree enforced
# it at all, and every command below was allowed from every branch.
#
# Both fixtures are checked because rule 2 is not a question about where you are
# standing, and the feature branch is the case that matters: that is where an
# agent is when its pull request goes green and merging becomes tempting.
for m in "gh pr merge 15 --squash --admin" "gh pr merge --auto 15" \
  "gh --repo o/r pr merge 15" "pnpm test && gh pr merge 15" \
  "gh api repos/o/r/pulls/1/merge"; do
  expect "off main refuses: $m" DENY \
    "$(bash_payload "$m" | CLAUDE_PROJECT_DIR="$main_repo" "$HOOKS/branch-guard.sh" | decision)"
done

git -C "$main_repo" switch -q main
expect "on main refuses: gh pr merge 15" DENY \
  "$(bash_payload "gh pr merge 15" | CLAUDE_PROJECT_DIR="$main_repo" "$HOOKS/branch-guard.sh" | decision)"
git -C "$main_repo" switch -q feat/ordinary

# The line between guarding the act and censoring the word, which is why the
# match is anchored to command position rather than looked for anywhere in the
# text. `PLAN.md` discusses `gh pr merge` at length and so do commit messages in
# this repository; a guard that stopped you writing about itself would be turned
# off the same day. The last case here is the one that catches that mistake.
for ok in "gh pr view 15" "gh pr create --draft" "gh pr checks" "gh pr ready" \
  "gh api repos/o/r/pulls/15 --jq .mergeable" \
  "git commit -m 'docs: explain why gh pr merge is refused'"; do
  expect "off main allows: $ok" SILENT \
    "$(bash_payload "$ok" | CLAUDE_PROJECT_DIR="$main_repo" "$HOOKS/branch-guard.sh" | decision)"
done

echo
echo "branch-stack.sh"

stack="$(scratch)"
expect "no unmerged branches is quiet" SILENT \
  "$(CLAUDE_PROJECT_DIR="$stack" "$HOOKS/branch-stack.sh" </dev/null | decision)"

# Empty branches count as merged, so each fixture branch needs a commit. Getting
# this wrong once produced a SILENT that looked like a bug in the hook and was
# a bug in the test.
git -C "$stack" switch -q -c 'feat/q"z' && git -C "$stack" commit -q --allow-empty -m w1
expect "under the threshold is quiet" SILENT \
  "$(BRANCH_STACK_MAX=3 CLAUDE_PROJECT_DIR="$stack" "$HOOKS/branch-stack.sh" </dev/null | decision)"

git -C "$stack" switch -q main
git -C "$stack" switch -q -c feat/two && git -C "$stack" commit -q --allow-empty -m w2
git -C "$stack" switch -q main
git -C "$stack" switch -q -c feat/three && git -C "$stack" commit -q --allow-empty -m w3

# Standing on main, which is the realistic position: the hook fires when a
# branch is about to be created, and the branch you are on is not part of the
# backlog you are being asked to clear.
git -C "$stack" switch -q main
expect "at the threshold asks a human" ASK \
  "$(BRANCH_STACK_MAX=3 CLAUDE_PROJECT_DIR="$stack" "$HOOKS/branch-stack.sh" </dev/null | decision)"
expect "quoted branch in the list still parses" ASK \
  "$(BRANCH_STACK_MAX=1 CLAUDE_PROJECT_DIR="$stack" "$HOOKS/branch-stack.sh" </dev/null | decision)"

# It asks and never denies. Stacking is sometimes the right call; what is never
# right is stacking without anyone deciding to.
expect "never denies" ASK \
  "$(BRANCH_STACK_MAX=1 CLAUDE_PROJECT_DIR="$stack" "$HOOKS/branch-stack.sh" </dev/null | decision)"

# The default is the number that will actually be in force, and every case above
# overrides it — so raising it to 99 left the whole suite green. It is 3 from
# evidence rather than taste (three phases stacked on one base once forced the
# plan to record that the bottom one's end-to-end test gated all three), and a
# threshold nothing pins is a threshold that drifts.
unset BRANCH_STACK_MAX
expect "default threshold fires at 3" ASK \
  "$(CLAUDE_PROJECT_DIR="$stack" "$HOOKS/branch-stack.sh" </dev/null | decision)"

two_deep="$(scratch)"
git -C "$two_deep" switch -q -c feat/a && git -C "$two_deep" commit -q --allow-empty -m a
git -C "$two_deep" switch -q main
git -C "$two_deep" switch -q -c feat/b && git -C "$two_deep" commit -q --allow-empty -m b
git -C "$two_deep" switch -q main
expect "default threshold is quiet at 2" SILENT \
  "$(CLAUDE_PROJECT_DIR="$two_deep" "$HOOKS/branch-stack.sh" </dev/null | decision)"

# The branch you are standing on is not backlog. Counting it means the number
# can never reach zero, and a threshold that cannot be satisfied is a prompt
# people learn to dismiss without reading.
git -C "$two_deep" switch -q -c feat/c && git -C "$two_deep" commit -q --allow-empty -m c
expect "HEAD is not counted against the stack" SILENT \
  "$(CLAUDE_PROJECT_DIR="$two_deep" "$HOOKS/branch-stack.sh" </dev/null | decision)"

# The base is origin/main when it exists, and this is the case that matters:
# a local main twenty commits behind its remote reported eleven stacked branches
# when nine of them were merged upstream with their remotes already deleted. The
# count survived the operator cleaning up, which is how it was found.
bare="$(mktemp -d)/origin.git"
git init -q --bare -b main "$bare"
clone="$(mktemp -d)/clone"
git clone -q "$bare" "$clone" 2>/dev/null
git -C "$clone" commit -q --allow-empty -m init
git -C "$clone" push -q -u origin main
# Merged upstream, and local main never pulled it — the exact state the real
# repository was in when this was found.
git -C "$clone" switch -q -c feat/merged-upstream && git -C "$clone" commit -q --allow-empty -m up
git -C "$clone" push -q origin feat/merged-upstream:main
git -C "$clone" fetch -q origin
git -C "$clone" switch -q main
expect "measures against origin/main, not stale local main" SILENT \
  "$(BRANCH_STACK_MAX=1 CLAUDE_PROJECT_DIR="$clone" "$HOOKS/branch-stack.sh" </dev/null | decision)"

# And the same repository read against the stale local ref is the bug, so this
# is the assertion that fails if the preference order is ever reversed.
expect "the stale local ref would have reported a stack" ASK \
  "$(BRANCH_STACK_BASE=main BRANCH_STACK_MAX=1 CLAUDE_PROJECT_DIR="$clone" \
    "$HOOKS/branch-stack.sh" </dev/null | decision)"

# Once the base is origin/main, local `main` can itself appear unmerged — it does
# the moment it holds an unpushed commit. It is the base, not backlog, so it is
# excluded. This case is why that filter is not dead code: it never fires while
# the base is a local branch, because nothing is unmerged into itself.
git -C "$clone" switch -q main
git -C "$clone" commit -q --allow-empty -m "local commit not pushed"
git -C "$clone" switch -q -c feat/elsewhere
expect "the base is not counted as its own backlog" SILENT \
  "$(BRANCH_STACK_MAX=1 CLAUDE_PROJECT_DIR="$clone" "$HOOKS/branch-stack.sh" </dev/null | decision)"

# The command gate. Without it the hook prompts on every Bash call once the
# stack is deep, and a guard that cries wolf gets approved without being read.
for creating in "git switch -c feat/x" "git switch --track -c feat/x" \
  "git checkout -b feat/x" "git checkout -q -b feat/x" \
  "git worktree add /tmp/w -b feat/x" "git branch feat/x"; do
  expect "asks on: $creating" ASK \
    "$(bash_payload "$creating" | CLAUDE_PROJECT_DIR="$stack" "$HOOKS/branch-stack.sh" | decision)"
done

for other in "git switch main" "git checkout main" "git branch" "git branch -d feat/x" \
  "git branch --list" "git status" "pnpm test" "git commit -m x"; do
  expect "quiet on: $other" SILENT \
    "$(bash_payload "$other" | CLAUDE_PROJECT_DIR="$stack" "$HOOKS/branch-stack.sh" | decision)"
done

echo
echo "session-brief.sh"

brief="$(CLAUDE_PROJECT_DIR="$main_repo" "$HOOKS/session-brief.sh")"
case "$brief" in
*dev-house-rules/SKILL.md*)
  expect "names the working contract" yes yes
  ;;
*)
  expect "names the working contract" yes no
  ;;
esac

on_main="$(cd "$main_repo" && git switch -q main && CLAUDE_PROJECT_DIR="$main_repo" "$HOOKS/session-brief.sh")"
case "$on_main" in
*"protected branch"*)
  expect "warns when HEAD is main" yes yes
  ;;
*)
  expect "warns when HEAD is main" yes no
  ;;
esac

echo
if [ "$fail" -gt 0 ]; then
  echo "$fail failed, $pass passed"
  exit 1
fi
echo "$pass passed"
