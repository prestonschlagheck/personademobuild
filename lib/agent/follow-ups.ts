import { MIC_END_REASONS, type CallEndReason, type NewEvent, type Reminder, type Session, type SessionEvent, type Slot } from "@/lib/session/schema";
import { callPossible, canGraduate, clockIn, fold, isAskCapped, nextBestAsk, openSlots, recentAgentLines, type AskTarget } from "@/lib/agent/policy";
import {
  CUT_OFF,
  DROPPED,
  callingBackLine,
  connectedAsLine,
  connectedOfferLine,
  reconnectedLine,
  declinedLine,
  formatMinutes,
  inboxUnreadableLine,
  linkReminderLine,
  locationDeniedLine,
  locationThanksLine,
  missedCallLine,
  oauthDeniedLine,
  oauthErrorLine,
  onRequestLine,
  partialGrantLine,
  recoveryAfterCall,
  remindLaterLine,
  staleLinkLine,
  startAsk,
  stillConnectedLine,
  toEvent,
  valueMomentLine,
  valueUnavailableLine,
  welcomeBackLine,
  type CallEndDetail,
  type Line,
} from "@/lib/agent/messages";
import { factFitsNeed } from "@/lib/gmail/workspace-facts";

// What the agent says when the server itself did something: a call ended, rang out or was turned down, the
// user came back, Google sign-in finished. The live model writes the reply from the note. The template is the
// reply in mock mode and whenever the model is slow or fails, and its kinds are what the thread records either way.

export type FollowUp = {
  /** What just happened, for the model, with the only facts it may state. */
  note: string;
  fallback: Line[];
  /** Words the reply must carry as written, like the connected address, or the template goes out instead. */
  mustSay?: string[];
  /** At least one of these, as whole words, like the names the inbox fact was built from, or the template goes out. */
  mustSayOne?: string[];
  /** Words that would tell a different story than the one that happened, like "dropped" for a hangup. */
  mustNotSay?: string[];
  /** The reply has to ask something, like the question that starts on their need once setup ends, or the template goes out. */
  mustAsk?: boolean;
  /** When set, the reply may state no number these facts do not contain. */
  facts?: string[];
  /** Rows that belong after the reply, like the graduation row. */
  after?: NewEvent[];
};

export const followUpEvents = (followUp: FollowUp): NewEvent[] => [...followUp.fallback.map(toEvent), ...(followUp.after ?? [])];

const ASK_NAMES: Record<AskTarget, string> = {
  agentName: "a name for you",
  userName: "what to call them",
  helpNeed: "one thing they'd like help with",
  gmail: "connecting gmail (offer the link, and send it only once they say yes)",
  call_offer: "a quick call to finish the rest",
  graduation_offer: "whether they'd like to skip the rest and start on their need now",
};

// Right after a call ends or is turned down, the next ask never offers another call. The offer to skip the rest is
// left to a turn, where it is recorded, so a yes to it can be read as one.
function nextAsk(s: Session, offerCall = false): string {
  const { slot } = nextBestAsk(s, "text", { offerCall, offerGraduation: false });
  if (slot === "none") return "there is nothing left to ask for.";
  if (slot === "gmail" && s.gmail.status === "link_sent") return "the gmail link is still open above, so point to it instead of asking again.";
  return `next, ask for ${ASK_NAMES[slot]}, with a short reason.`;
}

// Sign-offs that leave the next move to them, which the text that ends setup never uses.
const PASSIVE = ["text me anytime", "text me any time", "text me whenever", "here whenever", "hit me up", "reach out anytime"];

// What setup still has open, as a light pointer for a sign-off: the link already out, else the first thing that may
// still be asked for.
const STILL_OPEN: Record<Slot, string> = {
  agentName: "they can pick a name for you",
  userName: "they can tell you what to call them",
  helpNeed: "they can tell you what they'd like a hand with",
  gmail: "they can connect gmail",
};

