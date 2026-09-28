import { describe, expect, it } from "vitest";
import { MOCK_ACCOUNTS, mockAccount, mockInbox, type FixtureId } from "@/lib/gmail/fixtures";
import { businessInNeed, searchesTopic } from "@/lib/gmail/queries";
import { businessName, dayLabel, inboxFinding, isPerson, parseFrom, type MessageMeta } from "@/lib/gmail/value-fact";
import { helpCategorySchema, type HelpCategory } from "@/lib/session/schema";

const factOf = (...args: Parameters<typeof inboxFinding>) => inboxFinding(...args).fact;

// Saturday Sep 26, 2026, noon ET.
const NOW = new Date("2026-09-26T16:00:00Z");

const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3_600_000).toUTCString();
const msg = (hoursAgo: number, from: string, subject: string, bulk = false): MessageMeta => ({ from, subject, date: at(hoursAgo), bulk });

describe("parseFrom", () => {
  it("reads quoted, bare and angle-only addresses", () => {
    expect(parseFrom('"Delta Air Lines" <DeltaAirLines@t.delta.com>')).toEqual({ name: "Delta Air Lines", local: "deltaairlines", domain: "t.delta.com" });
    expect(parseFrom("sam@example.com")).toEqual({ name: null, local: "sam", domain: "example.com" });
    expect(parseFrom("<billing@acme.com>")).toEqual({ name: null, local: "billing", domain: "acme.com" });
  });
});

describe("isPerson", () => {
  it.each([
    ["Maya Chen <maya.chen@gmail.com>", true],
    ["Mom <mom.jones@icloud.com>", true],
    ["Sarah Kim <sarah@acme.co>", true],
    ["sarah.kim@acme.co", true],
    ["Chase <no.reply.alerts@chase.com>", false],
    ["Delta Air Lines <DeltaAirLines@t.delta.com>", false],
    ["Verizon <verizonwireless@email.vzwshop.com>", false],
    ["Jake from State Farm <jake@statefarm.com>", false],
    ["Bluebird Air <confirm@bluebirdair.example>", false],
    ["Amazon.com <shipment-tracking@amazon.com>", false],
    ["maya chen <maya@northpeak.co>", true],
    ["MAYA CHEN <maya@northpeak.co>", true],
    ["Sean O'Brien <sean@northpeak.co>", true],
    ["Jordan Q. Rivera <jordan@riveradesign.example>", true],
    ["Jane Smith <jane@janesmith.com>", true],
    ["Theo Grant <hi@grant.family>", true],
    ["Streamloop <streamloop@streamloop.example>", false],
  ])("%s -> %s", (from, expected) => {
    expect(isPerson({ from, subject: "hi", date: at(1) })).toBe(expected);
  });

  it("treats bulk mail as a business even from a webmail domain", () => {
    expect(isPerson({ from: "Maya Chen <maya@gmail.com>", subject: "hi", date: at(1), bulk: true })).toBe(false);
  });
});

describe("businessName", () => {
  it.each([
    ['"Amazon.com" <shipment-tracking@amazon.com>', "amazon"],
    ["The Morning Ledger <newsletter@morningledger.example>", "morning ledger"],
    ["Cobalt Card Customer Service <help@cobaltcard.example>", "cobalt card"],
    ["Card 4821 Alerts <alerts@cobaltcard.example>", "cobaltcard"],
    ["noreply@harbormobile.example", "harbormobile"],
    ["Barnes & Noble <news@bn.com>", "barnes & noble"],
    ["Delta Air Lines <DeltaAirLines@t.delta.com>", "delta air lines"],
    ["Uber Receipts <noreply@uber.com>", "uber"],
    ["Maya Chen via Splitwise <hello@splitwise.com>", "splitwise"],
    ["Jake from State Farm <jake@statefarm.com>", "state farm"],
    ["Priya Patel <support@acme.co>", "acme"],
    ["MAYA CHEN <support@acme.co>", "acme"],
    ["Theo Grant (via Google Docs) <drive-shares-noreply@google.com>", "google"],
    ["Maya Chen <billing@chen.family>", ""],
  ])("%s -> %s", (from, expected) => {
    expect(businessName(parseFrom(from))).toBe(expected);
  });
});

