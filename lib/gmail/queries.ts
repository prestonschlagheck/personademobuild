import type { HelpCategory } from "@/lib/session/schema";

// The Gmail searches behind the value moment. A need about bills, subscriptions, travel or appointments searches that
// kind of mail, read or not, over the weeks it takes to show up; any other need reads the week's unread. A need that
// names a business ("cancel my planet fitness") gets one more search, for mail from it. Every query is built from fixed
// words and a name cut down to letters and digits, never from the user's raw text.

/** How far back the inbox search and a named business's search reach. */
export const INBOX_DAYS = 7;
export const BUSINESS_DAYS = 90;

const TOPICS = {
  bills: { days: 45, words: ["bill", "invoice", "statement", '"payment due"', "receipt"] },
  subscriptions: { days: 90, words: ["renewal", "subscription", "membership", '"your plan"', "receipt"] },
  travel: { days: 120, words: ["itinerary", "confirmation", '"boarding pass"', "reservation", "booking"] },
  appointments: { days: 30, words: ["appointment", "reminder", "confirmed", "reschedule"] },
} as const satisfies Partial<Record<HelpCategory, { days: number; words: readonly string[] }>>;

type Topic = keyof typeof TOPICS;

// Marketing and social mail never holds the bill, booking or appointment, and would crowd out the ones that do.
const NOT_MARKETING = "-category:promotions -category:social";

/** Whether the need searches its own kind of mail, read or not, rather than the week's unread. */
export const searchesTopic = (category: HelpCategory | null): category is Topic => category !== null && Object.hasOwn(TOPICS, category);

/** How many days back the need's search reaches, and so the window its fact may speak for. */
export function searchDays(category: HelpCategory | null): number {
  return searchesTopic(category) ? TOPICS[category].days : INBOX_DAYS;
}

export function needQuery(category: HelpCategory | null): string {
  if (!searchesTopic(category)) return `in:inbox is:unread newer_than:${INBOX_DAYS}d ${NOT_MARKETING}`;
  const { days, words } = TOPICS[category];
  return `newer_than:${days}d ${NOT_MARKETING} (${words.join(" OR ")})`;
}

/** Mail from a business by its display name, or by its name run together as a domain (planetfitness.com). */
export function businessQuery(name: string): string {
  const words = name.split(" ");
  const joined = words.length > 1 ? ` OR from:${words.join("")}` : "";
  return `newer_than:${BUSINESS_DAYS}d (from:"${name}"${joined})`;
}

// Words that lead into a business: "cancel my planet fitness", "a charge from chase", "stop paying for hulu".
const LEADS = new Set([
  "cancel", "canceling", "cancelling", "pay", "paying", "track", "tracking", "dispute", "return", "renew", "stop", "quit",
  "leave", "manage", "handle", "fix", "contact", "call", "from", "with", "at", "for", "my", "our",
]);

// Skipped between a lead and the name.
const FILLERS = new Set(["my", "our", "the", "a", "an", "this", "that", "their"]);

// Never part of a business name: grammar, and what a need is about rather than who it's from.
const NOT_NAMES = new Set(
  [
    "a an the their i me mine you your we us they them it its he she his her and or but so to of in on by about into",
    "before after when if then than as is are was be been am do does did dont doesnt not no up out off over again all any some every each",
    "more most just also too please help want need can could would should will get got keep make start this that these",
    "those what which who how why where there here now today tomorrow soon later next last time times day days week",
    "weeks month months year once",
    "account accounts bill bills billing invoice invoices statement statements payment payments charge charges fee fees",
    "subscription subscriptions membership memberships plan plans renewal renewals trial order orders package packages",
    "delivery deliveries shipping returns refund refunds purchase purchases flight flights trip trips travel hotel hotels",
    "booking bookings reservation reservations itinerary appointment appointments appt dentist doctor dr therapist vet",
    "meeting meetings calendar schedule event events email emails mail inbox gmail newsletter newsletters spam message",
    "messages text texts calls phone rent mortgage utilities taxes tax insurance gym stuff things thing life work job home",
    "house family kids mom dad wife husband partner friends friend boss landlord school money finances budget expenses",
    "receipt receipts card cards bank credit service services customer support company companies app apps car groceries",
    "shopping everything anything something mess reminder reminders due date dates",
  ]
    .join(" ")
    .split(" "),
);

const isNameWord = (word: string) => !NOT_NAMES.has(word) && !LEADS.has(word) && word.length <= 24;

/**
 * The business a need names, as up to three lowercase words of letters and digits, or null. "cancel my planet fitness
 * membership" names planet fitness; "reschedule my dentist appointment" names none. A name is only a guess until the
 * value fact finds mail sent by it, so a wrong one costs a search and says nothing.
 */
export function businessInNeed(need: string): string | null {
  const tokens = (
    need
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/['’]s\b/g, "")
      .replace(/['’]/g, "")
      .match(/[\p{L}\p{N}]+/gu) ?? []
  ).slice(0, 60);
  for (let i = 0; i < tokens.length; i++) {
    if (!LEADS.has(tokens[i] ?? "")) continue;
    let j = i + 1;
    while (j < tokens.length && FILLERS.has(tokens[j] ?? "")) j++;
    const name: string[] = [];
    while (j < tokens.length && name.length < 3 && isNameWord(tokens[j] ?? "")) name.push(tokens[j++] ?? "");
    const joined = name.join("");
    if (joined.length >= 3 && /\p{L}/u.test(joined)) return name.join(" ");
  }
  return null;
}
