import { BUSINESS_DAYS, INBOX_DAYS, searchDays } from "@/lib/gmail/queries";
import type { HelpCategory } from "@/lib/session/schema";

// The one inbox fact delivered after Gmail connects, computed from header metadata only, and the one offer that
// follows from it (lib/gmail/workspace-facts.ts joins them into the value line).
// Privacy: name businesses and give counts. Never name a person, never quote a subject, never repeat a number
// from an email other than a trip's date or a dollar amount in a business's own subject line, and never name a
// medical or legal sender. A sender is named only when the mail is plainly from a business, and then only by its
// brand. Every template below is built from counts, dates, amounts and those names.

export type MessageMeta = {
  from: string;
  subject: string;
  date: string;
  /** Sent with List-Unsubscribe or Precedence: bulk, so certainly not a person. */
  bulk?: boolean;
};

export type InboxSnapshot = {
  /** Unread conversations in the inbox, from labels.get. */
  unread: number;
  /** What the need's search found, from messages.list and messages.get (lib/gmail/queries.ts). */
  messages: MessageMeta[];
  /** Only the gmail.labels scope was granted, so no message metadata exists. */
  labelsOnly?: boolean;
  /** The business the need names and what its own search found. `capped` says that search hit its limit. */
  business?: { name: string; messages: MessageMeta[]; capped?: boolean };
};

/**
 * What the inbox showed for the need, as one sentence, and the one offer that follows from it. `anchors` are what the
 * fact was built from, the business names it gives or else its count, so a reply that shares it can be held to one of
 * them; a fact that found nothing has none.
 */
export type InboxFinding = { fact: string; offer: string; anchors: string[]; category: HelpCategory | null; business?: string };

/** The most recent messages read for the fact. Every count from them is out of this sample. */
export const RECENT_LIMIT = 20;
/** The most messages read from a named business's search. */
export const BUSINESS_LIMIT = 10;

const TIME_ZONE = "America/New_York";
const DAY_MS = 86_400_000;

const CONSUMER_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "hotmail.com", "outlook.com", "live.com",
  "msn.com", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "pm.me",
  "gmx.com", "gmx.net", "mail.com", "zoho.com", "fastmail.com", "hey.com", "comcast.net",
  "verizon.net", "att.net", "sbcglobal.net", "yandex.com", "qq.com",
]);
const CONSUMER_PREFIXES = ["yahoo.", "hotmail.", "outlook.", "live.", "btinternet."];

const AUTOMATED_TOKENS = new Set([
  "noreply", "donotreply", "no", "reply", "notification", "notifications", "notify", "alert", "alerts",
  "info", "support", "help", "billing", "bill", "bills", "invoice", "invoices", "receipt", "receipts",
  "order", "orders", "shipping", "shipment", "tracking", "delivery", "confirm", "confirmation",
  "confirmations", "reservation", "reservations", "booking", "bookings", "itinerary", "travel", "update",
  "updates", "news", "newsletter", "hello", "team", "account", "accounts", "service", "care", "mailer",
  "daemon", "bounce", "bounces", "marketing", "statement", "statements", "payment", "payments",
  "security", "verify", "admin", "contact", "feedback", "digest", "rewards", "offers", "deals", "sales",
  "member", "members", "customer", "customerservice",
]);

const SENDING_LABELS = new Set([
  "email", "e", "em", "mail", "mailer", "t", "news", "info", "alerts", "alert", "notifications",
  "notification", "notify", "reply", "bounce", "marketing", "send", "mg", "sg", "messages", "message",
  "comms", "communications", "updates", "account", "accounts", "members", "hello", "go", "click", "engage",
]);

const BRAND_WORDS = new Set([
  "team", "support", "service", "services", "bank", "card", "air", "airlines", "airways", "hotel",
  "hotels", "store", "shop", "app", "inc", "llc", "co", "news", "updates", "billing", "energy", "mobile",
  "wireless", "insurance", "health", "pay", "rewards", "travel", "delivery", "orders", "from", "via",
  "the", "customer", "care", "notifications", "alerts", "account", "accounts", "official", "club", "labs",
  "group", "digest", "weekly", "daily", "fitness", "books", "learning", "calendar", "credit", "utilities",
  "receipt", "receipts", "order", "invites", "events", "offers", "deals", "tickets", "shipping", "payments",
]);

