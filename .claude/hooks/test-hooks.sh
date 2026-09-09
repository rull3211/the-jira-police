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

# The command is JSON-encoded rather than interpolated, and that is a repair.
# For as long as this helper existed it wrote the command straight into the
# string, so any case whose command contained a double quote produced a payload
# no hook could parse. Those assertions were not testing what they said: the
# hook was falling through its "cannot read the command" path and the expected
# outcome happened to be the same one. Exposed by commit-brief.sh, which is the
# first hook here that behaves differently on an unparseable payload than on a
# command it does not care about — three of its assertions inverted, and the
# harness turned out to be the thing that was wrong.
#
# This is lib.sh's jsonEscape incident for a third time, in the test suite this
# time: hand-built JSON containing user text is the same defect wherever it is
# written.
bash_payload() {
  node -e '
    process.stdout.write(
      JSON.stringify({ tool_name: "Bash", tool_input: { command: process.argv[1] } }),
    );
  ' "$1"
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

# `pull` joined the write list on 2026-09-09, and this half is the constraint on
# that change rather than a formality. Updating a feature branch from upstream is
# the ordinary way work moves here; a guard that refused it would be switched off
# within the day. Only HEAD decides, which the paired refusals on `main` below
# assert with these same commands.
for target in "git pull" "git pull --rebase" "git pull --ff-only origin main"; do
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

# `merge` was on the write list and `pull` was not, so on `main` these four were
# every one of them measured as allowed while `git merge --ff-only origin/main`
# was refused — the same act with a fetch in front, and the one that can leave a
# merge commit on the protected branch. The `-C .` spelling is here because the
# global-option run in front of the subcommand is a bypass this list has already
# been caught by once.
for w in "git pull" "git pull --rebase" "git pull --ff-only origin main" "git -C . pull"; do
  expect "on main refuses: $w" DENY \
    "$(bash_payload "$w" | CLAUDE_PROJECT_DIR="$main_repo" "$HOOKS/branch-guard.sh" | decision)"
done

for r in "git switch -c feat/x" "git checkout -b feat/x" "git status" "git log" \
  "git diff" "git fetch origin" "pnpm test" "ls"; do
  expect "on main allows: $r" SILENT \
    "$(bash_payload "$r" | CLAUDE_PROJECT_DIR="$main_repo" "$HOOKS/branch-guard.sh" | decision)"
done

# `git pull-request` was in that list as an *allowed* case, proving the floor
# regex's `([[:space:]]|$)` terminator stopped `pull` swallowing it. It is
# refused now and that is the intended change, not a break: it is not a git
# subcommand, the read allowlist does not name it, and an unrecognised verb is a
# write. Refusing the verb nobody thought of is the property the inversion was
# chosen for, so the fixture stays and only its verdict moves.
#
# What that costs, stated rather than discovered later: the terminator is no
# longer observable through this guard's decision, because both halves refuse
# this input now and an assertion here cannot tell a working terminator from a
# broken one. It has become defence in depth behind a `case` that matches verbs
# exactly, where a prefix bug of that shape cannot arise. If the terminator
# regressed, nothing in this suite would go red.
expect "on main refuses: git pull-request, an unknown verb" DENY \
  "$(bash_payload "git pull-request" | CLAUDE_PROJECT_DIR="$main_repo" "$HOOKS/branch-guard.sh" | decision)"

# The audit. Every subcommand git knows about was fed to the guard with HEAD on
# a protected branch; the denylist refused 13 of 163 and the inversion refuses
# 102. These are the ones that measured *allowed* before it, each one a write
# the old list had no name for.
for w in "git checkout somefile.ts" "git clean -fd" "git stash" "git stash push -u" \
  "git update-ref refs/heads/x HEAD" "git symbolic-ref HEAD refs/heads/x" \
  "git send-pack origin HEAD" "git http-push https://example.invalid/r HEAD" \
  "git subtree merge --prefix=p ref" "git subtree pull --prefix=p origin ref" \
  "git reflog expire --all" "git bisect start" "git worktree add /tmp/x ref" \
  "git add ." "git read-tree HEAD" "git update-index --refresh" \
  "git checkout-index -a" "git sparse-checkout set src" "git submodule update --init" \
  "git tag v1.2.3" "git notes add -m hi" "git replace a b" "git config user.email x@y" \
  "git gc --prune=now" "git mergetool" "git fast-import" "git filter-branch --all" \
  "git branch -d gone" "git branch --force target ref" "git branch -m old new" \
  "git fetch origin topic:topic"; do
  expect "on main refuses: $w" DENY \
    "$(bash_payload "$w" | CLAUDE_PROJECT_DIR="$main_repo" "$HOOKS/branch-guard.sh" | decision)"
done

# The other half of the same claim, and the half that decides whether this guard
# survives contact with a working day. Inverting a denylist buys coverage with
# false positives, so every conditional verb gets its read form asserted next to
# its write form above. An over-refusal here is what earns a guard the contempt
# that gets it switched off.
for r in "git branch" "git branch --list" "git branch -a" "git branch --show-current" \
  "git branch newthing" "git stash list" "git stash show" "git reflog" "git reflog show" \
  "git tag" "git tag -l" "git tag --list" "git worktree list" "git remote" "git remote -v" \
  "git remote show origin" "git remote get-url origin" "git config --get user.email" \
  "git config --list" "git fetch" "git fetch --all --prune" "git submodule status" \
  "git bisect log" "git notes list" "git sparse-checkout list" "git checkout -B feat/x" \
  "git switch main" "git merge-base --is-ancestor a b" "git merge-tree --write-tree a b" \
  "git cherry -v main topic" "git ls-remote --heads origin" "git rev-parse HEAD" \
  "git show HEAD" "git grep -n TODO" "git describe --tags" "git shortlog -sn"; do
  expect "on main allows: $r" SILENT \
    "$(bash_payload "$r" | CLAUDE_PROJECT_DIR="$main_repo" "$HOOKS/branch-guard.sh" | decision)"
done

# The floor exists for exactly this: command-position analysis cannot see inside
# a quoted `-c` argument, so dropping the substring pass in favour of the
# inversion would have opened a hole while closing thirty. Measured — with the
# floor removed, all of these are allowed on a protected branch.
#
# The second and third are the shape the floor was missing until this suite
# stopped feeding it malformed JSON: the write verb sits flush against the
# closing quote, and the old `([[:space:]]|$)` terminator did not match a quote.
# `bash -lc "git push"` was in this list and passing on the harness defect
# rather than on the guard. The single-quoted fixture never covered it, because
# its verb is followed by a space either way — which is why one bad terminator
# hid behind a neighbouring assertion for four days.
for w in "sh -c 'git commit -m x'" "bash -lc \"git push\"" "sh -c 'git pull'" \
  "bash -c \"cd /tmp && git commit\""; do
  expect "on main refuses: $w" DENY \
    "$(bash_payload "$w" | CLAUDE_PROJECT_DIR="$main_repo" "$HOOKS/branch-guard.sh" | decision)"
done

# The over-refusal side of widening that terminator. A read inside the same
# quoting must still come back silent, or the floor has stopped being a floor
# and become a ban on the word "git" in an argument.
for r in "bash -lc \"git status\"" "sh -c 'git log --oneline -5'" \
  "bash -c \"git rev-parse HEAD\""; do
  expect "on main allows: $r" SILENT \
    "$(bash_payload "$r" | CLAUDE_PROJECT_DIR="$main_repo" "$HOOKS/branch-guard.sh" | decision)"
done

# Each simple command is examined on its own, so a write in the second half of a
# chain is caught. The first fixture's leading command is a read that the
# allowlist names, which is what makes it a test of the split rather than of the
# floor.
for w in "git status && git worktree add /tmp/x ref" "git log | head -5; git clean -fd"; do
  expect "on main refuses: $w" DENY \
    "$(bash_payload "$w" | CLAUDE_PROJECT_DIR="$main_repo" "$HOOKS/branch-guard.sh" | decision)"
done

# Global options and an absolute path in front of the verb, which is the bypass
# this guard has already been caught by once.
for w in "git -C . worktree add /tmp/x ref" "/usr/bin/git clean -fd" \
  "GIT_AUTHOR_NAME=x git stash" "git -c user.name=x tag v1"; do
  expect "on main refuses: $w" DENY \
    "$(bash_payload "$w" | CLAUDE_PROJECT_DIR="$main_repo" "$HOOKS/branch-guard.sh" | decision)"
done

# These are the assertions that make the option-consuming loop above testable at
# all, and they exist because a mutation survived without them.
#
# Deleting that loop was expected to let `git -C . worktree add` through. It did
# not, and the reason is a property of the inversion worth naming: with the
# options unconsumed, `-C` itself lands where the verb goes, the allowlist does
# not name it, and it is refused as an unrecognised write. Mis-parsing can only
# ever over-refuse here, never under-refuse -- which is the direction the whole
# change was chosen for, and also why the write fixtures above cannot see the
# loop break.
#
# So the loop's only observable job is not refusing a read that carries a global
# option, and that is what these check. Without them the loop is untested code
# that looks covered by the four assertions directly above it.
for r in "git -C . status" "git --no-pager log --oneline" \
  "git -c core.pager=cat diff" "git --git-dir=.git rev-parse HEAD"; do
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

brief="$(CLAUDE_PROJECT_DIR="$main_repo" "$HOOKS/session-brief.sh" </dev/null)"
case "$brief" in
*dev-house-rules/SKILL.md*)
  expect "names the working contract" yes yes
  ;;
