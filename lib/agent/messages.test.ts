import { describe, expect, it } from "vitest";
import { callEndReasonSchema, newSession, type Session } from "@/lib/session/schema";
import {
  CHIPS,
  OPENING,
  TERMS_URL,
  askText,
  freshLine,
  openingLines,
  withNames,
  callConflictLine,
  connectedAsLine,
  connectedOfferLine,
  contactCardLine,
  dashboardLinkLine,
  declinedLine,
  deletedLine,
  echo,
  formatMinutes,
  freshAsk,
  callGreeting,
  gmailLinkLine,
  linkFromCallLine,
  linkReminderLine,
  missedCallLine,
  needFirstLine,
  oauthDeniedLine,
  oauthErrorLine,
  onRequestLine,
  properCase,
  partialGrantLine,
  recapLine,
  recoveryAfterCall,
  remindLaterLine,
  resumedLine,
  setupSkippedLine,
  staleLinkLine,
  stoppedLine,
  toEvent,
  unverifiedLine,
  valueMomentLine,
  valueUnavailableLine,
  welcomeBackLine,
  type Line,
} from "@/lib/agent/messages";

const NOW = "2026-09-27T01:00:00.000Z";
const filled = (value: string) => ({ value, source: "voice" as const, setAt: NOW });
const base = (): Session => ({ ...newSession("s1", NOW), agentName: filled("Jarvis"), consent: { termsShownAt: NOW } });
const done = (): Session => ({
  ...base(),
  userName: filled("Preston"),
  helpNeed: { ...filled("my bills"), category: "bills" },
  gmail: { status: "connected", email: "p@gmail.com", valueFact: "i see a verizon email from tuesday that looks like a bill." },
});

describe("callGreeting", () => {
  const FULL = "hey, it's Jarvis.";
  const SHORT = "hey, it's Jarvis again.";

  it("names the agent as it was saved, with \"again\" on callbacks and no ai line", () => {
    expect(callGreeting(base())).toBe(FULL);
    expect(callGreeting({ ...base(), call: { status: "active", attempts: 2 } })).toBe(SHORT);
    expect(callGreeting(newSession("s2", NOW))).toBe("hey, it's Persona.");
  });

  it("gives the first-call hello when the earlier rings never connected", () => {
    const later = "2026-09-27T01:05:00.000Z";
    const secondRing = { ...base(), call: { status: "active" as const, attempts: 2, startedAt: later }, consent: { firstCallAt: later } };
    expect(callGreeting(secondRing)).toBe(FULL);
    expect(callGreeting({ ...secondRing, consent: { firstCallAt: NOW } })).toBe(SHORT);
  });

  it("uses the current name after a rename", () => {
    expect(callGreeting({ ...base(), agentName: filled("Max") })).toContain("it's Max.");
  });
});

describe("asks", () => {
  it("never repeats the same wording on consecutive asks", () => {
    for (const target of ["agentName", "userName", "helpNeed", "gmail", "call_offer"] as const) {
      expect(askText(target, 0)).not.toBe(askText(target, 1));
    }
    expect(askText("agentName", 1)).not.toBe(askText("agentName", 2));
  });

  it("has Spanish wording", () => {
    expect(askText("agentName", 0, "text", "es")).toBe("¿cómo quieres llamarme?");
  });
});

