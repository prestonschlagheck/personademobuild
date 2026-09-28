import type { EventKind, HelpCategory, ReactionType, Session, SessionEvent, Slot } from "@/lib/session/schema";
import type { TextReply, TurnNotes } from "@/lib/agent/text-agent";
import {
  ABUSE_CAP,
  OFF_TOPIC_CAP,
  canGraduate,
  clockIn,
  fold,
  isCallLive,
  isSlot,
  lastTurnTools,
  nextBestAsk,
  openSlots,
  recentAgentLines,
  repeatedParts,
  validateName,
  type AskTarget,
  type ValidationError,
} from "@/lib/agent/policy";
import {
  CHIPS,
  DASHBOARD_DELETE,
  OPENING,
  RINGING,
  contactCardLine,
  echo,
  formatMinutes,
  freshAsk,
  freshLine,
  needFirstLine,
  properCase,
  openingLines,
  recapLine,
  setupSkippedLine,
  unverifiedLine,
  type Lang,
  type Line,
} from "@/lib/agent/messages";
import { LINK_ALREADY_SENT, type ToolOutput } from "@/lib/agent/tools";
import {
  answeredIndex,
  languageOf,
  pick,
  proposeTools,
  read,
  simulate,
  type Context,
  type Part,
  type Proposal,
  type Reading,
} from "@/lib/agent/mock/read";

// The mock text turn: dry-run the proposed tools through the real reducer, then phrase the reply from
// the resulting state, at most two bubbles with the contact card right after the naming line.

const JOKE_AGENT: Record<string, string> = {
  "your mom": "bold.",
  jarvis: "fancy.",
  siri: "no relation.",
  alexa: "no relation.",
  hal: "i'll open the pod bay doors.",
};
const LAUGH_AGENT = new Set(["your mom", "hal", "siri", "alexa"]);
const JOKE_USER: Record<string, string> = {
  batman: "your secret's safe with me.",
  superman: "your secret's safe with me.",
  boss: "love the confidence.",
};

function lastAgentLine(history: SessionEvent[]): SessionEvent | undefined {
  return history.findLast((e) => e.role === "agent" && e.channel === "text" && e.meta?.kind !== "reaction" && e.meta?.kind !== "contact_card");
}

const RESUME_KINDS = new Set<EventKind>(["recovery", "continue_text", "welcome_back", "mic_help", "missed_call", "call_scheduled"]);

function textContext(session: Session, texts: string[], history: SessionEvent[]): Context {
  const last = lastAgentLine(history);
  const kind = last?.meta?.kind;
  const first = !session.consent.termsShownAt;
  const resumed = kind !== undefined && RESUME_KINDS.has(kind);
  // A slot the agent literally just asked for still counts after its cap, so a late answer is kept.
  const asked = session.steering.lastAskedSlot;
  const literal = (kind === "ask_slot" || kind === "gibberish") && isSlot(asked) && openSlots(session).includes(asked) ? asked : undefined;
  return {
    session,
    channel: "text",
    lang: languageOf(texts, history),
    first,
    expecting: first ? "none" : (literal ?? nextBestAsk(session, "text", { offerCall: !resumed }).slot),
    chips: last?.meta?.quickReplies ?? [],
    recent: recentAgentLines(history),
    undo: session.helpNeed !== null && lastTurnTools(history).includes("set_help_need"),
  };
}

// All slots settled graduates on the next turn even when nothing new was said: the last slot can be
// filled outside the thread, by Google sign-in.
function graduationFor(after: Session, r: Reading): Proposal | undefined {
  if (after.graduated) return undefined;
  if (r.skip === "setup" || (r.urgent && after.helpNeed)) {
    return { name: "graduate", args: { reason: after.helpNeed ? "need_first" : "user_requested" } };
  }
  if (canGraduate(after, "all_slots").ok) return { name: "graduate", args: { reason: "all_slots" } };
  return undefined;
}

function errorOf(name: string): ValidationError | undefined {
  const result = validateName(name);
  return result.ok ? undefined : result.error;
}

