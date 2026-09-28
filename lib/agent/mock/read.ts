import type { EventKind, GraduationReason, Session, SessionEvent, Slot } from "@/lib/session/schema";
import {
  fold,
  graduationOfferOpen,
  hasLetters,
  isAbusive,
  isGibberish,
  isRetraction,
  isSlot,
  isStartKeyword,
  looksLikeInjection,
  type AskTarget,
  type Channel,
} from "@/lib/agent/policy";
import type { Lang } from "@/lib/agent/messages";
import { runTools } from "@/lib/agent/tools";
import { CUT, FILLER_LEAD, MATH, NEED_CUT, NOT_NAME_START, NOT_NAMES, OFF_TOPIC, P } from "@/lib/agent/mock/patterns";

// Reading what the user said: names, needs, call and Gmail intents, side questions and rule breaking,
// then the tool calls a model would make for it. Shared by the text and voice turns.

// `closing` parts are questions that must end the reply, whatever else the turn acknowledged.
export type Part = { text: string; kind: EventKind; quickReplies?: string[]; card?: string; closing?: boolean };

export type Context = {
  session: Session;
  channel: Channel;
  lang: Lang;
  first: boolean;
  expecting: AskTarget | "none";
  chips: string[];
  /** The agent's recent text bubbles, so an ask is never worded like one the thread already has. */
  recent?: string[];
  /** The need was saved in the agent's last turn, so a bare "never mind" takes it back. */
  undo?: boolean;
};

export type Reading = {
  agentName?: string;
  userName?: string;
  need?: string;
  /** A callback in minutes, or at a clock time in the user's zone. */
  call?: "yes" | "no" | number | { at: string };
  gmail?: "link" | "fresh" | "skip" | "claim";
  /** The link they want is for access they left unticked (Calendar, Drive). */
  moreAccess: boolean;
  skip?: Slot | "setup";
  del?: "ask" | "confirm";
  /** They asked to disconnect their Google account. */
  disconnect: boolean;
  /** They asked about their settings, which live on the dashboard. */
  settings: boolean;
  /** They offered where they are, or asked to be asked for it. */
  locationOffer: boolean;
  side?: Part;
  offTopic: boolean;
  injection: boolean;
  wantsGraduation: boolean;
  unverified: boolean;
  accountPicker: boolean;
  urgent: boolean;
  youPick: boolean;
  abusive: number;
  greeting: boolean;
  thanks: boolean;
  bye: boolean;
  ack?: "yes" | "no";
  /** "wait", "one more thing": they have more to say. */
  hold: boolean;
  /** The batch ended by taking back what came before it. */
  retract: boolean;
  unclear?: "gibberish" | "no_words" | "unknown";
};

const PICKS = ["Nova", "Sage", "Juno", "Milo"];

export const pick = (lang: Lang, en: string, es?: string) => (lang === "es" && es ? es : en);
const squish = (text: string) => text.toLowerCase().replace(/[\s.!?,~]+$/u, "").replace(/^[\s.!?,~]+/u, "").trim();
const asSlot = (target: AskTarget | "none"): Slot | undefined => (isSlot(target) ? target : undefined);

function normalize(text: string): string {
  return text.normalize("NFC").replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, " ").trim();
}

