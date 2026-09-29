/**
 * An audit record drawn as the Slack message it stands for — a collapsible container holding the
 * status card, major events and the timeline — plus a broadcast's line and the pull request line.
 * Pure, so the whole layout is readable in a test.
 */

import { oneLine } from "../text.ts";
import type { AuditRecord, Entry, PullRequest, TriageState, WorkState } from "./audit.ts";

/** Slack's own limits: a container's title, one section's text, and a container's children. */
const TITLE_CHARS = 150;
const SECTION_CHARS = 3000;
export const MAX_CHILD_BLOCKS = 10;

export interface RenderedMessage {
  /** What a notification or a screen reader shows in place of the blocks. */
  readonly text: string;
  readonly blocks: readonly object[];
}

export function renderRecord(record: AuditRecord): RenderedMessage {
  const title = clip(
    record.summary === record.key ? record.key : `${record.key} · ${record.summary}`,
    TITLE_CHARS,
  );
  const children: object[] = [
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `${link(record.url, record.key)}${record.repo === null ? "" : ` · repo ${escape(record.repo)}`}`,
        },
      ],
    },
    {
      type: "section",
      fields: [
        field("Triage", describeTriage(record.triage)),
        field("Work", describeWork(record.work)),
        field("PR", describePr(record.pr)),
        field("State", describeState(record)),
      ],
    },
  ];

  const major = chunks(
    record.major.map(
      (entry) => `${escape(entry.icon)} *${escape(entry.text)}*  ${stamp(entry.at)}`,
    ),
    SECTION_CHARS,
  );
  children.push(...major.map((chunk) => section(chunk)));

  // The timeline gives way first: whatever the other children leave of the container's ten.
  const room = MAX_CHILD_BLOCKS - children.length - 1;
  const lines = record.timeline.toReversed().map((entry) => timelineLine(entry));
  const timeline = lines.length === 0 ? [] : chunks(["*Timeline*", ...lines], SECTION_CHARS);
  const shown = timeline.slice(0, Math.max(0, room));
  children.push(...shown.map((chunk) => section(chunk)));
  const heading = shown.length > 0 ? 1 : 0;
  const cut =
    lines.length - (shown.reduce((count, chunk) => count + chunk.split("\n").length, 0) - heading);

  const hidden = record.dropped.major + record.dropped.timeline + cut;
  if (hidden > 0) {
    children.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `… ${String(hidden)} earlier ${hidden === 1 ? "entry" : "entries"} not shown`,
        },
      ],
    });
  }

  return {
    text: fallbackText(record),
    blocks: [
      {
        type: "container",
        title: { type: "plain_text", text: title },
        rich_text_title: richTitle(record.url, title),
        is_collapsible: true,
        default_collapsed: true,
        child_blocks: children.slice(0, MAX_CHILD_BLOCKS),
      },
    ],
  };
}

/** The one string written into a message unescaped, as `<@…>`; anything else could be a broadcast ping. */
export const SLACK_USER_ID_PATTERN = /^[UW][A-Z0-9]{2,20}$/u;

/**
 * The one line a major entry is broadcast as, so the channel shows what happened and to which ticket.
 * Mentions ride here and never on the card: a broadcast is a new message each time, the card an edit.
 */
export function renderBump(
  record: AuditRecord,
  entry: Entry,
  subscribers: readonly string[] = [],
): RenderedMessage {
  const title = record.summary === record.key ? record.key : `${record.key} · ${record.summary}`;
  const mentions = subscribers
    .filter((id) => SLACK_USER_ID_PATTERN.test(id))
    .map((id) => ` <@${id}>`)
    .join("");
  return {
    text: `${escape(entry.icon)} *${escape(entry.text)}* — ${link(record.url, clip(title, TITLE_CHARS))}${mentions}`,
    blocks: [],
  };
}

/** The team's own convention for a bot's pull request, so the pasted line reads like the others. */
export const PR_LINK_LABEL = "PR-Bencebot";

/**
 * What the operator pastes into the team's pull request channel: the link, then the fix pass's
 * sentence, or the pull request's title when the pass wrote none.
 */
export function renderPrLine(url: string, sentence: string, title: string): string {
  const words = oneLine(sentence) === "" ? oneLine(title) : oneLine(sentence);
  // Escaping protects only this message; pasted, a plain `@channel` would ping as the operator.
  const unpinged = words.replaceAll(/(?<![\w.])@(here|channel|everyone)\b/giu, "$1");
  return `${link(url, PR_LINK_LABEL)} ${escape(unpinged)}`;
}

