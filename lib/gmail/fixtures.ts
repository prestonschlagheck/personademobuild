import type { InboxSnapshot, MessageMeta } from "@/lib/gmail/value-fact";
import type { CalendarEvent } from "@/lib/gmail/workspace-facts";

// Stand-in inboxes for mock mode. Header metadata only, like the live read. Every sender uses
// the reserved .example domain, so nothing here can be mistaken for a real business or person. One
// gym carries a real brand's name, so a need that names a business can be played end to end.

export type FixtureId = "inbox" | "bills" | "travel" | "subscriptions" | "appointments" | "membership";

export type MockAccount = {
  id: FixtureId;
  name: string;
  email: string;
  summary: string;
  unread: number;
  messages: (now: Date) => MessageMeta[];
  /** The next week of the primary calendar, soonest first. */
  events: (now: Date) => CalendarEvent[];
  /** Top-level Drive folders, most recently changed first. */
  folders: string[];
};

const HOUR_MS = 3_600_000;

function message(now: Date, hoursAgo: number, from: string, subject: string, bulk = false): MessageMeta {
  return { from, subject, date: new Date(now.getTime() - hoursAgo * HOUR_MS).toUTCString(), bulk };
}

function event(now: Date, hoursAhead: number, summary: string, own = true): CalendarEvent {
  // Whole hours, like a real calendar, so the fact reads "at 3 pm".
  const start = new Date(Math.ceil((now.getTime() + hoursAhead * HOUR_MS) / HOUR_MS) * HOUR_MS);
  return { summary, start: start.toISOString(), allDay: false, own };
}

const shortDate = (date: Date) =>
  new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }).format(date);
const weekday = (date: Date) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(date);
// A subject's date `hours` from now, so the demo inbox always reads current and matches the event it invites to.
const ahead = (now: Date, hours: number) => new Date(now.getTime() + hours * HOUR_MS);