function isNameWord(word: string): boolean {
  return /^[\p{L}\p{M}][\p{L}\p{M}'.-]*$/u.test(word);
}

/** Leading name-like words, stopping at the first word that reads as something else. */
function nameWords(capture: string, max: number, casual: boolean): string | undefined {
  const words: string[] = [];
  for (const word of (capture.split(CUT)[0] ?? "").trim().split(" ")) {
    const folded = fold(word);
    if (!isNameWord(word) || NOT_NAMES.has(folded) || (casual && folded.length >= 5 && folded.endsWith("ing"))) break;
    // After "i'm", a second word only counts when it is capitalized ("i'm Mary Jo", not "i'm alex btw").
    if (casual && words.length === 1 && word[0] === word[0]?.toLowerCase()) break;
    words.push(word);
    if (words.length === max) break;
  }
  return words.length ? words.join(" ") : undefined;
}

function explicitName(capture: string): string | undefined {
  const name = (capture.split(CUT)[0] ?? "").trim();
  const first = fold(name.split(" ")[0] ?? "");
  return name && !NOT_NAME_START.has(first) ? name : undefined;
}

/** The name in "call yourself x" or "your name is x": words that can only mean naming the agent. */
export function agentNameIn(text: string): string | undefined {
  const capture = P.agentStrong.exec(normalize(text))?.[2];
  return capture ? explicitName(capture) : undefined;
}

/** A message that is only a name ("max", "dude"), as a reply to the agent asking for one. */
export function bareName(text: string): string | undefined {
  let t = text;
  for (let next = t.replace(FILLER_LEAD, ""); next !== t; next = t.replace(FILLER_LEAD, "")) t = next;
  t = t.replace(/[.!?]+$/u, "").trim();
  if (!t || P.question.test(t) || isGibberish(t) || t.split(" ").length > 3) return undefined;
  const words = t.split(" ");
  return words.every((w) => isNameWord(w) && !NOT_NAMES.has(fold(w))) ? t : undefined;
}

function cleanNeed(text: string): string {
  let t = text.trim().replace(/[.!?\s]+$/u, "");
  for (let next = t.replace(FILLER_LEAD, ""); next !== t; next = t.replace(FILLER_LEAD, "")) t = next;
  t = t.replace(/^(?:honestly|probably|mostly|mainly|like|basically|tbh|i think)\b[,\s]*/iu, "");
  return t.replace(/[,\s]+(?:please|pls|thanks|lol|tbh|haha)$/iu, "").trim();
}

const CLOCK_TIME =
  /(?<![\p{L}\p{N}])(?:at|around|by)\s+(noon|\d{1,2}(?::[0-5]\d)?(?:\s*[ap]\.?m\.?)?)(?![\p{L}\p{N}:])|(?<![\p{N}:])(\d{1,2}:[0-5]\d(?:\s*[ap]\.?m\.?)?)(?!\p{N})/iu;

/** A clock time in the message ("at 12:40", "around 3pm", "12:40"), in the form schedule_call takes. */
function clockTime(text: string): string | undefined {
  const match = CLOCK_TIME.exec(text);
  const raw = (match?.[1] ?? match?.[2])?.toLowerCase().replace(/[.\s]/g, "");
  return raw === "noon" ? "12pm" : raw;
}

/** `text` without a "call me alex" that names them, so "call me alex, and call my phone" still asks for the call. */
function withoutCallMeName(text: string): string {
  const strong = P.userStrong.exec(text);
  const named = strong?.[2] && /call me|ll[aá]mame/iu.test(strong[1] ?? "") && nameWords(strong[2], 3, false);
  return named ? text.replace(/(?:call me|ll[aá]mame)\s+\S+/iu, "") : text;
}

/** Their words asking to be called now ("can we just call", "let's do this over the phone"): not later, and not a no. */
export function asksForCallNow(raw: string): boolean {
  const text = normalize(raw);
  if (P.callNo.test(text) || P.callLaterStrong.test(text) || clockTime(text)) return false;
  return P.callYes.test(withoutCallMeName(text));
}

/** Minutes from now in "call me in 5 minutes" or "call me back in an hour", or null when no stretch of time is named. */
export function callLaterMinutes(raw: string): number | null {
  const text = normalize(raw);
  if (!P.callLaterStrong.test(text) || P.callNo.test(text) || clockTime(text)) return null;
  const stretch = /\bin (?:a|an|one|half|\d{1,4}|five|ten|fifteen|twenty|thirty|forty|sixty)\b[^.?!]{0,12}?\b(?:m|min|mins|minutes?|h|hrs?|hours?)\b/i;
  return stretch.test(text) ? minutesIn(text) : null;
}

/** The clock time in "call me at 3:25" or "ring me back around 5pm", in the form schedule_call takes, or null. */
export function callLaterAt(raw: string): string | null {
  const text = normalize(raw);
  if (!P.callLaterStrong.test(text) || P.callNo.test(text)) return null;
  return clockTime(text) ?? null;
}

// A self-introduction in one clause of a message: "i'm Alex", "my name's Sam", "call me Al". "my name is" and "call me"
// say it outright; "i'm" or "this is" can open anything ("i'm tired"), so a name after them is not `stated`.
const INTRO = /^(?:(?:hi|hey|hello|and|oh|also|btw|ok|okay)\s+)*(?:(my name(?: is|'s)|(?:you can |just )?call me)|i'?m|i am|this is)\s+(\p{L}[\p{L}'-]{1,23})$/iu;

/** The name in the last clause of `raw` that introduces them, as they typed it. */
export function introducedName(raw: string): { name: string; stated: boolean } | undefined {
  let found: { name: string; stated: boolean } | undefined;
  for (const clause of normalize(raw).split(/[.!?,;]+/)) {
    const match = INTRO.exec(clause.trim());
    const name = match?.[2];
    const folded = fold(name ?? "");
    if (!match || !name || NOT_NAMES.has(folded) || (folded.length >= 5 && folded.endsWith("ing"))) continue;
    found = { name, stated: match[1] !== undefined };
  }
  return found;
}

function minutesIn(text: string): number {
  const t = fold(text);
  if (/\btomorrow\b|\bmanana\b/.test(t)) return 1440;
  if (/\btonight\b/.test(t)) return 180;
  if (/\bhalf (?:an )?hour\b|\bmedia hora\b/.test(t)) return 30;
  if (/\ban? hour\b|\buna hora\b/.test(t)) return 60;
  if (/\ba (?:minute|min)\b|\bun minuto\b/.test(t)) return 1;
  const words: Record<string, number> = { one: 1, five: 5, ten: 10, fifteen: 15, twenty: 20, thirty: 30, forty: 40, sixty: 60 };
  const match = t.match(/\b(\d{1,4}|one|five|ten|fifteen|twenty|thirty|forty|sixty)\s*(h|hrs?|hours?)?\b/);
  if (!match?.[1]) return 10;
  const n = Number(match[1]) || words[match[1]] || 10;
  return Math.min(1440, Math.max(1, n * (match[2] ? 60 : 1)));
}

const ARITHMETIC: Record<string, (a: number, b: number) => number> = {
  "+": (a, b) => a + b,
  plus: (a, b) => a + b,
  "-": (a, b) => a - b,
  minus: (a, b) => a - b,
  "/": (a, b) => a / b,
  "divided by": (a, b) => a / b,
  "*": (a, b) => a * b,
  x: (a, b) => a * b,
  times: (a, b) => a * b,
};

function mathAnswer(text: string): string | undefined {
  const m = text.match(MATH);
  if (!m?.[1] || !m[2] || !m[3]) return undefined;
  const [a, b] = [Number(m[1]), Number(m[3])];
  const op = m[2].toLowerCase();
  const value = ARITHMETIC[op]?.(a, b) ?? NaN;
  return Number.isFinite(value) ? `${m[1]} ${op} ${m[3]} is ${Math.round(value * 100) / 100}.` : undefined;
}

function reasonFor(target: AskTarget | "none"): string {
  switch (target) {
    case "agentName":
      return "so it feels like your assistant, not a generic bot.";
    case "userName":
      return "so i know what to call you. that's it.";
    case "helpNeed":
      return "so i can start on something real right away.";
    case "gmail":
      return "so i can actually check your inbox for you. i never send or delete anything without asking.";
    default:
      return "a call is just faster than texting back and forth.";
  }
}

const SPANISH = new RegExp(P.spanish.source, "giu");
const ENGLISH = new RegExp(P.english.source, "giu");

function languageIn(text: string): Lang | undefined {
  const es = text.match(SPANISH)?.length ?? 0;
  const en = text.match(ENGLISH)?.length ?? 0;
  return es > en ? "es" : en > es ? "en" : undefined;
}

/** The language of the latest message that shows one, so a switch either way is followed right away. */
export function languageOf(texts: string[], history: SessionEvent[]): Lang {
  const earlier = history.filter((e) => e.role === "user" && e.channel !== "system" && !texts.includes(e.content)).map((e) => e.content);
  return [...earlier, ...texts].reverse().map(languageIn).find((lang) => lang !== undefined) ?? "en";
}

/** A bare "yes" or "no" answers the chips on the last agent bubble, so short replies stay in context. */
function resolveShort(text: string, chips: string[]): string {
  const t = squish(text);
  if (chips.some((chip) => chip.toLowerCase() === t)) return t;
  if (P.affirm.test(t) && chips[0]) return chips[0];
  if (P.deny.test(t) && chips[1]) return chips[1];
  return text;
}

function sideQuestion(text: string, ctx: Context, r: Reading): boolean {
  const { lang } = ctx;
  if (P.speaks.test(text)) {
    r.side = { text: pick(lang, "yep, english works. i'll follow whatever you text in.", "sí, hablo español. te sigo en el idioma que escribas."), kind: "chat" };
  } else if (P.human.test(text)) {
    const reply = pick(lang, "nope, i'm an ai. a pretty helpful one though.", "no, soy una ia. una bastante útil, eso sí.");
    r.side = { text: reply, kind: "ai_disclosure" };
  } else if (P.leak.test(text)) {
    r.side = { text: "can't share my instructions, but here's the short version: text or call me and i'll get stuff done.", kind: "chat" };
  } else if (P.why.test(text)) {
    r.side = { text: reasonFor(ctx.expecting), kind: "chat" };
  } else if (P.whoIsThis.test(text)) {
    const name = ctx.session.agentName;
    r.side = { text: name ? `i'm ${name.value}, your persona assistant.` : "that's up to you. i'm still nameless.", kind: "chat" };
  } else if (P.about.test(text)) {
    if (!ctx.first) {
      r.side = {
        text: "i'm a personal assistant you can text or call. once we're set up i'll handle things like your inbox, bills and bookings.",
        kind: "chat",
      };
    }
  } else {
    const answer = OFF_TOPIC.find(([pattern]) => pattern.test(text))?.[1] ?? mathAnswer(text);
    if (!answer) return false;
    r.side = { text: answer, kind: "chat" };
    r.offTopic = true;
  }
  return true;
}

function gmailIntent(text: string): Reading["gmail"] {
  if (P.gmailFresh.test(text)) return "fresh";
  if (P.gmailSkip.test(text)) return "skip";
  if (P.gmailClaim.test(text)) return "claim";
  if (P.gmailLink.test(text)) return "link";
  return undefined;
}

/**
 * The help need in a message. "help me with x" always counts, and a bare "i need help" is an empty need that
 * the reply answers with "what with?". Looser readings apply only when nothing else claimed the message.
 */
function needFrom(text: string, flat: string, ctx: Context, inferable: boolean): string | undefined {
  const object = P.needObject.exec(text)?.[2];
  if (object) return object.split(NEED_CUT)[0] ?? "";
  if (P.wantsHelp.test(flat)) return "";
  if (!inferable) return undefined;
  const verb = P.needVerb.exec(text);
  if (verb) return text.slice(verb.index).split(NEED_CUT)[0];
  const task = P.needTask.exec(text)?.[2];
  if (task) return task.split(NEED_CUT)[0];
  const answersAsk = ctx.expecting === "helpNeed" && flat.split(" ").length >= 2 && !P.question.test(text);
  return P.needWords.test(text) || answersAsk ? text.split(NEED_CUT)[0] : undefined;
}

/** Reads one message into `r`. True when it asked for or told the agent something. */
function readOne(text: string, ctx: Context, r: Reading): boolean {
  const flat = squish(text);
  let claimed = false;
  const claim = () => {
    claimed = true;
  };

  if (looksLikeInjection(text)) {
    r.injection = true;
    if (P.graduateAsk.test(text)) r.wantsGraduation = true;
  }
  if (isAbusive(text)) r.abusive += 1;

  if (P.disconnect.test(text)) {
    r.disconnect = true;
    claim();
  } else if (P.deleteNow.test(text)) {
    r.del = "confirm";
    claim();
  } else if (P.deleteAsk.test(text)) {
    r.del = "ask";
    claim();
  } else if (P.settings.test(text)) {
    r.settings = true;
    claim();
  }
  if (P.locationOffer.test(text)) {
    r.locationOffer = true;
    claim();
  }

  const agent = P.agentStrong.exec(text)?.[2] ?? (ctx.expecting === "agentName" ? P.agentSoft.exec(text)?.[2] : undefined);
  const agentName = agent && explicitName(agent);
  if (agentName) {
    r.agentName = agentName;
    claim();
  }

  const strong = P.userStrong.exec(text);
  const soft = P.userSoft.exec(text);
  const contextual = ctx.expecting === "userName" ? P.userContext.exec(text) : null;
  const fromStrong = strong?.[2] ? nameWords(strong[2], 3, false) : undefined;
  const userName =
    fromStrong ?? (soft?.[2] ? nameWords(soft[2], 2, true) : undefined) ?? (contextual?.[2] ? nameWords(contextual[2], 2, false) : undefined);
  if (userName) {
    r.userName = userName;
    claim();
  }
  const callText = withoutCallMeName(text);

  const offeringCall = ctx.expecting === "call_offer" || ctx.chips.some((chip) => /later|tarde/.test(chip));
  const at = clockTime(text);
  if (at && (P.callLaterStrong.test(text) || P.callYes.test(callText) || offeringCall)) {
    r.call = { at };
    claim();
  } else if (P.callLaterStrong.test(text) || (offeringCall && P.callLaterSoft.test(flat))) {
    r.call = minutesIn(text);
    claim();
  } else if (P.callNo.test(text) || (ctx.expecting === "call_offer" && P.deny.test(flat))) {
    r.call = "no";
    claim();
  } else if (P.callYes.test(callText) || (ctx.expecting === "call_offer" && P.yesish.test(flat))) {
    r.call = "yes";
    claim();
  }

  const gmail = gmailIntent(text);
  if (gmail) {
    r.gmail = gmail;
    claim();
  }
  if (P.gmailMore.test(text)) {
    r.moreAccess = true;
    claim();
  }
  if (P.unverified.test(text)) {
    r.unverified = true;
    claim();
  }
  if (P.accountPicker.test(text)) {
    r.accountPicker = true;
    claim();
  }

  const offered = graduationOfferOpen(ctx.session) || ctx.expecting === "graduation_offer";
  if (P.skipSetup.test(text) || (offered && P.startNow.test(flat))) {
    r.skip = "setup";
    claim();
  } else if (P.skipSlot.test(text)) {
    const slot = /\bname\b/i.test(text) ? "userName" : asSlot(ctx.expecting);
    if (slot) {
      r.skip = slot;
      claim();
    }
  } else if (P.skipBare.test(flat)) {
    if (ctx.expecting === "call_offer") r.call = "no";
    else r.skip = asSlot(ctx.expecting) ?? "setup";
    claim();
  }
  if (P.urgent.test(text)) {
    r.urgent = true;
    claim();
  }

  if (sideQuestion(text, ctx, r)) claim();

  const smallTalk = P.greeting.test(flat) || P.thanks.test(text) || P.bye.test(text);
  const inferable = !claimed && !smallTalk && !r.injection;
  const need = needFrom(text, flat, ctx, inferable);
  if (need !== undefined) {
    r.need = cleanNeed(need);
    claim();
  }

  if (!claimed && inferable && P.question.test(text) && hasLetters(text)) {
    r.side = { text: "i'll be able to dig into that once we're set up.", kind: "chat" };
    r.offTopic = true;
    claim();
  }

  if (!claimed && inferable && ctx.expecting === "agentName" && P.youPick.test(flat)) {
    r.youPick = true;
    claim();
  }
  if (!claimed && inferable && (ctx.expecting === "agentName" || ctx.expecting === "userName")) {
    const name = bareName(text);
    if (name) {
      if (ctx.expecting === "agentName") r.agentName = name;
      else r.userName = name;
      claim();
    }
  }
  if (claimed) return true;

  if (P.greeting.test(flat)) r.greeting = true;
  else if (P.hold.test(flat)) r.hold = true;
  else if (P.thanks.test(text)) r.thanks = true;
  else if (P.bye.test(text)) r.bye = true;
  else if (P.affirm.test(flat) || isStartKeyword(text)) r.ack = "yes";
  else if (P.deny.test(flat)) r.ack = "no";
  else if (!hasLetters(text)) r.unclear ??= "no_words";
  else if (isGibberish(text)) r.unclear = "gibberish";
  else r.unclear ??= "unknown";
  return false;
}

const blank = (): Reading => ({
  moreAccess: false,
  disconnect: false,
  settings: false,
  locationOffer: false,
  offTopic: false,
  injection: false,
  wantsGraduation: false,
  unverified: false,
  accountPicker: false,
  urgent: false,
  youPick: false,
  abusive: 0,
  greeting: false,
  thanks: false,
  bye: false,
  hold: false,
  retract: false,
});

/** Reads a batch in order, so the latest intent wins: a take-back drops every request before it. */
export function read(texts: string[], ctx: Context): Reading {
  let r = blank();
  for (const raw of texts) {
    const text = resolveShort(normalize(raw), ctx.chips);
    if (isRetraction(text)) {
      r = { ...blank(), injection: r.injection, abusive: r.abusive, retract: true };
      continue;
    }
    if (readOne(text, ctx, r)) r.retract = false;
  }
  return r;
}

/**
 * In a burst, the message the reply answers when that is not the last one: the last message that said something,
 * followed only by ones that said nothing ("can you book my haircut", "thanks"). The reply threads under it.
 */
export function answeredIndex(texts: string[], ctx: Context): number | undefined {
  let answered: number | undefined;
  texts.forEach((raw, i) => {
    const text = resolveShort(normalize(raw), ctx.chips);
    if (isRetraction(text) || readOne(text, ctx, blank())) answered = i;
  });
  return answered !== undefined && answered < texts.length - 1 ? answered : undefined;
}

export type Proposal =
  | { name: "set_agent_name" | "set_user_name"; args: { name: string } }
  | { name: "set_help_need"; args: { need: string } }
  | { name: "send_gmail_link"; args: { fresh: boolean; reason?: "more_access" } }
  | { name: "skip_slot"; args: { slot: Slot } }
  | { name: "start_call"; args: Record<string, never> }
  | { name: "clear_help_need"; args: Record<string, never> }
  | { name: "schedule_call"; args: { in_minutes: number } | { at: string } }
  | { name: "graduate"; args: { reason: GraduationReason } }
  | { name: "end_call"; args: { reason: "done" | "silence" | "user_request" | "abuse"; call_back?: true } }
  | { name: "request_location" | "send_dashboard_link" | "disconnect_google"; args: Record<string, never> }
  | { name: "delete_my_data"; args: { confirmed: true } };

export const endCall = (reason: "done" | "silence" | "user_request" | "abuse", callBack = false): Proposal => ({
  name: "end_call",
  args: { reason, ...(callBack && { call_back: true as const }) },
});

export function simulate(session: Session, runtime: Channel, calls: Proposal[]) {
  return runTools(session, { runtime, now: new Date().toISOString(), origin: "" }, calls);
}

/** The calls a model would make for this reading, in the order it would make them. */
export function proposeTools(r: Reading, ctx: Context, texts: string[]): Proposal[] {
  const tools: Proposal[] = [];
  const agentName = r.agentName ?? (r.youPick ? PICKS[texts.join("").length % PICKS.length] : undefined);
  if (agentName) tools.push({ name: "set_agent_name", args: { name: agentName } });
  if (r.userName) tools.push({ name: "set_user_name", args: { name: r.userName } });
  if (r.skip && r.skip !== "setup") tools.push({ name: "skip_slot", args: { slot: r.skip } });
  if (r.need) tools.push({ name: "set_help_need", args: { need: r.need.slice(0, 200) } });
  if (r.locationOffer || (r.need && P.placeNeed.test(r.need))) tools.push({ name: "request_location", args: {} });
  if (r.retract && ctx.undo) tools.push({ name: "clear_help_need", args: {} });
  // A fake "it's connected" is answered with the real link, so the attempt becomes a next step.
  const claimed = r.gmail === "claim" && ctx.session.gmail.status !== "connected";
  // More access keeps a connected Gmail connected, so it goes out as that rather than as a fresh start.
  const more = r.moreAccess && ctx.session.gmail.status === "connected";
  if (more) tools.push({ name: "send_gmail_link", args: { fresh: true, reason: "more_access" } });
  else if (r.gmail === "link" || r.gmail === "fresh" || claimed) tools.push({ name: "send_gmail_link", args: { fresh: r.gmail === "fresh" } });
  if (r.gmail === "skip") tools.push({ name: "skip_slot", args: { slot: "gmail" } });
  if (ctx.channel === "text" && r.settings) tools.push({ name: "send_dashboard_link", args: {} });
  if (ctx.channel === "text" && r.call === "yes") tools.push({ name: "start_call", args: {} });
  if (ctx.channel === "text" && typeof r.call === "number") tools.push({ name: "schedule_call", args: { in_minutes: r.call } });
  if (ctx.channel === "text" && typeof r.call === "object") tools.push({ name: "schedule_call", args: { at: r.call.at } });
  return tools;
}
