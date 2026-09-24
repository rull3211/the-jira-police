# the-jira-police — architecture: invariants

The properties the whole system is meant to hold regardless of which module last changed, numbered
so they can be cited individually (`§14.N`) from anywhere else in the tree.

Index: [`ARCHITECTURE.md`](../ARCHITECTURE.md)

---

## 14. Invariants

Things that look like details and are not:

1. **`erasableSyntaxOnly: true` stays** while there is no build step. Node runs these files by
   stripping types, never compiling them, so parameter properties, enums and namespaces typecheck
   fine and then crash at startup. This bit twice for real before the flag went on.
2. **The analyst never gets a write tool**, and there is no `--yes` path. A second way to post
   would be a second way to post unchecked.
3. **The REST credential never leaves discovery.** `childEnv` is the enforcement; the test
   asserting its absence is the proof.
4. **The gate reads structured fields, never prose.** See §3.
5. **Labels are a delta, unioned against live** — never a replacement array.
6. **The footer sentinel is verbatim and load-bearing.** Change it and every existing comment
   becomes unrecognisable to its own skill, so re-runs stack instead of refresh.

   **Verbatim on the way out, and not on the way back — found 2026-09-06 building the watch.**
   The sentinel is written `_…_`; Jira stores ADF, so the underscores become an `em` mark and
   stop being characters; `renderAdf` re-emits emphasis as `*…*`. So a reader comparing the
   sentinel _whole_ against a comment fetched back matches nothing this service has ever posted.
   Anything identifying our own comments therefore keys on `FOOTER_TEXT` — the sentinel with its
   delimiters stripped, derived from it so the two cannot drift. The general rule: **the words
   survive the round trip and the markup does not**, so identity belongs to the words.

7. **`SKILL_NAME` defaults to the mock.** An unconfigured service must not be able to post.
8. **Anything that grants privilege fails closed.** `agentFitness` is optional in the schema and
   every ambiguity in `parseAgentFitness` — absent, malformed, truthy-but-not-`true` — resolves to
   `solvable: false`. Silence is a refusal, never a default yes.
9. **Triage cannot authorise its own downstream work.** It may set `agent:solvable`; `agent:start`
   belongs to a human and the rest of the `agent:` namespace to the solver. Its only input is
   attacker-controlled ticket text, so this is a boundary rather than a convention.
10. **A privilege allowlist gets no default.** `readSettings` substitutes the fallback whenever a
    value is missing _or blank_ (`settings.ts:333`) — the two are indistinguishable to it. So a
    default on `SOLVE_REPOS` would be a write privilege that survives being deleted from `.env`:
    an operator emptying the allowlist to take the solver off a repository would have it handed
    straight back, revocable only by editing source. It is one of several solve settings with no
    fallback — `SOLVE_REPO_ROOT` and `SOLVE_READ_DIRS` share the shape for a related but distinct
    reason, guarding a guessed path rather than a guessed privilege — and for `SOLVE_REPOS` unset
    means nothing is allowed. The same reasoning applies to anything that names what may be
    written to — **`SOLVE_GITHUB_OWNER` is the other one**, and carries a second reason of its
    own: an owner inferred from the checkout's remote is correct right up until somebody adds a
    fork as `origin`, at which point a bot opens a pull request against a repository nobody
    chose. Note this cuts the opposite way from `SOLVE_AUTO_ISSUE_TYPES`, where the fallback _is_
    the restriction — the test to apply is not "does it have a default" but "does silence widen
    or narrow what the service may touch."
