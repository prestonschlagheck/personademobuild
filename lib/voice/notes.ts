import { isCallback } from "@/lib/agent/messages";
import { fold, googleHelps, isOpen, locationLine, nextBestAsk } from "@/lib/agent/policy";
import { CALL_JUST_STARTED, INJECTED, NOTHING_HEARD_YET, type ToolOutput } from "@/lib/agent/tools";
import { factFitsNeed, grantedLine } from "@/lib/gmail/workspace-facts";
import { SLOTS, type Session, type SessionEvent } from "@/lib/session/schema";
import type { CallNote } from "@/lib/voice/transport";

// What the live voice model is told about things outside its own conversation: how to open, news from the
// thread, and the silence rule. Only server state and server-written text go in these system notes; whatever
// the user typed travels separately as their own user item.

export type NoteMessage = { system: string; user?: string; respond: boolean };
export type SilenceStep = "check_in" | "wait" | "goodbye";

// Silence is counted in the transport's quiet stretches (about 7 s each). One soft check-in after about 20 s, then a
// goodbye at about 45 s with nothing heard (the check-in itself takes a few seconds to say). Someone signing in to
// Google in another tab is still on the call, so while they do, the agent waits until about 3 minutes instead.
export const SILENCE_MS = 7_000;
export const CHECK_IN_AT = 3;
export const GOODBYE_AT = 6;
export const GOODBYE_AT_SIGNING_IN = 26;

/** Google sign-in is under way: the link is out and they opened it, so the call tab may sit quiet in the background. */
export function signingIn(s: Session): boolean {
  return s.gmail.status === "link_sent" && Boolean(s.gmail.openedAt);
}

// The call's opening ask, as a goal the model words for itself. It never offers to skip the rest: they took this
// call to finish setup.
function nextStep(s: Session): string {
  const { slot } = nextBestAsk(s, "voice", { offerGraduation: false });
  switch (slot) {
    case "userName":
      return "ask what to call them.";
    case "helpNeed":
      return "ask for one thing they'd like help with.";
    case "gmail":
      return s.gmail.status === "link_sent"
        ? "say the gmail link is in their messages whenever they're ready. don't send another."
        : googleHelps(s)
          ? "their need lives in their email, so text them the gmail link now with send_gmail_link, no need to ask, and say that going through their email is the best way to help with it."
          : "offer the google link once, lightly, as something that helps later, and send it with send_gmail_link only if they say yes.";
    case "graduation_offer":
      return `you already know what they want help with, so offer once to skip the rest and start on it now.`;
    case "agentName":
    case "call_offer":
    case "none":
      return 'nothing is missing, so just ask what you can help them with.';
  }
}

const LEFT_WORDS = { agentName: "a name for you", userName: "their name", helpNeed: "what they want help with", gmail: "their gmail" } as const;

// What setup still needs, counted in code, so the reason for the call never calls three missing things "one piece".
// One thing left needs no count: the ask itself names it, and a count only invites a list of what's done.
function leftLine(s: Session): string {
  const left = SLOTS.filter((slot) => isOpen(s, slot)).map((slot) => LEFT_WORDS[slot]);
  if (left.length < 2) return "";
  return `still to set up: ${left.slice(0, -1).join(", ")} and ${left.at(-1)}, ${left.length} things. say honestly that there are a few left, never that it's just one, and start with the easiest.`;
}

/**
 * The first thing the live model hears: introduce itself in its own words, then why it's calling and one ask, all in
 * one reply, never a restart. No line is given to say: a quoted hello gets said on its own and then again.
 * It holds nothing to narrate: what's saved is in the state, and the latest texts lead only when they raise a topic.
 */
export function openingNote(s: Session): string {
  return [
    `the call just connected. introduce yourself once, in your own words: a quick hi and that you're ${s.agentName?.value ?? "Persona"}. never add that you're an ai or that the call is transcribed.`,
    s.lang === "es" ? "they text you in spanish, so say everything in spanish." : "",
    isCallback(s) ? "this is a callback, so let them know it's you again. after your hi, go straight to why you're calling, with no recap of what's saved or of the last call." : "",
    s.call.scheduledFor ? "you're calling at the time they booked." : "",
    leftLine(s),
    `then, in that same reply, give one short, concrete reason for the call: what the next piece lets you do for them, for their need when you know it. claim nothing is set up or done yet. then ${nextStep(s)} say it once: never repeat it, never apologize.`,
  ]
    .filter(Boolean)
    .join(" ");
}