const GENERIC_NAME_WORDS = new Set([
  "inc", "llc", "ltd", "co", "corp", "team", "customer", "service", "services", "support", "notifications",
  "notification", "alerts", "alert", "billing", "no", "reply", "noreply", "info", "the", "account", "accounts",
  "receipt", "receipts", "order", "orders", "newsletter", "mailer",
]);

// One word of a person's name: Maya, maya, McKay, Mary-Jane, O'Brien, MAYA, or an initial. Every
// repeat starts with a character the one before it cannot take, so a hostile display name cannot
// make it backtrack.
const NAME_WORD = /^(?:\p{Lu}+\.?|\p{Lu}?\p{Ll}+(?:['’-]\p{Lu}?\p{Ll}+|\p{Lu}\p{Ll}+)*|\p{Lu}['’]\p{Lu}\p{Ll}+)$/u;

// "Maya Chen via Splitwise", "Jake from State Farm", "Acme | Billing": the brand is one of the parts.
const NAME_PARTS = /\s+(?:via|from|at)\s+|\s+[|·•\u2013\u2014-]\s+/i;

const SENSITIVE = new RegExp(
  `\\b(${[
    "health|healthcare|medical|medicine|clinic|hospital|pharmacy|rx|lab|labs|dental|dentist|doctor|dr",
    "therapy|therapist|counseling|counselor|patient|urgent care",
    "attorney|attorneys|law|legal|court|lawyer|lawyers|probation",
  ].join("|")})\\b`,
  "i",
);

const TOPICS = {
  bill: /\b(bills?|billing|invoices?|statements?|payment due|amount due|balance due|past due|due date|autopay|auto-pay|e-?bill|premium)\b/i,
  travel: /\b(flights?|itinerary|boarding|check[- ]?in|reservations?|booking|booked|trip|e-?tickets?|departure|hotels?|rental car)\b/i,
  delivery: /\b(orders?|shipped|shipping|delivery|delivered|package|tracking|on (?:its|the) way|arriving|dispatched)\b/i,
  subscription:
    /\b(subscri(?:ption|be)s?|renewals?|renews?|your plan|memberships?|trial[^.?!]{0,20}ending|auto-?renew\w*|billed (?:monthly|annually|yearly))\b/i,
  appointment: /\b(appointments?|appts?|reschedul\w*|check-?ups?|visits?|consultations?|cleanings?|exams?)\b/i,
} as const;

// Mail sent in bulk is a bill only when its subject says one is ready or due, never for "pay your bills faster".
const BILL_DUE =
  /\b(statements?|e-?bill|invoices?|(?:amount|payment|balance|past) due|due date|autopay|bill (?:is|was) (?:ready|due|available)|your (?:\w+ )?bill)\b/i;

// A dollar amount, the only number a subject line may give the fact besides a trip's date.
const AMOUNT = /\$\s?(\d{1,3}(?:,\d{3})+|\d{1,6})(\.\d{2})?(?![\d,])/;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// A travel email is only called a confirmation when its subject says so, never for a fare sale.
const CONFIRMED =
  /\b(confirm(?:ed|ation)|itinerar(?:y|ies)|e-?tickets?|boarding pass(?:es)?|you(?:'re| are) booked|your (?:upcoming )?(?:trip|flight|stay|reservation|booking))\b/i;

// Google and Apple calendar invites lead with this.
const INVITE = /^(?:updated\s+)?invitation\b/i;

// Providers whose billing mail is a subscription even when the subject is just "your receipt".
const KNOWN_SUBSCRIPTION_DOMAINS = new Set([
  "netflix.com", "spotify.com", "adobe.com", "hulu.com", "disneyplus.com", "audible.com",
  "dropbox.com", "notion.so", "nytimes.com", "peacocktv.com", "hbomax.com", "paramountplus.com",
]);

// Month names and their short forms only, so "Marriott 2 nights" or "May 15% off" is never read as a date.
const MONTH_DAY =
  /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+([12]?\d|3[01])(?:st|nd|rd|th)?\b(?!\s*%)/i;

type Sender = { name: string | null; local: string; domain: string };

type Classified = MessageMeta & {
  at: Date | null;
  sender: Sender;
  person: boolean;
  /** Plainly sent by a business, so it may be counted as one. */
  business: boolean;
  /** A medical or legal sender or subject: counted at most, never named. */
  sensitive: boolean;
  /** The brand to say out loud, or empty when this message must never be named. */
  name: string;
  topics: { bill: boolean; travel: boolean; delivery: boolean; subscription: boolean; invite: boolean; appointment: boolean };
};

export function parseFrom(from: string): Sender {
  const match = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(from);
  const name = match?.[1]?.trim() || null;
  const address = (match?.[2] ?? from).trim().toLowerCase();
  const at = address.lastIndexOf("@");
  return { name, local: at === -1 ? address : address.slice(0, at), domain: at === -1 ? "" : address.slice(at + 1) };
}

function isConsumerDomain(domain: string) {
  return CONSUMER_DOMAINS.has(domain) || CONSUMER_PREFIXES.some((p) => domain.startsWith(p));
}

function isAutomatedLocal(local: string) {
  if (/(no-?reply|do-?not-?reply)/.test(local)) return true;
  return local.split(/[.\-_+]/).some((token) => AUTOMATED_TOKENS.has(token));
}

function hasSendingSubdomain(domain: string) {
  const labels = domain.split(".");
  return labels.length >= 3 && SENDING_LABELS.has(labels[0] ?? "");
}

// The label a brand registered: delta in t.delta.com, northwind in mail.northwind.co.uk.
function brandLabel(domain: string) {
  const labels = domain.split(".").filter(Boolean);
  const secondLevel = labels.length >= 3 && /^(co|com|org|net|ac|gov)$/.test(labels.at(-2) ?? "");
  return labels.at(secondLevel ? -3 : -2) ?? labels[0] ?? "";
}

const letters = (text: string): string[] => text.toLowerCase().match(/\p{L}+/gu) ?? [];

// Some word of the name is in the domain's brand: Delta Air Lines at t.delta.com.
function nameMatchesDomain(name: string, domain: string) {
  const brand = brandLabel(domain);
  const words = letters(name);
  if (!brand || words.length === 0) return false;
  return brand.includes(words.join("")) || words.some((w) => w.length >= 3 && brand.includes(w));
}

// The whole name is the domain's brand: Streamloop at streamloop.com, Cadence Music at cadencemusic.com.
function nameIsBrand(name: string, domain: string) {
  const joined = letters(name).join("");
  return joined.length >= 3 && brandLabel(domain).includes(joined);
}

function looksHuman(name: string) {
  const words = name.trim().split(/\s+/);
  return words.length <= 3 && words.every((w) => NAME_WORD.test(w) && !BRAND_WORDS.has(w.toLowerCase()));
}

// jane@, jane.smith@, jsmith@ or janesmith@ under a full name: the person's own address.
function addressedByName(name: string, local: string) {
  const words = letters(name);
  if (words.length < 2) return false;
  const first = words[0] ?? "";
  const last = words.at(-1) ?? "";
  const tokens = local.split(/[.\-_+]/);
  return tokens.some((t) => t.length >= 2 && words.includes(t)) || [words.join(""), first.charAt(0) + last, first + last.charAt(0)].includes(local);
}

export function isPerson(message: MessageMeta, sender = parseFrom(message.from)) {
  if (message.bulk || isAutomatedLocal(sender.local)) return false;
  if (isConsumerDomain(sender.domain)) return true;
  if (hasSendingSubdomain(sender.domain)) return false;
  if (!sender.name) return /^\p{L}+(?:[._]\p{L}+)?$/u.test(sender.local);
  // A human-looking name is a brand only when it is the domain's whole brand, and not even then when
  // the address is the person's own (jane@janesmith.com).
  return looksHuman(sender.name) && (!nameIsBrand(sender.name, sender.domain) || addressedByName(sender.name, sender.local));
}

// Plainly sent by a business: a bulk header, a role address, a sending subdomain, or a display name
// that matches the domain. Mail with none of these is counted, never named.
function fromBusiness(message: MessageMeta, sender: Sender) {
  if (isConsumerDomain(sender.domain)) return false;
  if (message.bulk || isAutomatedLocal(sender.local) || hasSendingSubdomain(sender.domain)) return true;
  return sender.name !== null && nameMatchesDomain(sender.name, sender.domain);
}

const spoken = (text: string) =>
  text
    .replace(/\.(com|net|org|io|co)\b/gi, "")
    .toLowerCase()
    .split(/[^\p{L}&'’-]+/u)
    .filter((w) => (w === "&" || /\p{L}/u.test(w)) && !GENERIC_NAME_WORDS.has(w))
    .slice(0, 3)
    .join(" ")
    .replace(/^&\s*|\s*&$/g, "");

const readsAsBrand = (name: string) => !looksHuman(name) && (name.includes("&") || letters(name).some((w) => BRAND_WORDS.has(w)));

// A business name safe to say out loud: the part of the display name that is the sender's brand, a
// display name that plainly reads as a business, or else the brand in the domain. Never a person's
// name: a human-looking name is used only when it is the domain's whole brand. Empty when nothing is safe.
export function businessName(sender: Sender) {
  const label = spoken(brandLabel(sender.domain).replace(/\d+/g, " "));
  const display = sender.name?.replace(/\([^)]*\)/g, " ").trim();
  if (!display || /\d/.test(display)) return label;
  const parts = display.split(NAME_PARTS).filter(Boolean);
  const own = parts.find((part) => (looksHuman(part) ? nameIsBrand(part, sender.domain) : nameMatchesDomain(part, sender.domain)));
  if (own) return spoken(own) || label;
  // A person's name inside the domain (hi@chen.family) makes the domain theirs too.
  if (parts.some((part) => looksHuman(part) && nameMatchesDomain(part, sender.domain))) return "";
  const last = parts.at(-1) ?? "";
  return readsAsBrand(last) ? spoken(last) || label : label;
}

function classify(message: MessageMeta): Classified {
  const sender = parseFrom(message.from);
  const parsed = new Date(message.date);
  const person = isPerson(message, sender);
  const business = !person && fromBusiness(message, sender);
  const sensitive = SENSITIVE.test(`${sender.name ?? ""} ${brandLabel(sender.domain)} ${message.subject}`);
  const text = `${sender.name ?? ""} ${sender.local} ${message.subject}`;
  return {
    ...message,
    at: Number.isNaN(parsed.getTime()) ? null : parsed,
    sender,
    person,
    business,
    sensitive,
    name: business && !sensitive ? businessName(sender) : "",
    topics: {
      bill: TOPICS.bill.test(text),
      travel: TOPICS.travel.test(text),
      delivery: TOPICS.delivery.test(text),
      subscription: TOPICS.subscription.test(text) || (KNOWN_SUBSCRIPTION_DOMAINS.has(sender.domain) && /\breceipts?\b/i.test(message.subject)),
      invite: INVITE.test(message.subject),
      appointment: TOPICS.appointment.test(message.subject),
    },
  };
}

const words = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const containsRun = (hay: string[], run: string[]) => run.length > 0 && hay.some((_, i) => run.every((w, k) => hay[i + k] === w));

// Mail from the business a need names: a business sender, never a person or a medical or legal one, whose display
// name or brand holds the name, or whose domain is the name run together (planetfitness.com).
function sentBy(m: Classified, name: string) {
  if (!m.business || m.sensitive) return false;
  const wanted = words(name);
  return (
    containsRun(words(m.sender.name ?? ""), wanted) ||
    containsRun(words(m.name), wanted) ||
    words(brandLabel(m.sender.domain)).join("") === wanted.join("")
  );
}

// Every search reaches back a set number of days; holding every input to it keeps the window a fact names true.
function recent(messages: MessageMeta[], days: number, now: Date): Classified[] {
  const inWindow = (m: Classified) => !m.at || now.getTime() - m.at.getTime() <= days * DAY_MS;
  return messages
    .map(classify)
    .filter(inWindow)
    .sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0));
}

const dateKey = (date: Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);

function calendarDaysAgo(date: Date, now: Date) {
  return Math.round((Date.parse(dateKey(now)) - Date.parse(dateKey(date))) / DAY_MS);
}

function monthDay(date: Date) {
  return new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, month: "short", day: "numeric" }).format(date).toLowerCase();
}