describe("dayLabel", () => {
  it("speaks relative days in ET", () => {
    expect(dayLabel(new Date("2026-09-26T13:00:00Z"), NOW)).toBe("today");
    expect(dayLabel(new Date("2026-09-26T03:00:00Z"), NOW)).toBe("yesterday");
    expect(dayLabel(new Date("2026-09-22T13:15:00Z"), NOW)).toBe("tuesday");
    expect(dayLabel(new Date("2026-09-12T13:15:00Z"), NOW)).toBe("sep 12");
  });
});

describe("computeValueFact", () => {
  it("counts real people for an inbox need", () => {
    const fact = factOf(
      {
        unread: 214,
        messages: [
          msg(1, "Maya Chen <maya.chen@gmail.com>", "Dinner?"),
          msg(2, "Sam Ortiz <sam@outlook.com>", "Re: apartment"),
          msg(3, "Fernway <no-reply@fernway.example>", "New sign-in"),
          msg(4, "The Morning Ledger <newsletter@morningledger.example>", "Top stories", true),
        ],
      },
      "inbox",
      NOW,
    );
    expect(fact).toBe("you've got 214 unread, and only 2 of your newest 4 look like real people.");
  });

  it("handles one person, no people, all people and an empty inbox", () => {
    const person = msg(1, "Maya Chen <maya.chen@gmail.com>", "Dinner?");
    const bot = msg(2, "Fernway <no-reply@fernway.example>", "New sign-in");
    expect(factOf({ unread: 9, messages: [person, bot] }, "inbox", NOW)).toContain("only 1 of your newest 2 looks like a real person");
    expect(factOf({ unread: 9, messages: [bot] }, "inbox", NOW)).toContain("your newest one isn't from a real person");
    expect(factOf({ unread: 9, messages: [person, person] }, "inbox", NOW)).toContain("your newest 2 are all from real people");
    expect(factOf({ unread: 0, messages: [] }, "inbox", NOW)).toMatch(/^nothing unread/);
  });

  it("names the newest bill sender and the day it arrived", () => {
    const northwind = msg(95, "Northwind Energy <billing@northwindenergy.example>", "Your statement is ready");
    expect(factOf({ unread: 37, messages: [northwind] }, "bills", NOW)).toBe("i see a northwind energy bill from tuesday.");
    const fact = factOf(
      { unread: 37, messages: [msg(100, "Harbor Mobile <noreply@harbormobile.example>", "Your bill is ready"), northwind] },
      "bills",
      NOW,
    );
    expect(fact).toBe("i see bills from 2 companies in the last 6 weeks: northwind energy and harbor mobile.");
  });

  it("uses an before a vowel", () => {
    const fact = factOf({ unread: 2, messages: [msg(3, "Aster Power <billing@asterpower.example>", "Your bill is ready")] }, "bills", NOW);
    expect(fact).toMatch(/^i see an aster power bill from today/);
  });

  it("never names a medical or legal sender", () => {
    const fact = factOf(
      {
        unread: 5,
        messages: [
          msg(2, "Mercy Clinic <billing@mercyclinic.example>", "Your bill is ready"),
          msg(3, "Hale Law Group <billing@halelaw.example>", "Invoice attached"),
          msg(30, "Northwind Energy <billing@northwindenergy.example>", "Your statement is ready"),
        ],
      },
      "bills",
      NOW,
    );
    expect(fact).toContain("northwind energy");
    expect(fact).not.toMatch(/clinic|mercy|hale|law/);
  });

  it("never names a person, even when they send a bill", () => {
    const fact = factOf(
      { unread: 3, messages: [msg(1, "Theo Grant <theo.grant@gmail.com>", "Your share of the bill")] },
      "bills",
      NOW,
    );
    expect(fact).not.toMatch(/theo|grant/);
    expect(fact).toBe("i don't see any bills from the last 6 weeks.");
  });

  it("never repeats a number or a subject from an email", () => {
    const subject = "Statement for card ending 4821 is ready";
    const fact = factOf({ unread: 12, messages: [msg(5, "Card 4821 <alerts@cobaltcard.example>", subject)] }, "bills", NOW);
    expect(fact).not.toContain("4821");
    expect(fact.toLowerCase()).not.toContain("statement for card");
  });

  it("uses the trip date from a travel confirmation subject", () => {
    const fact = factOf(
      { unread: 58, messages: [msg(4, "Bluebird Air <reservations@bluebirdair.example>", "Your trip confirmation: SFO to JFK on Oct 3")] },
      "travel",
      NOW,
    );
    expect(fact).toBe("looks like you've got a bluebird air confirmation for oct 3.");
  });

  it("falls back to the email's day when the subject has no date", () => {
    const fact = factOf(
      { unread: 58, messages: [msg(24, "Stayline Hotels <bookings@stayline.example>", "Reservation confirmed")] },
      "travel",
      NOW,
    );
    expect(fact).toBe("looks like you've got a stayline hotels confirmation from yesterday.");
  });

  it("counts deliveries and names the latest shipper", () => {
    const deliveries = [
      msg(2, "Parcelly <tracking@parcelly.example>", "Out for delivery"),
      msg(30, "Kestrel Books <orders@kestrelbooks.example>", "Your order has shipped"),
    ];
    expect(factOf({ unread: 10, messages: deliveries }, "shopping", NOW)).toBe(
      "2 delivery updates in the last week, latest from parcelly.",
    );
    expect(factOf({ unread: 10, messages: deliveries.slice(1) }, "shopping", NOW)).toBe(
      "1 delivery update in the last week, from kestrel books.",
    );
  });

  it("never counts a friend's package news as a delivery", () => {
    const fact = factOf({ unread: 3, messages: [msg(2, "maya chen <maya@northpeak.co>", "the package arrived!")] }, "shopping", NOW);
    expect(fact).toBe("you've got 1 unread from the last day.");
  });

  it("counts calendar invites without naming who sent them", () => {
    const fact = factOf(
      {
        unread: 9,
        messages: [
          msg(2, "Maya Chen <maya.chen@gmail.com>", "Invitation: Dinner at Luigi's @ Thu Oct 1"),
          msg(5, "Loop Calendar <invites@loopcalendar.example>", "Updated invitation: Design review @ Tue"),
          msg(8, "Webinar Hub <events@webinarhub.example>", "Invitation to our free webinar", true),
        ],
      },
      "calendar",
      NOW,
    );
    expect(fact).toBe("i see 2 unread calendar invites from the last week.");
  });

  it("calls a travel email a confirmation only when it is one", () => {
    const sale = msg(3, "Wayfarer Deals <offers@wayfarer.example>", "Book your next trip: fall flights from $49", true);
    expect(factOf({ unread: 5, messages: [sale] }, "travel", NOW)).toBe("i don't see any bookings from the last 4 months.");
  });

  it("reads a trip date only from a real month and day", () => {
    const stay = msg(4, "Stayline Hotels <bookings@stayline.example>", "Reservation confirmed: Marriott 2 nights");
    expect(factOf({ unread: 5, messages: [stay] }, "travel", NOW)).toBe(
      "looks like you've got a stayline hotels confirmation from today.",
    );
  });

  it("prefers a bill over bulk mail that mentions bills", () => {
    const fact = factOf(
      {
        unread: 5,
        messages: [
          msg(1, "Ledgerly <news@ledgerly.example>", "Pay your bills faster this fall", true),
          msg(20, "Northwind Energy <billing@northwindenergy.example>", "Your statement is ready"),
        ],
      },
      "bills",
      NOW,
    );
    expect(fact).toMatch(/^i see a northwind energy bill from yesterday/);
  });

  it("ignores anything older than a week", () => {
    const fact = factOf({ unread: 30, messages: [msg(24 * 9, "Parcelly <tracking@parcelly.example>", "Delivered")] }, "shopping", NOW);
    expect(fact).toBe("you've got 30 unread, but nothing new this week.");
  });

  it("names up to three subscription businesses by count", () => {
    const fact = factOf(
      {
        unread: 12,
        messages: [
          msg(2, "Streamloop <billing@streamloop.example>", "Your subscription renews tomorrow"),
          msg(10, "Cadence Music <receipts@cadencemusic.example>", "Your plan renews next week"),
          msg(26, "Draftline Studio <noreply@draftlinestudio.example>", "Your free trial is ending soon"),
          msg(60, "Vantage Fitness <hello@vantagefitness.example>", "Your membership auto-renews soon"),
        ],
      },
      "subscriptions",
      NOW,
    );
    expect(fact).toBe("i see what look like 4 subscriptions, including streamloop, cadence music and draftline studio.");
  });

  it("never names a person as a subscription", () => {
    const fact = factOf(
      { unread: 4, messages: [msg(1, "Theo Grant <theo.grant@gmail.com>", "My gym membership renews Friday")] },
      "subscriptions",
      NOW,
    );
    expect(fact).not.toMatch(/theo|grant/);
  });

  it("says plainly when a need has no subscriptions, since its search was not the week's unread", () => {
    const fact = factOf({ unread: 6, messages: [msg(1, "Maya Chen <maya@gmail.com>", "hey")] }, "subscriptions", NOW);
    expect(fact).toBe("i don't see any subscriptions from the last 3 months.");
  });

  it("falls back to recent counts when the need has no match", () => {
    const messages = [msg(1, "Maya Chen <maya@gmail.com>", "hey"), msg(50, "Fernway <no-reply@fernway.example>", "Receipt")];
    expect(factOf({ unread: 40, messages }, "calendar", NOW)).toBe("you've got 2 unread from the last 3 days.");
    expect(factOf({ unread: 40, messages }, "calls", NOW)).toBe("you've got 2 unread from the last 3 days.");
    expect(factOf({ unread: 40, messages }, "travel", NOW)).toBe("i don't see any bookings from the last 4 months.");
    expect(factOf({ unread: 40, messages: [] }, "other", NOW)).toBe("you've got 40 unread, but nothing new this week.");
  });

  it("uses only label counts in labels mode", () => {
    expect(factOf({ unread: 1204, messages: [], labelsOnly: true }, "bills", NOW)).toBe("1,204 unread in your inbox.");
  });

  it("defaults to the people fact before a need is known", () => {
    expect(factOf({ unread: 8, messages: [msg(1, "Maya Chen <maya@gmail.com>", "hey")] }, null, NOW)).toContain("your newest one is from a real person");
  });
});

