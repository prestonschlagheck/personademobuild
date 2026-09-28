import "server-only";
import { z } from "zod";
import { businessQuery } from "@/lib/gmail/queries";
import { BUSINESS_LIMIT, RECENT_LIMIT, type InboxSnapshot, type MessageMeta } from "@/lib/gmail/value-fact";

// Gmail REST over plain fetch. Only labels and header metadata are read, never bodies, and nothing
// read here is stored beyond the one-line fact.

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const HEADERS = ["From", "Subject", "Date", "List-Unsubscribe", "Precedence"];
const HEADER_LIMIT = 512;

class GmailError extends Error {
  constructor(readonly status: number) {
    super(`gmail request failed with ${status}`);
  }
}

const labelSchema = z.object({ threadsUnread: z.number().int().nonnegative() });
const listSchema = z.object({ messages: z.array(z.object({ id: z.string() })).optional() });
const messageSchema = z.object({
  payload: z.object({ headers: z.array(z.object({ name: z.string(), value: z.string() })).optional() }).optional(),
});

async function get<T>(token: string, path: string, schema: z.ZodType<T>): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(6_000),
  });
  if (!res.ok) throw new GmailError(res.status);
  const parsed = schema.safeParse(await res.json());
  if (!parsed.success) throw new GmailError(502);
  return parsed.data;
}

/** The verification gate: Gmail is connected only once this call succeeds. */
export async function inboxUnread(token: string) {
  const inbox = await get(token, "/labels/INBOX", labelSchema);
  return inbox.threadsUnread;
}

async function search(token: string, q: string, limit: number): Promise<string[]> {
  const query = new URLSearchParams({ q, maxResults: String(limit) });
  const { messages = [] } = await get(token, `/messages?${query}`, listSchema);
  return messages.map((m) => m.id);
}

async function metadata(token: string, id: string): Promise<MessageMeta> {
  const headerQuery = new URLSearchParams([["format", "metadata"], ...HEADERS.map((h) => ["metadataHeaders", h])]);
  const { payload } = await get(token, `/messages/${encodeURIComponent(id)}?${headerQuery}`, messageSchema);
  // Any sender can write these, so a padded header is cut before the fact's patterns ever see it.
  const header = (name: string) => (payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "").slice(0, HEADER_LIMIT);
  return {
    from: header("From"),
    subject: header("Subject"),
    date: header("Date"),
    bulk: Boolean(header("List-Unsubscribe")) || /^(bulk|list)$/i.test(header("Precedence")),
  };
}

/**
 * What the need's search finds (lib/gmail/queries.ts), and, when the need names a business, what a search for mail
 * from it finds: two list calls at most, then one header read per message, each message read once.
 */
export async function readInbox(token: string, query: string, business: string | null): Promise<Pick<InboxSnapshot, "messages" | "business">> {
  const [found, fromBusiness] = await Promise.all([
    search(token, query, RECENT_LIMIT),
    // The business search only adds to the fact, so it failing leaves the need's own search to answer.
    business ? search(token, businessQuery(business), BUSINESS_LIMIT).catch(() => null) : null,
  ]);
  const ids = [...new Set([...(fromBusiness ?? []), ...found])];
  const read = new Map(await Promise.all(ids.map(async (id) => [id, await metadata(token, id)] as const)));
  const pick = (list: string[]) => list.flatMap((id) => read.get(id) ?? []);
  return {
    messages: pick(found),
    ...(business && fromBusiness && { business: { name: business, messages: pick(fromBusiness), capped: fromBusiness.length >= BUSINESS_LIMIT } }),
  };
}
