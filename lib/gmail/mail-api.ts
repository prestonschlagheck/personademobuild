import "server-only";
import { z } from "zod";

// Gmail and Calendar REST over plain fetch, for the agent's tools (lib/gmail/tools.ts): search, read, labels,
// drafts, send, and label changes on the user's own mail, and their calendar's events. Nothing read here is stored;
// the agent sees it for the turn that asked.

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const CALENDAR = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
/** How much of one email's text the agent reads, so a long thread never floods its turn. */
const BODY_LIMIT = 4_000;
const SNIPPET_LIMIT = 200;

export class GoogleError extends Error {
  constructor(readonly status: number) {
    super(`google request failed with ${status}`);
  }
}

async function call<T>(token: string, url: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.body && { "Content-Type": "application/json" }) },
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new GoogleError(res.status);
  const parsed = schema.safeParse(res.status === 204 ? {} : await res.json());
  if (!parsed.success) throw new GoogleError(502);
  return parsed.data;
}

const header = z.object({ name: z.string(), value: z.string() });
type Part = { mimeType?: string; body?: { data?: string }; parts?: Part[]; headers?: z.infer<typeof header>[] };
const part: z.ZodType<Part> = z.lazy(() =>
  z.object({
    mimeType: z.string().optional(),
    body: z.object({ data: z.string().optional() }).optional(),
    parts: z.array(part).optional(),
    headers: z.array(header).optional(),
  }),
);
const messageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  labelIds: z.array(z.string()).optional(),
  snippet: z.string().optional(),
  payload: part.optional(),
});

export type MailSummary = { id: string; from: string; to: string; subject: string; date: string; unread: boolean; snippet: string };
export type Mail = MailSummary & { threadId: string; messageId: string; body: string };

const headerOf = (payload: Part | undefined, name: string) =>
  payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

const decode = (data: string) => Buffer.from(data, "base64url").toString("utf8");
const stripHtml = (html: string) =>
  html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"');

/** The message's plain text: its text/plain part, or its HTML with the tags taken out. */
function textOf(payload: Part | undefined): string {
  const all: Part[] = [];
  const walk = (p: Part | undefined) => {
    if (!p) return;
    all.push(p);
    p.parts?.forEach(walk);
  };
  walk(payload);
  const plain = all.find((p) => p.mimeType === "text/plain" && p.body?.data);
  if (plain?.body?.data) return decode(plain.body.data);
  const html = all.find((p) => p.mimeType === "text/html" && p.body?.data);
  return html?.body?.data ? stripHtml(decode(html.body.data)) : "";
}

const tidy = (text: string) => text.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

function summary(m: z.infer<typeof messageSchema>): MailSummary {
  return {
    id: m.id,
    from: headerOf(m.payload, "From").slice(0, 200),
    to: headerOf(m.payload, "To").slice(0, 200),
    subject: headerOf(m.payload, "Subject").slice(0, 300),
    date: headerOf(m.payload, "Date"),
    unread: m.labelIds?.includes("UNREAD") ?? false,
    snippet: (m.snippet ?? "").slice(0, SNIPPET_LIMIT),
  };
}

/** The newest few matches, and how many match in all: Gmail's estimate, or the exact count when every match came back. */
export type SearchResult = { messages: MailSummary[]; estimate: number };

/**
 * Gmail's own search, newest first, with each match's headers and snippet. Only `q` goes to Gmail, with no label filter,
 * so it covers every folder and label and archived mail, and leaves spam and trash out.
 */
export async function searchMail(token: string, query: string, max: number): Promise<SearchResult> {
  const params = new URLSearchParams({ q: query, maxResults: String(max) });
  const list = await call(
    token,
    `${GMAIL}/messages?${params}`,
    z.object({ messages: z.array(z.object({ id: z.string() })).optional(), resultSizeEstimate: z.number().optional() }),
  );
  const headers = new URLSearchParams([["format", "metadata"], ...["From", "To", "Subject", "Date"].map((h) => ["metadataHeaders", h])]);
  const found = await Promise.all((list.messages ?? []).map((m) => call(token, `${GMAIL}/messages/${m.id}?${headers}`, messageSchema)));
  // Fewer than asked for means every match is here, so the count is exact.
  const estimate = found.length < max ? found.length : Math.max(list.resultSizeEstimate ?? 0, found.length);
  return { messages: found.map(summary), estimate };
}

export async function readMail(token: string, id: string): Promise<Mail> {
  const m = await call(token, `${GMAIL}/messages/${encodeURIComponent(id)}?format=full`, messageSchema);
  return { ...summary(m), threadId: m.threadId, messageId: headerOf(m.payload, "Message-ID"), body: tidy(textOf(m.payload)).slice(0, BODY_LIMIT) };
}

/** A folder or label by its own name, with its counts, or null counts when Google didn't give them. */
export type Label = { name: string; type: "system" | "user"; unread: number | null; total: number | null };
const LABEL_LIMIT = 50;