/** Asks for a reply again after one that introduced the agent a second time, which nobody heard. */
export const HELLO_SAID_NOTE =
  "you already said hi and your name on this call, so that reply was cut before they heard it. answer again with no greeting and without your name: pick up from where the conversation is.";

/** Asks the agent to go on after it stopped for sound that turned out not to be them talking (its own echo, a cough). */
export const CUT_OFF_NOTE =
  "you stopped for a sound that wasn't them talking. carry on from where you were cut off, in a few words: never start over or repeat what they already heard.";

/** The last question in what the agent last said, so a note can keep it from being asked again word for word. */
function lastQuestion(said: string | undefined): string | undefined {
  return said
    ?.split(/(?<=[.!?])\s+/)
    .findLast((sentence) => sentence.trim().endsWith("?"))
    ?.trim();
}

const SAVED_WORDS = { userName: "their name", helpNeed: "what they want help with" } as const;

/** `lastSaid` is the agent's last line on the call, when there is one. */
export function callNote({ note, text, extras, saved }: CallNote, lastSaid?: string): NoteMessage {
  switch (note) {
    case "value_moment": {
      // Connecting is news, not a report: it came through, what else they allowed, and one offer. The inbox finding
      // comes only when it answers a specific need (valueNote); counts, events and folders otherwise wait for a question.
      const also = extras ? `, and that their ${extras} came with it` : "";
      const places = ["email", ...(extras ? extras.split(" and ") : [])];
      const where = places.length > 1 ? `${places.slice(0, -1).join(", ")} or ${places.at(-1)}` : places[0];
      const next = text
        ? ` then share this one finding in a sentence of your own, keeping its numbers and names, with its offer as your one question: "${text}". nothing else from their ${where} unless they ask.`
        : ` then, as your one question, offer to look into ${extras ? "any of it" : "their email"} for them. read out nothing from their ${where} unless they ask: no counts, events or folders.`;
      return {
        system: `gmail just connected. you're already mid-call, so no hello and no name: say in a few words of your own that it came through${also}.${next} one or two short sentences, then let them answer. never ask what they want help with: carry on with what they were asking about, and look things up with the google tools when they ask.`,
        respond: true,
      };
    }
    case "user_texted": {
      const asked = lastQuestion(lastSaid);
      const kept = saved?.map((slot) => SAVED_WORDS[slot]).join(" and ");
      return {
        system: [
          "the user just texted you during the call. their message follows; answer it out loud and keep going, and never ask for something it just gave you.",
          kept ? `the text thread already saved ${kept} from it, so just acknowledge it and don't call a tool to save it again.` : "",
          asked ? `you last asked "${asked}": if you ask that again, word it differently.` : "if you ask again for something you already asked, put it in new words.",
        ]
          .filter(Boolean)
          .join(" "),
        user: text ?? "",
        respond: true,
      };
    }
    case "gmail_result":
      return {
        system: `google sign-in did not connect gmail. the thread just told them: "${text ?? ""}". acknowledge it in one short line, then move on.`,
        respond: true,
      };
    case "location_shared":
      return {
        system: `they just shared their location from the card you texted. ${text ?? ""} say in a few words that you can see it now, then carry on with their need or the next missing thing. never say the numbers.`,
        respond: true,
      };
    case "location_denied":
      return {
        system: `they tapped share my location, but it didn't go through. the thread just told them: "${text ?? ""}". say so in one short line, that the button in messages still works, and carry on. never ask where they are out loud.`,
        respond: true,
      };
    case "renamed":
      // The text thread already confirmed the rename, so the call only takes the new name on, without a word.
      return {
        system: `they just renamed you over text. your name is now ${text ?? ""}: use it from here on, and don't announce it unless they bring it up.`,
        respond: false,
      };
  }
}