*)
  expect "names the working contract" yes no
  ;;
esac

on_main="$(cd "$main_repo" && git switch -q main && CLAUDE_PROJECT_DIR="$main_repo" "$HOOKS/session-brief.sh" </dev/null)"
case "$on_main" in
*"protected branch"*)
  expect "warns when HEAD is main" yes yes
  ;;
*)
  expect "warns when HEAD is main" yes no
  ;;
esac

# --- the compact case -------------------------------------------------------
#
# A fixture repository carrying real copies of the two documents the brief
# extracts from, so the extraction can be mutated without touching the tree.
# The point of these assertions is not that the text appears; it is that the
# text is DERIVED. A brief that had the checklist pasted into it would pass
# every "contains" assertion here and fail the four mutations below, which is
# exactly the split PROVING.md's literal-list rule is about.
ROOT="$(cd "$HOOKS/../.." && pwd)"

brief_repo="$(scratch)"
mkdir -p "$brief_repo/.claude/skills/dev-house-rules"
cp "$ROOT/CLAUDE.md" "$brief_repo/CLAUDE.md"
cp "$ROOT/.claude/skills/dev-house-rules/FINISHING.md" \
  "$brief_repo/.claude/skills/dev-house-rules/FINISHING.md"

brief_out() {
  printf '%s' "$1" | CLAUDE_PROJECT_DIR="$brief_repo" "$HOOKS/session-brief.sh"
}

