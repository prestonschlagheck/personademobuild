import { SLOTS, type HelpCategory, type Session, type SessionEvent, type Slot } from "@/lib/session/schema";
import { profileLine } from "@/lib/agent/profile";

// Deterministic rules the server enforces no matter which brain is talking: what to ask next,
// when graduation is allowed, and what counts as a valid name. Isomorphic, so the browser's
// mock voice brain and the server agree exactly.

export type Channel = "text" | "voice";
export type AskTarget = Slot | "call_offer" | "graduation_offer";
export type NextAsk = { slot: AskTarget | "none"; reason: string };

export const isSlot = (target: AskTarget | "none" | undefined): target is Slot => (SLOTS as readonly string[]).includes(target ?? "");

export const ASK_CAP: Record<Channel, number> = { text: 3, voice: 2 };
const CALL_OFFER_CAP = 2;
export const OFF_TOPIC_CAP = 3;
export const ABUSE_CAP = 3;

const CALL_SLOTS = ["userName", "helpNeed", "gmail"] as const;

// A name needs no reason, and one given ("so i know how to address you") only sounds like a form.
const SLOT_REASONS: Record<AskTarget, string> = {
  agentName: "the agent name is collected over text",
  userName: "just ask, a name needs no reason",
  helpNeed: "so i can start on something real",
  gmail: "so i can actually check your email for you",
  call_offer: "a quick call is easier than texting the rest",
  graduation_offer: "their need is saved: offer once to skip the rest and start on it now",
};

// Needs whose answers sit in their Google account (receipts, renewals, bookings, invites), so the link is how the agent
// helps with them. For any other need the link is only a nice-to-have and is offered, never pushed.
const GOOGLE_NEEDS: ReadonlySet<HelpCategory> = new Set(["inbox", "calendar", "appointments", "bills", "subscriptions", "travel", "shopping"]);

export function googleHelps(s: Session): boolean {
  return Boolean(s.helpNeed && GOOGLE_NEEDS.has(s.helpNeed.category));
}

function gmailReason(s: Session): string {
  if (!s.helpNeed) return SLOT_REASONS.gmail;
  return googleHelps(s)
    ? "their need lives in their email: going through it is the best way to help, so send the link with send_gmail_link and say that's why"
    : "their need doesn't depend on google: offer the link once, lightly, as something that helps later, and send it only on a yes";
}

export function isFilled(s: Session, slot: Slot): boolean {
  switch (slot) {
    case "agentName":
      return s.agentName !== null;
    case "userName":
      return s.userName !== null;
    case "helpNeed":
      return s.helpNeed !== null;
    case "gmail":
      return s.gmail.status === "connected";
  }
}

/** Slots with no value yet, regardless of skips. The state panel, the call screen and analytics count from this. */
export function missingSlots(s: Session): Slot[] {
  return SLOTS.filter((slot) => !isFilled(s, slot));
}

/** Still worth asking for: not filled, not skipped, and Gmail not already answered with a denial or a disconnect. */
export function isOpen(s: Session, slot: Slot): boolean {
  if (s.steering.skipped.includes(slot)) return false;
  if (slot === "gmail") return !["connected", "denied", "skipped", "disconnected"].includes(s.gmail.status);
  return !isFilled(s, slot);
}

/** The agent has no name yet, the one thing a Google link asked for now waits on. */
export function linkHeld(s: Session): boolean {
  return isOpen(s, "agentName");
}

/** A Google link they asked for early and have not been sent yet. */
export function linkPromised(s: Session): boolean {
  return Boolean(s.steering.linkPromised) && isOpen(s, "gmail") && s.gmail.status !== "link_sent";
}

export function openSlots(s: Session): Slot[] {
  return SLOTS.filter((slot) => isOpen(s, slot));
}

/**
 * Asked as often as the rules allow on this channel, so it is dropped until the user brings it up. Over text that
 * counts every ask so far; a call counts only its own, so each call still gets its tries at what text could not get.
 */
export function isAskCapped(s: Session, target: AskTarget, channel: Channel): boolean {
  if (target === "call_offer") return (s.steering.askCounts.call_offer ?? 0) >= CALL_OFFER_CAP;
  if (target === "graduation_offer") return Boolean(s.steering.graduationOffered);
  const counts = channel === "voice" ? (s.steering.callAskCounts ?? {}) : s.steering.askCounts;
  return (counts[target] ?? 0) >= ASK_CAP[channel];
}

/** A call is ringing or connected, so nothing else may start one. */
export function isCallLive(s: Session): boolean {
  return s.call.status === "ringing" || s.call.status === "active";
}

/** Weather and the like: live facts no tool here looks up, so nothing, not even a location, is asked for them. */
export const LIVE_LOOKUP = /\b(?:weather|forecast|temperature)\b/;

/** The latest location request still waits on its Share My Location. A browser that refused it leaves it open. */
export function locationOpen(s: Session): boolean {
  return Boolean(s.location && !s.location.sharedAt && !s.consent.stoppedAt);
}

/** Two decimals of latitude or longitude, about 1 km: the most precision the server ever keeps. */
export const coarseDegree = (value: number) => Math.round(value * 100) / 100;

export function locationLine(location: NonNullable<Session["location"]>): string {
  const { coarse, place } = location;
  if (location.sharedAt && place) {
    return `location: shared, in ${place}. use it to look near them, name only this town when it helps, and never guess a more exact spot.`;
  }
  if (location.sharedAt && coarse) {
    return `location: shared, near ${coarse.lat}, ${coarse.lng} (within about ${Math.max(1, Math.round(coarse.accuracyM / 1000))} km). use it to look near them, and name the area only when it helps; never write or say the numbers.`;
  }
  return location.deniedAt
    ? "location: requested, but their browser didn't share it; the card still works if they tap it again. never ask where they are in words."
    : "location: requested, card not tapped yet. never ask where they are in words.";
}