describe("recovery after a call", () => {
  it("offers a callback when nothing was collected", () => {
    expect(recoveryAfterCall(base(), "user_hangup")).toMatchObject({
      text: "looks like you hung up. want me to call back, or just finish here over text?",
      kind: "recovery",
      quickReplies: ["call me back", "text is fine"],
    });
  });

  it("keeps the name, says it to them rather than reading it back, and asks for the need", () => {
    expect(recoveryAfterCall({ ...base(), userName: filled("Preston") }, "network").text).toBe(
      "the line dropped, Preston. what's one thing you'd love handled? that's where i'll start.",
    );
  });

  it("says exactly how the call ended", () => {
    const lead = (reason: Parameters<typeof recoveryAfterCall>[1], detail = {}) => recoveryAfterCall(base(), reason, detail).text.split(". ")[0];
    expect(lead("user_hangup", { userCutOff: true })).toBe("you hung up mid-sentence");
    expect(lead("network")).toBe("the line dropped");
    expect(lead("tab_closed")).toBe("the call ended when your tab closed");
    expect(lead("timeout")).toBe("lost the connection on your end");
    expect(lead("timeout", { lengthCap: true })).toBe("we hit the time limit on the call");
    expect(lead("agent_end", { agentReason: "silence" })).toBe("it went quiet, so i hung up");
    expect(lead("user_hangup", { neverConnected: true })).toBe("you hung up before it connected");
    expect(lead("network", { neverConnected: true })).toBe("the call couldn't connect");
  });

  it("asks what they were about to say when the hangup cut them off", () => {
    expect(recoveryAfterCall({ ...base(), userName: filled("Preston") }, "user_hangup", { userCutOff: true }).text).toBe(
      "you hung up mid-sentence, Preston. what were you about to say?",
    );
  });

  it("keeps offering a callback however many calls there were", () => {
    const many: Session = { ...base(), call: { status: "ended", attempts: 30 } };
    expect(recoveryAfterCall(many, "user_hangup")).toEqual(recoveryAfterCall({ ...base(), call: { status: "ended", attempts: 1 } }, "user_hangup"));
    // Text only is the one thing that stops the offer.
    const textOnly: Session = { ...many, steering: { ...many.steering, textOnly: true } };
    expect(recoveryAfterCall(textOnly, "user_hangup")).toEqual({
      text: "looks like you hung up. let's finish here over text. what should i call you?",
      kind: "recovery",
    });
  });

  it("offers a pause after an abusive call instead of the next ask", () => {
    expect(recoveryAfterCall(base(), "agent_end", { agentReason: "abuse" }).kind).toBe("offer_pause");
  });

  it("keeps the Gmail link alive while OAuth is open", () => {
    const s: Session = { ...base(), userName: filled("Preston"), helpNeed: { ...filled("bills"), category: "bills" }, gmail: { status: "link_sent" } };
    expect(recoveryAfterCall(s, "tab_closed").kind).toBe("recovery");
    expect(recoveryAfterCall(s, "tab_closed").text).toContain("gmail link above still works");
    expect(recoveryAfterCall(s, "agent_end").text).not.toContain("cut off");
  });

  it("asks for the need, not the link, when the call drops before the need", () => {
    const s: Session = { ...base(), userName: filled("Preston"), gmail: { status: "link_sent" } };
    expect(recoveryAfterCall(s, "user_hangup").text).toBe(
      "looks like you hung up, Preston. what's one thing you'd love handled? that's where i'll start. the gmail link above still works too.",
    );
  });

  it("signs off instead of recapping again after a call that followed graduation", () => {
    const s: Session = { ...done(), graduated: true, graduatedAt: "2026-09-27T10:00:00.000Z", call: { status: "ended", attempts: 2, startedAt: "2026-09-27T10:05:00.000Z" } };
    expect(recoveryAfterCall(s, "user_hangup")).toEqual({ text: "good talking. text me whenever you need something.", kind: "continue_text" });
  });

  it("points that sign-off at what is still open, in words the thread has not had yet", () => {
    const graduated = { graduated: true, graduatedAt: "2026-09-27T10:00:00.000Z", call: { status: "ended" as const, attempts: 3, startedAt: "2026-09-27T10:05:00.000Z" } };
    const linkOut: Session = { ...done(), ...graduated, gmail: { status: "link_sent" } };
    const first = "good talking. the gmail link's in the thread whenever you want it.";
    expect(recoveryAfterCall(linkOut, "user_hangup").text).toBe(first);
    expect(recoveryAfterCall(linkOut, "user_hangup", { sent: [first] }).text).toBe("good talking. that gmail link's still up there if you want it.");
    expect(recoveryAfterCall(linkOut, "network").text).toBe("the line dropped. the gmail link's in the thread whenever you want it.");
    const noName: Session = { ...done(), ...graduated, userName: null };
    expect(recoveryAfterCall(noName, "user_hangup").text).toBe("good talking. tell me what to call you whenever you like.");
    // A name asked for as often as allowed is left alone.
    const capped = { ...noName, steering: { ...noName.steering, askCounts: { userName: 9 } } };
    expect(recoveryAfterCall(capped, "user_hangup").text).toBe("good talking. text me whenever you need something.");
  });

  it("recaps once the value moment landed", () => {
    expect(recoveryAfterCall(done(), "user_hangup")).toEqual({
      text: "looks like you hung up. you're all set, Preston. i'm Jarvis and your gmail's connected. first on my list: bills. want me to start there now?",
      kind: "recap",
    });
    expect(recoveryAfterCall(done(), "agent_end")).toEqual(recapLine(done()));
  });

  it("explains a blocked mic", () => {
    expect(recoveryAfterCall(base(), "mic_denied").kind).toBe("mic_help");
  });

  it("has a line for every end reason", () => {
    for (const reason of callEndReasonSchema.options) expect(recoveryAfterCall(base(), reason).text.length).toBeGreaterThan(0);
  });
});