contains() {
  case "$1" in
  *"$2"*) printf 'yes' ;;
  *) printf 'no' ;;
  esac
}

compact="$(brief_out '{"trigger":"compact"}')"
expect "compact carries rule 1 verbatim" yes \
  "$(contains "$compact" 'Never work on `main`')"
expect "compact carries rule 2 verbatim" yes \
  "$(contains "$compact" 'A human merges. Always.')"
expect "compact carries the 3am question" yes \
  "$(contains "$compact" 'If this fails at 3am')"
expect "compact names committing" yes \
  "$(contains "$compact" 'Before your next commit')"

# The wrapped half of each item. Matching only the line that opens a list item
# shipped four sentences cut in half, and it looked correct in the source file.
expect "compact keeps wrapped continuations" yes \
  "$(contains "$compact" 'the ones you did not.')"

# A brief that is always long is a brief that is always skimmed, so the
# expensive half is spent only where it was measured to be needed.
startup="$(brief_out '{"trigger":"startup"}')"
expect "startup omits the checklist" no \
  "$(contains "$startup" 'If this fails at 3am')"
expect "startup still names the contract" yes \
  "$(contains "$startup" 'dev-house-rules/SKILL.md')"

# Mutation 1: rename the heading the extractor keys on. A pasted copy survives
# this; a derived one goes silent, and silence is what this asserts.
sed -i.bak 's/^## The checklist/## The list/' \
  "$brief_repo/.claude/skills/dev-house-rules/FINISHING.md"
mutated="$(brief_out '{"trigger":"compact"}')"
expect "renaming the heading drops the checklist" no \
  "$(contains "$mutated" 'If this fails at 3am')"
