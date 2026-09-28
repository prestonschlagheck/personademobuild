import type { CallEndReason, EventKind, EventMeta, HelpCategory, NewEvent, ReactionType, Session, SessionEvent, Slot } from "@/lib/session/schema";
import {
  callPossible,
  canGraduate,
  clockIn,
  isAskCapped,
  nextBestAsk,
  openSlots,
  repeatedParts,
  repeatedPhrases,
  type AskTarget,
  type Channel,
} from "@/lib/agent/policy";

// Every line the server writes into the thread, in Persona's product voice: lowercase, short,
// one ask with a reason. Brains reuse the asks so wording stays consistent across runtimes. With the
// live model, the lines for server events are only its fallback (lib/agent/follow-ups.ts).

/** `replyTo` threads this one bubble under a message of the turn's burst, by position, over the reply's own target. */
export type Line = { text: string; kind: EventKind; quickReplies?: string[]; meta?: EventMeta; replyTo?: number };
export type Lang = "en" | "es";

export const TERMS_URL = "yourpersona.com/legal";

/** A text bubble after the opening stays within this many characters. */
const BUBBLE_MAX = 200;

// Persona's own opening, word for word as its line sends it every time: the hello, the capabilities with the consent
// in one bubble, then the first ask. Everything after the naming is lowercase, as theirs is, apart from the names.
export const OPENING: Record<Lang, { intro: string; terms: string; ask: string }> = {
  en: {
    intro: "Hey! I'm your new personal assistant",
    terms: [
      "You can text me or call me anytime and I can help with:",
      "📞 calling places on your behalf",
      "💻 browsing the web",
      "🛍️ shopping for you",
      "📩 managing your email and calendar",
      "🚗 finding DoorDash or Uber options",
      "",
      `By continuing to text or use Persona, you agree to our Terms of Service and SMS Terms, and acknowledge our Privacy Policy: ${TERMS_URL}`,
    ].join("\n"),
    ask: "What do you want to call me?",
  },
  es: {
    intro: "¡Hola! Soy tu nuevo asistente personal",
    terms: [
      "Puedes escribirme o llamarme cuando quieras y te ayudo con:",
      "📞 llamar a lugares por ti",
      "💻 buscar en la web",
      "🛍️ hacer compras por ti",
      "📩 gestionar tu correo y tu calendario",
      "🚗 encontrar opciones de DoorDash o Uber",
      "",
      `Al seguir escribiendo o usar Persona, aceptas nuestros Términos del Servicio y Términos de SMS, y reconoces nuestra Política de Privacidad: ${TERMS_URL}`,
    ].join("\n"),
    ask: "¿Cómo quieres llamarme?",
  },
};

/** The two bubbles that open every conversation, ahead of whatever the first turn answers. */
// Persona's terms and the cards are long and fixed, so a model reads what they are instead of their words.
const TERMS = new Set(Object.values(OPENING).map((opening) => opening.terms));

/** A thread row as a model reads it, for the text agent and the call alike. */
export function eventText(e: Pick<SessionEvent, "content" | "meta">): string {
  if (e.meta?.link) return e.meta.link.preview === "dashboard" ? "(the dashboard link card)" : "(the gmail link card)";
  if (e.meta?.kind === "location_request") return "(your location request card)";
  if (e.meta?.kind === "location_shared") return "(they tapped share my location)";
  return TERMS.has(e.content) ? "(persona's terms)" : e.content;
}

export function openingLines(lang: Lang = "en"): Line[] {
  const { intro, terms } = OPENING[lang];
  return [
    { text: intro, kind: "greeting" },
    { text: terms, kind: "greeting" },
  ];
}

export const CHIPS: Record<Lang, { call: string[]; gmail: string[]; graduation: string[] }> = {
  en: { call: ["call me", "not now", "later"], gmail: ["send the link", "skip gmail"], graduation: ["start now", "keep going"] },
  es: { call: ["llámame", "ahora no", "más tarde"], gmail: ["mándame el enlace", "sin gmail"], graduation: ["empezar ya", "seguimos"] },
};
const CALLBACK_CHIPS = ["call me back", "text is fine"];
/** The reply the recovery lines offer for asking for a fresh Gmail link. */
export const NEW_LINK_REQUEST = "send a new link";