export const MOCK_ACCOUNTS: readonly MockAccount[] = [
  {
    id: "inbox",
    name: "Jordan Lee",
    email: "jordan.lee@example.com",
    summary: "Busy inbox, mostly newsletters",
    unread: 214,
    messages: (now) => [
      message(now, 1, "Maya Chen <maya.chen@example.com>", "Dinner Thursday?"),
      message(now, 3, "The Morning Ledger <newsletter@morningledger.example>", "Five stories to start your week", true),
      message(now, 5, "Fernway <no-reply@fernway.example>", "New sign-in to your account"),
      message(now, 7, "Dana Brooks <dana.brooks@example.com>", `Invitation: Coffee catch-up @ ${weekday(ahead(now, 20))} ${shortDate(ahead(now, 20))}`),
      message(now, 9, "Priya Patel <priya@example.com>", "Photos from the weekend"),
      message(now, 14, "Loop Calendar <notifications@loopcalendar.example>", "Your agenda for the week", true),
      message(now, 20, "Tallgrass Fitness <hello@tallgrassfitness.example>", "Your membership renews soon", true),
      message(now, 26, "Kestrel Books <orders@kestrelbooks.example>", "Your order has shipped"),
      message(now, 31, "Sam Ortiz <sam.ortiz@example.com>", "Re: apartment"),
      message(now, 40, "Brightpath Learning <team@brightpath.example>", "Your course starts Monday", true),
      message(now, 52, "Crestline Bank <alerts@crestlinebank.example>", "Your statement is ready"),
      message(now, 60, "Parcelly <tracking@parcelly.example>", "Your package is on the way"),
      message(now, 75, "Dana Brooks <dana.brooks@example.com>", "Quick question"),
      message(now, 88, "Stackline <digest@stackline.example>", "Weekly digest", true),
      message(now, 104, "Fernway <no-reply@fernway.example>", "Your receipt"),
    ],
    events: (now) => [event(now, 20, "Coffee catch-up", false), event(now, 30, "Dentist"), event(now, 72, "Team standup", false), event(now, 100, "Gym")],
    folders: ["Work", "Photos", "Apartment", "Recipes", "Taxes 2025"],
  },
  {
    id: "bills",
    name: "Casey Morgan",
    email: "casey.morgan@example.com",
    summary: "A few bills due this month",
    unread: 37,
    messages: (now) => [
      message(now, 6, "Mercy Clinic <billing@mercyclinic.example>", "Your bill is ready"),
      message(now, 50, "Northwind Energy <billing@northwindenergy.example>", "Your October statement is ready"),
      message(now, 70, "Theo Grant <theo.grant@example.com>", "Splitting the internet bill"),
      message(now, 96, "Harbor Mobile <noreply@harbormobile.example>", "Your bill is ready to view"),
      message(now, 110, "Cobalt Card <alerts@cobaltcard.example>", "Statement for card ending 4821"),
      message(now, 130, "Pinecrest Weekly <news@pinecrest.example>", "This week in Pinecrest", true),
    ],
    events: (now) => [event(now, 26, "Pay rent"), event(now, 50, "Call internet provider")],
    folders: ["Bills", "Receipts", "Insurance"],
  },
  {
    id: "travel",
    name: "Avery Quinn",
    email: "avery.quinn@example.com",
    summary: "A trip coming up",
    unread: 58,
    messages: (now) => [
      message(
        now,
        4,
        "Bluebird Air <reservations@bluebirdair.example>",
        `Your trip confirmation: SFO to JFK on ${shortDate(ahead(now, 7 * 24))}`,
      ),
      message(now, 18, "Stayline Hotels <bookings@stayline.example>", "Reservation confirmed, 3 nights"),
      message(now, 30, "Noor Haddad <noor.haddad@example.com>", "Are we still on for the trip?"),
      message(now, 44, "Parcelly <tracking@parcelly.example>", "Out for delivery today"),
      message(now, 80, "Wayfarer Deals <offers@wayfarer.example>", "48 hours only: fall fares", true),
    ],
    events: (now) => [event(now, 22, "Pack for trip"), event(now, 7 * 24 - 12, "Flight to JFK")],
    folders: ["Travel", "Passport scans", "Work", "Photos"],
  },
  {
    id: "subscriptions",
    name: "Riley Sato",
    email: "riley.sato@example.com",
    summary: "A few subscriptions worth reviewing",
    unread: 92,
    messages: (now) => [
      message(now, 2, "Streamloop <billing@streamloop.example>", "Your subscription renews tomorrow", true),
      message(now, 10, "Cadence Music <receipts@cadencemusic.example>", "Your plan renews next week", true),
      message(now, 26, "Draftline Studio <noreply@draftlinestudio.example>", "Your free trial is ending soon"),
      message(now, 40, "Priya Patel <priya@example.com>", "Want to split a family plan?"),
      message(now, 60, "Vantage Fitness <hello@vantagefitness.example>", "Your membership auto-renews soon", true),
    ],
    events: () => [],
    folders: ["Music", "Design projects"],
  },
  {
    id: "appointments",
    name: "Jamie Park",
    email: "jamie.park@example.com",
    summary: "A few appointments coming up",
    unread: 23,
    messages: (now) => [
      message(now, 5, "Brightsmile Dental <reminders@brightsmiledental.example>", `Appointment reminder: cleaning on ${shortDate(ahead(now, 21))}`),
      message(now, 20, "Jess Morales <jess.morales@example.com>", "Can we reschedule lunch?"),
      message(now, 30, "Northside Vet <appointments@northsidevet.example>", "Your appointment is confirmed"),
      message(now, 50, "Fade Studio <booking@fadestudio.example>", "Time to book your next visit", true),
      message(now, 70, "Kestrel Books <orders@kestrelbooks.example>", "Your order has shipped"),
    ],
    events: (now) => [event(now, 21, "Dentist"), event(now, 54, "Vet appointment"), event(now, 80, "Book club", false)],
    folders: ["Health", "Pets"],
  },
  {
    id: "membership",
    name: "Morgan Diaz",
    email: "morgan.diaz@example.com",
    summary: "A gym membership to cancel",
    unread: 48,
    messages: (now) => [
      message(now, 3, "Planet Fitness <hello@planetfitness.example>", "Bring a friend free this weekend", true),
      message(now, 20, "Rowan Lee <rowan.lee@example.com>", "Gym tomorrow?"),
      message(now, 30, "Harbor Mobile <noreply@harbormobile.example>", "Your bill is ready to view"),
      message(now, 60, "Streamloop <billing@streamloop.example>", "Your subscription renews tomorrow", true),
      message(now, 12 * 24, "Planet Fitness <billing@planetfitness.example>", "Your Planet Fitness receipt: $24.99"),
      message(now, 42 * 24, "Planet Fitness <billing@planetfitness.example>", "Membership dues paid: $24.99"),
      message(now, 72 * 24, "Planet Fitness <billing@planetfitness.example>", "Your Planet Fitness receipt: $24.99"),
      message(now, 100 * 24, "Planet Fitness <billing@planetfitness.example>", "Your Planet Fitness receipt: $24.99"),
    ],
    events: (now) => [event(now, 50, "Planet Fitness"), event(now, 75, "Dinner with Rowan", false)],
    folders: ["Fitness", "Receipts"],
  },
];

export function mockAccount(id: string) {
  return MOCK_ACCOUNTS.find((account) => account.id === id);
}

/**
 * The fixture's inbox as the live read would give it. Every message stands in for both searches: the value fact holds
 * each to the need's window, and to mail sent by the business, as it does the live results.
 */
export function mockInbox(account: MockAccount, now: Date = new Date(), business: string | null = null): InboxSnapshot {
  const messages = account.messages(now);
  return { unread: account.unread, messages, ...(business && { business: { name: business, messages } }) };
}