11. **A label write names the labels it changes, and nothing else.** Every label edit goes
    through `JiraClient.updateLabels`, which sends Jira's `update.labels.add` / `.remove` and
    refuses any label failing `/^agent:[a-z][a-z0-9-]{0,60}$/`. So the write is physically
    incapable of touching `triaged`, `svc:*`, `dor:*` or a human's `next:*`, and verification
    asks only whether the delta took — `diffEdit`, not a whole-field comparison.

    **This inverts what this invariant said until 2026-09-04, and the history is the point.**
    It used to read _every label write is read-modify-write, and must be verified after the
    fact_, because the only write path was MCP `editJiraIssue`, whose input schema has one field
    for issue data — `fields` — and is `additionalProperties: false`. There was no `update` key
    to pass. Adding one label meant reading all N, appending, and writing all N back, so any
    label anyone added in between was silently dropped: a PM adding `next:to-trio` while a solve
    claimed the ticket lost their edit, with nothing in either history explaining it. The
    mitigation was read-back-and-verify, which narrows the window and cannot close it — and
    `claim.ts` shipped its own limit as a passing test saying so.

    What changed is not the tool surface but a **decision about the standing rule** that the
    REST credential is discovery-only. The amendment is deliberately the narrowest one that
    closes the hole: one method, one HTTP verb, labels only, the `agent:` namespace only, and
    **comments stay on the MCP path** — those are Atlassian Document Format, the MCP tool does
    the markdown→ADF conversion, and reimplementing that to move a write off a path that works
    would be widening the credential for no benefit.

    Three things follow. **Concurrent claims are still not prevented**, only made unlikely
    (`MAX_CONCURRENT_SOLVES=1`, one host) — a delta is not a compare-and-swap. **Verification
    narrowed on purpose**: with a delta, a bystander label appearing between the write and the
    read-back is a colleague working, and reporting it as `unverified` would fire the check on
    innocent events, which is how a check ends up switched off (§8). **And `releaseClaim`
    derives its delta from the receipt, not from the live set** — "remove whatever is live and
    was not there before" reads as the careful version and is the old clobber by another route.

    Invariant 5 (_delta, never a replacement array_) now holds on both write paths rather than
    on one, which is what it was always asking for.

    **The rule has a second amendment, authorised 2026-09-06: `JiraClient.fetchActivity` reads a
    ticket's changelog.** It is read-only, so it does not touch what the first amendment was
    about — but the standing rule is _discovery_, not _reads_, and issue history is not
    discovery, so it is an amendment rather than an ordinary use. What it buys is the sendback
    watch (F): the trigger for re-triaging a watched ticket is a reporter editing the field that
    was blocking it, and the changelog is the only place that fact exists. The alternative was
    keying on the changelog's **author** as the plan originally proposed, which is both a wider
    read and a worse rule — the poster writes through an MCP session on a human's Atlassian
    account, so authorship cannot separate this service from the operator, and a field-based
    trigger is immune to whoever holds the credential.

    Two bounds keep it narrow. The method reads status, comments and changelog for **one named
    issue** and nothing else, and it is called only from the watch path. And it **refuses a
    partial read**: both lists are paged to completion, and a ticket past the cap throws rather
    than returning a prefix, because the count of our own comments is the whole bound on what a
    watched ticket may cost and a count of some of them reads exactly like a count of all of
    them.

    **That same GET was widened the same day, and it is recorded as a widening rather than as a
    third amendment.** `fetchActivity` now asks for `summary,description,environment,attachment`
    alongside `status,labels` — four read-only fields, on a request already being made, for one
    named issue. What forced it: `BLOCKER_CLEARING_FIELDS` are content fields, and the relevance
    check was being handed the _name_ of a field that moved with none of its text, so the
    commonest way a reporter answers a sendback — editing the description — could only ever be
    refused. It failed closed, so it never spent; it simply declined everything, and each refusal
    read like judgement. The distinction from the two amendments above is deliberate and is the
    line to hold: those added a **write** and a **new endpoint**, this asks the discovery
    credential for more of a ticket it is already reading.

    **The line named in the sentence that used to end this invariant has since been crossed, and
    it was not recorded here until 2026-09-08.** That sentence read: _"Nothing about attachment
    **bytes** is fetched — names, types and sizes only — and widening past that is a fresh
    decision."_ `JiraClient.fetchAttachmentText` (`client.ts:488`) GETs
    `/rest/api/3/attachment/content/{id}` on the discovery credential and returns the file's
    contents, which `solve/ticket.ts:158` inlines into the prompt a solve pass is given. That is
    a **third endpoint** and it is **bytes**, so it is the fresh decision the sentence reserved —
    taken in `0d42074` ("Let the solver read the whole ticket, not just its title") without the
    invariant being updated in the same commit.

    Recorded here rather than quietly deleted, because the mechanism that failed is the one this
    file exists to describe. The house rule is that prose which has become false is rewritten in
    the same commit as the behaviour; the rule held for the two amendments above and did not hold
    for this one, so the file asserted a bound the code had already stepped past. **It is the
    project's own defect class, in the invariant list, about the governing constraint** — which
    is the worst place in the repository for it to happen and the reason it is written up rather
    than tidied.

    Four properties bound it, and they are the argument for keeping it if it is kept. The
    endpoint is read-only. `assertAttachmentId` rejects anything that is not a bare id, so the
    path cannot be steered. `isInlineable` fetches nothing that is not a text-like MIME type, and
    `DEFAULT_TICKET_RENDER_OPTIONS` caps the run at **five attachments of 32KB each** — small
    enough that a ticket cannot push the real instructions out of the context window by attaching
    a large file. And the size is checked **twice**, before and after the download, because
    `content-length` is absent on chunked responses and a cap that trusted it is a cap any
    sufficiently large file steps around; over the cap the reader returns `null` and the caller
    says "attachment too large to inline" and names the file, which is true, rather than handing
    over a truncated head that would produce a confidently wrong artifact.

    What is genuinely new and is **not** bounded by those three is the trust boundary:
    attachment bytes are uploaded by whoever can edit the ticket, and they are inlined into a
    prompt given to a session holding `Write` and `Edit`. That is a fresh untrusted-input path
    into the solver, and the plan named it as one — _"a new privilege and a new untrusted-bytes
    path, so not now"_. It is now.

    **The operator kept it on 2026-09-16 and widened it to bytes that are not text (§13).**
    `fetchAttachmentBytes` is the same GET without the UTF-8 decode — `fetchAttachmentText` now
    calls it, so there is one cap, one id check and one endpoint rather than two of each — and
    `attachments/stage.ts` writes the image ones to a read-only directory for a pass to `Read`.
    Three bounds are new with it. The declared type is not believed: a file is staged only if its
    own leading bytes name a raster format, and the extension written comes from the signature.
    **The staged path is derived from the attachment id and that signature, never from the
    uploader's filename** — `../../.ssh/authorized_keys` is a filename. And the pixels stop at the
    passes that hold no `Write`: the fix pass gets recon's brief, which is text and therefore
    inside every control the paragraph above describes.

    What none of that bounds is the picture itself. An instruction painted into a screenshot is
    invisible to `sanitiseUntrusted`, and the transcript records a path and a digest rather than
    what the model was shown — so the residual risk here is **unmeasured**, not controlled, and
    that is why the wiring is phased behind a setting that defaults off.