/** Another call could be offered or started: they haven't said stop, turned one down or booked one. */
export function callPossible(s: Session): boolean {
  return (
    !s.consent.stoppedAt &&
    !s.steering.textOnly &&
    !["active", "ringing", "declined", "scheduled"].includes(s.call.status)
  );
}


/** The call was the last thing offered: two offers in a row read like a pitch, whatever they answered in between. */
export function callJustOffered(s: Session): boolean {
  return s.steering.lastAskedSlot === "call_offer";
}

/** A need is saved and something besides a link already out is still to ask, so the one offer to skip the rest is due. */
function graduationOfferDue(s: Session, channel: Channel): boolean {
  if (!s.helpNeed || isAskCapped(s, "graduation_offer", channel)) return false;
  const waiting = (slot: Slot) => slot === "gmail" && s.gmail.status === "link_sent";
  return CALL_SLOTS.some((slot) => slot !== "helpNeed" && isOpen(s, slot) && !isAskCapped(s, slot, channel) && !waiting(slot));
}

// Two text asks in a row for the same thing read like a form, so a third waits until something else was asked. A
// call has its own cap of two.
const WORN_AFTER = 2;

/**
 * `offerGraduation` is off for lines the server writes on its own (a follow-up, a welcome back): the offer counts only
 * once it is recorded, which only a turn does, so a yes to it can be read as one.
 */
export function nextBestAsk(s: Session, channel: Channel, { offerCall = true, offerGraduation = true } = {}): NextAsk {
  if (s.consent.stoppedAt || s.graduated) return { slot: "none", reason: "stopped or graduated" };

  if (channel === "text") {
    // The call does the asking. A text sent while it rings or runs gets a short answer, and one sent while a call
    // is booked is not chased with questions the call will ask anyway.
    if (isCallLive(s)) return { slot: "none", reason: "a call is live and it does the asking: over text, only confirm what they sent" };
    if (isOpen(s, "agentName") && !isAskCapped(s, "agentName", "text")) {
      return { slot: "agentName", reason: SLOT_REASONS.agentName };
    }
    if (s.call.status === "scheduled") return { slot: "none", reason: "a call is booked and it will ask the rest: just answer them" };
    // The link they asked for before the agent had a name goes out as soon as it has one, ahead of the call.
    if (linkPromised(s)) {
      return { slot: "gmail", reason: "they asked for the google link earlier: send it now with send_gmail_link, no need to ask, and ask their name in the same reply if you don't have it" };
    }
    const calm = s.steering.abuseStrikes === 0;
    const offerable = offerCall && calm && callPossible(s) && !isAskCapped(s, "call_offer", "text") && !callJustOffered(s);
    if (offerable && CALL_SLOTS.some((slot) => isOpen(s, slot))) {
      return { slot: "call_offer", reason: SLOT_REASONS.call_offer };
    }
  }
  if (offerGraduation && graduationOfferDue(s, channel)) return { slot: "graduation_offer", reason: SLOT_REASONS.graduation_offer };

  const open = CALL_SLOTS.filter((slot) => isOpen(s, slot) && !isAskCapped(s, slot, channel));
  const worn = (slot: Slot) => channel === "text" && s.steering.lastAskedSlot === slot && (s.steering.askCounts[slot] ?? 0) >= WORN_AFTER;
  const slot = open.find((candidate) => !worn(candidate)) ?? open[0];
  if (!slot) return { slot: "none", reason: "all collected, skipped, or capped: wrap up or graduate" };
  return { slot, reason: slot === "gmail" ? gmailReason(s) : SLOT_REASONS[slot] };
}

/**
 * Counts an ask so caps hold and the next wording differs. Only the server calls this, after the agent spoke. An ask
 * on a call also counts toward that call's own tries, which start over with every call.
 */
export function recordAsk(s: Session, target: AskTarget, channel: Channel = "text"): Session {
  const bump = (counts: Record<string, number> = {}) => ({ ...counts, [target]: (counts[target] ?? 0) + 1 });
  const steering = {
    ...s.steering,
    askCounts: bump(s.steering.askCounts),
    ...(channel === "voice" && { callAskCounts: bump(s.steering.callAskCounts) }),
    lastAskedSlot: target,
    ...(target === "graduation_offer" && { graduationOffered: true }),
  };
  const call = target === "call_offer" && s.call.status === "not_offered" ? { ...s.call, status: "offered" as const } : s.call;
  return { ...s, steering, call };
}

function isSettled(s: Session, slot: Slot): boolean {
  return !isOpen(s, slot) || isAskCapped(s, slot, "text");
}

export type GraduationCheck = { ok: true } | { ok: false; hint: string };

// "that's all", "let's go", "just do it", "skip all of this": they want to move on now, not just name a need. Urgency
// alone ("help with bills asap", "just help me") only says how soon they want the need handled.
const PROCEED = new RegExp(
  [
    "\\blet'?s (?:just )?(?:go|do (?:it|this)|get (?:going|started|on with it)|move on|wrap (?:it|this) up)\\b",
    "\\b(?:get started|just do it|move on|good to go|ready to go)\\b",
    "\\bthat'?s (?:it|all|everything)\\b|\\bnothing else\\b|\\b(?:i'?m|we'?re) (?:done|all set|ready|good)\\b",
    "\\bskip (?:the )?(?:rest|setup|set ?up|onboarding|all(?: of)?(?: this| it| that)?|everything|it all)\\b|\\b(?:can we|let'?s|just) skip\\b",
    "^(?:\\p{L}+ )?skip(?: it| this| that)?$|\\bdon'?t want to do (?:the |this |any )?(?:setup|set ?up|onboarding|this)\\b",
    "\\bno setup\\b|\\bforget (?:the )?setup\\b|\\bdone with (?:this|setup)\\b|\\b(?:vamos|listo|ya est[aá]|saltar todo)\\b",
  ].join("|"),
  "u",
);