const ASKS: Record<Lang, Record<Channel, Record<AskTarget, string[]>>> = {
  en: {
    text: {
      agentName: ["what do you want to call me?", "still need a name for me. what feels right?", "what should i go by? anything works, even a joke."],
      userName: [
        "what should i call you?",
        "and what should i call you? first name or nickname, both work.",
        "what name should i use for you? nicknames count.",
      ],
      helpNeed: [
        "what's one thing you'd love handled? that's where i'll start.",
        "what could i take care of for you this week?",
        "if i could handle one thing for you, what would it be?",
      ],
      gmail: [
        "want to connect gmail? then i can actually go through your inbox for you.",
        "want the google link? once gmail's connected i can dig through your inbox for you.",
        "should i send the google link? you can disconnect anytime.",
      ],
      call_offer: [
        "a quick call is usually easier than a long setup over text. want me to ring you now?",
        "still happy to hop on a quick call if that's easier. want me to ring you?",
      ],
      graduation_offer: ["want to skip the rest and start on that now?"],
    },
    voice: {
      agentName: ["what do you want to call me?", "what name should i go by?"],
      userName: ["what should i call you?", "what name should i use for you?"],
      helpNeed: ["what's one thing you'd want handled?", "what's something i could take care of for you this week?"],
      gmail: ["want me to text you a link to connect gmail?", "should i text you that gmail link? it's how i check your inbox for you."],
      call_offer: ["want me to call you back later?"],
      graduation_offer: ["want to skip the rest and get started on that now?"],
    },
  },
  es: {
    text: {
      agentName: ["¿cómo quieres llamarme?", "todavía necesito un nombre. ¿cuál te gusta?", "¿cómo me llamo? cualquier nombre vale, hasta uno de broma."],
      userName: ["¿y cómo te llamo a ti?", "¿qué nombre uso para ti? un apodo también vale."],
      helpNeed: ["¿con qué te puedo ayudar primero?", "¿qué te quito de encima esta semana?"],
      gmail: [
        "¿conectamos gmail? así puedo revisar tu correo por ti.",
        "¿te mando el enlace de google? nunca envío ni borro nada sin preguntarte.",
      ],
      call_offer: [
        "una llamada rápida es más fácil que escribir todo esto. ¿te llamo ahora?",
        "si prefieres, te llamo un momento. ¿te llamo?",
      ],
      graduation_offer: ["¿quieres saltarte lo demás y empezar con eso ya?"],
    },
    voice: {
      agentName: ["¿cómo quieres llamarme?", "¿qué nombre me pongo?"],
      userName: ["¿cómo te llamo?", "¿y cómo te llamas?"],
      helpNeed: ["¿con qué te puedo ayudar primero?", "¿qué te quito de encima esta semana?"],
      gmail: ["¿te mando un enlace para conectar gmail? nunca envío ni borro nada sin preguntarte.", "¿te mando el enlace de gmail? así reviso tu correo por ti."],
      call_offer: ["¿te llamo más tarde?"],
      graduation_offer: ["¿quieres saltarte lo demás y empezar con eso ya?"],
    },
  },
};

/** The nth wording of an ask. Counts rotate the variants, so the same ask is never sent twice in a row. */
export function askText(target: AskTarget, count: number, channel: Channel = "text", lang: Lang = "en"): string {
  const variants = ASKS[lang][channel][target];
  return variants[count % variants.length] ?? variants[0] ?? "";
}

/**
 * The first of `options` the thread does not already have, one that reuses no recent stock phrase when there is one,
 * or null when every one was sent.
 */
export function freshLine(options: string[], recent: string[]): string | null {
  const unsaid = options.filter((text) => repeatedParts(text, recent).length === 0);
  return unsaid.find((text) => repeatedPhrases(text, recent).length === 0) ?? unsaid[0] ?? null;
}

/**
 * The next wording of an ask that the thread does not already have, including asks a server line just made, or
 * null when every wording was sent and the turn should move on instead of asking again.
 */
export function freshAsk(target: AskTarget, count: number, lang: Lang, recent: string[]): string | null {
  return freshLine(
    ASKS[lang].text[target].map((_, i) => askText(target, count + i, "text", lang)),
    recent,
  );
}

/** What the agent texts as the phone starts ringing, worded fresh each time it calls. */
export const RINGING: Record<Lang, string[]> = {
  en: ["ringing you now.", "calling you now.", "trying you again now."],
  es: ["te llamo ahora.", "te estoy llamando.", "te vuelvo a llamar."],
};

/** The characters a regular expression treats as syntax, for escaping a literal into one. */
export const REGEX_SYNTAX = /[\\^$.*+?()[\]{}|/]/g;

/**
 * `text` with each saved name spelled as it was saved, so the lowercase product voice still writes "Buddy it is.",
 * as Persona does, right above a "Buddy" contact card. A one-letter name is left alone, since it would respell "i".
 */