12. **A capability is only withheld if something withholds it.** `--allowedTools` pre-approves;
    it does not restrict. This service ran for its whole life with three comments in
    `runner.ts` and one in `poster.ts` asserting that omission from that list was denial, and it
    never was — every triage run had `Bash`, `Write` and `Edit`. The general form is worth more
    than the specific bug: **an absence is not a control.** A list of what is permitted restricts
    nothing unless the mechanism reading it denies the complement, and whether it does is a fact
    about the tool, not about the intention of whoever wrote the list. Probe it, and write down
    what the probe showed rather than what the flag is named. The corollary for reviewers: a
    comment claiming something is prevented should name the mechanism, so the claim can be
    checked against it.
13. **Nothing may edit the definition of whether it passed.** Mechanical verification is only
    worth anything if the thing being verified cannot move the goalposts — and the harness reads
    its test, typecheck and lint commands out of the repository it is checking. So the diff gate
    refuses `package.json`, `tsconfig*.json` and the lint and test configs unconditionally, on a
    change of any size. The reasoning generalises to anything later that discovers
    behaviour from data an agent can write: **discover from the pristine base, not from what the
    run produced**, and treat "the check passed" as meaningless until you know the check was the
    one you meant.
14. **An escalation that does not arrive undoes itself.** Every rung above the dry run opens by
    claiming the ticket and closes, in a `finally`, by releasing it. A crash, a bail, a failed
    verification and a refused push all leave the board exactly as they found it, because a claim
    left behind by a run nobody watched is a ticket the queue can never offer again — and the
    manual repair for that is a human editing the label field by hand, which is the whole-field
    clobber invariant 11 exists to have eliminated.

    The single exception is a pull request that exists, including one whose reviewer could not be
    added. There the work is real and ongoing, and releasing would return a solved ticket to the
    queue for a second solver to duplicate. So the rule is not "always release" but **release
    unless the run produced something someone else can now see** — which is the same line the
    ladder is ordered along.

    Two things make this checkable rather than aspirational. The release is derived from the
    receipt (invariant 11), so it is arithmetically the inverse of the claim and cannot touch a
    label this service did not write. And it never throws: it runs on the way out of a run that
    has usually already failed, and turning "the claim was gone before I could undo it" into an
    exception would replace the operator's real error with a bookkeeping one.

    **The guarantee is exactly as strong as the `finally`, which is weaker than the sentence
    above reads.** It holds for anything that throws. It does not hold for an exit that skips
    the stack: `process.exit(130)` on a second `SIGINT`/`SIGTERM` (`createShutdown` in
    `src/index.ts`), `process.exit(1)` on an uncaught exception (`logUnexpectedExits` there), a
    `SIGKILL`, or a laptop that slept. In
    every one of those the claim survives the process, and **nothing reclaims it** — there is no
    TTL, no lease and no reaper in `src/`, so at `MAX_CONCURRENT_SOLVES=1` a single stranded
    `agent:solving` halts the solve half until a human clears the label, which is the manual
    repair this invariant opens by calling unacceptable. That gap is `PLAN.md` §31, and the
    reason it is stated here rather than only there is that this paragraph is where a reader
    comes to find out how much the claim protocol is worth.