function openPointer(s: Session): string {
  if (s.gmail.status === "link_sent") return ", with one light pointer that the gmail link is in the thread whenever they want it";
  const slot = openSlots(s).find((open) => !isAskCapped(s, open, "text"));
  return slot ? `, with one light pointer that ${STILL_OPEN[slot]} whenever they want` : "";
}

/** Setup is over and this call is where it ended: it graduated on the call or at its hangup, not before it. */
function setupEndedOnCall(s: Session): boolean {
  if (!s.graduated && !canGraduate(s, "all_slots").ok) return false;
  return !(s.graduatedAt && s.call.startedAt && s.graduatedAt < s.call.startedAt);
}

/**
 * The goal for the text that ends setup: start on what they want. `offers` is set when a line already ends on an offer
 * toward it, like the value fact, which is then the one question.
 */
function startOnNeed(s: Session, offers = false): string {
  if (!s.helpNeed) return "setup is done, so sum up in a few words what's set, then ask what they'd like you to start on first.";
  const ask = offers
    ? "the value fact's offer is that step and your one question, so ask nothing else"
    : "end on one question: the one detail you need first, or an offer to do that step (a reminder, if a time would help, set only once they say yes)";
  return `setup is done, so start on "${s.helpNeed.value}": sum up in a few words what's set, then name the first concrete thing you'd do for it from what you know. ${ask}. never sign off in a way that leaves the next move to them.`;
}

/** Enough of the thread to hold one whole call: its transcript, its tool calls and the rows around it. */
export const CALL_EVENT_WINDOW = 200;

// "text me when you find it", "just text me the rest", "send it over text". A request for the link is the link
// tool's job, and "don't text me" is not a request.
const TEXT_ME =
  /\b(?:text|message)\s+(?:me|it)\b|\bsend (?:me )?(?:a |the )?(?:text|message|recap|summary)\b|\bshoot me a (?:text|message)\b|\b(?:over|by|via) text\b|\b(?:recap|summary)\b|\bmandame (?:un )?mensaje\b|\bescribeme\b|\bpor mensaje\b|\bresumen\b/;