/** The user's own labels first, then the inbox and sent mail, each with total and unread counts. */
export async function listLabels(token: string): Promise<Label[]> {
  const { labels = [] } = await call(
    token,
    `${GMAIL}/labels`,
    z.object({ labels: z.array(z.object({ id: z.string(), name: z.string(), type: z.string().optional() })).optional() }),
  );
  // The cap cuts their own labels, never the inbox or sent mail.
  const system = labels.filter((l) => l.id === "INBOX" || l.id === "SENT");
  const wanted = [...labels.filter((l) => l.type === "user").slice(0, LABEL_LIMIT - system.length), ...system];
  const counted = z.object({ messagesUnread: z.number().optional(), messagesTotal: z.number().optional() });
  const full = await Promise.allSettled(wanted.map((l) => call(token, `${GMAIL}/labels/${encodeURIComponent(l.id)}`, counted)));
  // One label Google didn't count (a 429, a timeout) keeps its name, so it can still be searched. None counted means Google is down.
  const [first] = full;
  if (first?.status === "rejected" && full.every((r) => r.status === "rejected")) throw first.reason;
  return wanted.map((l, i) => {
    const got = full[i];
    const counts = got?.status === "fulfilled" ? got.value : null;
    return { name: l.name, type: l.type === "user" ? "user" : "system", unread: counts && (counts.messagesUnread ?? 0), total: counts && (counts.messagesTotal ?? 0) };
  });
}

/** One RFC 5322 message, as Gmail takes it. Headers are cut at a line break, so a value can never add one. */
function rawMessage({ from, to, subject, body, inReplyTo }: { from: string; to: string; subject: string; body: string; inReplyTo?: string }) {
  const line = (value: string) => value.replace(/[\r\n]+/g, " ").trim();
  const encoded = (value: string) => (/^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`);
  const headers = [
    `From: ${line(from)}`,
    `To: ${line(to)}`,
    `Subject: ${encoded(line(subject))}`,
    ...(inReplyTo ? [`In-Reply-To: ${line(inReplyTo)}`, `References: ${line(inReplyTo)}`] : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
  ];
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${body}`, "utf8").toString("base64url");
}

type DraftInput = { from: string; to: string; subject: string; body: string; replyTo?: Mail };

export async function createDraft(token: string, { from, to, subject, body, replyTo }: DraftInput): Promise<{ draftId: string }> {
  const raw = rawMessage({ from, to, subject, body, ...(replyTo?.messageId && { inReplyTo: replyTo.messageId }) });
  const draft = await call(token, `${GMAIL}/drafts`, z.object({ id: z.string() }), {
    method: "POST",
    body: JSON.stringify({ message: { raw, ...(replyTo && { threadId: replyTo.threadId }) } }),
  });
  return { draftId: draft.id };
}

export async function sendDraft(token: string, draftId: string): Promise<{ messageId: string }> {
  const sent = await call(token, `${GMAIL}/drafts/send`, z.object({ id: z.string() }), { method: "POST", body: JSON.stringify({ id: draftId }) });
  return { messageId: sent.id };
}

export type MailAction = "archive" | "mark_read" | "mark_unread" | "star" | "unstar" | "trash";
const LABEL_CHANGES: Record<Exclude<MailAction, "trash">, { addLabelIds?: string[]; removeLabelIds?: string[] }> = {
  archive: { removeLabelIds: ["INBOX"] },
  mark_read: { removeLabelIds: ["UNREAD"] },
  mark_unread: { addLabelIds: ["UNREAD"] },
  star: { addLabelIds: ["STARRED"] },
  unstar: { removeLabelIds: ["STARRED"] },
};

/** Trash keeps mail for 30 days, so nothing here deletes anything for good. */
export async function updateMail(token: string, ids: string[], action: MailAction): Promise<void> {
  if (action === "trash") {
    await Promise.all(ids.map((id) => call(token, `${GMAIL}/messages/${encodeURIComponent(id)}/trash`, z.object({}).passthrough(), { method: "POST" })));
    return;
  }
  await call(token, `${GMAIL}/messages/batchModify`, z.object({}).passthrough(), { method: "POST", body: JSON.stringify({ ids, ...LABEL_CHANGES[action] }) });
}

export type CalendarItem = { summary: string; start: string; end: string; allDay: boolean; location: string };

export async function calendarEvents(token: string, from: Date, to: Date): Promise<CalendarItem[]> {
  const params = new URLSearchParams({
    timeMin: from.toISOString(),
    timeMax: to.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "25",
    fields: "items(summary,start,end,location)",
  });
  const when = z.object({ dateTime: z.string().optional(), date: z.string().optional() }).optional();
  const { items = [] } = await call(
    token,
    `${CALENDAR}?${params}`,
    z.object({ items: z.array(z.object({ summary: z.string().optional(), start: when, end: when, location: z.string().optional() })).optional() }),
  );
  return items.flatMap((item) => {
    const start = item.start?.dateTime ?? item.start?.date;
    if (!start) return [];
    return [{ summary: item.summary ?? "(no title)", start, end: item.end?.dateTime ?? item.end?.date ?? start, allDay: !item.start?.dateTime, location: item.location ?? "" }];
  });
}