describe("the fact's anchors", () => {
  it("are the business names the fact gives, or else its count, and nothing for a fact that found nothing", () => {
    const bills = inboxFinding(mockInbox(mockAccount("bills")!, NOW), "bills", NOW);
    expect(bills.anchors).toEqual(["northwind energy", "harbor mobile", "cobalt card"]);
    for (const anchor of bills.anchors) expect(bills.fact).toContain(anchor);
    const travel = inboxFinding(mockInbox(mockAccount("travel")!, NOW), "travel", NOW);
    expect(travel.anchors).toEqual(["bluebird air", "stayline hotels"]);
    expect(inboxFinding(mockInbox(mockAccount("inbox")!, NOW), "inbox", NOW).anchors).toEqual(["214"]);
    expect(inboxFinding({ unread: 1204, messages: [], labelsOnly: true }, "bills", NOW).anchors).toEqual(["1,204", "1204"]);
    expect(inboxFinding({ unread: 0, messages: [] }, "inbox", NOW).anchors).toEqual([]);
    expect(inboxFinding({ unread: 3, messages: [] }, "bills", NOW).anchors).toEqual([]);
  });

  it("are always in the fact they anchor, for every fixture and need", () => {
    for (const account of MOCK_ACCOUNTS) {
      for (const category of [null, ...helpCategorySchema.options]) {
        const { fact, anchors } = inboxFinding(mockInbox(account, NOW), category, NOW);
        for (const anchor of anchors) expect(fact).toContain(anchor);
      }
    }
  });
});