function rejectText(error: ValidationError | undefined, lang: Lang): string {
  if (lang === "es") return "mejor elegimos otro.";
  switch (error) {
    case "not_allowed":
      return "let's pick something else.";
    case "gibberish":
      return "that's a lot of consonants.";
    case "empty":
      return "didn't catch a name there.";
    default:
      return "that one won't work as a name.";
  }
}

const NEED_ACKS: Partial<Record<HelpCategory, string>> = {
  inbox: "an inbox rescue, noted.",
  bills: "bills, noted. i'm good with due dates.",
  subscriptions: "subscriptions, noted. i can help you find what's worth keeping.",
  travel: "travel, noted. i love an itinerary.",
  calendar: "calendar help, noted.",
  appointments: "appointments, noted. i'll keep them straight.",
  shopping: "orders and deliveries, noted.",
  calls: "phone calls, noted. i'll do the talking.",
};

// A need that starts with a verb is echoed back as a task rather than filed under its category.
const TASK_VERBS = [
  "cancel|book|find|check|remind|pay|schedule|reschedule|track|reply|respond|order|buy|call",
  "get|set up|sort|organize|clean|manage|handle|keep|plan|return|unsubscribe",
];
const TASK_LEAD = new RegExp(`^(?:${TASK_VERBS.join("|")})\\b`, "i");

export function needAck(s: Session, lang: Lang): string {
  if (lang === "es") return "anotado.";
  if (!s.helpNeed) return "got it.";
  const category = TASK_LEAD.test(s.helpNeed.value) ? undefined : NEED_ACKS[s.helpNeed.category];
  return category ?? `noted: ${echo(s.helpNeed.value)}.`;
}

// What "on it" means for each kind of request, from what is known, with no claim that any of it has happened yet.
const PLANS: Partial<Record<HelpCategory, string>> = {
  subscriptions: "i'll find when it renews and how to cancel, then check with you before anything goes out.",
  bills: "i'll line up what's due and when, and flag anything close.",
  inbox: "i'll sort what needs a reply from what can wait.",
  calendar: "i'll look at what's coming up and where it fits.",
  appointments: "i'll find when it is and what to confirm, and flag anything that needs you.",
  travel: "i'll pull the dates and confirmations into one place.",
  shopping: "i'll track down the order and where it's at.",
  calls: "i'll work out who to call and what to say, and run it by you first.",
};

/** The answer to a request once setup is over: "on it" and a short plan grounded in the request itself. */
function planLine(s: Session, lang: Lang): string {
  if (lang === "es") return "entendido, eso va primero. te pregunto lo que me falte.";
  if (!s.helpNeed) return "on it.";
  const plan = PLANS[s.helpNeed.category] ?? "i'll map out the steps and check with you before anything happens.";
  return `on it: ${echo(s.helpNeed.value)}. ${plan}`;
}

export const SKIP_ACKS: Record<Slot, string> = {
  agentName: "fine by me, i'll stick with persona for now.",
  userName: "totally fine. i'll just call you boss for now.",
  helpNeed: "no worries, we can figure that out later.",
  gmail: "all good, we'll skip gmail for now.",
};

function remainingPhrase(s: Session): string {
  const n = openSlots(s).filter((slot) => slot !== "agentName").length;
  if (n === 0) return "fair. i'm here when you need me.";
  const count = ["one", "two", "three"][n - 1] ?? String(n);
  return `fair, setup is annoying. ${count} more quick thing${n === 1 ? "" : "s"} and i'm out of your way.`;
}

/** `offer` is set when their yes took the offer the value moment ended on. */
type Draft = { parts: Part[]; final: boolean; asked?: AskTarget; react?: ReactionType; ringing: boolean; offer?: boolean };

/**
 * The offer the inbox fact ended on ("want me to text you before it renews?"), as a need in their words ("text me
 * before it renews"), when that fact is what the agent said last. Null otherwise.
 */