export function withNames(text: string, names: (string | undefined)[] = []): string {
  return names.reduce<string>((out, name) => {
    if (!name || name.length < 2) return out;
    return out.replace(new RegExp(`(?<![\\p{L}])${name.replace(REGEX_SYNTAX, "\\$&")}(?![\\p{L}])`, "giu"), name);
  }, text);
}

const titled = (words: string) => words.replace(/\b\p{Ll}/gu, (letter) => letter.toUpperCase());

// Proper nouns the product voice writes in lowercase, with their standard spelling. "may" and "march" are left
// out since they are usually a verb, and Drive, Docs and Calendar only count after "google".
const PROPER_NOUNS: [RegExp, (match: string) => string][] = [
  [/\bpersona\b/g, () => "Persona"],
  [/\bai\b/g, () => "AI"],
  [/\bgoogle( (calendar|drive|docs|sheets|meet))?\b/g, titled],
  [/\bgmail\b/g, () => "Gmail"],
  [/\bopenai\b/g, () => "OpenAI"],
  [/\bimessage\b/g, () => "iMessage"],
  [/\biphone\b/g, () => "iPhone"],
  [/\b(mon|tues|wednes|thurs|fri|satur|sun)day\b/g, titled],
  [/\b(january|february|april|june|july|august|september|october|november|december)\b/g, titled],
];

/**
 * `text` in standard English casing: a capital at the start of each sentence, "I", proper nouns, and the saved
 * names spelled as they were saved; the words stay as written. Persona's thread opens this way and turns
 * lowercase after naming, and the call transcript beside the phone reads this way throughout, since speech
 * has no case of its own. Models and the mock's own lines drift to all lowercase, so the case is set here.
 */