expect "...and the rules are unaffected" yes \
  "$(contains "$mutated" 'A human merges. Always.')"
mv "$brief_repo/.claude/skills/dev-house-rules/FINISHING.md.bak" \
  "$brief_repo/.claude/skills/dev-house-rules/FINISHING.md"

# Mutation 2: change the text itself. The brief must follow the source file
# rather than a snapshot of it taken when this hook was written.
sed -i.bak 's/If this fails at 3am/If this fails at dawn/' \
  "$brief_repo/.claude/skills/dev-house-rules/FINISHING.md"
followed="$(brief_out '{"trigger":"compact"}')"
expect "edited checklist text follows through" yes \
  "$(contains "$followed" 'If this fails at dawn')"
mv "$brief_repo/.claude/skills/dev-house-rules/FINISHING.md.bak" \
  "$brief_repo/.claude/skills/dev-house-rules/FINISHING.md"

# Mutations 3 and 4: the same pair again, against the OTHER extraction.
#
# They exist because the first version of this block guarded the checklist half
# and left the rules half unwatched, while one comment described both as
# "extracted" — so a pasted copy of the two rules passed everything above. An
# asymmetry between what a comment claims and what an assertion covers is
# invisible from the inside; this was found by mutating the half nobody had
# mutated. The lesson is per-extraction, not per-file.
sed -i.bak 's/^## Two rules that are not advisory/## Two important rules/' "$brief_repo/CLAUDE.md"
no_rules="$(brief_out '{"trigger":"compact"}')"
expect "renaming the rules heading drops the rules" no \
  "$(contains "$no_rules" 'A human merges. Always.')"
expect "...and the checklist is unaffected" yes \
  "$(contains "$no_rules" 'If this fails at 3am')"
mv "$brief_repo/CLAUDE.md.bak" "$brief_repo/CLAUDE.md"

sed -i.bak 's/A human merges. Always./A human merges. Invariably./' "$brief_repo/CLAUDE.md"
expect "edited rule text follows through" yes \
  "$(contains "$(brief_out '{"trigger":"compact"}')" 'A human merges. Invariably.')"
mv "$brief_repo/CLAUDE.md.bak" "$brief_repo/CLAUDE.md"

# `trigger` comes from documentation a subagent read, not from a payload anyone
# has seen, and PreCompact spells the same idea `source`. Both are accepted on
# purpose: guessing wrong makes the whole compact branch dead code that no test
# would notice. This asserts the tolerance rather than the guess.
expect "a source= payload is treated as compact too" yes \
  "$(contains "$(brief_out '{"source":"compact"}')" 'If this fails at 3am')"
expect "an unrelated trigger gets no checklist" no \
  "$(contains "$(brief_out '{"trigger":"resume"}')" 'If this fails at 3am')"

# Malformed input and no input both fall through to the short brief. A hook
# that crashes or hangs at SessionStart takes the session with it, so the safe
# direction is text nobody needed.
expect "malformed JSON degrades to the brief" yes \
  "$(contains "$(brief_out '{not json')" 'dev-house-rules/SKILL.md')"
expect "closed stdin degrades to the brief" yes \
  "$(contains "$(CLAUDE_PROJECT_DIR="$brief_repo" "$HOOKS/session-brief.sh" </dev/null)" \
    'dev-house-rules/SKILL.md')"

# The case the assertion above was named for and did not cover. `</dev/null` is
# stdin CLOSED; the hook's guard was `[ ! -t 0 ]`, which cannot tell a pipe with
# data coming from a pipe that will never be written, and `cat` waited on the
# second one forever. The suite inherited the hang, so it was green on a
# terminal and would have sat there until killed anywhere stdin is an idle pipe.
#
# Held open by fd 9 and never written. Watchdogged rather than trusted, because
# the failure this guards against is a hang, and a suite that hangs to report a
# hang has not reported anything.
fifo="$brief_repo/silent-stdin"
mkfifo "$fifo"
exec 9<>"$fifo"
CLAUDE_PROJECT_DIR="$brief_repo" "$HOOKS/session-brief.sh" <"$fifo" >"$brief_repo/silent.out" 2>&1 &
hookpid=$!
waited=0
while kill -0 "$hookpid" 2>/dev/null && [ "$waited" -lt 5 ]; do
  sleep 1
  waited=$((waited + 1))