export function dayLabel(date: Date, now: Date) {
  const days = calendarDaysAgo(date, now);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, weekday: "long" }).format(date).toLowerCase();
  return monthDay(date);
}

const formatCount = (n: number) => n.toLocaleString("en-US");
const withArticle = (name: string) => `${/^[aeiou]/.test(name) ? "an" : "a"} ${name}`;
const fromDay = (m: Classified, now: Date) => (m.at ? ` from ${dayLabel(m.at, now)}` : "");
const onDay = (m: Classified, now: Date) => {
  const day = m.at ? dayLabel(m.at, now) : "";
  return !day ? "" : day === "today" || day === "yesterday" ? ` ${day}` : ` on ${day}`;
};
const unique = (names: string[]) => [...new Set(names)];

const SPANS: Record<number, string> = { 30: "the last month", 45: "the last 6 weeks", 90: "the last 3 months", 120: "the last 4 months" };
const spanOf = (days: number) => SPANS[days] ?? `the last ${days} days`;

// One offer per line, for what the fact found. Each is a plain yes or no, so the next turn is easy to take.
const OFFERS = {
  inbox: "want me to flag mail from real people as it comes in?",
  labels: "want help getting that down?",
  bills: "want a heads-up the day before each one's due?",
  bill: "want a heads-up before it's due?",
  subscriptions: "want me to text you before each one renews?",
  subscription: "want me to text you before it renews?",
  travel: "want me to text you if anything changes?",
  appointments: "want a reminder the day before?",
  calendar: "want me to flag new invites as they come in?",
  shopping: "want a text when your orders arrive?",
  general: "want me to flag anything that needs you?",
  none: "want me to watch for new ones?",
  charge: "want me to text you before the next one?",
  business: "want me to flag the next one when it comes in?",
} as const;

