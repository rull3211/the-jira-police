/**
 * An audit record drawn as the Slack message it stands for: a status card, one line per major event,
 * then the timeline newest first. Pure, so the whole layout is readable in a test.
 */

import type { AuditRecord, Entry, PullRequest, TriageState, WorkState } from "./audit.ts";

/** Slack's own limits: a header's text, one section's text, and blocks per message. */
const HEADER_CHARS = 150;
const SECTION_CHARS = 3000;
export const MAX_BLOCKS = 50;

export interface RenderedMessage {
  /** What a notification or a screen reader shows in place of the blocks. */
  readonly text: string;
  readonly blocks: readonly object[];
}

export function renderRecord(record: AuditRecord): RenderedMessage {
  const blocks: object[] = [
    {
      type: "header",
      text: { type: "plain_text", text: clip(`${record.key} · ${record.summary}`, HEADER_CHARS) },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `${link(record.url, record.key)}${record.repo === null ? "" : ` · repo ${escape(record.repo)}`}`,
        },
      ],
    },
    { type: "divider" },
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

  if (record.major.length > 0) {
    blocks.push({ type: "divider" });
    for (const entry of record.major) {
      blocks.push(section(`${entry.icon} *${escape(entry.text)}*  ${stamp(entry.at)}`));
    }
  }

  if (record.timeline.length > 0) {
    blocks.push({ type: "divider" });
    const lines = record.timeline.toReversed().map((entry) => timelineLine(entry));
    for (const chunk of chunks(["*Timeline*", ...lines], SECTION_CHARS)) {
      blocks.push(section(chunk));
    }
  }

  const hidden = record.dropped.major + record.dropped.timeline;
  if (hidden > 0) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `… ${String(hidden)} earlier ${hidden === 1 ? "entry" : "entries"} not shown`,
        },
      ],
    });
  }

  return { text: fallbackText(record), blocks: blocks.slice(0, MAX_BLOCKS) };
}

/**
 * Slack reads `&`, `<` and `>` as markup, so a ticket titled `<!channel>` would ping everyone. Every
 * string a record holds came from a ticket, a model or an error, and passes through here.
 */
export function escape(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
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
  return pr === null
    ? "— none yet"
    : `${link(pr.url, `#${String(pr.number)}`)} ${escape(pr.state)}`;
}

/** Escaping cannot make a URL safe inside `<url|label>`, so anything but a plain https URL is shown as its label. */
function link(url: string, label: string): string {
  return /^https:\/\/[^\s|<>]+$/u.test(url) ? `<${url}|${escape(label)}>` : escape(label);
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
  return `${stamp(entry.at)}  ${entry.icon} ${escape(entry.text)}`;
}

/** Rendered in each reader's own timezone by Slack; the fallback is what a client too old to do so shows. */
function stamp(iso: string): string {
  const seconds = Math.floor(Date.parse(iso) / 1000);
  return Number.isFinite(seconds)
    ? `<!date^${String(seconds)}^{date_short_pretty} {time}|${iso}>`
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