/**
 * Gmail connecting on this call, as the call hears it: the optional access granted with it, by name only, and the one
 * inbox finding only when their need is specific enough for it to answer. A general need hears no finding.
 */
export function valueNote(s: Session): CallNote {
  const extras = grantedLine(s.gmail);
  const text = factFitsNeed(s.helpNeed?.category ?? null) ? s.gmail.valueFact : undefined;
  return { note: "value_moment", ...(text && { text }), ...(extras && { extras }) };
}

/**
 * The note a thread event passes into a live call, if any: a text they sent, how Google sign-in turned out, or how a
 * location share went. Tapbacks are not texts. A rename by text is read from the session instead, since the row that
 * saved it is a tool's.
 */
export function threadNote(e: SessionEvent, s: Session): CallNote | null {
  if (e.channel !== "text") return null;
  const kind = e.meta?.kind;
  if (e.role === "user" && kind === "location_shared") return { note: "location_shared", ...(s.location && { text: locationLine(s.location) }) };
  if (e.role === "user") return kind === "reaction" ? null : { note: "user_texted", text: e.content };
  if (e.role !== "agent") return null;
  if (kind === "value_moment" || kind === "value_unavailable") return valueNote(s);
  if (kind === "oauth_denied_ack" || kind === "stale_link") return { note: "gmail_result", text: e.content };
  if (kind === "location_denied") return { note: "location_denied", text: e.content };
  return null;
}

/** What the model hears back when it calls end_call without a word first, so a call never ends in silence. */
export const UNSPOKEN_END_CALL: ToolOutput = {
  ok: false,
  error: "say_goodbye_first",
  hint: "nothing was said yet: say a short goodbye out loud, then call end_call again",
  state: "",
};

/**
 * A tool result the model still has to speak to, even after a response that already spoke over its tools: a refusal,
 * or what a lookup found. An accepted call gets no second response, even with a hint on how to word it (the link that
 * just went out, a reminder's time), since the response that called it already said it and a second one only says it
 * again, unless its words never mention the link (linkUnsaid). A response that said nothing is answered whatever its tools returned. Nor do refusals get one whose answer is
 * what it was already saying: a guess on the opening or a hangup before they spoke (wait for them), and a save from
 * words that tried to change the rules.
 */
const ALREADY_ANSWERED = new Set<string>([NOTHING_HEARD_YET, CALL_JUST_STARTED, INJECTED]);

export function needsAnswer(output: unknown): boolean {
  if (typeof output !== "object" || output === null || !("ok" in output)) return true;
  if (output.ok !== true) return !("error" in output && typeof output.error === "string" && ALREADY_ANSWERED.has(output.error));
  // What a Google tool read is the answer they are waiting for.
  return "result" in output && typeof output.result === "string" && output.result.length > 0;
}

/**
 * A link that just went out which what the response said never mentions, as when the server sends the Google link on
 * its own with a need it saved: news the caller hasn't heard, so it still gets its answer.
 */
export function linkUnsaid(output: unknown, said: string): boolean {
  if (typeof output !== "object" || output === null || !("ok" in output) || output.ok !== true) return false;
  const hint = "hint" in output && typeof output.hint === "string" ? output.hint : "";
  if (/\blink is in their messages\b/.test(hint)) return !/\b(?:link|enlace)\b/i.test(said);
  // A rename the response spoke over without saying the new name back still owes them that name.
  const renamed = /^saved as (.+?), and your new contact card\b/.exec(hint)?.[1];
  return renamed !== undefined && !said.toLowerCase().includes(renamed.toLowerCase());
}

// The next asks that are questions to put to them. Gmail is one only as the light offer before any link: once a link is
// out it is waited on, and one sent without asking was the news itself.
const QUESTION_ASKS = new Set<string>(["userName", "helpNeed", "agentName", "graduation_offer"]);

/**
 * A saved answer the response spoke over without moving on: setup still has a question to ask next, and nothing it
 * said asked anything, so the caller would be left in silence. It gets a second response that carries on. A lookup's
 * result and a link that just went out are answered by needsAnswer and linkUnsaid instead.
 */