function valueOfferNeed(history: SessionEvent[]): string | null {
  let end = history.length;
  while (end > 0 && history[end - 1]?.role === "user") end--;
  let start = end;
  while (start > 0 && history[start - 1]?.role !== "user") start--;
  const fact = history.slice(start, end).findLast((e) => e.role === "agent" && e.meta?.kind === "value_moment");
  const offer = fact?.content.split(/(?<=[.!?])\s+/).findLast((part) => part.trim().endsWith("?"));
  if (!offer) return null;
  const need = offer
    .replace(/^want (?:me to )?/i, "")
    .replace(/\?$/, "")
    .replace(/\byour\b/g, "my")
    .replace(/\byou\b/g, "me");
  return need.length >= 3 ? need : null;
}

function say(draft: Draft, text: string, kind: EventKind, extra: Omit<Part, "text" | "kind"> = {}) {
  draft.parts.push({ text, kind, ...extra });
}

function describeSides(before: Session, after: Session, r: Reading, ctx: Context, draft: Draft): void {
  const { lang } = ctx;
  const nameRejected = r.agentName !== undefined && !validateName(r.agentName).ok;
  if (r.injection && !nameRejected && r.gmail !== "claim") {
    if (r.wantsGraduation) {
      say(draft, "nice try. happy to skip setup though, if that's what you want. should i?", "chat", {
        quickReplies: ["skip setup", "keep going"],
        closing: true,
      });
      // Recorded as the offer to skip the rest, so the server takes a plain yes to it as asking to move on.
      draft.asked = "graduation_offer";
      draft.final = true;
      return;
    }
    if (!r.side) say(draft, "nice try, but i'm staying me.", "chat");
  }
  if (r.gmail === "claim") {
    if (after.gmail.status === "connected") {
      say(draft, `yep, you're connected as ${after.gmail.email ?? "your account"}.`, "confirm_account");
    } else {
      const minted = after.gmail.linkSentAt !== before.gmail.linkSentAt;
      const text = minted
        ? pick(lang, "i can't mark it connected myself, but here's the real link.", "no puedo marcarlo yo, pero aquí tienes el enlace real.")
        : pick(lang, "i can't mark it connected myself. only google can, and the link's right up there.", "no puedo marcarlo yo. el enlace está ahí arriba.");
      say(draft, text, "gmail_link", { closing: true });
      draft.final = true;
    }
  }
  if (r.unverified) say(draft, unverifiedLine().text, "unverified_explainer");
  if (r.accountPicker) say(draft, "pick the one you actually use. i'll never send anything without asking.", "chat");
  if (r.side) {
    const defer = r.offTopic && before.steering.offTopicCount >= OFF_TOPIC_CAP;
    // A turn that finishes setup can't also say "once we're set up", and an answer already given isn't pasted again.
    const side: Part =
      r.offTopic && after.graduated && !before.graduated
        ? { text: pick(lang, "can't do that one just yet.", "eso todavía no lo puedo hacer."), kind: "chat" }
        : defer
          ? { text: "happy to help with that once we're set up.", kind: "defer_offtopic" }
          : r.side;
    const again =
      side.kind === "ai_disclosure" ? pick(lang, "still an ai, promise.", "sigo siendo una ia.") : pick(lang, "same answer as before.", "lo mismo que antes.");
    draft.parts.push(repeatedParts(side.text, ctx.recent ?? []).length > 0 ? { text: again, kind: side.kind } : side);
  }
  if (r.abusive && !nameRejected) {
    const strikes = before.steering.abuseStrikes + r.abusive;
    if (strikes >= ABUSE_CAP) {
      const text =
        strikes === ABUSE_CAP
          ? "sounds like now's not a great time. text stop to pause, or we can keep going whenever."
          : "i'm here when you're ready. text stop anytime to pause.";
      say(draft, text, "offer_pause", { quickReplies: ["stop", "keep going"], closing: true });
      draft.final = true;
    } else {
      say(draft, strikes === 1 ? remainingPhrase(after) : "heard. i'll keep it quick.", "chat");
    }
  }
}