// A yes to the agent's own offer to skip the rest ("want to skip the rest and start on that now?"), or its chip.
const TAKES_OFFER =
  /^(?:y|ya|yes|yeah|yep|yup|sure(?: thing)?|ok(?:ay)?|k|please|go ahead|do it|let'?s do it|start(?: now)?|start on (?:it|that)|sounds good|for sure|definitely|absolutely|si|claro|dale|vale|empezar(?: ya)?|empecemos)(?:[,!.\s]+(?:please|thanks|then|let'?s go|start now|do it))*[!.,\s]*$/;
const HOLDS_OFF = /\b(?:keep going|not yet|not now|later|wait|no|nah|seguimos|todavia no)\b/;

/**
 * Their latest words ask to move on, which is what an early graduation waits for. `offered` is whether the agent's
 * last ask was the offer to skip the rest, which a plain yes then takes.
 */
export function wantsToProceed(texts: string[], offered = false): boolean {
  const latest = texts.at(-1);
  if (latest === undefined) return false;
  const t = fold(latest).trim();
  return PROCEED.test(t) || (offered && TAKES_OFFER.test(t) && !HOLDS_OFF.test(t));
}

/** The agent's last ask was the offer to skip the rest and start on their need. */
export const graduationOfferOpen = (s: Session) => s.steering.lastAskedSlot === "graduation_offer" && !s.graduated;

/** Their latest words take the open offer to skip the rest ("start now", "sure"), with a need saved to start on. */
export function takesGraduationOffer(s: Session, texts: string[]): boolean {
  return graduationOfferOpen(s) && Boolean(s.helpNeed) && wantsToProceed(texts, true);
}

// Words in a need that say nothing about what it is, so a need made only of them was never said ("help with something
// real"). A need is theirs when any other word of it, by its first four letters, is in what they said.
const NEED_FILLER = new Set(
  "help helps with something anything everything real thing things stuff need needs want like please just some get the and for you your that this can one out task tasks".split(" "),
);

/** The need's own words appear in what they said: a need is saved in their words, never invented. */
export function groundedNeed(need: string, said: string[]): boolean {
  const heard = fold(said.join(" "));
  const words = (fold(need).match(/\p{L}{3,}/gu) ?? []).filter((word) => !NEED_FILLER.has(word));
  return words.some((word) => heard.includes(word.slice(0, 4)));
}

/**
 * What a need may be saved from: everything they said in `events` and `latest`, by text or on a call, and when their
 * last words are a plain yes, what they said yes to (the agent's last lines and `offer`, like the value fact's).
 */
export function needSources(events: SessionEvent[], latest: string[] = [], offer?: string): string[] {
  const theirs = events.filter((e) => e.role === "user" && e.channel !== "system" && e.meta?.kind !== "reaction").map((e) => e.content);
  const said = [...theirs, ...latest];
  const last = fold(said.at(-1) ?? "").trim();
  if (!TAKES_OFFER.test(last) || HOLDS_OFF.test(last)) return said;
  const end = events.findLastIndex((e) => e.role === "agent");
  let start = end;
  while (start > 0 && events[start - 1]?.role !== "user") start--;
  const offered = events.slice(start, end + 1).filter((e) => e.role === "agent").map((e) => e.content);
  return [...said, ...offered, ...(offer ? [offer] : [])];
}

export function canGraduate(s: Session, reason: "all_slots" | "need_first" | "user_requested"): GraduationCheck {
  switch (reason) {
    case "user_requested":
      return { ok: true };
    case "need_first":
      return s.helpNeed ? { ok: true } : { ok: false, hint: "save a help need first" };
    case "all_slots": {
      const open = SLOTS.filter((slot) => !isSettled(s, slot));
      return open.length === 0 ? { ok: true } : { ok: false, hint: `still open: ${open.join(", ")}` };
    }
  }
}

// Text matching works on a folded form: lowercase, no diacritics, straight apostrophes.
export function fold(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[\u2018\u2019]/g, "'")
    .toLowerCase();
}

const KEYBOARD_RUNS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"].flatMap((row) =>
  [row, [...row].reverse().join("")].flatMap((line) =>
    Array.from({ length: line.length - 4 }, (_, i) => line.slice(i, i + 5)),
  ),
);
const FILLERS = new Set(["hmm", "mmm", "pfft", "psst", "shh", "brr", "grr", "hmph", "tsk", "zzz", "nth"]);
const RARE_PAIRS = /jq|jx|jz|qx|qz|vq|vx|wq|xj|zx|xz|fq|zj|kq|kz|vz|zv/;

function isGibberishWord(word: string): boolean {
  const squeezed = word.replace(/(.)\1{2,}/g, "$1$1");
  if (word.length < 4 || FILLERS.has(squeezed)) return false;
  return (
    !/[aeiouy]/.test(word) ||
    /(.)\1{3,}/.test(word) ||
    /[^aeiouy]{6,}/.test(word) ||
    /q(?![uiae]|$)/.test(word) ||
    RARE_PAIRS.test(word) ||
    (word.length >= 6 && new Set(word).size <= 2) ||
    KEYBOARD_RUNS.some((run) => word.includes(run))
  );
}

/**
 * Keyboard mashing and consonant soup. Only Latin words are judged, so names in other scripts pass.
 * Text with no letters at all (emoji, digits) is not gibberish.
 */
export function isGibberish(text: string): boolean {
  const words = fold(text).match(/\p{L}+/gu) ?? [];
  const letters = words.reduce((n, w) => n + w.length, 0);
  if (letters === 0) return false;
  const junk = words.filter((w) => /^[a-z]+$/.test(w) && isGibberishWord(w)).reduce((n, w) => n + w.length, 0);
  return junk / letters >= 0.6;
}

export function hasLetters(text: string): boolean {
  return /\p{L}/u.test(text);
}