// The agent's own word on the call that a text is coming ("i'll text you a recap"), which the text after it keeps.
const WILL_TEXT = /\bi(?:'ll| will) (?:text|message|send) you\b|\bi(?:'ll| will) send (?:you )?(?:a |the )?(?:text|recap|summary)\b|\bi(?:'ll| will) shoot you a text\b|\bte (?:mando|escribo)\b/;
const NOT_TEXT_ME = /\b(?:don'?t|do not|never|stop|no)\s+(?:text|message)|\blink\b/;
// Only the last things said count, so an early "text me the link" is not read as a request at the end.
const REQUEST_WINDOW = 4;
// A line trailing off ("so many things, like...") reads as cut off too, not only one the hangup flushed.
const TRAILING = /(?:\.\.\.|…|,)\s*$/;
// "there are so many things i need help with, like": the start of a list of needs.
const LISTING = /\b(?:need|help)\b/;
// "hello?", "you there?", "¿me escuchas?": checking the line is up, not a question that wants an answer.
const CHECK_IN = /^\W*(?:(?:hello|hi|hey|hola|(?:are )?you (?:still )?there|still there|can you hear me|me (?:escuchas|oyes)|(?:sigues|estas) ahi)\W*)+$/;

const asksToBeTexted = (text: string) => {
  const folded = fold(text);
  return TEXT_ME.test(folded) && !NOT_TEXT_ME.test(folded);
};

function endCallReason(event: SessionEvent | undefined): string | undefined {
  const args = event?.meta?.tool?.args;
  return typeof args === "object" && args !== null && "reason" in args && typeof args.reason === "string" ? args.reason : undefined;
}

/** How one call ended beyond its reason, read from its own transcript and tool calls. */
export function callEndDetail(events: SessionEvent[], attempt: number): CallEndDetail {
  const lines = events.filter((e) => e.meta?.kind === "transcript" && e.meta.callAttempt === attempt);
  const said = lines.filter((e) => e.role === "user");
  const last = lines.at(-1);
  // Tool records carry no attempt, so only the ones after this call's start row are its own.
  const start = events.findLastIndex((e) => e.meta?.kind === "call_started" && e.meta.callAttempt === attempt);
  const endCall = start < 0 ? undefined : events.slice(start + 1).findLast((e) => e.meta?.tool?.name === "end_call" && e.meta.tool.ok);
  const detail: CallEndDetail = {};
  const agentReason = endCallReason(endCall);
  if (agentReason) detail.agentReason = agentReason;
  const args = endCall?.meta?.tool?.args;
  if (typeof args === "object" && args !== null && "call_back" in args && args.call_back === true) detail.callBack = true;
  if (said.some((e) => e.content.endsWith(CUT_OFF)) || (last?.role === "user" && TRAILING.test(last.content))) {
    detail.userCutOff = true;
    if (LISTING.test(fold(said.at(-1)?.content ?? ""))) detail.cutOffListing = true;
  }
  if (lines.some((e) => e.role === "agent" && e.content.endsWith(CUT_OFF))) detail.agentCutOff = true;
  // A text send_text already put in the thread answered what was asked before it, and the line the call said with it
  // ("i'll text you that now"): only a request after that line still waits for the text after the call.
  const texted = start < 0 ? -1 : events.findLastIndex((e, i) => i > start && e.meta?.tool?.name === "send_text" && e.meta.tool.ok);
  const answered = texted < 0 ? -1 : events.findIndex((e, i) => i > texted && e.role === "agent" && lines.includes(e));
  const open = (e: SessionEvent) => texted < 0 || (answered >= 0 && events.indexOf(e) > answered);
  const promised = lines
    .filter((e) => e.role === "agent" && open(e))
    .slice(-REQUEST_WINDOW)
    .some((e) => WILL_TEXT.test(fold(e.content)) && !/\blink\b/.test(fold(e.content)));
  if (promised || said.filter(open).slice(-REQUEST_WINDOW).some((e) => asksToBeTexted(e.content))) detail.askedToText = true;
  // A question the agent never spoke to before their next line, or before the call ended. A check-in the hangup cut
  // off is still a check-in.
  const unanswered = lines.some(
    (e, i) =>
      e.role === "user" && e.content.includes("?") && !CHECK_IN.test(fold(e.content.replace(CUT_OFF, "")).trim()) && lines[i + 1]?.role !== "agent",
  );
  if (unanswered) detail.unanswered = true;
  const spoke = lines.findLast((e) => e.role === "agent");
  if (spoke) detail.lastAgentAt = spoke.at;
  const sent = recentAgentLines(events);
  if (sent.length) detail.sent = sent;
  return detail;
}

/**
 * Whether they already have the inbox fact: Gmail connected before this call, so the thread had it, or the agent
 * spoke after it connected on this call. A call that ended right as Gmail connected never said it.
 */
function factHeard(s: Session, detail: CallEndDetail): boolean {
  const { connectedAt, valueFact } = s.gmail;
  if (!valueFact) return false;
  if (!connectedAt || !s.call.startedAt || connectedAt < s.call.startedAt) return true;
  return detail.lastAgentAt !== undefined && detail.lastAgentAt > connectedAt;
}

// Only a line that went on its own dropped. A hangup, the agent's own goodbye, or a call that never connected did not.
const DROP_WORDS = ["disconnect", "dropped", "cut off", "cut out", "got cut", "lost the connection", "lost you"];

// Said to the model as plainly as the thread will say it, so the text states what happened and never guesses.
function whatHappened(reason: CallEndReason, detail: CallEndDetail): string {
  if (detail.neverConnected) return reason === "user_hangup" ? "they hung up before it connected" : "it never connected";
  switch (reason) {
    case "user_hangup":
      return detail.userCutOff ? "they hung up in the middle of a sentence" : "they hung up";
    case "agent_end":
      if (detail.agentReason === "silence") return "you hung up after they went quiet and didn't answer your check-in";
      if (detail.agentReason === "abuse") return "you ended it after repeated abuse";
      return "you ended it yourself after a goodbye, so it did not drop";
    case "network":
      return "the connection dropped";
    case "tab_closed":
      return "their browser tab closed";
    case "timeout":
      return detail.lengthCap ? "it hit the length limit for a call" : "their side stopped responding and the line timed out";
    case "mic_denied":
      return "it never started because their browser blocked the microphone";
    case "mic_missing":
      return "it never started because their device has no microphone the browser can use";
    case "mic_busy":
      return "it never started because another app is using their microphone";
    case "error":
      return "it failed on our side";
  }
}

function afterCallGuidance(s: Session, reason: CallEndReason, detail: CallEndDetail, sharing: boolean): string {
  if (reason === "mic_denied") return "say their mic looks blocked: they can allow it from the lock icon, or just keep going over text.";
  if (reason === "mic_missing") return `say there's no mic on their device, so you'll keep going over text, and offer no call. ${nextAsk(s)}`;
  if (reason === "mic_busy") return "say their mic's busy with another app: they can close it and you'll call back, or keep going over text.";
  if (detail.agentReason === "abuse") return "stay calm, one line: you're happy to pick this up over text whenever they're ready. ask for nothing.";
  if (reason === "error" || detail.neverConnected) {
    return callPossible(s) ? "offer to try the call again, or keep going here." : `keep going over text. ${nextAsk(s)}`;
  }
  if (s.graduated || canGraduate(s, "all_slots").ok) {
    // Their open question is the real task, so it leads over the need as saved, which can be a word like "gmail".
    if (setupEndedOnCall(s) && detail.unanswered) {
      return "setup is done, so start on that open question, not on the need as saved: sum up in a few words what's set, then answer it. never sign off in a way that leaves the next move to them.";
    }
    if (setupEndedOnCall(s)) return startOnNeed(s, sharing);
    // Answering what they asked is the whole text, not a sign-off that asks nothing.
    if (detail.unanswered) {
      return "setup was done before this call, so no recap of it: that answer and its offer are the whole text. never reuse the words of a text you already sent, like your last one after a call.";
    }
    return `setup was done before this call, so sign off warmly in one line${openPointer(s)}. ask nothing, and never reuse the words of a text you already sent, like your last one after a call.`;
  }
  // The offer on their open question is the one question, so setup's next ask goes out only as that offer.
  if (detail.unanswered) {
    return `if doing what they asked needs what setup is still missing (${nextAsk(s)}), make that the offer; otherwise setup waits for a later turn.`;
  }
  const nothing = !s.userName && !s.helpNeed && s.gmail.status === "not_started";
  if (!nothing) return nextAsk(s);
  return callPossible(s) ? "nothing was saved on the call, so offer to call back or finish here over text." : `nothing was saved on the call. ${nextAsk(s)}`;
}

// What they asked to be texted: the one fact about their inbox as the server computed it, or a recap once they heard it.
// `starts` says the text also starts on their need, since setup ended on this call and nothing is left to wait on.
function requested(s: Session, heard: boolean): { note: string; starts: boolean } {
  const { gmail } = s;
  const ended = setupEndedOnCall(s);
  if (gmail.status === "connected") {
    if (!gmail.valueFact) return { note: "gmail is connected but their inbox couldn't be read, so say that plainly and promise no update.", starts: false };
    if (!heard) {
      return {
        note: `send what you found: value_fact: "${gmail.valueFact}". that is the only thing known about their inbox, so share it, reworded if you like, keeping every number and name, and add nothing to it.`,
        starts: ended,
      };
    }
    const next = ended
      ? startOnNeed(s)
      : "sum up in one line what's set (their name, their need, gmail connected) and what happens next. promise nothing more.";
    return { note: `they already heard what you found on the call, so don't send it again: ${next}`, starts: ended };
  }
  if (gmail.status === "link_sent") {
    return { note: "you can't look anything up until gmail is connected: say so in a few words and point to the link above. promise nothing else.", starts: false };
  }
  if (openSlots(s).includes("gmail")) {
    return { note: "you can't look anything up until gmail is connected: say so in a few words and offer the link, sent only once they say yes.", starts: false };
  }
  return { note: ended ? startOnNeed(s) : `sum up what you have in one line. ${nextAsk(s)}`, starts: ended };
}

/** The checks a text that ends setup is held to: it asks something, and never signs off passively. */
function startChecks(starts: boolean, mustNotSay: string[] | undefined): Pick<FollowUp, "mustAsk" | "mustNotSay"> {
  const banned = [...(mustNotSay ?? []), ...(starts ? PASSIVE : [])];
  return { ...(starts && { mustAsk: true }), ...(banned.length && { mustNotSay: banned }) };
}

export function afterCall(s: Session, reason: CallEndReason, detail: CallEndDetail = {}): FollowUp {
  const what = `the call just ended: ${whatHappened(reason, detail)}.`;
  // Numbers only ever come from the inbox fact or the address, so a text after a call can promise no times or counts,
  // and none from their calendar or drive, which wait for a question.
  const facts = [s.gmail.valueFact, s.gmail.email].filter((fact): fact is string => Boolean(fact));
  const mustNotSay = DROPPED.has(reason) && !detail.neverConnected ? undefined : DROP_WORDS;
  const heard = factHeard(s, detail);
  if (detail.askedToText && !MIC_END_REASONS.includes(reason) && !detail.neverConnected) {
    const asked = requested(s, heard);
    return {
      note: `${what} before it ended they asked you to text them, so do exactly that now. ${asked.note}`,
      fallback: [onRequestLine(s, heard)],
      facts,
      ...startChecks(asked.starts, mustNotSay),
    };
  }
  const cut = detail.userCutOff ? " their last line on the call ended mid-sentence: respond to what they were starting to say." : "";
  const self = detail.agentCutOff ? " you were mid-sentence yourself: don't repeat that line, just pick up." : "";
  // A callback they asked for that the server could not book (they said stop, or the calls ran out).
  const noCallBack = detail.callBack ? " they asked you to call them right back, but you can't ring them again now: say so in a few words, and that they can call you anytime." : "";
  // Their question on the call that nothing answered, which this text answers before anything else it picks up.
  const open =
    detail.unanswered && detail.agentReason !== "abuse"
      ? " a question they asked on the call never got an answer: it is their last real question in the call lines. right after saying what happened, answer it plainly from what you and your tools can do, and make your one question an offer to do it."
      : "";
  // Gmail connected as the call ended, so the fact the call was about to say goes by text instead, but only for a need
  // it answers: a general one hears no counts until they ask.
  const fact = s.gmail.valueFact && !heard && factFitsNeed(s.helpNeed?.category ?? null) ? s.gmail.valueFact : null;
  // With their question open, its offer is the one question, so the fact goes without its own.
  const share = fact
    ? ` they never heard what you found, so share it in its own bubble: value_fact: "${open ? withoutOffer(fact) : fact}". keep every number and name, and add nothing.`
    : "";
  // Mic trouble, abuse, a failure or a call that never connected get their own guidance, even with setup done.
  const starts =
    setupEndedOnCall(s) && !MIC_END_REASONS.includes(reason) && detail.agentReason !== "abuse" && reason !== "error" && !detail.neverConnected;
  const recovery = recoveryAfterCall(s, reason, detail);
  // The fact ends on its own offer toward their need, so the recap before it asks nothing.
  const ask = ` ${startAsk(s)}`;
  const first = fact && recovery.text.endsWith(ask) ? { ...recovery, text: recovery.text.slice(0, -ask.length) } : recovery;
  return {
    note: `${what} text them now: first say what happened in a few plain words, exactly as it happened, then pick up where the call left off from what the state says was saved, and never ask for anything already saved. if on the call they asked you to text them something or you said you would, this text is that: send it.${cut}${self}${noCallBack}${open} ${afterCallGuidance(s, reason, detail, Boolean(fact))}${share}`,
    fallback: [first, ...(fact ? [valueMomentLine(fact)] : [])],
    facts,
    ...startChecks(starts, mustNotSay),
  };
}

export function missedCall(s: Session): FollowUp {
  const booked = s.call.scheduledFor && s.timeZone ? clockIn(s.call.scheduledFor, s.timeZone) : null;
  const when = !s.call.scheduledFor ? "" : booked ? ` at ${booked}, the time they booked,` : " at the time they booked";
  const retry = callPossible(s)
    ? "and ask whether they want you to try again or keep going over text."
    : `and keep going over text, with no more calls for now. ${nextAsk(s)}`;
  return {
    note: `you called them${when} and it rang out with no answer. say exactly that in a few words, no worries, ${retry}`,
    fallback: [missedCallLine(s)],
    facts: booked ? [booked] : [],
    // Nothing was said on a call nobody answered, so it was never cut off and left no voicemail or transcript.
    mustNotSay: [...DROP_WORDS, "voicemail", "transcript", "before you could"],
  };
}

/** The agent hung up to ring them straight back, as they asked, and the ring is already booked. */
export function callingBack(): FollowUp {
  return {
    note: "they asked you to hang up and call them again, so the call just ended and you're ringing them back in a few seconds. say in a few words that you're calling right back. ask for nothing.",
    fallback: [callingBackLine()],
    facts: [],
    mustNotSay: [...DROP_WORDS, "rang out", "missed"],
  };
}

export function declinedCall(s: Session): FollowUp {
  return {
    note: `they declined your call on the ring screen. say you saw that and it's fine, and keep going over text without offering another call. ${nextAsk(s)}`,
    fallback: [declinedLine(s)],
    facts: [],
    mustNotSay: [...DROP_WORDS, "rang out", "missed"],
  };
}

export function remindLater(minutes: number): FollowUp {
  const when = formatMinutes(minutes);
  return {
    note: `they tapped remind me on the ring screen, so the server booked a callback in ${when}. confirm you'll call back in ${when} and that you can keep going over text meanwhile. ask for nothing else.`,
    fallback: [remindLaterLine(minutes)],
    facts: [when],
  };
}

/** `history` is the thread they came back to, so the fallback never repeats the ask it ends on. */
export function welcomeBack(s: Session, history: SessionEvent[] = []): FollowUp {
  return {
    note: `they just came back to the thread after being away a while. welcome them back in a few words and pick up where you left off. ${nextAsk(s, true)}`,
    fallback: [welcomeBackLine(s, recentAgentLines(history))],
  };
}

/**
 * They shared their location from the request card. The coarse point is in the state block; the reply may name the
 * area when it helps their need, but states no number, so the coordinates never reach the thread.
 */
export function locationShared(s: Session): FollowUp {
  return {
    note: `they just shared their location from your request card; the state block has it, rounded to about 1 km. thank them in a few words, name the area only if it helps their need, and never write the coordinates or claim you found or booked anything. ${nextAsk(s)}`,
    fallback: [locationThanksLine(s)],
    facts: [],
    mustNotSay: ["booked", "found"],
  };
}

/** Their browser refused or failed to give a position. The card stays tappable, and the reply says so once. */
export function locationDenied(reason: "denied" | "unavailable" | "timeout"): FollowUp {
  const what = reason === "denied" ? "their browser blocked location for this page" : "their browser couldn't get a position just now";
  return {
    note: `they tapped share my location, but ${what}, so nothing was shared. say so honestly in one short line, and that the button still works. don't ask where they are in words, and ask nothing else.`,
    fallback: [locationDeniedLine(reason)],
    facts: [],
  };
}

export function linkReminder(): FollowUp {
  return {
    note: "the gmail link you sent a couple of minutes ago is still unused. send one short, no-pressure nudge that it's still up there. no new link, and ask for nothing else.",
    fallback: [linkReminderLine()],
  };
}

/** A reminder they asked for came due. The text says what it is for, with no number their own words do not have. */
export function reminderDue(s: Session, reminder: Reminder): FollowUp {
  const what = reminder.what.toLowerCase();
  return {
    note: `they asked you to remind them now: "${reminder.what}". text them the reminder in one short bubble, in your own words, naming what it's for. ask for nothing.`,
    fallback: [{ text: s.lang === "es" ? `te recuerdo: ${what}.` : `quick reminder: ${what}.`, kind: "reminder" }],
    facts: [reminder.what],
  };
}

// The offer that ends a value line was already made at the first sign-in, so a second one says only what it found.
const withoutOffer = (fact: string) => fact.replace(/\s*[^.?!]*\?\s*$/, "").trim() || fact;

/**
 * What sign-in brought beyond the inbox fact: `granted` is the optional Google access they allowed, said aloud
 * ("calendar and drive", "calendar" or "drive"), and `anchors` the names or count the fact rests on.
 */
export type ConnectExtras = { granted?: string; anchors?: string[] };

/**
 * On a live call the call speaks the rest, so the thread only confirms the account and what else they allowed: the
 * same fact twice, once aloud and once by text, reads like two agents talking. Off a call the one inbox finding goes
 * out only for a need it answers; a general need gets an offer instead, and nothing from Calendar or Drive is read
 * out until they ask.
 */
export function gmailConnected(email: string, fact: string | null, onCall = false, extras: ConnectExtras = {}, again = false, s?: Session): FollowUp {
  const said = again
    ? `they signed in again to add access, so say in a few words it's all set, now connected as ${email}, written exactly like that, without asking whether it's the right account. skip the privacy line, they've heard it.`
    : `say it's connected as ${email}, written exactly like that, so they can catch a wrong account. skip the privacy line, they've heard it.`;
  const confirm = again ? reconnectedLine(email) : connectedAsLine(email);
  const allowed = extras.granted
    ? ` they also allowed their ${extras.granted}: say so in a few words, and that you can look into any of it whenever they want, reading out nothing from it.`
    : "";
  // Off a call, connecting can settle the last open slot, and lib/gmail/oauth.ts then graduates: this text ends setup.
  const ends = Boolean(s && !onCall && !s.graduated && canGraduate({ ...s, gmail: { ...s.gmail, status: "connected" } }, "all_slots").ok);
  const checks = ends ? { mustAsk: true, mustNotSay: PASSIVE } : {};
  if (onCall) {
    return {
      note: `google sign-in just finished and gmail is connected. ${said}${allowed} you're on a call with them and the call speaks the rest, so say only that, in one short bubble, and nothing about their inbox.`,
      fallback: [confirm],
      mustSay: [email],
      facts: [email],
    };
  }
  if (!fact) {
    return {
      note: `google sign-in just finished and gmail is connected, but the first look at their inbox didn't go through. ${said}${allowed} then, in your own words, ${ends && s?.helpNeed ? `setup is done, so start on "${s.helpNeed.value}": offer, as one question, the first thing you'd look for in their inbox for it, or a fresh link if nothing can be read` : "offer to look for anything they need or draft an email for them"}. say nothing about what's in it yet.`,
      fallback: [confirm, valueUnavailableLine()],
      mustSay: [email],
      facts: [email],
      ...checks,
    };
  }
  // A need the finding doesn't answer on its own ("my inbox", "gmail", or none saved) hears no counts at connect. With
  // no session the need is unknown, so the finding goes out as before.
  const general = s !== undefined && !factFitsNeed(s.helpNeed?.category ?? null);
  const need = s?.helpNeed ? ` they want help with "${s.helpNeed.value}": tie what you can do to that.` : "";
  const onward = ends
    ? " that settles setup, so this reply starts on their need: the offer that ends it is the first step toward it and your one question, so ask nothing else, and never sign off in a way that leaves the next move to them."
    : s
      ? ` keep setup moving lightly if anything's missing (${nextAsk(s)}), or leave it for a later turn if that would crowd this one.`
      : "";
  // The agent words this moment itself, but the first connect for a specific need is where they see what it found,
  // so the reply has to carry the fact's own names or count; one that doesn't sends the template. A reconnect may
  // leave it out.
  const found = general
    ? " then, in its own bubble, make your one question an offer to go through their email for them, reading out nothing sign-in saw (no counts, names, events or folders) until they ask."
    : again
      ? ` if it helps, you may mention what the server noticed at sign-in, keeping every number and name as is: "${fact}". it's optional; don't recite it.`
      : ` then, in its own bubble and your own words, share what the server found at sign-in, keeping every number and name as is and adding nothing: "${fact}". this is the moment they see you're useful, so never leave it out.`;
  const anchors = again || general ? [] : (extras.anchors ?? []);
  return {
    note: `google sign-in just finished and gmail is connected. ${said}${allowed} in your own words, fresh (never a line you've sent before), let them know you can now go through their inbox or draft an email for them.${need}${found}${onward} one or two short bubbles.`,
    fallback: [confirm, general ? connectedOfferLine(extras.granted) : valueMomentLine(again ? withoutOffer(fact) : fact)],
    mustSay: [email],
    ...(anchors.length > 0 && { mustSayOne: anchors }),
    facts: general ? [email] : [email, fact],
    ...checks,
  };
}

export function oauthDenied(): FollowUp {
  return {
    note: "they cancelled google sign-in, so gmail is skipped for now. no pressure: say it's fine, you'll just be less useful without it, and move on without asking for gmail again.",
    fallback: [oauthDeniedLine()],
  };
}

export function partialGrant(): FollowUp {
  return {
    note: "they signed in with google but left gmail access unticked, so nothing connected. say so plainly and offer a fresh link, sent only once they say yes.",
    fallback: [partialGrantLine()],
    mustSay: ["link"],
  };
}

export function oauthError(): FollowUp {
  return {
    note: "google sign-in didn't go through (an admin block or a failed exchange), so nothing connected. say so, mention a personal @gmail.com account usually works best, and ask whether they want a fresh link, sent only once they say yes.",
    fallback: [oauthErrorLine()],
    // The offer is the next step, so a reply that only explains the failure dead-ends.
    mustSay: ["@gmail.com", "link"],
  };
}

export function inboxUnreadable(): FollowUp {
  return {
    note: "they finished google sign-in, but gmail wouldn't answer when you went to read their inbox, so nothing connected and nothing was kept. it's not their account's fault. say so in one line and offer a fresh link to try again, sent only once they say yes.",
    fallback: [inboxUnreadableLine()],
    mustSay: ["link"],
  };
}

export function stillConnected(email: string): FollowUp {
  return {
    note: `they didn't finish the new google sign-in, so nothing changed: gmail is still connected as ${email}. say that in one short line, with the address written exactly like that, and ask for nothing.`,
    fallback: [stillConnectedLine(email)],
    mustSay: [email],
    facts: [email],
  };
}

export function staleLink(): FollowUp {
  return {
    note: "they just opened a gmail link that was already used or has expired. tell them in one line and offer a new link, sent only once they say yes.",
    fallback: [staleLinkLine()],
    mustSay: ["link"],
  };
}