describe("need-aware facts", () => {
  const gym = (hoursAgo: number, subject: string, bulk = false) => msg(hoursAgo, "Planet Fitness <billing@planetfitness.example>", subject, bulk);
  const days = (n: number) => n * 24;

  it("leads with mail from the business the need names, and the amount from its own subject", () => {
    const messages = [gym(days(12), "Your Planet Fitness receipt: $24.99"), gym(days(42), "Your Planet Fitness receipt: $24.99")];
    const finding = inboxFinding({ unread: 9, messages: [], business: { name: "planet fitness", messages } }, "subscriptions", NOW);
    expect(finding).toEqual({
      fact: "i found 2 planet fitness emails from the last 3 months, the latest a $24.99 charge on sep 14.",
      offer: "want me to text you before the next one?",
      anchors: ["planet fitness"],
      category: "subscriptions",
      business: "planet fitness",
    });
  });

  it("says including when the charge is not the newest email, and never takes an amount from marketing or a person", () => {
    const messages = [
      gym(2, "Save $10 when you bring a friend", true),
      msg(3, "Rowan Lee <rowan.lee@gmail.com>", "planet fitness was $30 for me"),
      gym(days(12), "Membership dues paid: $24.99"),
    ];
    const { fact } = inboxFinding({ unread: 9, messages: [], business: { name: "planet fitness", messages } }, "subscriptions", NOW);
    expect(fact).toBe("i found 2 planet fitness emails from the last 3 months, including a $24.99 charge on sep 14.");
    expect(fact).not.toMatch(/\$10|\$30|rowan/);
  });

  it("matches a business by its domain as well as its display name", () => {
    const messages = [msg(5, "PF Billing <receipts@planetfitness.example>", "Your receipt")];
    expect(factOf({ unread: 1, messages: [], business: { name: "planet fitness", messages } }, "subscriptions", NOW)).toBe(
      "i found 1 planet fitness email from the last 3 months, the latest from today.",
    );
  });

  it("marks a count as more when the business search hit its limit, and holds it to 3 months", () => {
    const messages = [gym(5, "Your class is booked"), gym(days(95), "Your Planet Fitness receipt: $24.99")];
    const { fact, offer } = inboxFinding({ unread: 1, messages: [], business: { name: "planet fitness", messages, capped: true } }, "other", NOW);
    expect(fact).toBe("i found 1+ planet fitness emails from the last 3 months, the latest from today.");
    expect(offer).toBe("want me to flag the next one when it comes in?");
  });

  it("falls back to the need's own fact when none of the business search is plainly from the business", () => {
    const person = msg(4, "Maya Chen <maya.chen@gmail.com>", "maya chen sent you money");
    const clinic = msg(5, "Maya Chen Dental <billing@mayachendental.example>", "Your bill is ready");
    const input = { unread: 12, messages: [msg(6, "Northwind Energy <billing@northwindenergy.example>", "Your statement is ready")] };
    const fact = factOf({ ...input, business: { name: "maya chen", messages: [person, clinic] } }, "bills", NOW);
    expect(fact).toBe("i see a northwind energy bill from today.");
    expect(fact).not.toMatch(/maya|chen|dental/);
  });

  it("gives a single bill its amount from the subject, and marketing mail is a bill only when it says one is due", () => {
    const due = msg(20, "Aster Power <billing@asterpower.example>", "Your bill of $84.12 is ready");
    expect(factOf({ unread: 3, messages: [due] }, "bills", NOW)).toBe("i see an aster power bill from yesterday for $84.12.");
    const promo = msg(2, "Ledgerly <news@ledgerly.example>", "Pay your bills faster, save $20", true);
    const statement = msg(3, "Harbor Mobile <news@harbormobile.example>", "Your statement is ready", true);
    expect(factOf({ unread: 3, messages: [promo, statement] }, "bills", NOW)).toBe("i see a harbor mobile bill from today.");
  });

  it("holds each need to the window its search covers", () => {
    const old = msg(days(50), "Northwind Energy <billing@northwindenergy.example>", "Your statement is ready");
    expect(factOf({ unread: 3, messages: [old] }, "bills", NOW)).toBe("i don't see any bills from the last 6 weeks.");
    const renewal = msg(days(80), "Streamloop <billing@streamloop.example>", "Your subscription renews tomorrow");
    expect(factOf({ unread: 3, messages: [renewal] }, "subscriptions", NOW)).toBe("i see what looks like 1 subscription: streamloop.");
    const booking = msg(days(110), "Stayline Hotels <bookings@stayline.example>", "Reservation confirmed");
    expect(factOf({ unread: 3, messages: [booking] }, "travel", NOW)).toBe("looks like you've got a stayline hotels confirmation from jun 8.");
  });

  it("picks the next trip ahead over a newer confirmation for one already taken", () => {
    const past = msg(5, "Bluebird Air <reservations@bluebirdair.example>", "Your trip confirmation: SFO to JFK on Sep 20");
    const ahead = msg(days(40), "Stayline Hotels <bookings@stayline.example>", "Reservation confirmed for Oct 12");
    expect(factOf({ unread: 3, messages: [past, ahead] }, "travel", NOW)).toBe(
      "looks like you've got a stayline hotels confirmation for oct 12, plus one from bluebird air.",
    );
  });

  it("counts appointment emails, names only a sender that is neither medical nor legal, and skips marketing", () => {
    const dentist = msg(5, "Brightsmile Dental <reminders@brightsmiledental.example>", "Appointment reminder: cleaning on Oct 1");
    const vet = msg(30, "Northside Vet <appointments@northsidevet.example>", "Your appointment is confirmed");
    const promo = msg(2, "Fade Studio <booking@fadestudio.example>", "Time to book your next visit", true);
    expect(factOf({ unread: 4, messages: [promo, dentist, vet] }, "appointments", NOW)).toBe(
      "i see 2 appointment emails from the last month, the latest from today.",
    );
    expect(factOf({ unread: 4, messages: [vet] }, "appointments", NOW)).toBe(
      "i see 1 appointment email from the last month, the latest from northside vet yesterday.",
    );
    expect(factOf({ unread: 4, messages: [dentist] }, "appointments", NOW)).not.toMatch(/brightsmile|dental|oct 1/);
  });

  it("ends every finding with exactly one offer, and states the fact without asking anything", () => {
    for (const account of MOCK_ACCOUNTS) {
      for (const category of [...helpCategorySchema.options, null]) {
        const { fact, offer } = inboxFinding(mockInbox(account, NOW), category, NOW);
        expect(fact).not.toContain("?");
        expect(offer).toMatch(/^want [^?]+\?$/);
      }
    }
    expect(inboxFinding({ unread: 1204, messages: [], labelsOnly: true }, "bills", NOW).offer).toBe("want help getting that down?");
  });
});