done
if kill -0 "$hookpid" 2>/dev/null; then
  kill -9 "$hookpid" 2>/dev/null || true
  hung=yes
else
  hung=no
fi
wait "$hookpid" 2>/dev/null || true
exec 9>&-
expect "an open but silent stdin does not hang" no "$hung"
expect "...and it still prints the brief" yes \
  "$(contains "$(cat "$brief_repo/silent.out" 2>/dev/null || true)" 'dev-house-rules/SKILL.md')"

echo
echo "commit-brief.sh"

# The only hook here that is not a guard. It prints the four questions when a
# commit is about to happen and never refuses, so the assertions split three
# ways: it fires on the right commands, it stays out of the way on everything
# else, and — the one that matters most — it carries no permission decision at
# all. A reminder that accidentally learned to deny would stop every commit in
# the repository, and every stdout assertion below would still pass.

commit_repo="$(scratch)"
mkdir -p "$commit_repo/.claude/skills/dev-house-rules"
cp "$ROOT/.claude/skills/dev-house-rules/FINISHING.md" \
  "$commit_repo/.claude/skills/dev-house-rules/FINISHING.md"

commit_out() {
  bash_payload "$1" | CLAUDE_PROJECT_DIR="$commit_repo" "$HOOKS/commit-brief.sh"
}

# The advisory text, or empty. Distinct from `decision()` above, which reports
# BADJSON for output this hook produces on purpose — there is no
# permissionDecision to read.
context() {
  node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      if (!s.trim()) return;
      try {
        process.stdout.write(String(JSON.parse(s).hookSpecificOutput.additionalContext || ""));
      } catch {
        process.stdout.write("BADJSON");
      }
    });
  '
}

# yes when the output carries any permissionDecision field, which this hook must
# never do.
carries_decision() {
  node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      if (!s.trim()) return console.log("no");
      try {
        const o = JSON.parse(s).hookSpecificOutput || {};
        console.log("permissionDecision" in o ? "yes" : "no");
      } catch {
        console.log("BADJSON");
      }
    });
  '
}

fires() {
  local out
  out="$(commit_out "$1")"
  if [ -n "$out" ]; then printf 'yes'; else printf 'no'; fi
}

# The same question asked of a whole payload rather than a command, for the
# shapes `bash_payload` cannot build.
fires_payload() {
  local out
  out="$(printf '%s' "$1" | CLAUDE_PROJECT_DIR="$commit_repo" "$HOOKS/commit-brief.sh")"
  if [ -n "$out" ]; then printf 'yes'; else printf 'no'; fi
}

expect "fires on a plain git commit" yes "$(fires 'git commit')"
expect "fires on git commit -m" yes "$(fires 'git commit -m ok')"
expect "fires on git commit --amend" yes "$(fires 'git commit --amend')"
expect "fires after && in a chain" yes "$(fires 'pnpm test && git commit -m ok')"
expect "fires after ; in a chain" yes "$(fires 'pnpm test; git commit -m ok')"

# The solver works in isolated worktrees, so this is the form it would use. It
# is also the case the first pattern got wrong: allowing only dash-prefixed
# tokens between `git` and `commit` skipped the *argument* of `-C`.
expect "fires on git -C <path> commit" yes "$(fires 'git -C /tmp/x commit --amend')"
expect "fires on git -c k=v commit" yes "$(fires 'git -c user.name=x commit')"

# branch-guard.sh's rule, and the reason it matters more here: this hook fires
# on commits, and a commit message is the one place in this repository where the
# words "git commit" appear in prose constantly. Anchoring is the difference
# between guarding the act and censoring the words.
expect "silent on an unrelated git command" no "$(fires 'git status')"
expect "silent on a word that merely starts with commit" no "$(fires 'git commitment')"
expect "silent when the words appear in a quoted argument" no \
  "$(fires 'echo "remember to git commit later"')"
expect "silent when searching for the words" no "$(fires 'git log --grep "git commit"')"
expect "silent when searching for them unquoted" no "$(fires 'git log --grep git commit')"
expect "silent on a PR body mentioning them" no \
  "$(fires 'gh pr create --body "then git commit"')"