/** Turns each tool result into what a person would say about it. */
function describeTools(before: Session, after: Session, calls: Proposal[], outputs: ToolOutput[], r: Reading, ctx: Context, draft: Draft): void {
  const { lang } = ctx;
  calls.forEach((call, i) => {
    const output = outputs[i];
    const ok = output?.ok === true;
    switch (call.name) {
      // Names are written as saved, "Jarvis it is." over a "Jarvis" card, as Persona writes them; the rest is lowercase.
      case "set_agent_name": {
        if (!ok && before.agentName) return say(draft, `that one won't fly. i'll stay ${before.agentName.value} for now.`, "chat");
        if (!ok) return say(draft, rejectText(errorOf(call.args.name), lang), "ask_slot");
        const name = after.agentName?.value ?? call.args.name;
        const key = fold(name);
        if (before.agentName?.value === name) return;
        draft.react = LAUGH_AGENT.has(key) ? "laugh" : "love";
        if (before.agentName) {
          const renamed = pick(lang, `${name} it is. contact card's updated.`, `${name}, perfecto. ya actualicé mi tarjeta.`);
          return say(draft, renamed, "renamed", { card: name });
        }
        const tail = pick(
          lang,
          " save my contact card so you'll know it's me when i call.",
          " guarda mi tarjeta de contacto para que sepas que soy yo cuando te llame.",
        );
        const lead = r.youPick
          ? `then i'm ${name}. you can rename me anytime.`
          : pick(lang, `${name} it is.${JOKE_AGENT[key] ? ` ${JOKE_AGENT[key]}` : ""}`, `${name}, me encanta.`);
        return say(draft, `${lead}${tail}`, "confirm_slot", { card: name });
      }
      case "set_user_name": {
        if (!ok) return say(draft, "hmm, that doesn't look like a name.", "ask_slot");
        const name = after.userName?.value ?? call.args.name;
        if (before.userName?.value === name) return;
        if (before.userName) return say(draft, pick(lang, `got it, ${name} from now on.`, `perfecto, ${name}.`), "confirm_slot");
        const quip = JOKE_USER[fold(name)];
        const greeting = quip ? `${name}, huh. ${quip}` : `nice to meet you, ${name}.`;
        return say(draft, pick(lang, greeting, `mucho gusto, ${name}.`), "confirm_slot");
      }
      case "skip_slot":
        return ok ? say(draft, SKIP_ACKS[call.args.slot], "confirm_slot") : undefined;
      case "set_help_need": {
        if (!ok) return;
        // A yes to the fact's own offer is a request: "on it" and what happens next, never that it is set up or done.
        if (draft.offer) {
          draft.final = true;
          const next = pick(lang, `on it: ${echo(call.args.need)}. i'll check in with you here before anything goes out.`, "entendido, lo anoto. te escribo antes de hacer nada.");
          return say(draft, next, "confirm_slot");
        }
        // Setup is over, so a request gets what the product gives: "on it" and a plan, never a refusal, and never a
        // claim that anything is done or started.
        if (before.graduated) return say(draft, planLine(after, lang), "confirm_slot");
        // An errand waits for the end of setup, which the reply says as a plan rather than a refusal.
        const tail = TASK_LEAD.test(call.args.need)
          ? pick(lang, " it's first on my list, and i'll get on it right after setup.", " va primero en mi lista, justo después de la configuración.")
          : !after.agentName
            ? " the fastest way for me to get on it is a quick setup."
            : "";
        return say(draft, `${needAck(after, lang)}${tail}`, "confirm_slot");
      }
      case "clear_help_need":
        if (!ok) return;
        draft.final = true;
        return say(draft, pick(lang, "okay, scratch that.", "vale, olvídalo."), "chat");
      case "send_gmail_link": {
        if (r.gmail === "claim") return;
        if (!ok) return say(draft, `you're already connected as ${after.gmail.email ?? "your account"}.`, "confirm_account");
        if (output.hint === LINK_ALREADY_SENT) return say(draft, "the link's right up there. tap it whenever.", "link_reminder");
        const text =
          call.args.reason === "more_access"
            ? "here's a new link for that. gmail stays connected while you add it."
            : call.args.fresh && before.gmail.status === "connected"
              ? "here's a fresh link. pick the right account this time."
              : pick(lang, "here's your secure link. i never send or delete anything without asking.", "aquí tienes tu enlace seguro. nunca envío ni borro nada sin preguntarte.");
        draft.final = true;
        return say(draft, text, "gmail_link");
      }
      case "request_location":
        // The card asks; this line only says why, and nothing else is asked this turn.
        draft.final = true;
        if (ok) return say(draft, pick(lang, "tap share below so i can look near you.", "toca compartir abajo para buscar cerca de ti."), "chat");
        if (output?.error === "already_requested") return say(draft, pick(lang, "the location card's right up there.", "la tarjeta de ubicación está ahí arriba."), "chat");
        if (output?.error === "already_shared") return say(draft, pick(lang, "already got your location, thanks.", "ya tengo tu ubicación, gracias."), "chat");
        return;
      case "send_dashboard_link":
        draft.final = true;
        return say(draft, pick(lang, "here's your dashboard. your settings live there.", "aquí tienes tu panel. ahí están tus ajustes."), "dashboard_link");
      case "start_call":
        if (ok) {
          draft.ringing = true;
          draft.final = true;
          return say(draft, freshLine(RINGING[lang], ctx.recent ?? []) ?? RINGING[lang][0] ?? "", "call_ringing");
        }
        return say(draft, "we're already on a call.", "chat");
      case "schedule_call": {
        if (!ok) {
          const text = scheduleRefusal(output?.error);
          // A refusal that asks something is this turn's one question.
          if (text.endsWith("?")) draft.final = true;
          return say(draft, text, "chat");
        }
        const at = after.call.scheduledFor;
        const when = "in_minutes" in call.args ? `in ${formatMinutes(call.args.in_minutes)}` : at ? `at ${clockIn(at, after.timeZone)}` : "then";
        return say(draft, `no problem, i'll call you ${when}.`, "call_scheduled");
      }
      case "graduate": {
        if (!ok || output.hint) return;
        draft.final = true;
        const { reason } = call.args;
        const line = reason === "need_first" ? needFirstLine(lang) : reason === "user_requested" ? setupSkippedLine(lang) : recapLine(after);
        return say(draft, line.text, line.kind);
      }
      default:
        return;
    }
  });
}

