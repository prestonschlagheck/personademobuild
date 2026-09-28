import { describe, expect, it } from "vitest";
import { newSession } from "@/lib/session/schema";
import { OPENING } from "@/lib/agent/messages";
import { ASK_CAP } from "@/lib/agent/policy";
import { buildSystemPrompt, sessionPrompt, staticPrompt } from "@/lib/agent/prompt";

const NOW = "2026-09-27T01:00:00.000Z";

describe("buildSystemPrompt", () => {
  it("fills the agent name, picks the channel addendum, and ends with the state block", () => {
    const session = { ...newSession("s1", NOW), agentName: { value: "Jarvis", source: "text" as const, setAt: NOW } };
    const voice = buildSystemPrompt(session, "voice", "call started");
    expect(voice).toContain("your name is Jarvis;");
    // The agent introduces itself in its own words: no hello line is handed to it to say.
    expect(voice).not.toMatch(/hey, it's|word for word/);
    expect(voice).not.toContain("callback.");
    expect(voice).not.toMatch(/\{\{\w+\}\}/);
    const callback = buildSystemPrompt({ ...session, call: { status: "active", attempts: 2 } }, "voice");
    expect(callback).toContain("you already talked with them on an earlier call, so this one is a callback.");
    expect(callback).not.toMatch(/hey, it's|word for word/);
    expect(voice.trimEnd().endsWith("recent_event: call started")).toBe(true);

    const text = buildSystemPrompt(newSession("s2", NOW), "text");
    expect(text).toContain("your name is Persona;");
    expect(text).toContain("you are texting, like imessage.");
    expect(text).toContain("next_best_ask: agentName");
  });

  it("lets them rename the agent on either channel, and says no live lookup exists instead of asking for a location", () => {
    for (const channel of ["text", "voice"] as const) {
      const rules = staticPrompt(channel);
      expect(rules).toContain(`they can rename you any time, never "can't": if they ask, say your current name and ask what they'd like instead`);
      expect(rules).toContain("you have no live lookups (weather, scores, the web): say so plainly at once, offer what you can do, and ask no location or detail for one.");
    }
    const graduated = { ...newSession("s1", NOW), graduated: true };
    expect(sessionPrompt(graduated, "text")).toContain("when they ask for something new (a live lookup is not one, nor is a calendar change: calendar access is read only)");
    expect(staticPrompt("voice")).toContain("after graduate, a new request (a live lookup or a calendar change is not one)");
  });

  it("opens a call in Spanish for someone who texts in Spanish", () => {
    const session = { ...newSession("s1", NOW), agentName: { value: "Lucía", source: "text" as const, setAt: NOW }, lang: "es" as const };
    const voice = buildSystemPrompt(session, "voice");
    expect(voice).toContain("speak spanish on this call");
    expect(buildSystemPrompt({ ...session, lang: "en" }, "voice")).not.toContain("spanish on this call");
  });

  it("carries the rule for the person card only once the card has something in it", () => {
    const fresh = newSession("s1", NOW);
    expect(sessionPrompt(fresh, "text")).not.toContain("person line");
    expect(sessionPrompt({ ...fresh, profile: { lang: "en" } }, "text")).not.toContain("person line");
    expect(sessionPrompt({ ...fresh, profile: { channel: "text" } }, "text")).toContain("mirror the person line quietly and never mention it");
    expect(staticPrompt("text")).not.toContain("person line");
  });

  it("leaves out of the text rules what the server already holds in code", () => {
    const fresh = newSession("s1", NOW);
    const text = buildSystemPrompt(fresh, "text");
    for (const line of Object.values(OPENING.en)) expect(text).not.toContain(line);
    expect(text).not.toMatch(/more than \d+ times|lowercase|emoji/);
    // A call has no such code, so it keeps its own cap.
    expect(buildSystemPrompt(fresh, "voice")).toContain(`more than ${ASK_CAP.voice} times`);
  });

  it("carries the opening rule only until the terms have gone out", () => {
    const fresh = newSession("s1", NOW);
    const opened = { ...fresh, consent: { termsShownAt: NOW } };
    expect(buildSystemPrompt(fresh, "text")).toContain("this is your first reply");
    expect(buildSystemPrompt(opened, "text")).not.toContain("first reply");
    expect(buildSystemPrompt(fresh, "voice")).not.toContain("first reply");
  });

  it("carries Google's screens once a link has gone out over text, and on every call", () => {
    const fresh = newSession("s1", NOW);
    const linked = { ...fresh, gmail: { status: "link_sent" as const, linkSentAt: NOW } };
    expect(buildSystemPrompt(fresh, "text")).not.toContain("access blocked");
    expect(buildSystemPrompt(linked, "text")).toContain("tap advanced, then continue");
    expect(buildSystemPrompt(fresh, "voice")).toContain("access blocked");
  });
});

describe("the main experience after graduation", () => {
  const graduated = { ...newSession("s1", NOW), graduated: true, consent: { termsShownAt: NOW } };

  it("carries the in-character plan rule only once setup is done, over text and on a call", () => {
    for (const channel of ["text", "voice"] as const) {
      const prompt = buildSystemPrompt(graduated, channel);
      expect(prompt, channel).toContain('answer in character: "on it" or the like, a short concrete plan');
      expect(prompt, channel).toContain('never say "i can\'t", and never claim anything is done, booked, sent, set up, scheduled or started');
      expect(buildSystemPrompt({ ...graduated, graduated: false }, channel), channel).not.toContain("setup is done and you're their assistant now");
    }
  });

  it("never tells the agent it can't run tasks, before or after graduation", () => {
    for (const s of [newSession("s1", NOW), graduated]) {
      const text = buildSystemPrompt(s, "text");
      expect(text).not.toContain("you can't run real tasks yet");
      expect(text).toContain('then answer as their assistant, "on it" and a one-line plan from what you know. never say "i can\'t"');
    }
  });

  it("takes a yes to the inbox fact's offer as a request once there is a fact", () => {
    const connected = { ...graduated, graduated: false, gmail: { status: "connected" as const, email: "p@gmail.com", valueFact: "x. want me to text you before it renews?" } };
    expect(buildSystemPrompt(connected, "text")).toContain("value_fact ends with an offer");
    expect(buildSystemPrompt({ ...connected, gmail: { status: "not_started" as const } }, "text")).not.toContain("value_fact ends with an offer");
    expect(buildSystemPrompt(newSession("s1", NOW), "voice")).toContain("the value fact ends with an offer. a yes to it is a request");
  });
});

describe("the rules this onboarding changed", () => {
  it("offers to skip the rest once, and holds a link only while the agent has no name", () => {
    const text = buildSystemPrompt(newSession("s1", NOW), "text");
    expect(text).toContain("say yes to your one offer to skip the rest (graduation_offer)");
    expect(text).not.toContain("naming a need is not asking to move on");
    expect(text).toContain("only while you have no name yet, say it's right after and ask for yours");
    expect(text).not.toContain("until you're named and know their name");
    expect(text).toContain('their own name gets a different welcome ("nice to meet you, alex")');
  });

  it("opens a call with a concrete reason and texts the link once the need calls for it, in two sentences", () => {
    const voice = buildSystemPrompt(newSession("s1", NOW), "voice");
    expect(voice).toContain('never a vague "to get you set up"');
    expect(voice).toContain("the google link comes after you know what they want help with, never before");
    expect(voice).toContain("if the need has nothing to do with google, don't push it");
    expect(voice).not.toContain("right after you have their name");
    expect(voice).not.toContain("wait for their yes before you call send_gmail_link");
    expect(voice).toContain("one or two short sentences per turn, never three");
  });

  it("answers what it's built on as persona's assistant in a line or two, never with talk of models or stacks", () => {
    for (const channel of ["text", "voice"] as const) {
      const rules = staticPrompt(channel);
      expect(rules).toContain("in a line or two, you're persona's assistant, built by the persona team, then what you can do for them.");
      expect(rules).toContain("never say model, stack, infrastructure or under the hood, name what's behind you, or say you can't see it.");
    }
  });

  it("books a callback on the call when they ask to be called again, and only the call has it", () => {
    expect(staticPrompt("voice")).toContain("hang up and call them back or call again, say in one line you're calling right back, and call end_call with call_back: true.");
    expect(staticPrompt("text")).not.toContain("call_back");
  });

  it("texts them from the call with its own tools, and says plainly that calendar access is read only", () => {
    const voice = staticPrompt("voice");
    expect(voice).toContain("send_text for anything they ask you to text them now");
    // A text at a time they name is a reminder, not a text sent this second.
    expect(voice).toContain("set_reminder for a text at a set time");
    expect(voice).toContain("send_contact_card for your card, request_location for a location card, send_gmail_link for google. never say you can't text them.");
    // Scoped to what Google allows, so an errand still gets its plan, and never offered first and taken back.
    expect(voice).toContain("your calendar and drive access is read only, so never offer or agree to add, move or delete an event or a file, even as a plan.");
    expect(voice).toContain("never say you can and then take it back.");
    expect(voice).not.toContain("something none of your tools does");
    // Over text every reply is already a text.
    expect(staticPrompt("text")).not.toContain("send_text");
  });

  it("hangs up when asked to, with a one-line bye and end_call in the same turn", () => {
    const voice = staticPrompt("voice");
    expect(voice).toContain("when they say bye, that they're done, or ask you to hang up, say bye in one line and call end_call in that same turn.");
    expect(voice).toContain("hang up only once they say bye, that's all, or ask you to hang up, never right after they ask you for something else.");
  });

  it("confirms a gmail connect on a call with what else was allowed, and reads out nothing it wasn't handed", () => {
    const voice = staticPrompt("voice");
    expect(voice).toContain(
      "when a note says gmail just connected, confirm it in a few words, name anything else they allowed with it, and make one offer: share a finding with its offer only when the note hands you one, otherwise offer to look into any of it.",
    );
    expect(voice).toContain("never read out counts, events or folders unprompted.");
    expect(voice).not.toMatch(/the value fact gets two of its own|share the value fact right away|outside the opening and the value moment/);
  });

  it("opens a callback with no recap and never claims anything is set up", () => {
    const voice = staticPrompt("voice");
    expect(voice).toContain("open the call by introducing yourself once, in your own words: a quick hi and your name (on a callback, that it's you again).");
    expect(voice).toContain("once you've introduced yourself, never say hi or your name again on this call, unless they ask who you are.");
    expect(voice).toContain("on a callback, go straight from your hi to why you're calling, with no recap of what's saved or of the last call");
    expect(voice).toContain('never a vague "to get you set up" and never that anything is already set up');
    expect(voice).not.toContain("without saying that you are");
  });

  it("says search reaches every folder, finds a folder by its label, and gives only totals a tool returned", () => {
    for (const channel of ["text", "voice"] as const) {
      const rules = staticPrompt(channel);
      expect(rules).toContain("gmail_search covers all their mail, every folder, label and archived mail, not only the inbox (never spam or trash)");
      expect(rules).toContain('get its exact name from gmail_labels and search with label:"name"');
      expect(rules).toContain("a count you give is a tool's total, never how many results you saw.");
      expect(rules).not.toContain("going through their inbox");
    }
  });

  it("never opens a call on the offer to skip the rest", () => {
    const need = {
      ...newSession("s1", NOW),
      agentName: { value: "Jarvis", source: "text" as const, setAt: NOW },
      userName: { value: "Preston", source: "text" as const, setAt: NOW },
      helpNeed: { value: "bills", source: "text" as const, setAt: NOW, category: "bills" as const },
    };
    expect(buildSystemPrompt(need, "voice")).toContain("next_best_ask: gmail");
    expect(buildSystemPrompt(need, "text")).toContain("next_best_ask: call_offer");
  });
});