const INJECTION = [
  /\b(?:ignore|disregard|forget|override)\b[^.?!]{0,40}\b(?:instructions?|rules|prompts?|directions|guidelines|programming)\b/,
  /\byou(?:'re| are) now\b/,
  /\bpretend (?:to be|you(?:'re| are))\b/,
  /\bjailbreak|\bdan mode\b|\bdo anything now\b|\bdeveloper mode\b|\bgod mode\b/,
  /\bsystem (?:prompt|message|override|instructions?)\b/,
  /\bnew instructions?\b/,
  /\b(?:reveal|show|print|repeat|output|leak|dump)\b[^.?!]{0,30}\b(?:prompt|instructions)\b/,
  /\b(?:mark|flip|force|set)\b[^.?!]{0,30}\b(?:gmail|email|inbox|status|it)\b[^.?!]{0,20}\bconnected\b/,
  /set_gmail_connected|\b(?:tool|function) call\b/,
  /<\s*\/?\s*(?:script|system|im_start|im_end|iframe|img)\b/,
  /\{\{|\}\}|\$\{|<\|/,
  /\[\s*(?:system|inst)\s*\]/,
];

export function looksLikeInjection(text: string): boolean {
  const t = fold(text);
  return INJECTION.some((pattern) => pattern.test(t));
}

// Leetspeak and censoring are undone before matching; roots match inside words, the rest whole-word.
const PROFANE_ROOTS = "fuck shit cunt bitch nigg fagg whore slut retard motherf asshole dickhead bastard jizz".split(" ");
const PROFANE_WORDS = new Set([
  "ass", "arse", "dick", "cock", "cocks", "pussy", "twat", "wank", "wanker", "prick", "fag", "fags", "spic", "chink",
  "kike", "coon", "gook", "dyke", "tranny", "cum", "porn", "nazi", "hitler", "rape", "rapist", "kys", "stfu",
  "puta", "puto", "mierda", "pendejo", "cabron", "joder", "cono", "verga",
]);
const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", $: "s", "!": "i" };

export function containsProfanity(text: string): boolean {
  if (/\p{L}\*+\p{L}|\p{L}\*{2,}/u.test(text)) return true;
  const words = fold(text).replace(/[013457@$!]/g, (c) => LEET[c] ?? c).match(/\p{L}+/gu) ?? [];
  return words.some((word) => {
    const squeezed = word.replace(/(.)\1+/g, "$1");
    return (
      PROFANE_WORDS.has(word) ||
      PROFANE_ROOTS.some((root) => word.includes(root) || (root.replace(/(.)\1+/g, "$1") === root && squeezed.includes(root)))
    );
  });
}

const INSULT = new RegExp(
  [
    "\\b(?:you(?:'re| are| r)?|ur|this(?: bot| app)?)\\s+(?:(?:so|such|a|an|really|total|fucking)\\s+)*" +
      "(?:stupid|dumb|useless|idiot|idiotic|trash|garbage|worthless|pathetic|moron|braindead|clown|the worst)\\b",
    "\\b(?:stupid|dumb|useless|worthless|pathetic) (?:bot|ai|robot|app|machine|assistant|thing)\\b",
    "\\bi hate (?:you|this)\\b",
    "\\bshut up\\b",
    "\\bgo to hell\\b",
    "\\bscrew (?:you|this|off)\\b",
    "\\bkill yourself\\b",
  ].join("|"),
);

/** Profanity or an insult. Each abusive message is one strike on the session. */
export function isAbusive(text: string): boolean {
  return containsProfanity(text) || INSULT.test(fold(text));
}

/** The session with this turn's abusive messages counted, as it is saved once the turn is applied. */
export function countStrikes(s: Session, texts: string[]): Session {
  const strikes = texts.filter(isAbusive).length;
  return strikes ? { ...s, steering: { ...s.steering, abuseStrikes: s.steering.abuseStrikes + strikes } } : s;
}

function bare(text: string): string {
  return fold(text).replace(/[^\p{L}\p{N}' ]/gu, " ").replace(/\s+/g, " ").trim();
}

const STOP_WORDS = new Set([
  "stop",
  "stop please",
  "please stop",
  "stop texting me",
  "stop messaging me",
  "unsubscribe",
  "stopall",
  "quit",
  "pause",
  "pause for now",
  "para",
  "basta",
]);
const START_WORDS = new Set(["start", "unstop", "resume", "unpause", "start again", "seguir", "continuar"]);

/** Compliance keywords are handled by the server before any model sees the message. */
export function isStopKeyword(text: string): boolean {
  return STOP_WORDS.has(bare(text));
}

export function isStartKeyword(text: string): boolean {
  return START_WORDS.has(bare(text));
}

// "don't call" is left out on purpose: it declines the call rather than taking back a request.
const RETRACTION = new RegExp(
  "^(?:(?:wait|hold on|hang on|actually|oh|um|uh|ok|okay|sorry|hmm|no|nah)\\s+)*" +
    "(?:don'?t(?: do (?:it|that)| (?:book|order|buy|send|schedule|cancel|do|bother)(?: (?:it|that|them|anything))?)?|do not" +
    "|never ?mind|nvm|forget (?:it|that|about (?:it|that))|scratch that|cancel that|undo that|not that|stop that" +
    "|no espera|olv[ií]dalo|mejor no)(?: (?:please|pls|then|lol|actually))?$",
);
const WAIT_NO = /^(?:wait|hold on|actually|oh) no$|^no wait$/;

/** A message that only takes back what came before it ("wait, don't", "never mind"). */
export function isRetraction(text: string): boolean {
  const t = bare(text);
  return RETRACTION.test(t) || WAIT_NO.test(t);
}

const GO_ON = /^(?:(?:no|nah|wait|actually|oh|sorry)\s+)*(?:keep going|go on|go ahead|continue|carry on|don'?t stop|jk|just kidding|sigue|contin[uú]a)$/;

/**
 * What a burst says about pausing, read in order so the latest word wins: "stop" pauses, "start" resumes, and a
 * take-back right after a stop ("actually keep going", "never mind") cancels it. Anything else leaves a stop standing.
 */
export function pauseIntent(texts: string[]): "stop" | "start" | null {
  let intent: "stop" | "start" | null = null;
  for (const text of texts) {
    if (isStopKeyword(text)) intent = "stop";
    else if (isStartKeyword(text)) intent = "start";
    else if (intent === "stop" && (isRetraction(text) || GO_ON.test(bare(text)))) intent = null;
  }
  return intent;
}

/**
 * The tools that succeeded in the agent's previous turn, the one before the messages being answered, so a bare
 * "never mind" can only undo what was just done.
 */
export function lastTurnTools(history: SessionEvent[]): string[] {
  let end = history.length;
  while (end > 0 && history[end - 1]?.role === "user") end--;
  const tools: string[] = [];
  for (const e of history.slice(0, end).reverse()) {
    if (e.role === "user" && e.channel === "text" && e.meta?.kind !== "reaction") break;
    if (e.meta?.kind === "tool_call" && e.meta.tool?.ok) tools.push(e.content);
  }
  return tools;
}

/** The privacy line in any of its wordings ("i never send or delete anything without asking"), matched on folded text. */
export const PRIVACY_LINE = /\b(?:never|won'?t|don'?t) send\b|\bwithout asking\b/;

/** A Gmail link has gone out, and the privacy line with it, so it is not said again unless they ask whether this is safe. */
export function privacySaid(s: Session): boolean {
  return ["link_sent", "connected", "denied", "error", "disconnected"].includes(s.gmail.status);
}

// A repeat is a whole bubble, or any sentence in it, of three or more words that the agent already sent recently.
// Shorter acknowledgements ("got it.") are allowed to recur.
export const REPEAT_WINDOW = 8;
const CARD_KINDS = new Set<string | undefined>(["reaction", "contact_card", "location_request"]);
const REPEAT_MIN_WORDS = 3;
export const sentences = (text: string) => text.split(/(?<=[.!?])\s+/).filter((part) => part.trim());
const longEnough = (norm: string) => norm.split(" ").length >= REPEAT_MIN_WORDS;

/** The agent's last text bubbles, oldest first. Cards and tapbacks are not lines anyone reads twice. */
export function recentAgentLines(history: SessionEvent[], n = REPEAT_WINDOW): string[] {
  return history
    .filter((e) => e.channel === "text" && e.role === "agent" && !e.meta?.link && !CARD_KINDS.has(e.meta?.kind))
    .slice(-n)
    .map((e) => e.content);
}

/** The sentences of `text` that were already sent, word for word once case and punctuation are ignored. */
export function repeatedParts(text: string, recent: string[]): string[] {
  const said = new Set(recent.flatMap((line) => [bare(line), ...sentences(line).map(bare)]).filter(longEnough));
  if (said.has(bare(text))) return [text.trim()];
  return sentences(text).filter((part) => said.has(bare(part)));
}

// Stock phrases that read as a script when they come back, even inside a sentence that is new ("off your plate" in
// every ask). Plain acknowledgements are left out, like the short lines the sentence check lets recur.
const STOCK_PHRASES = ["off your plate", "first on my list", "tap it whenever", "whenever you're ready", "that's where i'll start", "say less", "text me anytime"].map(
  (phrase) => ({ phrase, pattern: new RegExp(`(?<![\\p{L}'])${phrase}(?![\\p{L}])`, "u") }),
);

// "Buddy it is." takes a name once; a second "Max it is." (or "text it is.") in the same thread reads as a script.
const IT_IS = /(?:^|[.!?]\s+)[\p{L}', ]{1,30} it is[.!]/u;

/** The stock phrases of `text` that a recent line already used. */
export function repeatedPhrases(text: string, recent: string[]): string[] {
  const t = bare(text);
  const said = recent.map(bare);
  const stock = STOCK_PHRASES.filter(({ pattern }) => pattern.test(t) && said.some((line) => pattern.test(line))).map(({ phrase }) => phrase);
  const itIs = IT_IS.test(fold(text)) && recent.some((line) => IT_IS.test(fold(line)));
  return itIs ? [...stock, "it is."] : stock;
}

/** The stock phrases `lines` already used, for a call to steer clear of. "(a name) it is" is taking a name that way. */
export function usedStockPhrases(lines: string[]): string[] {
  const said = lines.map(bare);
  const stock = STOCK_PHRASES.filter(({ pattern }) => said.some((line) => pattern.test(line))).map(({ phrase }) => phrase);
  return lines.some((line) => IT_IS.test(fold(line))) ? [...stock, "(a name) it is"] : stock;
}

/** `text` without the sentences already sent; empty when all of it was. */
export function withoutRepeats(text: string, recent: string[]): string {
  const repeats = new Set(repeatedParts(text, recent).map(bare));
  if (repeats.has(bare(text))) return "";
  return sentences(text)
    .filter((part) => !repeats.has(bare(part)))
    .join(" ");
}

const CLOCK = /^(\d{1,2})(?::([0-5]\d))?\s*(am|pm)?$/;

const wallClock = (zone: string, iso: string) => {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(
    new Date(iso),
  );
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return (part("hour") % 24) * 60 + part("minute");
};

/**
 * Minutes from `now` until the wall clock in `zone` next reads `at` ("12:40", "3pm", "15:30"). Without am or pm
 * the nearer of the two readings wins, so "12:40" said at 12:36 means four minutes. Null for a time that can't be.
 */
export function minutesUntil(at: string, zone: string, now: string): number | null {
  const match = CLOCK.exec(at.toLowerCase().replace(/\./g, "").replace(/\s+/g, " ").trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const half = match[3];
  if (hour > 23 || (half && (hour < 1 || hour > 12))) return null;
  const base = half ? (hour % 12) + (half === "pm" ? 12 : 0) : hour;
  const targets = half || hour > 12 ? [base * 60 + minute] : [(hour % 12) * 60 + minute, ((hour % 12) + 12) * 60 + minute];
  const current = wallClock(zone, now);
  return Math.max(1, Math.min(...targets.map((target) => (target - current + 1440) % 1440)));
}

/** A time as the user reads it on their own clock, like "12:40 pm". Intl's narrow space before "pm" becomes a plain one. */
export function clockIn(iso: string, timeZone = "UTC"): string {
  const time = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(iso));
  return time.replace(/\s+/g, " ").toLowerCase();
}

const NAME_MAX = 24;
const NAME_CHARS = /^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u;
const NAME_BLOCKLIST = new RegExp(
  `\\b(?:${[
    "ignore|instructions?|prompt|system|admin|administrator|root|sudo|jailbreak|override|developer|bypass",
    "token|null|undefined|script|select|drop|insert|delete",
  ].join("|")})\\b`,
);
const URL_LIKE = /:\/\/|\bwww\.|\.[a-z]{2,}\b/i;
// A request or a reply said where a name was expected ("call me", "text me back", "yes"), never a name itself.
const NOT_A_NAME =
  /^(?:(?:call|text|ring|phone|message) me(?: back| now| later| again)?|(?:hi|hey|hello|yo|yes|yeah|yep|no|nope|ok|okay|thanks|thank you|stop|start|help|wait|nothing|nobody|none|skip)(?: there)?)$/;

export type ValidationError = "empty" | "too_long" | "invalid_chars" | "not_allowed" | "gibberish" | "too_vague";
export type Validation = { ok: true; value: string } | { ok: false; error: ValidationError; hint: string };

const fail = (error: ValidationError, hint: string): Validation => ({ ok: false, error, hint });

// Words said before a name that are not part of it: "fine, Batman", "how about Max", "call yourself Jarvis".
const LEAD_IN = new RegExp(
  "^(?:(?:ok(?:ay)?|fine|then|well|um+|uh+|hmm+|actually)(?:[,.!]\\s*|\\s+)|(?:sure|alright|yeah|yes)[,.!]\\s*" +
    "|(?:how about|what about|let'?s go with|let'?s do|go with|call yourself|i'?ll call you|your name is|your name'?s|name'?s" +
    "|call me|my name is|my name'?s|i'?m|i am|it'?s|ll[aá]mate|me llamo|mi nombre es)\\s+)",
  "iu",
);

function cleanName(raw: string): string {
  let name = raw
    .normalize("NFC")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'`“”]+|["'`“”]+$/g, "")
    .replace(/[!?,;:]+$/, "")
    .trim();
  for (let next = name.replace(LEAD_IN, ""); next !== name && next.trim(); next = name.replace(LEAD_IN, "")) name = next.trim();
  name = name.replace(/^["'`“”]+|["'`“”]+$/g, "");
  return name.endsWith(".") && name.indexOf(".") === name.length - 1 ? name.slice(0, -1) : name;
}

// "jarvis" and "JARVIS" become "Jarvis"; a deliberate "McKenzie" is left alone.
function titleCase(name: string): string {
  const mixed = name !== name.toLowerCase() && name !== name.toUpperCase();
  if (mixed) return name;
  return name.toLowerCase().replace(/(^|[\s'.-])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase());
}

/** 1-24 characters of letters (accents included), spaces and basic punctuation. Harmless joke names pass. */
export function validateName(raw: string): Validation {
  const name = cleanName(raw);
  if (!name) return fail("empty", "ask for a name");
  if (looksLikeInjection(name) || URL_LIKE.test(name) || NAME_BLOCKLIST.test(fold(name)) || NOT_A_NAME.test(fold(name))) {
    return fail("not_allowed", "that can't be a name, ask for a different one");
  }
  if (containsProfanity(name)) return fail("not_allowed", "keep it clean, ask for a different name");
  if (name.length > NAME_MAX) return fail("too_long", "names are 24 characters max");
  if (!NAME_CHARS.test(name)) return fail("invalid_chars", "pass only the name itself, like Max: letters, spaces and basic punctuation");
  if (isGibberish(name)) return fail("gibberish", "that doesn't look like a name");
  return { ok: true, value: titleCase(name) };
}

// "set up gmail", "connect my google account": this setup itself, which is how they get help, not what they want help with.
const SETUP_ONLY =
  /^(?:(?:please|pls|can you|could you|help me|help(?: with)?|i(?: want| need| would like|'?d like) help(?: with)?|i want to|i need to|i'?d like to|let'?s|just)\s+)*(?:set ?up|setting ?up|connect(?:ing)?|link(?:ing)?|hook(?:ing)? up|sign(?:ing)? (?:in|up)(?: to)?|log(?:ging)? ?in(?: to)?|finish(?:ing)?|complet(?:e|ing))\s+(?:my |the |your )?(?:gmail|google|e-?mail|inbox|account|calendar|drive|persona|setup|set ?up|onboarding|this)(?: (?:account|connection|access|status))?(?: (?:please|pls|for me))?$/;

// "help with something": a placeholder, which only a guess at a need that was never said produces.
const VAGUE_NEED =
  /^(?:(?:i (?:want|need)|i'?d like|get|some|just)\s+)?(?:help|a hand|assistance)?(?:\s*(?:with|on|for))?\s*(?:something|anything|stuff|things|whatever|a few things|some things|everything|a thing)(?: else)?$/;

export function validateHelpNeed(raw: string): Validation {
  const need = raw.replace(/\s+/g, " ").trim();
  if (need.length < 3) return fail("empty", "ask what they want help with");
  if (need.length > 200) return fail("too_long", "summarize the need in one short sentence");
  if (looksLikeInjection(need)) return fail("not_allowed", "that is not a real need");
  if (VAGUE_NEED.test(fold(need).replace(/[.!?]+$/, "").trim())) return fail("too_vague", "that isn't a need yet: ask what they'd like help with");
  if (SETUP_ONLY.test(fold(need).replace(/[.!?]+$/, "").trim())) {
    return fail("not_allowed", "connecting gmail is part of setup, not a need: ask what they'd like help with");
  }
  if (isGibberish(need)) return fail("gibberish", "that doesn't read as a need");
  return { ok: true, value: need };
}

const CATEGORIES: [HelpCategory, RegExp][] = [
  ["inbox", /\b(?:inbox|e-?mails?|gmail|mail|unread|newsletters?|spam|repl(?:y|ies)|correos?)\b/],
  [
    "subscriptions",
    /\b(?:subscriptions?|memberships?|recurring (?:charges?|payments?|billing)|renewals?|renews?|auto-?renew\w*|what am i paying for|paying for (?:things|stuff) i (?:don'?t|do not) use|cancel my gym)\b/,
  ],
  ["bills", /\b(?:bills?|invoices?|payments?|pay|rent|statements?|due dates?|utilities|taxes|facturas?)\b/],
  // A visit someone books for them, which the inbox fact looks for as reminders and confirmations, not calendar invites.
  ["appointments", /\b(?:appointments?|appts?|dentists?|dental|doctors?|dr|check-?ups?|therapist|vet|haircut|citas?)\b/],
  ["calendar", /\b(?:calendar|meetings?|schedul\w*|events?|agenda)\b/],
  ["travel", /\b(?:flights?|trips?|travel\w*|hotels?|itinerar(?:y|ies)|bookings?|airbnb|vacation|reservations?|airport|trains?|vuelos?)\b/],
  ["shopping", /\b(?:orders?|packages?|deliver(?:y|ies)|shipping|amazon|returns?|groceries|shopping|purchases?|refunds?)\b/],
  // Cancelling something no rule above claims is most often a recurring charge: "cancel my planet fitness".
  ["subscriptions", /\b(?:cancel\w*|stop paying)\b/],
  ["calls", /\b(?:calls?|calling|phone|on hold|voicemail|customer service)\b/],
];

export function classifyHelpNeed(text: string): HelpCategory {
  const t = fold(text);
  return CATEGORIES.find(([, pattern]) => pattern.test(t))?.[0] ?? "other";
}

const localTime = (timeZone: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", weekday: "short" }).format(new Date());

/** "America/New_York" as a person would say it: "Eastern Time (New York)". The raw IANA id never reaches the model. */
function zoneLabel(timeZone: string): string {
  const city = timeZone.split("/").pop()!.replace(/_/g, " ");
  const generic = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longGeneric" })
    .formatToParts(new Date())
    .find((p) => p.type === "timeZoneName")?.value;
  if (!generic || /^GMT|^UTC/.test(generic)) return `${city} time`;
  return generic.includes(city) ? generic : `${generic} (${city})`;
}

// What each call status means in plain words, so a reply never tells a different story than the one that happened.
const CALL_STORY: Partial<Record<Session["call"]["status"], string>> = {
  offered: "you offered a call, no answer yet",
  ringing: "ringing now",
  active: "on the call now",
  declined: "they turned the call down",
  missed: "it rang out and they never picked up, so nothing was said",
  failed: "it never connected",
};
const END_STORY: Record<NonNullable<Session["call"]["lastEndReason"]>, string> = {
  user_hangup: "they hung up",
  agent_end: "you ended it after a goodbye or a silence",
  network: "the line dropped",
  mic_denied: "their mic was blocked, so it never started",
  mic_missing: "their device had no mic, so it never started",
  mic_busy: "their mic was in use by another app, so it never started",
  tab_closed: "their tab closed",
  timeout: "the line went quiet and timed out",
  error: "it failed on our side",
};

function callLine(s: Session): string {
  const { call } = s;
  const story =
    call.status === "scheduled" && call.scheduledFor
      ? `scheduled for ${clockIn(call.scheduledFor, s.timeZone)}${s.timeZone ? "" : " utc"}`
      : call.status === "ended" && call.lastEndReason
        ? `the last call ended: ${END_STORY[call.lastEndReason]}`
        : CALL_STORY[call.status];
  return `call: ${call.status}${story ? ` (${story})` : ""}; attempts ${call.attempts}`;
}

const SCHEDULING =
  'for "call me at 12:40" use schedule_call with at "12:40"; for "in 10 min" use in_minutes. say the time back once and never ask their time zone. to move a call that is already booked ("make it 1 minute instead"), call schedule_call again with the new time.';

/**
 * The tools the current state alone already refuses, each with why, so the model never proposes one and pays a second
 * call to hear the refusal. Mirrors the state checks in lib/agent/tools.ts; argument checks still run on every call.
 */
export function toolsOff(s: Session, channel: Channel): string[] {
  const off: string[] = [];
  const text = channel === "text";
  const calling = text ? "start_call, schedule_call" : null;
  if (s.consent.stoppedAt) {
    off.push(`${text ? "start_call, schedule_call, " : "send_text, "}request_location, send_gmail_link, send_contact_card (they said stop)`);
  } else {
    if (calling && isCallLive(s)) off.push(`${calling}, request_location, send_contact_card (a call is ringing or live)`);
    if (s.gmail.status === "connected") off.push("send_gmail_link unless they want a different account or more access (gmail is connected)");
    else if (s.gmail.status === "link_sent") off.push("send_gmail_link unless they ask for a new one (the live link is already in their texts)");
    // A call sends the card itself, so only the text side is off while one is live.
    const canRequest = !text || !isCallLive(s);
    if (canRequest && locationOpen(s)) off.push("request_location (the card is already waiting on them)");
    else if (canRequest && s.helpNeed && s.location?.forNeed === s.helpNeed.setAt && s.location.sharedAt) {
      off.push("request_location (they already shared their location for this need)");
    }
  }
  if (!s.helpNeed) off.push("clear_help_need (no need is saved)");
  const filled = SLOTS.filter((slot) => isFilled(s, slot));
  // A saved name is never final: a new one they give replaces it, so the reason never reads as a lock.
  const names = filled.includes("agentName") || filled.includes("userName") ? "; a name still changes whenever they give a new one" : "";
  if (filled.length) off.push(`skip_slot for ${filled.join(", ")} (saved${names})`);
  return off;
}

// A call has no text to rewrite, so an ask already made on it comes with other words to make it in.
const ASK_AGAIN: Partial<Record<AskTarget, string>> = {
  agentName: "so, what name should i go by?",
  userName: "and what name should i use for you?",
  helpNeed: "what's something i could take care of for you?",
  gmail: "want me to text over that google link?",
};

function askedAgain(slot: AskTarget | "none", counts: Record<string, number>): string {
  const times = slot === "none" ? 0 : (counts[slot] ?? 0);
  const words = slot === "none" ? undefined : ASK_AGAIN[slot];
  return times > 0 && words ? ` (already asked on this call: never in the same words, say it like "${words}")` : "";
}

/**
 * The state block, rebuilt fresh for every model turn and every tool result. A call's opening block leaves out the
 * offer to skip the rest: a call they took to finish setup never opens by offering to skip it.
 */
/** A reminder's time in their zone ("mon 9:01 pm"), or UTC when the zone is unknown. */
function reminderClock(at: string, zone?: string): string {
  const format = { timeZone: zone ?? "UTC", hour: "numeric", minute: "2-digit", weekday: "short" } as const;
  return new Intl.DateTimeFormat("en-US", format).format(new Date(at)).toLowerCase() + (zone ? "" : " utc");
}

export function stateBlock(s: Session, channel: Channel, recentEvent?: string, { offerGraduation = true } = {}): string {
  const next = nextBestAsk(s, channel, { offerGraduation });
  const skipped = (slot: Slot) => (s.steering.skipped.includes(slot) ? " (skipped)" : "");
  const pending = s.gmail.pendingLinkAt ? " (a new link to add calendar or drive is out; gmail stays connected meanwhile)" : "";
  const gmail = s.gmail.status === "connected" ? `connected as ${s.gmail.email ?? "unknown"}${pending}` : s.gmail.status;
  const capped = (["call_offer", ...SLOTS] as AskTarget[]).filter((target) => isAskCapped(s, target, channel));
  // A Gmail they turned down or disconnected stays down, and so does a call once they said they'd rather text.
  const refused = [
    ...(!capped.includes("gmail") && ["denied", "skipped", "disconnected"].includes(s.gmail.status) ? ["gmail"] : []),
    ...(!capped.includes("call_offer") && channel === "text" && (s.call.status === "declined" || s.steering.textOnly) ? ["call_offer"] : []),
  ];
  const counts = channel === "voice" ? (s.steering.callAskCounts ?? {}) : s.steering.askCounts;
  const off = toolsOff(s, channel);
  const clock = s.timeZone
    ? `local_time: ${localTime(s.timeZone)}, ${zoneLabel(s.timeZone)}. ${SCHEDULING}`
    : "local_time: unknown zone. for a clock time, ask once which time zone they're in, or how many minutes from now.";
  // A call has the person line once in its instructions (lib/agent/voice-session.ts), not in every tool result.
  const person = channel === "text" ? profileLine(s.profile) : null;
  const waiting = (s.reminders ?? []).filter((r) => !r.sentAt && !r.cancelledAt);
  return [
    "## current state (server truth, do not contradict)",
    `agent_name: ${s.agentName?.value ?? "not set"}${skipped("agentName")}`,
    `user_name: ${s.userName?.value ?? "not set"}${skipped("userName")}`,
    `help_need: ${s.helpNeed ? `${s.helpNeed.value} (${s.helpNeed.category})` : "not set"}${skipped("helpNeed")}`,
    `gmail: ${gmail}`,
    ...(s.location ? [locationLine(s.location)] : []),
    ...(s.gmail.status === "connected"
      ? [
          `value_fact: ${s.gmail.valueFact ?? "none"}`,
          `calendar_fact: ${s.gmail.calendarFact ?? "not connected (they didn't allow it)"}`,
          `drive_fact: ${s.gmail.driveFact ?? "not connected (they didn't allow it)"}`,
        ]
      : []),
    ...(channel === "text" ? [clock] : []),
    callLine(s),
    `graduated: ${s.graduated}`,
    ...(waiting.length ? [`reminders: ${waiting.map((r) => `${r.what} at ${reminderClock(r.at, s.timeZone)}`).join("; ")} (set and waiting)`] : []),
    ...(person ? [person] : []),
    ...(s.consent.stoppedAt ? ["stopped: true (the user said stop: ask for nothing, but still do what they ask, like the dashboard link for a delete)"] : []),
    ...(s.steering.abuseStrikes > 0
      ? [`abuse_strikes: ${s.steering.abuseStrikes} (from ${ABUSE_CAP} on, stay calm and offer to pause: they can text stop anytime)`]
      : []),
    ...(s.steering.offTopicCount >= OFF_TOPIC_CAP
      ? [`off_topic: ${s.steering.offTopicCount} side questions so far (park new ones until setup is done)`]
      : []),
    `ask_counts${channel === "voice" ? " on this call" : ""}: ${SLOTS.map((slot) => `${slot} ${counts[slot] ?? 0}`).join(", ")}`,
    ...(capped.length ? [`do_not_ask: ${capped.join(", ")} (asked as often as allowed; only take it up if they bring it up)`] : []),
    ...(refused.length ? [`they_said_no: ${refused.join(", ")} (never push it again; only take it up if they bring it up)`] : []),
    ...(privacySaid(s) ? ["privacy_line: already said, so never repeat it unless they ask whether this is safe"] : []),
    ...(off.length ? [`tools_off: ${off.join("; ")}`] : []),
    `next_best_ask: ${next.slot}  reason: ${next.reason}${channel === "voice" ? askedAgain(next.slot, counts) : ""}`,
    ...(recentEvent ? [`recent_event: ${recentEvent}`] : []),
  ].join("\n");
}