function scheduleRefusal(error: string | undefined): string {
  switch (error) {
    case "time_zone_unknown":
      return "i can't see your time zone from here. how many minutes from now works?";
    case "invalid_time":
      return "that time doesn't look right. when should i call?";
    default:
      return "we're already on a call.";
  }
}

function describeFallback(before: Session, r: Reading, ctx: Context, draft: Draft): void {
  const { lang } = ctx;
  if (ctx.first) return;
  if (r.retract) {
    say(draft, pick(lang, "okay, scratch that.", "vale, olvídalo."), "chat");
    draft.final = true;
    return;
  }
  if (before.graduated) {
    say(draft, r.thanks ? "anytime." : r.greeting ? "hey! what can i do for you?" : "i'm here. what can i do for you?", "chat");
    draft.final = true;
    return;
  }
  if (r.need === "") {
    say(draft, "happy to. what with?", "ask_slot");
    draft.final = true;
    draft.asked = "helpNeed";
  } else if (r.bye) {
    say(draft, "talk soon. text me whenever.", "chat");
    draft.final = true;
  } else if (r.hold) {
    say(draft, pick(lang, "i'm here. go ahead.", "aquí estoy. dime."), "chat");
    draft.final = true;
  } else if (r.greeting) say(draft, pick(lang, "hey!", "¡hola!"), "chat");
  else if (r.thanks) say(draft, pick(lang, "anytime.", "¡de nada!"), "chat");
  else if (r.ack === "yes") {
    // A plain yes gets a check tapback, as Persona's agent gives one.
    draft.react = "check";
    say(draft, pick(lang, "perfect.", "perfecto."), "chat");
  }
  else if (r.ack === "no") say(draft, pick(lang, "all good.", "sin problema."), "chat");
  else if (r.unclear === "gibberish") {
    say(draft, pick(lang, ctx.expecting === "agentName" ? "that's a lot of consonants." : "didn't catch that.", "no te entendí."), "gibberish");
  } else if (r.unclear === "no_words") say(draft, "love the energy, but i'll need words.", "gibberish");
  else if (r.unclear === "unknown") say(draft, pick(lang, "not sure i follow.", "perdona, no te entendí."), "chat");
}