/**
 * Slack reads `&`, `<` and `>` as markup, so a ticket titled `<!channel>` would ping everyone. Every
 * string a record holds came from a ticket, a model or an error, and passes through here.
 */
export function escape(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Rich text is never parsed for markup, so the title needs no escaping; the URL still must be plain https. */
function richTitle(url: string, title: string): object {
  const text = isPlainHttps(url)
    ? { type: "link", url, text: title, style: { bold: true } }
    : { type: "text", text: title, style: { bold: true } };
  return { type: "rich_text", elements: [{ type: "rich_text_section", elements: [text] }] };
}

function describeTriage(triage: TriageState): string {
  switch (triage.kind) {
    case "pending":
      return "⏳ pending";
    case "refused":
      return "⛔ refused by the gate";
    case "verdict": {
      const icon = triage.verdict === "ready-ish" ? "✅" : "📝";
      const solvable = triage.solvable
        ? `solvable${triage.confidence === null ? "" : ` (${escape(triage.confidence)})`}`
        : "not solvable";
      return `${icon} ${escape(triage.verdict)} · ${solvable}${triage.posted ? "" : " · not posted"}`;
    }
    case "labelled": {
      const dor =
        triage.dor === "pass"
          ? "✅ DoR passed"
          : triage.dor === "gaps"
            ? "📝 DoR gaps"
            : "🏷️ triaged";
      return `${dor} · ${triage.solvable ? "solvable" : "not solvable"} · from the ticket's labels`;
    }
  }
}

function describeWork(work: WorkState): string {
  switch (work.kind) {
    case "idle":
      return "⚪ not started";
    case "claimed":
      return "🙋 claimed";
    case "solving":
      return `🔧 solving — ${escape(work.pass)}`;
    case "verified":
      return "✅ implemented and verified";
    case "ended":
      return `🛑 ended — ${escape(work.outcome)}`;
  }
}

function describePr(pr: PullRequest | null): string {
  if (pr === null) {
    return "— none yet";
  }
  const state = pr.state === "reworking" ? "back with the bot" : pr.state;
  return `${link(pr.url, `#${String(pr.number)}`)} ${escape(state)}`;
}

/** Escaping cannot make a URL safe inside `<url|label>`, so anything but a plain https URL is shown as its label. */
function link(url: string, label: string): string {
  return isPlainHttps(url) ? `<${url}|${escape(label)}>` : escape(label);
}

function isPlainHttps(url: string): boolean {
  return /^https:\/\/[^\s|<>]+$/u.test(url);
}

/** The one field that answers "is anything wrong", so a crash outranks every other state. */
function describeState(record: AuditRecord): string {
  if (record.crash !== null) {
    return `💥 crashed in ${escape(record.crash.where)}`;
  }
  if (record.pr?.state === "merged") {
    return "🎉 done";
  }
  if (record.pr?.state === "closed") {
    return "🗑️ closed";
  }
  if (record.work.kind === "ended") {
    return "🛑 stopped";
  }
  if (record.pr !== null) {
    return "👀 in review";
  }
  if (record.work.kind !== "idle") {
    return "🟢 working";
  }
  if (record.triage.kind === "pending" && record.timeline.length > 0) {
    return "🟢 triaging";
  }
  return "⚪ waiting";
}

function fallbackText(record: AuditRecord): string {
  const latest = record.major.at(-1) ?? record.timeline.at(-1);
  return escape(`${record.key}: ${latest === undefined ? "picked up" : latest.text}`);
}

function timelineLine(entry: Entry): string {
  return `${stamp(entry.at)}  ${escape(entry.icon)} ${escape(entry.text)}`;
}

/**
 * Rendered in each reader's own timezone by Slack. The fallback is rebuilt from the parsed time, never
 * echoed: `Date.parse` accepts text that can close the token early.
 */
function stamp(iso: string): string {
  const millis = Date.parse(iso);
  return Number.isFinite(millis)
    ? `<!date^${String(Math.floor(millis / 1000))}^{date_short_pretty} {time}|${new Date(millis).toISOString()}>`
    : "";
}

function field(label: string, value: string): object {
  return { type: "mrkdwn", text: `*${label}*\n${value}` };
}

function section(text: string): object {
  return { type: "section", text: { type: "mrkdwn", text: clip(text, SECTION_CHARS) } };
}

/** Lines packed into texts no longer than `limit`, a line never split. */
function chunks(lines: readonly string[], limit: number): string[] {
  const packed: string[] = [];
  let current = "";
  for (const line of lines) {
    const next = current === "" ? line : `${current}\n${line}`;
    if (next.length > limit && current !== "") {
      packed.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current !== "") {
    packed.push(current);
  }
  return packed;
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}