export function askUnsaid(output: unknown, said: string): boolean {
  if (typeof output !== "object" || output === null || !("ok" in output) || output.ok !== true) return false;
  if ("result" in output && output.result) return false;
  const hint = "hint" in output && typeof output.hint === "string" ? output.hint : "";
  if (/\blink\b/.test(hint)) return false;
  const state = "state" in output && typeof output.state === "string" ? output.state : "";
  const next = /^next_best_ask: (\S+)/m.exec(state)?.[1] ?? "none";
  const offer = next === "gmail" && /^gmail: not_started\b/m.test(state);
  return (QUESTION_ASKS.has(next) || offer) && !said.includes("?");
}

const KEEP_OPEN = new Set<string>([UNSPOKEN_END_CALL.error ?? "", CALL_JUST_STARTED]);

/** An end_call the rules refused: the call stays open, and the model hears why and carries on. */
export function keepsCallOpen(output: unknown): boolean {
  return typeof output === "object" && output !== null && "error" in output && typeof output.error === "string" && KEEP_OPEN.has(output.error);
}

// They said they're done, or asked the agent to hang up, and the reply signs off without asking anything: the call ends
// even when the model forgets end_call, because a goodbye is never followed by an open line. "don't hang up" is not
// that, and "hang up and call me back" is left to end_call, which books the callback.
const DONE =
  /\b(?:bye|goodbye|gotta go|got to go|have to go|that'?s (?:it|all|everything)|i'?m done|nothing else|talk (?:to you )?later|ttyl|adios|chao|(?<!(?:n'?t|not|never) )(?:hang up(?![^.?!]*\b(?:(?:call|ring|phone) me|call (?:back|again))\b)|end (?:the|this) call))\b/;
// Only a plain ask to hang up: someone who just says bye still hears one back.
const HANG_UP = /(?<!(?:n'?t|not|never) )\b(?:hang up(?![^.?!]*\b(?:(?:call|ring|phone) me|call (?:back|again))\b)|end (?:the|this) call)\b/;
// A sentence that signs off, which may trail a word or two, as in "bye for now" or "take care, alex".
const SIGNED_OFF =
  /\b(?:bye|goodbye|talk (?:to you )?soon|talk later|take care|take it easy|catch you later|see you|have a good (?:one|day|night)|adios|hasta luego|nos vemos|cuidate)\b(?:[\s,]+[\p{L}']+){0,2}[\s.!]*$/u;

/** They said they're done or asked the agent to hang up. */
export function asksToEnd(heard: string): boolean {
  return DONE.test(fold(heard));
}

/** They asked the agent to hang up, so an end_call with no words first still ends the call. A bye alone does not. */
export function asksToHangUp(heard: string): boolean {
  return HANG_UP.test(fold(heard));
}

/** A goodbye said back to someone saying goodbye, which ends the call as surely as end_call does. */
export function isFarewell(heard: string, said: string): boolean {
  const reply = fold(said).trim();
  const signsOff = reply.split(/(?<=[.!])\s+/).some((sentence) => SIGNED_OFF.test(sentence));
  return asksToEnd(heard) && signsOff && !reply.includes("?");
}

/**
 * Quiet patience, one soft check-in, then a goodbye, which waits for minutes only while they sign in to Google. The
 * count restarts whenever they speak, so a goodbye never follows their own words. The same rule as the mock brain.
 */
export function silenceStep(s: Session, count: number): SilenceStep {
  if (count === CHECK_IN_AT) return "check_in";
  return count >= (signingIn(s) ? GOODBYE_AT_SIGNING_IN : GOODBYE_AT) ? "goodbye" : "wait";
}

export function silenceNote(step: Exclude<SilenceStep, "wait">, s: Session): string {
  if (step === "goodbye") {
    return "it has been quiet for a while, even after your check-in. say one short goodbye in your own words, that you'll text them the rest, then call end_call with reason silence.";
  }
  return s.gmail.status === "link_sent"
    ? "they've gone quiet, probably signing in to google in another tab. say one short line that there's no rush and you're here, nothing else. no question."
    : 'they\'ve gone quiet for a bit, maybe busy with something. say one short line of your own that there\'s no rush. no question, and don\'t repeat your last ask.';
}