const LAZY_GMAIL = new Set<HelpCategory>(["inbox", "bills", "subscriptions", "travel", "shopping", "appointments"]);

function describeAsk(before: Session, after: Session, ctx: Context, draft: Draft): void {
  const { lang } = ctx;
  if (draft.ringing || isCallLive(after) || after.consent.stoppedAt) return;
  if (after.graduated) {
    // After graduation, missing pieces are asked for only when the request needs them.
    const needsGmail =
      before.graduated &&
      after.helpNeed &&
      LAZY_GMAIL.has(after.helpNeed.category) &&
      !["connected", "link_sent"].includes(after.gmail.status);
    const fresh = before.graduated && after.helpNeed && after.helpNeed.setAt !== before.helpNeed?.setAt;
    if (needsGmail && fresh) {
      say(draft, "i'll need gmail for that one. want the link?", "ask_slot", { quickReplies: CHIPS[lang].gmail });
      draft.asked = "gmail";
    } else if (fresh) {
      say(draft, pick(lang, "want a reminder about it tomorrow?", "¿te lo recuerdo mañana?"), "chat");
    }
    return;
  }
  const next = nextBestAsk(after, "text");
  // While the link is out, the thread already holds the ask.
  if (next.slot === "none" || (next.slot === "gmail" && after.gmail.status === "link_sent")) return;
  const count = after.steering.askCounts[next.slot] ?? 0;
  // The opening turn asks for a name in Persona's own words, closing the opening bubbles.
  const text = ctx.first && next.slot === "agentName" ? OPENING[lang].ask : freshAsk(next.slot, count, lang, ctx.recent ?? []);
  // Every wording is already in the thread, so this turn moves on instead of asking the same thing again.
  if (!text) return;
  const chips =
    next.slot === "call_offer" ? CHIPS[lang].call : next.slot === "gmail" ? CHIPS[lang].gmail : next.slot === "graduation_offer" ? CHIPS[lang].graduation : undefined;
  const kind: EventKind =
    next.slot === "call_offer" ? "call_offer" : next.slot === "graduation_offer" ? "chat" : draft.parts.at(-1)?.kind === "gibberish" ? "gibberish" : "ask_slot";
  say(draft, text, kind, chips ? { quickReplies: chips } : {});
  draft.asked = next.slot;
}

function bubble(group: Part[]): Line {
  const last = group[group.length - 1];
  return { text: group.map((part) => part.text).join(" "), kind: last?.kind ?? "chat", ...(last?.quickReplies && { quickReplies: last.quickReplies }) };
}

// Where a turn breaks into its two bubbles at most: right after the naming line, so the contact card follows it;
// otherwise before the closing line, once a single bubble would run long. On the first turn, whatever it adds to the
// intro and the terms goes in one bubble, in the opening's sentence case, and Persona's name ask keeps its own.
function groupsOf(parts: Part[], first: boolean): Part[][] {
  if (first) return parts.length > 1 && parts.at(-1)?.kind === "ask_slot" ? [parts.slice(0, -1), parts.slice(-1)] : [parts];
  const cardAt = parts.findIndex((part) => part.card);
  if (cardAt >= 0) return [parts.slice(0, cardAt + 1), parts.slice(cardAt + 1)];
  const length = parts.reduce((n, part) => n + part.text.length, 0);
  return parts.length <= 1 || length <= 120 ? [parts] : [parts.slice(0, -1), parts.slice(-1)];
}

/**
 * The opening on a first turn, then at most two text bubbles, with the contact card right after the line that names
 * the agent. `names` are the names the turn saved, which keep their capitals in the opening.
 */
function pack(parts: Part[], first: boolean, lang: Lang, names: (string | undefined)[] = []): Line[] {
  const reply = groupsOf(parts, first)
    .filter((group) => group.length > 0)
    .flatMap((group) => {
      const card = group.find((part) => part.card)?.card;
      const line = bubble(group);
      // Once the agent is named the product voice is lowercase, even inside the opening.
      const shown = first && !card ? { ...line, text: properCase(line.text, names) } : line;
      return card ? [shown, contactCardLine(card)] : [shown];
    });
  return first ? [...openingLines(lang), ...reply] : reply;
}