# The assertion the rest of this block exists to protect. A printer that starts
# denying blocks every commit; a printer that starts asking prompts on every
# one, which trains the human to approve without reading.
expect "carries no permission decision" no "$(commit_out 'git commit' | carries_decision)"
expect "the payload is valid JSON with context" yes \
  "$(contains "$(commit_out 'git commit' | context)" 'no command behind them')"
expect "names the branch it is about to commit on" yes \
  "$(contains "$(commit_out 'git commit' | context)" "on 'main'")"

# DERIVED, not pasted — the same split as the compact brief above. A copy of the
# checklist living in a shell script would pass the "contains" assertion and
# fail both mutations, and nothing else in this tree would ever check it.
expect "carries the 3am question" yes \
  "$(contains "$(commit_out 'git commit' | context)" 'If this fails at 3am')"
expect "keeps the wrapped continuation of an item" yes \
  "$(contains "$(commit_out 'git commit' | context)" 'the ones you did not.')"
expect "carries the Rules owed line" yes \
  "$(contains "$(commit_out 'git commit' | context)" 'Rules owed:')"

# Mutation 1: rename the heading. Unlike session-brief.sh, going quiet is NOT
# the accepted degradation here — this fires at the one moment the questions
# help, so it has to say out loud that it has stopped working.
sed -i.bak 's/^## The checklist/## The list/' \
  "$commit_repo/.claude/skills/dev-house-rules/FINISHING.md"
renamed="$(commit_out 'git commit' | context)"
expect "renaming the heading drops the questions" no \
  "$(contains "$renamed" 'If this fails at 3am')"
expect "...and it says so instead of going silent" yes \
  "$(contains "$renamed" 'has stopped reminding')"
expect "...and still carries no decision" no "$(commit_out 'git commit' | carries_decision)"
mv "$commit_repo/.claude/skills/dev-house-rules/FINISHING.md.bak" \
  "$commit_repo/.claude/skills/dev-house-rules/FINISHING.md"

# Mutation 2: edit the text. The brief must follow FINISHING.md rather than a
# snapshot taken when this hook was written.
sed -i.bak 's/If this fails at 3am/If this fails at dawn/' \
  "$commit_repo/.claude/skills/dev-house-rules/FINISHING.md"
expect "edited question text follows through" yes \
  "$(contains "$(commit_out 'git commit' | context)" 'If this fails at dawn')"
mv "$commit_repo/.claude/skills/dev-house-rules/FINISHING.md.bak" \
  "$commit_repo/.claude/skills/dev-house-rules/FINISHING.md"

# Quoting. The four questions contain double quotes, em dashes and a bracketed
# markdown link, so the JSON is built by node rather than hand-escaped. This is
# lib.sh's jsonEscape incident in a different costume: unescaped output is
# dropped by the runtime, and a hook that emits nothing looks exactly like a
# hook that had nothing to say.
expect "the embedded double quotes survive encoding" yes \
  "$(contains "$(commit_out 'git commit' | context)" '"The exception propagates"')"
expect "the markdown link survives encoding" yes \
  "$(contains "$(commit_out 'git commit' | context)" \
    '(#the-rules-you-owe-are-written-down-or-they-are-not-owed)')"

# Inspectability. Run by hand it prints, so a person can read what the model is
# being told rather than inferring it from the source.
expect "no payload at all still prints" yes \
  "$(contains "$(CLAUDE_PROJECT_DIR="$commit_repo" "$HOOKS/commit-brief.sh" </dev/null | context)" \
    'If this fails at 3am')"

# A payload that does not parse and a payload with no command in it are
# different failures and get different answers. The first version treated both
# as "not a commit" and went quiet, which is how a hook stops working and looks
# exactly like a hook with nothing to say — the failure mode this whole branch
# was opened about. Found by this assertion, which was written expecting the
# opposite result.
unparsed="$(printf '%s' '{not json' |
  CLAUDE_PROJECT_DIR="$commit_repo" "$HOOKS/commit-brief.sh" | context)"