// Personal mail written to trip every topic: a bill, a subscription, a trip, a package, an invite. The
// sender's name and every word of the subject are private.
const PERSONAL: MessageMeta[] = [
  msg(1, "Maya Chen <maya.chen@gmail.com>", "Your share of the Streamloop subscription and the flight bill"),
  msg(2, "maya chen <maya@northpeak.co>", "Splitting the electric bill after the trip"),
  msg(3, "Jordan Q. Rivera <jordan@riveradesign.example>", "Invoice for the apartment photos"),
  msg(4, "Jane Smith <jane@janesmith.com>", "Your order of cookies has shipped"),
  msg(5, "Theo Grant <hi@grant.family>", "Reservation confirmed for our anniversary trip on Oct 9"),
  msg(6, "Sam Ortiz <sam@ortiz.dev>", "My gym membership renews, want to join?"),
  msg(7, "MAYA CHEN <maya@acme.co>", "Package from grandma is on the way"),
  msg(8, "Priya Patel <priya@example.com>", "Invitation: Surprise party for Noor @ Sat Oct 3"),
];

const BUSINESS: MessageMeta[] = [
  msg(10, "Streamloop <billing@streamloop.example>", "Your subscription renews tomorrow", true),
  msg(12, "Northwind Energy <billing@northwindenergy.example>", "Your statement is ready"),
  msg(14, "Bluebird Air <reservations@bluebirdair.example>", "Your trip confirmation: SFO to JFK on Oct 3"),
  msg(16, "Parcelly <tracking@parcelly.example>", "Out for delivery today"),
  msg(18, "Maya Chen via Splitwise <hello@splitwise.com>", "Maya Chen added a bill: dinner at Luigi's"),
  msg(20, "Priya Patel <support@acme.co>", "Re: your order from the garden party"),
];