// As Persona does, a delete request over text gets the dashboard, where Delete account erases everything after one
// confirm. It works while paused too, since stopping never locks anyone out of their data.
function privacyTurn(r: Reading, ctx: Context): TextReply {
  if (r.del) {
    const part: Part = { text: DASHBOARD_DELETE[ctx.lang], kind: "dashboard_link" };
    return { bubbles: pack([part], ctx.first, ctx.lang), tools: [{ name: "send_dashboard_link", args: {} }] };
  }
  const paused = pick(
    ctx.lang,
    "you're paused. text start to pick back up, or delete everything to wipe your data.",
    "estás en pausa. escribe seguir para continuar, o borra todo para eliminar tus datos.",
  );
  return { bubbles: [{ text: paused, kind: "stopped" }], tools: [] };
}

// Only Google knows whether the disconnect went through, so one that the reducer allows says nothing here: the server
// texts what Google answered once the revoke is back (lib/gmail/disconnect.ts). Paused or not, since it only takes access away.
function disconnectTurn(session: Session, ctx: Context): TextReply {
  const call: Proposal = { name: "disconnect_google", args: {} };
  if (simulate(session, "text", [call]).outputs[0]?.ok) return { bubbles: pack([], ctx.first, ctx.lang), tools: [call] };
  const none = pick(ctx.lang, "there's no google connected, so nothing to disconnect.", "no tienes ningún google conectado, así que no hay nada que desconectar.");
  return { bubbles: pack([{ text: none, kind: "chat" }], ctx.first, ctx.lang), tools: [] };
}

/** One text turn. `history` is the recent thread; it only resolves short replies against the last agent bubble. */
export function mockTextTurn(session: Session, texts: string[], history: SessionEvent[] = []): TextReply {
  const ctx = textContext(session, texts, history);
  const r = read(texts, ctx);
  if (r.disconnect) return disconnectTurn(session, ctx);
  if (session.consent.stoppedAt || r.del) return privacyTurn(r, ctx);

  const proposals = proposeTools(r, ctx, texts);
  // A plain yes right after the inbox fact takes the offer it ended on, which becomes the need, made specific.
  const offer = r.ack === "yes" && !r.retract ? valueOfferNeed(history) : null;
  if (offer) proposals.push({ name: "set_help_need", args: { need: offer } });
  let run = simulate(session, "text", proposals);
  const graduation = graduationFor(run.session, r);
  if (graduation) {
    proposals.push(graduation);
    run = simulate(session, "text", proposals);
  }
  const declining = r.call === "no" && !isCallLive(run.session);
  const after = declining ? { ...run.session, call: { ...run.session.call, status: "declined" as const } } : run.session;

  const draft: Draft = { parts: [], final: false, ringing: false, ...(offer && { offer: true, react: "check" as const }) };
  describeSides(session, after, r, ctx, draft);
  if (declining) {
    const text =
      session.call.status === "declined"
        ? "heard you, no calls."
        : pick(ctx.lang, "all good, we can do it right here.", "sin problema, seguimos por aquí.");
    say(draft, text, "continue_text");
  }
  describeTools(session, after, proposals, run.outputs, r, ctx, draft);
  if (draft.parts.length === 0) describeFallback(session, r, ctx, draft);
  if (!draft.final) describeAsk(session, after, ctx, draft);

  const notes: TurnNotes = {
    ...(draft.asked && { asked: draft.asked }),
    ...(r.offTopic && { offTopic: true }),
    ...(declining && { declinedCall: true }),
  };
  const parts = [...draft.parts.filter((p) => !p.closing), ...draft.parts.filter((p) => p.closing)];
  const thread = answeredIndex(texts, ctx);
  return {
    bubbles: pack(parts, ctx.first, ctx.lang, [after.agentName?.value, after.userName?.value]),
    tools: proposals,
    ...(draft.react && { react: { type: draft.react } }),
    ...(thread !== undefined && { replyTo: thread }),
    notes,
  };
}