describe("texting what they asked for on the call", () => {
  it("sends the fact the server computed", () => {
    expect(onRequestLine(done())).toEqual({ text: "here's what i found: i see a verizon email from tuesday that looks like a bill.", kind: "recap" });
  });

  it("says plainly why there is nothing to send yet", () => {
    expect(onRequestLine({ ...base(), gmail: { status: "link_sent" } }).text).toBe(
      "you asked me to text you what i find. i can't look until gmail's connected, and the link above still works.",
    );
    expect(onRequestLine(base())).toMatchObject({ quickReplies: ["send the link", "skip gmail"] });
    expect(onRequestLine({ ...done(), gmail: { status: "connected", email: "p@gmail.com" } }).kind).toBe("value_unavailable");
  });

  it("sums up and asks the next thing when gmail is off the table", () => {
    const s: Session = { ...base(), userName: filled("Preston"), gmail: { status: "skipped" }, steering: { ...base().steering, skipped: ["gmail"] } };
    expect(onRequestLine(s).text).toBe("here's where we left off: i'm Jarvis and you're Preston. what's one thing you'd love handled? that's where i'll start.");
  });
});

describe("recap", () => {
  it("matches the product voice, and ends by starting on their need", () => {
    expect(recapLine(done()).text).toBe("you're all set, Preston. i'm Jarvis and your gmail's connected. first on my list: bills. want me to start there now?");
  });

  it("says only what is known, and asks what to start on with no need saved", () => {
    expect(recapLine(newSession("s", NOW)).text).toBe("you're all set. what should i start on first?");
    expect(recapLine(base()).text).toBe("you're all set. i'm Jarvis. what should i start on first?");
  });

  it("never ends setup on a sign-off that leaves the next move to them", () => {
    for (const line of [recapLine(done()), needFirstLine(), setupSkippedLine(), needFirstLine("es"), setupSkippedLine("es")]) {
      expect(line.text, line.text).toMatch(/\?$/);
      expect(line.text).not.toMatch(/anytime|whenever|cuando necesites/);
    }
  });
});

describe("call outcomes", () => {
  it("continues over text after a decline, asking the next slot", () => {
    expect(declinedLine(base())).toEqual({ text: "saw you declined, all good. we can do it here. what should i call you?", kind: "continue_text" });
  });

  it("offers a retry after a missed call, however many calls there were", () => {
    expect(missedCallLine({ ...base(), call: { status: "missed", attempts: 1 } })).toEqual({
      text: "tried you, but it rang out. no worries, want me to try again or keep going here?",
      kind: "missed_call",
      quickReplies: ["call me", "keep going here"],
    });
    expect(missedCallLine({ ...base(), call: { status: "missed", attempts: 30 } }).quickReplies).toEqual(["call me", "keep going here"]);
  });

  it("names the booked time when a scheduled callback rings out", () => {
    const booked: Session = { ...base(), timeZone: "America/New_York", call: { status: "missed", attempts: 2, scheduledFor: "2026-09-27T16:40:00.000Z" } };
    expect(missedCallLine(booked).text).toMatch(/^called at 12:40 pm like you asked, but it rang out\./);
    expect(missedCallLine({ ...booked, timeZone: undefined }).text).toMatch(/^called back like you asked, but it rang out\./);
  });

  it("formats the callback delay", () => {
    expect(remindLaterLine(10).text).toBe("no problem, i'll call you back in 10 min. we can keep going here meanwhile.");
    expect([formatMinutes(60), formatMinutes(120), formatMinutes(1440)]).toEqual(["an hour", "2 hours", "a day"]);
  });
});