const PRIVATE_WORDS =
  /\b(maya|chen|jordan|rivera|jane|smith|theo|grant|sam|ortiz|priya|patel|noor|share|electric|apartment|photos|cookies|anniversary|gym|grandma|surprise|party|luigi'?s?|dinner|garden|oct 9)\b/;

describe("privacy", () => {
  const needs = [...helpCategorySchema.options, null];

  it.each(needs)("never names a person or repeats a personal subject (%s)", (need) => {
    for (const messages of [PERSONAL, [...PERSONAL, ...BUSINESS], [...BUSINESS, ...PERSONAL].reverse()]) {
      const fact = factOf({ unread: 57, messages }, need, NOW);
      expect(fact).not.toMatch(PRIVATE_WORDS);
      expect(fact).not.toContain("@");
    }
  });

  // A need with its own search finds none of its mail, and says so: an unread count would describe another search.
  const NONE_FOUND = {
    bills: "i don't see any bills from the last 6 weeks.",
    subscriptions: "i don't see any subscriptions from the last 3 months.",
    travel: "i don't see any bookings from the last 4 months.",
    appointments: "i don't see any appointment emails from the last month.",
  } as const;

  it("falls back to counts alone when every email is personal", () => {
    for (const need of needs) {
      const fact = factOf({ unread: 57, messages: PERSONAL }, need, NOW);
      if (need === "calendar") expect(fact).toBe("i see 1 unread calendar invite from the last week.");
      else if (need === "inbox" || need === null) expect(fact).toBe("you've got 57 unread, and your newest 8 are all from real people.");
      else if (searchesTopic(need)) expect(fact).toBe(NONE_FOUND[need]);
      else expect(fact).toBe("you've got 8 unread from the last day.");
    }
  });

  it("still names the businesses when personal mail is mixed in", () => {
    const messages = [...PERSONAL, ...BUSINESS];
    expect(factOf({ unread: 57, messages }, "subscriptions", NOW)).toContain(": streamloop.");
    expect(factOf({ unread: 57, messages }, "bills", NOW)).toContain("northwind energy");
    expect(factOf({ unread: 57, messages }, "travel", NOW)).toContain("bluebird air confirmation for oct 3");
    expect(factOf({ unread: 57, messages }, "shopping", NOW)).toContain("latest from parcelly");
  });
});

describe("fixtures", () => {
  // Each fixture's headline: the need it is built for, and the fact that need gets.
  const expected: Record<FixtureId, { category: HelpCategory; need?: string; fact: string }> = {
    inbox: { category: "inbox", fact: "you've got 214 unread, and only 5 of your newest 15 look like real people." },
    bills: { category: "bills", fact: "i see bills from 3 companies in the last 6 weeks: northwind energy, harbor mobile and cobalt card." },
    travel: { category: "travel", fact: "looks like you've got a bluebird air confirmation for oct 3, plus one from stayline hotels." },
    subscriptions: {
      category: "subscriptions",
      fact: "i see what look like 4 subscriptions, including streamloop, cadence music and draftline studio.",
    },
    appointments: { category: "appointments", fact: "i see 2 appointment emails from the last month, the latest from today." },
    membership: {
      category: "subscriptions",
      need: "cancel my planet fitness",
      fact: "i found 4 planet fitness emails from the last 3 months, including a $24.99 charge on sep 14.",
    },
  };

  it.each(MOCK_ACCOUNTS.map((a) => [a.id, a] as const))("%s produces its headline fact", (id, account) => {
    const { category, need, fact } = expected[id];
    expect(factOf(mockInbox(account, NOW, businessInNeed(need ?? "")), category, NOW)).toBe(fact);
  });

  it("never leaks an address, a person, a personal subject or an email number for any need", () => {
    for (const account of MOCK_ACCOUNTS) {
      const inbox = mockInbox(account, NOW);
      const personal = inbox.messages.filter((m) => isPerson(m));
      const names = personal.flatMap((m) => (parseFrom(m.from).name ?? "").toLowerCase().split(" "));
      // Weekday names are left out: the fact says them on its own, from the date.
      const subjects = personal.flatMap((m) => m.subject.toLowerCase().match(/\p{L}{5,}/gu) ?? []).filter((w) => !/^(?:mon|tues|wednes|thurs|fri|satur|sun)day$/.test(w));
      for (const category of [...helpCategorySchema.options, null]) {
        const fact = factOf(inbox, category, NOW);
        expect(fact).not.toContain("@");
        expect(fact).not.toMatch(/4821|\bsfo\b|\bjfk\b/);
        for (const word of [...names, ...subjects]) expect(fact).not.toMatch(new RegExp(`\\b${word}\\b`));
      }
    }
  });

  it("gives one short lowercase line for every need", () => {
    for (const account of MOCK_ACCOUNTS) {
      for (const category of [...helpCategorySchema.options, null]) {
        const fact = factOf(mockInbox(account, NOW), category, NOW);
        expect(fact).toBe(fact.toLowerCase());
        expect(fact).not.toMatch(/\n/);
        expect(fact.length).toBeLessThanOrEqual(160);
      }
    }
  });

  it("gives the calendar and shopping needs their own facts", () => {
    const inbox = mockInbox(MOCK_ACCOUNTS[0]!, NOW);
    expect(factOf(inbox, "calendar", NOW)).toBe("i see 1 unread calendar invite from the last week.");
    expect(factOf(inbox, "shopping", NOW)).toBe("2 delivery updates in the last week, latest from kestrel books.");
  });

  it("looks accounts up by id", () => {
    expect(mockAccount("travel")?.email).toBe("avery.quinn@example.com");
    expect(mockAccount("nope")).toBeUndefined();
  });
});