type Found = { fact: string; offer: string; anchors: string[] };

// Newest named business message that matches, preferring one that is not bulk mail.
function latestNamed(messages: Classified[], matches: (m: Classified) => boolean) {
  const named = messages.filter((m) => m.name && matches(m));
  return named.find((m) => !m.bulk) ?? named[0];
}

function amountIn(subject: string): string | null {
  const match = AMOUNT.exec(subject);
  return match ? `$${match[1]}${match[2] ?? ""}` : null;
}

// A dollar amount comes only from a business's own subject line, and never from marketing mail.
function chargeIn(mail: Classified[], now: Date): string {
  const charged = mail.find((m) => !m.bulk && amountIn(m.subject));
  if (!charged) return "";
  const what = `a ${amountIn(charged.subject)} ${BILL_DUE.test(charged.subject) ? "bill" : "charge"}${onDay(charged, now)}`;
  return charged === mail[0] ? `, the latest ${what}` : `, including ${what}`;
}

function joinNames(names: string[]): string {
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

// Three names at most, so a longer list is "including" them rather than a count the names don't add up to.
const listed = (names: string[]) => (names.length > 3 ? `, including ${joinNames(names.slice(0, 3))}` : `: ${joinNames(names)}`);

function billFact(messages: Classified[], now: Date): Found | null {
  const bills = messages.filter((m) => m.name && m.topics.bill && (!m.bulk || BILL_DUE.test(m.subject)));
  const names = unique(bills.map((m) => m.name));
  const [latest] = bills;
  if (!latest) return null;
  if (names.length === 1) {
    const amount = latest.bulk ? null : amountIn(latest.subject);
    return { fact: `i see ${withArticle(latest.name)} bill${fromDay(latest, now)}${amount ? ` for ${amount}` : ""}.`, offer: OFFERS.bill, anchors: [latest.name] };
  }
  return {
    fact: `i see bills from ${names.length} companies in ${spanOf(searchDays("bills"))}${listed(names)}.`,
    offer: OFFERS.bills,
    anchors: names.slice(0, 3),
  };
}

// A subject's month and day is a trip date on or after the day it was sent: nobody books a trip that already happened.
function tripDay(m: Classified, now: Date): { label: string; at: number; upcoming: boolean } | null {
  const [, month = "", day] = MONTH_DAY.exec(m.subject) ?? [];
  const index = MONTHS.indexOf(month.slice(0, 3).toLowerCase());
  if (index === -1 || !day) return null;
  const sent = m.at ?? now;
  let at = Date.UTC(sent.getUTCFullYear(), index, Number(day), 12);
  if (at < sent.getTime() - DAY_MS) at = Date.UTC(sent.getUTCFullYear() + 1, index, Number(day), 12);
  return { label: `${MONTHS[index]} ${Number(day)}`, at, upcoming: at >= Date.parse(dateKey(now)) };
}

function travelFact(messages: Classified[], now: Date): Found | null {
  const trips = messages.filter((m) => m.name && m.topics.travel && CONFIRMED.test(m.subject));
  if (trips.length === 0) return null;
  // The next trip ahead, or else the newest confirmation.
  const dated = trips.map((m) => ({ m, day: tripDay(m, now) }));
  const ahead = dated.filter((t) => t.day?.upcoming).sort((a, b) => (a.day?.at ?? 0) - (b.day?.at ?? 0));
  const next = ahead[0] ?? dated[0]!;
  const date = next.day ? ` for ${next.day.label}` : fromDay(next.m, now);
  const others = unique(trips.map((m) => m.name)).filter((name) => name !== next.m.name);
  const more = others.length === 1 ? `, plus one from ${others[0]}` : others.length > 1 ? `, plus ${others.length} more bookings` : "";
  return {
    fact: `looks like you've got ${withArticle(next.m.name)} confirmation${date}${more}.`,
    offer: OFFERS.travel,
    anchors: [next.m.name, ...(others.length === 1 ? others : [])],
  };
}

// Counted, and named only when the sender is a business that is not medical or legal.
function appointmentFact(messages: Classified[], now: Date): Found | null {
  const appointments = messages.filter((m) => m.business && !m.bulk && m.topics.appointment);
  const [latest] = appointments;
  if (!latest) return null;
  const noun = appointments.length === 1 ? "appointment email" : "appointment emails";
  const last = latest.name ? `, the latest from ${latest.name}${onDay(latest, now)}` : `, the latest${fromDay(latest, now)}`;
  return {
    fact: `i see ${appointments.length} ${noun} from ${spanOf(searchDays("appointments"))}${last}.`,
    offer: OFFERS.appointments,
    anchors: latest.name ? [latest.name] : [`${appointments.length}`],
  };
}

// Counted as updates, not packages: one order often sends several emails.
function deliveryFact(messages: Classified[]): Found | null {
  const updates = messages.filter((m) => m.topics.delivery && m.business);
  if (updates.length === 0) return null;
  const from = latestNamed(updates, () => true)?.name;
  const anchors = from ? [from] : [`${updates.length}`];
  if (updates.length === 1) return { fact: `1 delivery update in the last week${from ? `, from ${from}` : ""}.`, offer: OFFERS.shopping, anchors };
  return { fact: `${updates.length} delivery updates in the last week${from ? `, latest from ${from}` : ""}.`, offer: OFFERS.shopping, anchors };
}

function subscriptionFact(messages: Classified[], now: Date): Found | null {
  const subscriptions = messages.filter((m) => m.name && m.topics.subscription);
  const names = unique(subscriptions.map((m) => m.name));
  if (names.length === 0) return null;
  const noun = names.length === 1 ? "subscription" : "subscriptions";
  const looks = names.length === 1 ? "looks" : "look";
  const charge = names.length === 1 ? chargeIn(subscriptions, now) : "";
  return {
    fact: `i see what ${looks} like ${names.length} ${noun}${listed(names)}${charge}.`,
    offer: names.length === 1 ? OFFERS.subscription : OFFERS.subscriptions,
    anchors: names.slice(0, 3),
  };
}

// A count names no one, so invites from people count too.
function inviteFact(messages: Classified[]): Found | null {
  const invites = messages.filter((m) => m.topics.invite && !m.bulk).length;
  if (invites === 0) return null;
  return {
    fact: `i see ${invites} unread calendar ${invites === 1 ? "invite" : "invites"} from the last week.`,
    offer: OFFERS.calendar,
    anchors: [`${invites}`],
  };
}

// People are counted in the recent sample, so the claim names the sample, never the whole inbox.
function peopleFact(unread: number, people: number, sampled: number) {
  if (unread === 0) return zeroFact();
  const total = `you've got ${formatCount(unread)} unread`;
  if (sampled === 1) return people ? `${total}, and your newest one is from a real person.` : `${total}, and your newest one isn't from a real person.`;
  const newest = `your newest ${sampled}`;
  if (people === 0) return `${total}, and none of ${newest} are from real people.`;
  if (people === sampled) return `${total}, and ${newest} are all from real people.`;
  if (people === 1) return `${total}, and only 1 of ${newest} looks like a real person.`;
  return `${total}, and only ${people} of ${newest} look like real people.`;
}

function countsFact(unread: number, messages: Classified[], now: Date) {
  if (messages.length === 0) {
    return unread === 0 ? zeroFact() : `you've got ${formatCount(unread)} unread, but nothing new this week.`;
  }
  const oldest = messages.reduce<Date | null>((min, m) => (m.at && (!min || m.at < min) ? m.at : min), null);
  const days = oldest ? Math.min(INBOX_DAYS, Math.max(1, Math.ceil((now.getTime() - oldest.getTime()) / DAY_MS))) : INBOX_DAYS;
  const span = days === 1 ? "the last day" : `the last ${days} days`;
  const count = messages.length >= RECENT_LIMIT ? `${RECENT_LIMIT}+` : `${messages.length}`;
  return `you've got ${count} unread from ${span}.`;
}

function zeroFact() {
  return "nothing unread in your inbox right now, nice.";
}

// The unread count, as the fact writes it and as a reply may ("1,204" or "1204"). A count of nothing anchors nothing.
const unreadAnchors = (unread: number) => (unread === 0 ? [] : [...new Set([formatCount(unread), `${unread}`])]);

// The count countsFact gives: this week's mail when there is some, else the unread total.
const countsAnchors = (unread: number, messages: Classified[]) =>
  messages.length === 0 ? unreadAnchors(unread) : [`${Math.min(messages.length, RECENT_LIMIT)}`];

// Mail from the business the need names, found by its own search. It leads when any of it is plainly from them.
function businessFact({ name, messages, capped }: NonNullable<InboxSnapshot["business"]>, now: Date): Found | null {
  const mail = recent(messages, BUSINESS_DAYS, now).filter((m) => sentBy(m, name));
  if (mail.length === 0) return null;
  const count = capped ? `${mail.length}+ ${name} emails` : `${mail.length} ${name} ${mail.length === 1 ? "email" : "emails"}`;
  const charge = chargeIn(mail, now);
  return {
    fact: `i found ${count} from ${spanOf(BUSINESS_DAYS)}${charge || `, the latest${fromDay(mail[0]!, now)}`}.`,
    offer: charge ? OFFERS.charge : OFFERS.business,
    anchors: [name],
  };
}

/** The inbox fact for the need and its offer. Mail from a business the need names comes first. */
export function inboxFinding(input: InboxSnapshot, category: HelpCategory | null, now: Date = new Date()): InboxFinding {
  if (input.labelsOnly) {
    const fact = input.unread === 0 ? zeroFact() : `${formatCount(input.unread)} unread in your inbox.`;
    return { fact, offer: input.unread === 0 ? OFFERS.inbox : OFFERS.labels, anchors: unreadAnchors(input.unread), category };
  }
  const business = input.business && businessFact(input.business, now);
  if (business && input.business) return { ...business, category, business: input.business.name };
  const messages = recent(input.messages, searchDays(category), now);
  const people = messages.filter((m) => m.person).length;
  return { ...factFor(category, input.unread, messages, people, now), category };
}

function factFor(category: HelpCategory | null, unread: number, messages: Classified[], people: number, now: Date): Found {
  const counts = (): Found => ({ fact: countsFact(unread, messages, now), offer: OFFERS.general, anchors: countsAnchors(unread, messages) });
  // A need with its own search has no unread count to fall back on: what it read is that kind of mail, read or not.
  const none = (noun: string): Found => ({ fact: `i don't see any ${noun} from ${spanOf(searchDays(category))}.`, offer: OFFERS.none, anchors: [] });
  switch (category) {
    case null:
    case "inbox":
      return messages.length > 0
        ? { fact: peopleFact(unread, people, messages.length), offer: OFFERS.inbox, anchors: unreadAnchors(unread) }
        : { fact: countsFact(unread, messages, now), offer: OFFERS.inbox, anchors: countsAnchors(unread, messages) };
    case "subscriptions":
      return subscriptionFact(messages, now) ?? none("subscriptions");
    case "bills":
      return billFact(messages, now) ?? none("bills");
    case "travel":
      return travelFact(messages, now) ?? none("bookings");
    case "appointments":
      return appointmentFact(messages, now) ?? none("appointment emails");
    case "shopping":
      return deliveryFact(messages) ?? counts();
    case "calendar":
      return inviteFact(messages) ?? counts();
    case "calls":
    case "other":
      return counts();
    default: {
      const unknown: never = category;
      return unknown;
    }
  }
}