describe("welcome back", () => {
  it("offers the call while call slots are open, naming only the next thing that's missing", () => {
    expect(welcomeBackLine(base())).toMatchObject({
      text: "welcome back. i still need your name, and a quick call's the fastest way. want me to ring you?",
      kind: "welcome_back",
      quickReplies: ["call me", "text is fine"],
    });
    expect(welcomeBackLine({ ...base(), userName: filled("P") }).text).toBe(
      "welcome back. i still need to hear what you'd like help with, and a quick call's the fastest way. want me to ring you?",
    );
  });

  it("points at the open Gmail link", () => {
    expect(welcomeBackLine({ ...base(), gmail: { status: "link_sent" } }).text).toBe(
      "welcome back. the gmail link's still up there whenever you're ready.",
    );
  });

  it("words the ask another way than the last one in the thread", () => {
    const s: Session = { ...base(), call: { status: "declined", attempts: 0 } };
    const line = welcomeBackLine(s, ["no problem. we'll stick to text. what should i call you?"]);
    expect(line.text).toBe("welcome back. and what should i call you? first name or nickname, both work.");
    // With no thread at hand it still moves past the wording the last ask used.
    expect(welcomeBackLine(s).text).not.toBe("welcome back. what should i call you?");
    const both = ["what should i call you?", "and what should i call you? first name or nickname, both work."];
    expect(welcomeBackLine(s, both).text).toBe("welcome back. what name should i use for you? nicknames count.");
  });

  it("asks for Gmail when only Gmail is left", () => {
    const s: Session = { ...base(), userName: filled("P"), helpNeed: { ...filled("bills"), category: "bills" }, call: { status: "declined", attempts: 0 } };
    expect(welcomeBackLine(s)).toEqual({
      text: "welcome back. want the gmail link? it's how i'll check your inbox for you.",
      kind: "welcome_back",
      quickReplies: ["send the link", "skip gmail"],
    });
  });
});

describe("thread items", () => {
  it("builds the Gmail link card", () => {
    expect(gmailLinkLine("https://x.test/a")).toEqual({
      text: "https://x.test/a",
      kind: "gmail_link",
      meta: {
        link: { url: "https://x.test/a", title: "Connect your Google account", subtitle: "Nothing is sent without your OK. You can disconnect anytime.", preview: "google" },
      },
    });
  });

  it("builds the dashboard link card with Persona's title and its own preview", () => {
    const line = dashboardLinkLine("https://x.test/dashboard");
    expect(line.kind).toBe("dashboard_link");
    expect(line.meta?.link).toMatchObject({ url: "https://x.test/dashboard", title: "Open your Persona dashboard", preview: "dashboard" });
  });

  it("builds the contact card", () => {
    expect(contactCardLine("Jarvis")).toEqual({ text: "Jarvis", kind: "contact_card", meta: { contactCard: { name: "Jarvis" } } });
  });

  it("turns lines into agent text events with meta.kind", () => {
    expect(toEvent(connectedAsLine("p@gmail.com"))).toEqual({
      channel: "text",
      role: "agent",
      content: "connected as p@gmail.com. if that's the wrong account, just say so.",
      meta: { kind: "confirm_account", quickReplies: ["wrong account"] },
    });
  });

  it("flips pronouns when echoing the user's words", () => {
    expect(echo("Cancel my gym membership.")).toBe("cancel your gym membership");
    expect(echo("i'm drowning in email")).toBe("you're drowning in email");
  });
});