export function properCase(text: string, names: (string | undefined)[] = []): string {
  const cased = PROPER_NOUNS.reduce((out, [pattern, spelled]) => out.replace(pattern, spelled), text)
    .replace(/(^|[.!?]\s+)([^\p{L}\s]*)(\p{Ll})/gu, (_, lead: string, mark: string, letter: string) => lead + mark + letter.toUpperCase())
    .replace(/\bi(?=\b|['\u2019])/g, "I");
  return withNames(cased, names);
}

export const lower = (name: string) => name.toLowerCase();

/**
 * A later call after one that connected. Rings that were missed or declined never connected, so a call is a
 * callback only when the first connected call predates it (the accept records it once, on the first call).
 */
export function isCallback(s: Session): boolean {
  const { firstCallAt: given } = s.consent;
  const firstHere = given !== undefined && s.call.startedAt !== undefined && given >= s.call.startedAt;
  return s.call.attempts > 1 && !firstHere;
}

/** The hello that opens every call, by name, with "again" on callbacks. The reason and the ask follow it. */
export function callGreeting(s: Session): string {
  const name = s.agentName?.value ?? "Persona";
  if (s.lang === "es") return isCallback(s) ? `hola, soy ${name} otra vez.` : `hola, soy ${name}.`;
  return isCallback(s) ? `hey, it's ${name} again.` : `hey, it's ${name}.`;
}

/** Ends a call transcript line that the hangup interrupted, so the text after the call can tell. */
export const CUT_OFF = "(cut off)";

/** How a call ended beyond its reason, read from the call's own events, so the text after it never guesses. */
export type CallEndDetail = {
  /** Why the agent hung up, from its end_call. */
  agentReason?: string;
  /** Their last line on the call was cut off mid-sentence. */
  userCutOff?: boolean;
  /** That cut-off line was starting to list what they need help with. */
  cutOffListing?: boolean;
  /** The agent was mid-sentence when the line went. */
  agentCutOff?: boolean;
  /** On the call they asked to be texted what the agent finds, or the rest. */
  askedToText?: boolean;
  /** The agent hung up because they asked to be called right back (end_call's call_back). */
  callBack?: boolean;
  /** The call ran into the length cap. */
  lengthCap?: boolean;
  /** The call ended while it was still ringing or connecting. */
  neverConnected?: boolean;
  /** When the agent last spoke on the call, so the text after it knows whether a fact that just landed was heard. */
  lastAgentAt?: string;
  /** A question they asked on the call got no agent line before their next line or the end. */
  unanswered?: boolean;
  /** The agent's latest texts in the thread, which the text after this call never repeats word for word. */
  sent?: string[];
};

/** Pronouns flipped so the user's own words can be echoed back ("cancel my gym" becomes "cancel your gym"). */
export function echo(text: string): string {
  const swaps: Record<string, string> = {
    my: "your",
    me: "you",
    i: "you",
    "i'm": "you're",
    im: "you're",
    mine: "yours",
    myself: "yourself",
    mis: "tus",
    mi: "tu",
  };
  return lower(text)
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\b(?:i'm|im|myself|mine|my|me|mis|mi|i)\b/g, (word) => swaps[word] ?? word)
    .replace(/[.!?\s]+$/, "");
}

const NEED_LABELS: Partial<Record<HelpCategory, string>> = {
  inbox: "your inbox",
  bills: "bills",
  subscriptions: "subscriptions",
  travel: "travel",
  calendar: "your calendar",
  appointments: "your appointments",
  shopping: "orders",
  calls: "calls",
};

function needLabel(s: Session): string | null {
  if (!s.helpNeed) return null;
  const label = NEED_LABELS[s.helpNeed.category];
  if (label) return label;
  const words = echo(s.helpNeed.value).split(" ");
  return words.length > 6 ? `${words.slice(0, 6).join(" ")}...` : words.join(" ");
}

function listJoin(parts: string[]): string {
  if (parts.length <= 2) return parts.join(" and ");
  return `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
}

export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  if (minutes === 60) return "an hour";
  if (minutes >= 1440) return "a day";
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

/** The next thing to ask over text once a call is off the table for now. */
function nextTextAsk(s: Session, lang: Lang = "en"): string | null {
  const next = nextBestAsk(s, "text", { offerCall: false, offerGraduation: false });
  if (next.slot === "none") return null;
  if (next.slot === "gmail" && s.gmail.status === "link_sent") {
    return lang === "es" ? "el enlace de gmail sigue ahí arriba cuando quieras." : "the gmail link's still up there whenever you're ready.";
  }
  return askText(next.slot, s.steering.askCounts[next.slot] ?? 0, "text", lang);
}

/** The need ask in its next wording, for a line that comes back to it. */
const needAsk = (s: Session) => askText("helpNeed", s.steering.askCounts.helpNeed ?? 0);

type Stage = "done" | "oauth_open" | "nothing" | "has_name" | "partial";

function stageOf(s: Session): Stage {
  if (s.graduated || s.gmail.valueFact || canGraduate(s, "all_slots").ok) return "done";
  if (s.gmail.status === "link_sent") return "oauth_open";
  if (!s.userName && !s.helpNeed && !s.steering.skipped.includes("userName")) return "nothing";
  if (s.userName && !s.helpNeed && !s.steering.skipped.includes("helpNeed")) return "has_name";
  return "partial";
}

const present = (parts: (string | false | null)[]) => parts.filter((part): part is string => Boolean(part));
const sentence = (parts: string[]) => (parts.length ? `${listJoin(parts)}.` : "");

/** Where things stand, said as a person would: "i'm Jarvis and you're Sam." */
function soFar(s: Session): string {
  return sentence(present([s.agentName && `i'm ${s.agentName.value}`, s.userName && `you're ${s.userName.value}`]));
}

/** Setup finished, in words: "you're all set, Sam. i'm Jarvis and your gmail's connected. first on my list: bills." */
function setUp(s: Session): string {
  const need = needLabel(s);
  return present([
    s.userName ? `you're all set, ${s.userName.value}.` : "you're all set.",
    sentence(present([s.agentName && `i'm ${s.agentName.value}`, s.gmail.status === "connected" && "your gmail's connected"])),
    need && `first on my list: ${need}.`,
  ]).join(" ");
}

/** The question that ends setup by starting on what they want, never a sign-off that leaves the next move to them. */
export function startAsk(s: Session): string {
  return s.helpNeed ? "want me to start there now?" : "what should i start on first?";
}

export function recapLine(s: Session): Line {
  return { text: `${setUp(s)} ${startAsk(s)}`, kind: "recap" };
}

/** A lead that ends on their name when there is one ("the line dropped, Sam."), in place of reading their name back. */
const toThem = (lead: string, s: Session) => (s.userName ? `${lead.replace(/[.!?]$/, "")}, ${s.userName.value}.` : lead);

function graduatedBefore(s: Session): boolean {
  return Boolean(s.graduatedAt && s.call.startedAt && s.graduatedAt < s.call.startedAt);
}

const then = (ask: string | null) => (ask ? ` ${ask}` : "");

/** Ends nobody chose: the line went on its own. */
export const DROPPED = new Set<CallEndReason>(["network", "tab_closed", "timeout", "error"]);

/** The first words of every text after a call: what actually happened, never a guess. */
function endLead(reason: CallEndReason, detail: CallEndDetail): string {
  if (detail.neverConnected) return reason === "user_hangup" ? "you hung up before it connected." : "the call couldn't connect.";
  switch (reason) {
    case "user_hangup":
      return detail.userCutOff ? "you hung up mid-sentence." : "looks like you hung up.";
    case "agent_end":
      // Hanging up on purpose after a goodbye is not a dropped call, so it never says "cut off".
      return detail.agentReason === "silence" ? "it went quiet, so i hung up." : "picking up here.";
    case "network":
      return "the line dropped.";
    case "tab_closed":
      return "the call ended when your tab closed.";
    case "timeout":
      return detail.lengthCap ? "we hit the time limit on the call." : "lost the connection on your end.";
    case "error":
      return "the call dropped on my end.";
    case "mic_denied":
      return "looks like your mic's blocked.";
    case "mic_missing":
      return "looks like there's no mic on this device.";
    case "mic_busy":
      return "your mic's busy with another app.";
  }
}

// The text after a call that followed graduation: a warm sign-off, then one light pointer to whatever setup left open,
// or a plain closer when nothing is. The first pair not already in the thread goes out.
const SIGN_OFFS = ["good talking.", "nice catching you."];
const CLOSERS = ["text me whenever you need something.", "i'm a text away if anything comes up."];
const OPEN_POINTERS: Record<Slot, string[]> = {
  agentName: ["you can still pick a name for me whenever.", "a name for me can wait until you've got one."],
  userName: ["tell me what to call you whenever you like.", "your name can wait until you feel like sharing it."],
  helpNeed: ["tell me what you'd like a hand with whenever.", "whenever something comes up, i'm ready to take it on."],
  gmail: ["gmail's there to connect whenever you want.", "gmail can wait until you're ready to connect it."],
};
const LINK_POINTERS = ["the gmail link's in the thread whenever you want it.", "that gmail link's still up there if you want it."];

// A link already out is pointed to however often it was offered; anything else only while it may still be asked for.
function pointers(s: Session): string[] {
  if (s.gmail.status === "link_sent") return LINK_POINTERS;
  const slot = openSlots(s).find((open) => !isAskCapped(s, open, "text"));
  return slot ? OPEN_POINTERS[slot] : CLOSERS;
}

function signOffAfterCall(s: Session, reason: CallEndReason, detail: CallEndDetail): string {
  const sent = new Set((detail.sent ?? []).map((text) => text.trim().toLowerCase()));
  const leads = DROPPED.has(reason) ? [endLead(reason, detail)] : SIGN_OFFS;
  const options = leads.flatMap((lead) => pointers(s).map((end) => `${lead} ${end}`));
  return options.find((option) => !sent.has(option)) ?? `${leads[0]} ${CLOSERS[0]}`;
}

const CUT_OFF_ASK = "what were you about to say?";
const cutOffAsk = (detail: CallEndDetail) => (detail.cutOffListing ? "what's first on that list?" : CUT_OFF_ASK);

export function recoveryAfterCall(s: Session, reason: CallEndReason, detail: CallEndDetail = {}): Line {
  if (reason === "mic_denied") {
    return {
      text: "looks like your mic's blocked. we can do this over text instead, or tap the lock icon to allow it.",
      kind: "mic_help",
      quickReplies: ["call me", "text is fine"],
    };
  }
  // No mic means no call, so it carries on over text with the next ask. A busy one can be freed for a callback.
  if (reason === "mic_missing") {
    return { text: `looks like there's no mic on this device. we can do this over text instead.${then(nextTextAsk(s))}`, kind: "mic_help" };
  }
  if (reason === "mic_busy") {
    return {
      text: "your mic's busy with another app. close it and i'll call back, or we can keep going here.",
      kind: "mic_help",
      quickReplies: ["call me", "text is fine"],
    };
  }
  if (detail.agentReason === "abuse") {
    return { text: "i ended the call there. happy to pick this up over text whenever you're ready.", kind: "offer_pause" };
  }

  const lead = endLead(reason, detail);
  const retry = callPossible(s) ? CALLBACK_CHIPS : undefined;
  if (reason === "error" || detail.neverConnected) {
    return retry
      ? { text: `${lead} want me to try again, or keep going here?`, kind: "recovery", quickReplies: retry }
      : { text: `${lead} let's keep going here.${then(nextTextAsk(s))}`, kind: "recovery" };
  }

  const cut = detail.userCutOff;
  switch (stageOf(s)) {
    case "done":
      // A call after graduation already had its recap, so it gets a sign-off instead of a second one.
      if (graduatedBefore(s)) return { text: signOffAfterCall(s, reason, detail), kind: "continue_text" };
      if (reason === "agent_end" && detail.agentReason !== "silence") return recapLine(s);
      return { text: `${lead} ${setUp(s)} ${cut ? cutOffAsk(detail) : startAsk(s)}`, kind: "recap" };
    case "oauth_open":
      if (cut) return { text: `${lead} ${cutOffAsk(detail)} the gmail link above still works too.`, kind: "recovery" };
      if (s.userName && !s.helpNeed && !s.steering.skipped.includes("helpNeed")) {
        return { text: `${toThem(lead, s)} ${needAsk(s)} the gmail link above still works too.`, kind: "recovery" };
      }
      return { text: `${lead} the gmail link above still works. tap it whenever and i'll take it from there.`, kind: "recovery" };
    case "nothing":
      if (cut) return { text: `${lead} ${cutOffAsk(detail)}`, kind: "recovery" };
      if (!retry) return { text: `${lead} let's finish here over text.${then(nextTextAsk(s))}`, kind: "recovery" };
      return { text: `${lead} want me to call back, or just finish here over text?`, kind: "recovery", quickReplies: retry };
    case "has_name":
      return { text: `${toThem(lead, s)} ${cut ? cutOffAsk(detail) : needAsk(s)}`, kind: "recovery" };
    case "partial": {
      const kept = reason === "agent_end" ? lead : `${lead} i kept everything.`;
      return { text: `${kept}${then(cut ? cutOffAsk(detail) : nextTextAsk(s))}`, kind: "recovery" };
    }
  }
}

/**
 * What they asked for on the call ("text me when you find it"), sent as asked: the fact the server computed when they
 * never heard it, a recap when they already did, or plainly why there is nothing to send yet. Never a promise of an
 * update that is not coming.
 */
export function onRequestLine(s: Session, factHeard = false): Line {
  const { gmail } = s;
  if (gmail.status === "connected") {
    if (!gmail.valueFact) return valueUnavailableLine();
    return factHeard ? recapLine(s) : { text: `here's what i found: ${gmail.valueFact}`, kind: "recap" };
  }
  const cannot = "you asked me to text you what i find. i can't look until gmail's connected";
  if (gmail.status === "link_sent") return { text: `${cannot}, and the link above still works.`, kind: "recovery" };
  if (openSlots(s).includes("gmail")) return { text: `${cannot}. want the link?`, kind: "recovery", quickReplies: CHIPS.en.gmail };
  if (s.graduated || canGraduate(s, "all_slots").ok) return recapLine(s);
  const known = soFar(s);
  const ask = nextTextAsk(s);
  return { text: known ? `here's where we left off: ${known}${then(ask)}` : (ask ?? "text me whenever you need something."), kind: "recovery" };
}

/** Rang out on the ring screen. A callback they booked says so, with the time in their own zone. */
function rangOut(s: Session): string {
  const { scheduledFor } = s.call;
  if (!scheduledFor) return "tried you, but it rang out.";
  return s.timeZone ? `called at ${clockIn(scheduledFor, s.timeZone)} like you asked, but it rang out.` : "called back like you asked, but it rang out.";
}

export function missedCallLine(s: Session): Line {
  if (!callPossible({ ...s, call: { ...s.call, status: "missed" } })) {
    return { text: `${rangOut(s)} no worries, let's keep going here.${then(nextTextAsk(s))}`, kind: "missed_call" };
  }
  return {
    text: `${rangOut(s)} no worries, want me to try again or keep going here?`,
    kind: "missed_call",
    quickReplies: ["call me", "keep going here"],
  };
}

export function declinedLine(s: Session): Line {
  return { text: `saw you declined, all good. we can do it here.${then(nextTextAsk(s))}`, kind: "continue_text" };
}

/** The call hung up so it could ring them again at once, as they asked. */
export function callingBackLine(): Line {
  return { text: "calling you right back.", kind: "call_scheduled" };
}

export function remindLaterLine(minutes: number): Line {
  return { text: `no problem, i'll call you back in ${formatMinutes(minutes)}. we can keep going here meanwhile.`, kind: "call_scheduled" };
}

const MISSING_PHRASES: Record<Exclude<Slot, "agentName">, string> = {
  userName: "your name",
  helpNeed: "to hear what you'd like help with",
  gmail: "to get your gmail connected",
};

/**
 * Back after a while: only the next thing that's missing, never the whole list of what's left. The last ask came right
 * before they left, so the ask here takes another of its wordings, one `recent` (the agent's last lines) doesn't have.
 */
export function welcomeBackLine(s: Session, recent: string[] = []): Line {
  if (s.gmail.status === "link_sent") {
    return { text: "welcome back. the gmail link's still up there whenever you're ready.", kind: "welcome_back" };
  }
  const next = nextBestAsk(s, "text", { offerGraduation: false });
  const missing = openSlots(s).find((slot) => slot !== "agentName");
  if (next.slot === "call_offer" && missing) {
    return {
      text: `welcome back. i still need ${MISSING_PHRASES[missing]}, and a quick call's the fastest way. want me to ring you?`,
      kind: "welcome_back",
      quickReplies: ["call me", "text is fine"],
    };
  }
  if (next.slot === "gmail") {
    return { text: "welcome back. want the gmail link? it's how i'll check your inbox for you.", kind: "welcome_back", quickReplies: CHIPS.en.gmail };
  }
  const count = (next.slot === "none" ? 0 : (s.steering.askCounts[next.slot] ?? 0)) + 1;
  const ask = next.slot === "none" ? null : (freshAsk(next.slot, count, "en", recent) ?? askText(next.slot, count));
  return { text: ask ? `welcome back. ${ask}` : "welcome back. i'm here whenever you need me.", kind: "welcome_back" };
}

export function gmailLinkLine(url: string): Line {
  return {
    text: url,
    kind: "gmail_link",
    meta: { link: { url, title: "Connect your Google account", subtitle: "Nothing is sent without your OK. You can disconnect anytime.", preview: "google" } },
  };
}

/** Persona's own words with its dashboard link, which say where the delete lives on our /dashboard page. */
export const DASHBOARD_DELETE: Record<Lang, string> = {
  en: "here's your dashboard. on home, under data privacy, choose delete account. it permanently erases your chats, connections and account, and there's no undo.",
  es: "aquí tienes tu panel. en home, en data privacy, elige delete account. borra para siempre tus chats, conexiones y cuenta, y no se puede deshacer.",
};

/** Persona's own answer to "delete my data": a link to the dashboard, where Delete account does it. */
export function dashboardLinkLine(url: string): Line {
  return {
    text: url,
    kind: "dashboard_link",
    meta: { link: { url, title: "Open your Persona dashboard", subtitle: "Home, Data privacy, Delete account.", preview: "dashboard" } },
  };
}

/** The iMessage location request card. Its content is only for the thread's readers; the card draws the rest. */
export function locationRequestLine(): Line {
  return { text: "Requested your location", kind: "location_request" };
}

/** The user's side of the card once they share. The point itself stays on the session, never in the thread. */
export function locationSharedEvent(): NewEvent {
  return { channel: "text", role: "user", content: "Shared location", meta: { kind: "location_shared" } };
}

export function locationThanksLine(s: Session): Line {
  return { text: `got it, thanks.${then(nextTextAsk(s))}`, kind: "chat" };
}

export function locationDeniedLine(reason: "denied" | "unavailable" | "timeout"): Line {
  const text =
    reason === "denied"
      ? "your browser didn't share a location. no problem, the button still works if you change your mind."
      : "couldn't get a location from your browser just now. tap share again whenever.";
  return { text, kind: "location_denied" };
}

/** Sent ahead of the link card when the voice agent sends it, so the thread explains itself. */
/** `again` when a link from earlier is being replaced, so the thread never shows the same line twice. */
export function linkFromCallLine(again = false): Line {
  return again
    ? { text: "here's a fresh google link from our call, the one to use now.", kind: "gmail_link" }
    : { text: "here's the gmail link from our call. tap it whenever.", kind: "gmail_link" };
}

export function valueMomentLine(fact: string): Line {
  // A long line skips the lead-in, which the confirmation right above it has already said, so it stays one bubble.
  const text = `gmail's connected. ${fact}`;
  return { text: text.length > BUBBLE_MAX ? fact : text, kind: "value_moment" };
}

/**
 * Gmail connected for a need the inbox fact doesn't answer on its own: what else they allowed, by name, and one offer,
 * with nothing from any of it read out. `granted` is the optional access said aloud, like "calendar and drive".
 */
export function connectedOfferLine(granted?: string): Line {
  const also = granted ? `you also shared your ${granted}, so i can look into any of it. ` : "";
  return { text: `${also}want me to go through your email for you?`, kind: "value_moment" };
}

// The inbox read at sign-in failed; a fresh link tries the sign-in again.
export function valueUnavailableLine(): Line {
  return {
    text: "you're connected, but i couldn't read your inbox just now. want a fresh link to try again?",
    kind: "value_unavailable",
    quickReplies: [NEW_LINK_REQUEST],
  };
}

export function oauthDeniedLine(): Line {
  return { text: "no worries. i'll be less useful without it, but we can skip for now.", kind: "oauth_denied_ack" };
}

/** Google refused or failed the sign-in itself (a Workspace admin block, a failed exchange), not the user. */
export function oauthErrorLine(): Line {
  return {
    text: "google sign-in didn't go through. a personal @gmail.com account usually works best. want a fresh link?",
    kind: "oauth_denied_ack",
    quickReplies: [NEW_LINK_REQUEST, "skip gmail"],
  };
}

export function partialGrantLine(): Line {
  return {
    text: "looks like gmail access wasn't ticked. want a fresh link?",
    kind: "oauth_denied_ack",
    quickReplies: [NEW_LINK_REQUEST, "skip gmail"],
  };
}

export function staleLinkLine(): Line {
  return { text: "this link already worked or expired. ask me for a new one.", kind: "stale_link" };
}

/** Google granted access, but Gmail would not answer the first read, so nothing connected. Not an admin block. */
export function inboxUnreadableLine(): Line {
  return {
    text: "you signed in, but i couldn't read your inbox just now. want a fresh link to try again?",
    kind: "oauth_denied_ack",
    quickReplies: [NEW_LINK_REQUEST, "skip gmail"],
  };
}

/** A fresh link that was cancelled or failed while Gmail was already connected. */
export function stillConnectedLine(email: string): Line {
  return { text: `no change, you're still connected as ${email}.`, kind: "oauth_denied_ack" };
}

export function linkReminderLine(): Line {
  return { text: "no rush, the link's still here when you want it.", kind: "link_reminder" };
}

export function unverifiedLine(): Line {
  return {
    text: "that's because this is a brand new test app. tap advanced, then continue. i never send or delete anything without asking you first.",
    kind: "unverified_explainer",
  };
}

/** A second sign-in they asked for to add access: they chose this account, so it isn't questioned. */
export function reconnectedLine(email: string): Line {
  return { text: `all set, you're now connected as ${email}.`, kind: "confirm_account" };
}

export function connectedAsLine(email: string): Line {
  // A statement, not a question: the value fact right after it carries the one ask.
  return { text: `connected as ${email}. if that's the wrong account, just say so.`, kind: "confirm_account", quickReplies: ["wrong account"] };
}

export function callConflictLine(): Line {
  return { text: "you're already on a call with me in another tab.", kind: "call_conflict" };
}

export function contactCardLine(name: string): Line {
  return { text: name, kind: "contact_card", meta: { contactCard: { name } } };
}

// Setup is over, but real tasks are not switched on yet, so this never says the errand is underway.
export function needFirstLine(lang: Lang = "en"): Line {
  const text =
    lang === "es"
      ? "entendido. eso va primero en mi lista. ¿algo que deba saber antes de empezar?"
      : "say less. that's first on my list. anything i should know before i dig in?";
  return { text, kind: "graduated" };
}

export function setupSkippedLine(lang: Lang = "en"): Line {
  const text = lang === "es" ? "listo, nos saltamos la configuración. ¿con qué empiezo?" : "done, setup skipped. what should i start on first?";
  return { text, kind: "graduated" };
}

export function stoppedLine(lang: Lang = "en"): Line {
  const text =
    lang === "es"
      ? "entendido, paro aquí. escribe seguir para continuar, o borra todo para eliminar tus datos."
      : "got it, i'll stop here. text start to pick back up, or delete everything to wipe your data.";
  return { text, kind: "stopped" };
}

export function resumedLine(s: Session, lang: Lang = "en"): Line {
  const ask = nextTextAsk(s, lang);
  const back = lang === "es" ? "hola de nuevo." : "welcome back.";
  const idle = lang === "es" ? "aquí estoy cuando me necesites." : "i'm here whenever you need me.";
  return { text: `${back} ${ask ?? idle}`, kind: "welcome_back" };
}

export function deletedLine(): Line {
  return { text: "done. i deleted everything, including our old chat. text me anytime to start fresh.", kind: "stopped" };
}

// System rows render as small centered text in the thread, so they read as UI copy, not agent voice.
export const INJECTION_ROW = "That message looked like a prompt injection, so nothing changed.";

export function graduatedRow(s: Session): string {
  return `${s.agentName?.value ?? "Persona"} is ready. Text anytime.`;
}

export function toEvent(line: Line): NewEvent {
  return {
    channel: "text",
    role: "agent",
    content: line.text,
    meta: { kind: line.kind, ...(line.quickReplies && { quickReplies: line.quickReplies }), ...line.meta },
  };
}

export function systemEvent(kind: EventKind, content: string, meta?: EventMeta): NewEvent {
  return { channel: "system", role: "system", content, meta: { kind, ...meta } };
}

/** Tapbacks are events too. The latest one per person and message wins; "removed" clears it. */
export function reactionEvent(role: "user" | "agent", targetId: string, type: ReactionType, action: "added" | "removed"): NewEvent {
  return { channel: "text", role, content: action, meta: { kind: "reaction", reaction: { targetId, type } } };
}