15. **The pull request body is composed from what the harness measured, not from the model's
    account of itself.** The model writes the commit subject and body — it just made the change
    and is the only thing that knows why — and each pass's own account of what it did: the fix's
    summary and residual risk, the simplify pass's changes, and on a promoted repair the repair
    pass's. That is the only model-authored text in the document. Each piece is quoted under a
    heading naming whose words they are, and neutralised by `asProse`. Everything else is
    harness-established fact: exit codes it read, file and line counts it measured, the recon
    verdict it parsed, and on a promoted repair that the fix alone failed and which reason it
    failed with — the notice saying so is the harness's, placed above every model-written line.

    This matters more here than anywhere else in the pipeline, because the pull request body is
    the most widely-read artifact the service produces and the one most likely to be believed. A
    model asked to summarise its own work will say the tests pass, and it has no way to know — the
    harness ran them (invariant 13, §15). So the body says, in the document itself, that the model
    was never asked.

    The neutralising is not tidiness. The commit prose descends from ticket text, which is
    attacker-controlled, and text that can create document structure can forge a heading, a table
    row, a link, or a checklist that reads as though the harness wrote it.

    **This was a code fence until 2026-09-04, and the trade is worth recording.** `safeFence`
    counted the longest run of backticks in the text and fenced with one more, which is the
    stronger guarantee: nothing inside a fence renders as anything. It was traded away after the
    first live pull request (#2657) was read by a human, whose verdict was that the body was "a bit
    long and hard to read" — a fence renders prose as a monospace dump with a horizontal
    scrollbar, and the body's whole job is to be read. A document nobody reads has no integrity
    property worth protecting.

    So `asProse` replaces it: paragraphs are reflowed to one line each, then `\`, `` ` ``, `[`,
    `]` and `|` are escaped, `<` becomes `&lt;`, and a leading `#`, `>`, `-`, `+`, `*`, `=`, `~`
    or `1.` is escaped at the one line-start each paragraph now has. The backslash goes first, or
    a backslash already in the text cancels an escape added after it. Emphasis (`*`, `_` inline)
    is deliberately left renderable: it is cosmetic, it cannot forge a section or a link, and
    escaping it would mangle every `snake_case` identifier in the prose.

    It is a weaker guarantee than the fence and an enumerated one, so it is enumerated in tests —
    twenty-one cases in `pr-text.test.ts`, each mutation-tested. **If a construct is found that gets
    through, the fix is another line in `escapeInline` or `escapeLeading` plus a test, not a
    retreat to the fence.** The old reasoning that escaping "would corrupt code samples" was
    overstated: an escaped backtick renders as a backtick.

    The same change moved recon's correction, the fix pass's summary and simplify's log into
    `<details>`, leaving on the page only what a reviewer decides with — is it green, how big is
    it, and did anything disagree with anything. `details` escapes its own text rather than
    accepting rendered markdown, so that "there was nothing to say" is decided in one place; the
    first attempt composed it with the `_(nothing said)_` marker and therefore rendered a widget
    for every absent field, because that marker is not empty.

16. **The commit message is bounded by the harness, not by the model's restraint.** The fix pass
    is asked for one or two sentences and `composeCommitMessage` keeps two, wraps every kept line
    at 72 columns, and strips trailing whitespace from each. Asking is not enough on its own:
    the request is arithmetic about text, which a model satisfies most of the time, and "most of
    the time" is a solve that dies at the last step after three paid passes.

    This is written from the failure. The first live `--pr` run passed recon, fix, simplify and
    all four verification steps, and was then rejected by the target repository's own
    `commit-msg` hook — `@commitlint/config-conventional` caps body lines at 100 characters and
    the model had written one 190-character paragraph. Nothing upstream was wrong; the harness's
    own Conventional Commits check passed, because it checks the subject.

    Two smaller rules fall out of it. The width is 72, git's convention, rather than the 100 that
    happened to be configured here — this service does not read the target repository's
    commitlint config, so the margin has to come from choosing a number below every value anyone
    sets. And the shortening is a **cut, not a summary**: lines are wrapped and never rejoined,
    a word longer than the width gets its own line rather than being broken, and the long-form
    reasoning is not lost because `summary` and `residualRisk` carry it into the pull request,
    which is where a reviewer reads prose. A commit message is read in `git log --oneline`.

    The same run taught the diagnosis rule beside it. Commitlint echoes the message it was given
    before printing its verdict, so `why()` keeping the first 300 characters of output kept 300
    characters of our own commit body and cut the rule name. It now keeps **both ends** and marks
    the gap: a tool names the failing step at the top and gives the verdict at the bottom, and a
    truncation that can only preserve one of those will eventually drop the one that mattered.

17. **A new loop in the daemon may not be able to stop the old one.** The grooming loop is the
    part that has run in production for two months; the review loop shells out to `git` and `gh`
    and spends money. They are two `runLoop`s in a `Promise.all` rather than two steps of one
    tick, so each has its own cadence, its own backoff and its own failure isolation — a review
    sweep that throws every tick backs off the review side and grooming does not notice.

    **Everything the new loop needs is decided before either starts ticking.** `createReviewLoop`
    reads `SOLVE_ENABLED` first and returns `null` when it is off, so a grooming-only daemon never
    builds the solve dependencies and never refuses to start for want of a `VAULT_PATH` it will
    not read; when it is on, those dependencies are built once, out here, so a misconfiguration is
    one message and exit 78 rather than an identical failure every two minutes forever. The
    general form: **a configuration error belongs at startup, and a loop is where errors go to
    become invisible.**

    It lives in `src/review-loop.ts` rather than in `index.ts` because `index.ts` runs `main` on
    import, so anything decided there cannot be asserted about without starting a service. That is
    not tidiness either — the ordering above is the whole of the safety property, and a safety
    property with no test is a comment.