describe("product voice", () => {
  const all: Line[] = [
    recoveryAfterCall(done(), "user_hangup"),
    recoveryAfterCall(base(), "error"),
    recoveryAfterCall(base(), "agent_end", { agentReason: "silence" }),
    recoveryAfterCall(base(), "user_hangup", { userCutOff: true }),
    onRequestLine(done()),
    onRequestLine(base()),
    missedCallLine(base()),
    declinedLine(base()),
    remindLaterLine(10),
    welcomeBackLine(base()),
    linkFromCallLine(),
    valueMomentLine("you've got 12 unread from the last 3 days. want me to sort them later?"),
    valueUnavailableLine(),
    oauthDeniedLine(),
    oauthErrorLine(),
    partialGrantLine(),
    staleLinkLine(),
    linkReminderLine(),
    unverifiedLine(),
    connectedAsLine("p@gmail.com"),
    connectedOfferLine("calendar and drive"),
    connectedOfferLine(),
    callConflictLine(),
    recapLine(done()),
    needFirstLine(),
    setupSkippedLine(),
    stoppedLine(),
    resumedLine(base()),
    deletedLine(),
  ];

  // Names keep the capitals they were saved with, as Persona writes "Buddy it is."; everything else is lowercase.
  it("stays lowercase but for the saved names, short, and free of em dashes", () => {
    for (const line of all) {
      const unnamed = line.text.replaceAll("Jarvis", "").replaceAll("Preston", "");
      expect(unnamed, line.text).toBe(unnamed.toLowerCase());
      expect(line.text.length, line.text).toBeLessThanOrEqual(280);
      expect(line.text).not.toMatch(/[\u2014\u2013]/);
    }
  });

  it("puts the opening in sentence case and gives saved names their capitals back", () => {
    expect(properCase("jarvis it is. nice to meet you, mary jo. i'm an ai.", ["Jarvis", "Mary Jo"])).toBe(
      "Jarvis it is. Nice to meet you, Mary Jo. I'm an AI.",
    );
    expect(properCase("dr. who it is.", ["Dr. Who"])).toBe("Dr. Who it is.");
  });

  it("writes a call transcript line in standard English casing", () => {
    expect(properCase("hey, it's annalise. i still need what you want me to call you.", ["Annalise"])).toBe(
      "Hey, it's Annalise. I still need what you want me to call you.",
    );
    expect(properCase("perfect, preston it is. i'm built by the persona team for gmail and google calendar stuff.", ["Annalise", "Preston"])).toBe(
      "Perfect, Preston it is. I'm built by the Persona team for Gmail and Google Calendar stuff.",
    );
    expect(properCase("sure. \"i'd\" say friday, i\u2019m free. ok?", [])).toBe("Sure. \"I'd\" say Friday, I\u2019m free. Ok?");
    expect(properCase("see yourpersona.com, or it will be fine.", [])).toBe("See yourpersona.com, or it will be fine.");
  });

  it("picks the next wording of an ask the thread does not have yet, or none", () => {
    expect(freshAsk("userName", 0, "en", ["what should i call you?"])).toBe(askText("userName", 1));
    const every = [0, 1, 2].map((n) => askText("userName", n));
    expect(freshAsk("userName", 0, "en", every)).toBeNull();
  });

  it("has the pause, resume and graduation lines in Spanish too, and never says an errand is underway", () => {
    const spanish = [needFirstLine("es"), setupSkippedLine("es"), stoppedLine("es"), resumedLine(base(), "es")];
    for (const line of spanish) {
      expect(line.text, line.text).toBe(line.text.toLowerCase());
      expect(line.text, line.text).toMatch(/[áéíóúñ¿]|\b(?:entendido|listo|hola)\b/);
    }
    expect(needFirstLine().text).not.toMatch(/i'll start on that|on it|working on/);
  });

  it("opens in Persona's sentence case, with the terms, before the first ask", () => {
    for (const { intro, terms, ask } of Object.values(OPENING)) {
      for (const text of [intro, terms, ask]) {
        expect(text, text).toMatch(/^\P{L}*\p{Lu}/u);
        expect(text.length, text).toBeLessThanOrEqual(text === terms ? 400 : 80);
        expect(text).not.toMatch(/[\u2014\u2013]/);
      }
      expect(terms).toContain(TERMS_URL);
    }
  });
});

describe("the opening", () => {
  it("is Persona's own opening word for word: the hello, then the capabilities with the consent in one bubble", () => {
    expect(OPENING.en.intro).toBe("Hey! I'm your new personal assistant");
    expect(OPENING.en.terms).toBe(
      "You can text me or call me anytime and I can help with:\n📞 calling places on your behalf\n💻 browsing the web\n🛍️ shopping for you\n📩 managing your email and calendar\n🚗 finding DoorDash or Uber options\n\nBy continuing to text or use Persona, you agree to our Terms of Service and SMS Terms, and acknowledge our Privacy Policy: yourpersona.com/legal",
    );
    expect(OPENING.en.ask).toBe("What do you want to call me?");
    // The terms stay their own greeting event carrying the terms link, so the consent is still recorded when it goes out.
    for (const lang of ["en", "es"] as const) {
      expect(openingLines(lang)).toEqual([
        { text: OPENING[lang].intro, kind: "greeting" },
        { text: OPENING[lang].terms, kind: "greeting" },
      ]);
      expect(OPENING[lang].terms).toContain(TERMS_URL);
      expect(OPENING[lang].intro).not.toContain(TERMS_URL);
    }
  });
});

describe("names in the product voice", () => {
  it("keep the capitals they were saved with, and leave a one-letter name alone", () => {
    expect(withNames("buddy it is. nice to meet you, mary jo.", ["Buddy", "Mary Jo"])).toBe("Buddy it is. nice to meet you, Mary Jo.");
    expect(withNames("i think i can.", ["I"])).toBe("i think i can.");
    expect(withNames("maxwell is not max.", ["Max"])).toBe("maxwell is not Max.");
  });
});

describe("asks that don't read like a checklist", () => {
  const every = (["en", "es"] as const).flatMap((lang) =>
    (["text", "voice"] as const).flatMap((channel) =>
      (["agentName", "userName", "helpNeed", "gmail", "call_offer", "graduation_offer"] as const).flatMap((target) =>
        [0, 1, 2].map((n) => askText(target, n, channel, lang)),
      ),
    ),
  );

  it("drop the checklist wordings and use off your plate once at most", () => {
    for (const text of new Set(every)) expect(text, text).not.toMatch(/last try|next up is|last piece|so i know how to address you/);
    expect(new Set(every.filter((text) => text.includes("off your plate"))).size).toBeLessThanOrEqual(1);
  });

  it("offer to skip the rest with its two answers as chips, in both languages", () => {
    expect(askText("graduation_offer", 0)).toBe("want to skip the rest and start on that now?");
    expect(askText("graduation_offer", 0, "voice")).toBe("want to skip the rest and get started on that now?");
    expect(askText("graduation_offer", 0, "text", "es")).toMatch(/^¿.+\?$/);
    expect(CHIPS.en.graduation).toEqual(["start now", "keep going"]);
    expect(CHIPS.es.graduation).toHaveLength(2);
  });

  it("prefer a wording that reuses no stock phrase a recent line had", () => {
    const recent = ["what could i take off your plate this week?"];
    expect(freshLine(["what else could i take off your plate?", "what could i handle for you?"], recent)).toBe("what could i handle for you?");
    // With every wording reusing one, a new sentence still beats none.
    expect(freshLine(["what else could i take off your plate?"], recent)).toBe("what else could i take off your plate?");
  });
});

describe("connectedOfferLine", () => {
  it("names only the access they allowed, reads out nothing, and ends on one offer", () => {
    expect(connectedOfferLine("calendar and drive").text).toBe(
      "you also shared your calendar and drive, so i can look into any of it. want me to go through your email for you?",
    );
    expect(connectedOfferLine("drive").text).not.toContain("calendar");
    expect(connectedOfferLine().text).toBe("want me to go through your email for you?");
    for (const line of [connectedOfferLine("calendar and drive"), connectedOfferLine()]) {
      expect(line.kind).toBe("value_moment");
      expect(line.text).not.toMatch(/\d/);
      expect(line.text.match(/\?/g)).toHaveLength(1);
    }
  });
});

describe("valueMomentLine", () => {
  it("leads with the connection, unless that would push the bubble past 200 characters", () => {
    expect(valueMomentLine("you've got 3 bills this month.").text).toBe("gmail's connected. you've got 3 bills this month.");
    const long = `i see bills from 3 companies in the last 6 weeks: northwind energy, harbor mobile and cobalt card. "pay rent" is on your calendar tomorrow at 9 am. want a heads-up the day before each?`;
    expect(valueMomentLine(long).text).toBe(long);
    expect(valueMomentLine(long).text.length).toBeLessThanOrEqual(200);
  });
});