expect "an unparseable payload still prints" yes "$(contains "$unparsed" 'If this fails at 3am')"
expect "...and says the payload is the reason" yes "$(contains "$unparsed" 'could not parse')"
expect "...and still carries no decision" no \
  "$(printf '%s' '{not json' |
    CLAUDE_PROJECT_DIR="$commit_repo" "$HOOKS/commit-brief.sh" | carries_decision)"

# Parsed, but no command: an ordinary PreToolUse payload for any tool that is
# not Bash. Silence is correct here, and asserting it is what stops the fix
# above from being widened into "print on everything".
expect "a parsed payload with no command stays silent" no \
  "$(fires_payload '{"tool_name":"Write","tool_input":{"file_path":"/tmp/x"}}')"

echo
echo "exit codes, and the branch list they print"

# Every assertion above this line reads stdout and none of them read an exit
# code, which left the suite unable to answer the one question that decides
# whether a guard works at all: is a decision carried on stdout with exit 0
# honoured by the runtime, or does it need the documented exit 2?
#
# Answered on 2026-09-09 by running it rather than by reading the reference. A
# Write on `main` came back refused in branch-guard.sh's own words, and every
# path exited 0. So exit 0 is right here, and these assertions exist to stop it
# being "fixed".
#
# That is not a hypothetical edit. The plan for this work had pre-committed to
# giving deny() an exit 2 if the probe let the write through, and for most of an
# afternoon it looked like it had — the guards were silent on `main` because the
# settings file registering them was still an unmerged pull request, so it was
# absent from that branch's working tree. Switching to exit 2 then would have
# passed every stdout assertion above, looked like hardening, and fixed nothing.
# In branch-stack.sh the same edit is worse than nothing: its decision is `ask`,
# and exit 2 turns a prompt a human can approve into a refusal they cannot.

codes="$(scratch)"

CLAUDE_PROJECT_DIR="$codes" "$HOOKS/branch-guard.sh" </dev/null >/dev/null 2>&1
expect "branch-guard: deny exits 0, not 2" 0 "$?"

bash_payload "gh pr merge 15" |
  CLAUDE_PROJECT_DIR="$codes" "$HOOKS/branch-guard.sh" >/dev/null 2>&1
expect "branch-guard: merge deny exits 0" 0 "$?"

git -C "$codes" switch -q -c feat/ordinary
CLAUDE_PROJECT_DIR="$codes" "$HOOKS/branch-guard.sh" </dev/null >/dev/null 2>&1
expect "branch-guard: staying silent exits 0" 0 "$?"

BRANCH_STACK_MAX=1 CLAUDE_PROJECT_DIR="$stack" "$HOOKS/branch-stack.sh" </dev/null >/dev/null 2>&1
expect "branch-stack: ask exits 0, never 2" 0 "$?"

CLAUDE_PROJECT_DIR="$(scratch)" "$HOOKS/branch-stack.sh" </dev/null >/dev/null 2>&1
expect "branch-stack: staying silent exits 0" 0 "$?"

# Both paths, because this hook has no decision to carry: a non-zero exit is the
# only way it could ever block anything, and exit 2 in particular is documented
# as blocking with stderr fed back. A reminder must not be able to stop a commit.
bash_payload "git commit -m x" |
  CLAUDE_PROJECT_DIR="$commit_repo" "$HOOKS/commit-brief.sh" >/dev/null 2>&1
expect "commit-brief: printing exits 0, never 2" 0 "$?"

bash_payload "git status" |
  CLAUDE_PROJECT_DIR="$commit_repo" "$HOOKS/commit-brief.sh" >/dev/null 2>&1
expect "commit-brief: staying silent exits 0" 0 "$?"

# `paste -sd ', '` reads -d as a cycling list of delimiters rather than as one
# two-character separator, so three branches came out as "a,b c". Nothing caught
# it because every assertion here checked the decision and none read the prose
# the human is actually asked to act on.
git -C "$stack" switch -q main
expect "the branch list is comma-and-space separated" yes \
  "$(contains "$(BRANCH_STACK_MAX=1 CLAUDE_PROJECT_DIR="$stack" \
    "$HOOKS/branch-stack.sh" </dev/null)" 'feat/three, feat/two')"

echo
if [ "$fail" -gt 0 ]; then
  echo "$fail failed, $pass passed"
  exit 1
fi
echo "$pass passed"
