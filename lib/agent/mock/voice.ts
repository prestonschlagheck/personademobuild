import type { Session } from "@/lib/session/schema";
import { ABUSE_CAP, canGraduate, fold, graduationOfferOpen, nextBestAsk, openSlots, wantsToProceed, type AskTarget } from "@/lib/agent/policy";
import { askText, callGreeting, isCallback, needFirstLine, unverifiedLine, type Lang } from "@/lib/agent/messages";
import { endCall, languageOf, pick, proposeTools, read, simulate, type Context, type Proposal } from "@/lib/agent/mock/read";
import { needAck, SKIP_ACKS } from "@/lib/agent/mock/text";
import { LINK_ALREADY_SENT } from "@/lib/agent/tools";
import { silenceStep } from "@/lib/voice/notes";
import type { CallNote } from "@/lib/voice/transport";

// The mock voice turn: a hello by name first with a concrete reason, the Gmail link texted right after their name
// while the need is asked, the value fact spoken when it lands, patience while the user signs in, then a wrap-up.

export type VoiceInput =
  | { type: "start" }
  | { type: "user"; text: string }
  | { type: "silence"; count: number }
  | ({ type: "system" } & CallNote);

// The server counts asks from the transcript, the same way for this brain and the live model.
export type VoiceReply = { say: string; tools: { name: string; args: unknown }[]; end?: boolean };

function voiceAsk(s: Session, lang: Lang, prefix = "", offerGraduation = true): { text: string; asked?: AskTarget } {
  const next = nextBestAsk(s, "voice", { offerGraduation });
  if (next.slot === "none") {
    return { text: pick(lang, "looks like we're all set. anything else before i let you go?", "creo que ya está todo. ¿algo más?") };
  }
  if (next.slot === "gmail" && s.gmail.status === "link_sent") {
    return { text: prefix + pick(lang, "no rush, the gmail link's in your messages whenever you're ready.", "sin prisa, el enlace está en tus mensajes.") };
  }
  return { text: prefix + askText(next.slot, s.steering.callAskCounts?.[next.slot] ?? 0, "voice", lang), asked: next.slot };
}

// "hang up and call me again", "can you call me right back": now, not at a time, which only the thread can book.
const CALL_ME_BACK = /\b(?:call|ring) me (?:right )?(?:back|again)\b/;
const LATER = /\b(?:later|tomorrow|tonight|in (?:an?|\d+|a few)\b|at \d)/;

// A yes to the link just offered: "yeah, send it", "sure", "go ahead".
const AGREES = /^(?:y|ya|yes|yeah|yep|yup|sure|ok(?:ay)?|please|go ahead|do it|send it|si|claro|dale|vale)\b/;

function wrapUp(s: Session, lang: Lang, tools: Proposal[], lead: string, proceed: boolean): VoiceReply {
  const settled = canGraduate(s, "all_slots").ok;
  // Leaving the call is not asking to move on, so a saved need alone graduates only when they said so.
  const graduate: Proposal[] =
    !s.graduated && (settled || (s.helpNeed && proceed)) ? [{ name: "graduate", args: { reason: settled ? "all_slots" : "need_first" } }] : [];
  const who = s.userName ? `, ${s.userName.value}` : "";
  const close = settled
    ? pick(lang, `you're all set${who}. i'll text you a quick recap.`, `listo${who}. te mando un resumen por mensaje.`)
    : pick(lang, "sounds good. i'll text you the rest.", "perfecto. te escribo lo que falta.");
  return { say: lead ? `${lead} ${close}` : close, tools: [...tools, ...graduate, endCall("user_request")], end: true };
}

const WANTED: Record<string, string> = { userName: "your name", helpNeed: "what you need", gmail: "your gmail hooked up" };

/** What a first call is for, said as what it gets done ("calling to get your name..."), never "to get you set up". */
function callReason(s: Session): string {
  if (s.call.scheduledFor) return "calling when you asked.";
  if (isCallback(s)) return "picking up where we left off.";
  const wanted = openSlots(s).flatMap((slot) => (WANTED[slot] ? [WANTED[slot]] : []));
  const list = wanted.length > 2 ? `${wanted.slice(0, -1).join(", ")}, and ${wanted.at(-1)}` : wanted.join(" and ");
  return `calling to get ${list}, so i can start helping.`;
}

// The hello, why it's calling, then one ask. A callback picks up where the last call left off, a booked one says it
// kept the time, and with nothing left to ask it just offers to help. It never opens on the offer to skip the rest:
// they took the call to finish setup.
function opener(s: Session): VoiceReply {
  if (nextBestAsk(s, "voice", { offerGraduation: false }).slot === "none") return { say: `${callGreeting(s)} what can i help you with?`, tools: [] };
  return { say: `${callGreeting(s)} ${voiceAsk(s, "en", `${callReason(s)} `, false).text}`, tools: [] };
}

function voiceNote(s: Session, input: Extract<VoiceInput, { type: "system" }>): VoiceReply {
  switch (input.note) {
    case "value_moment": {
      // The note carries the finding only for a specific need (lib/voice/notes.ts valueNote), and names what else they
      // allowed; a general need hears it came through and one offer.
      const also = input.extras ? `, and your ${input.extras} too` : "";
      const say = input.text
        ? `oh nice, you're connected${also}. ${input.text}`
        : s.gmail.status === "connected" && !s.gmail.valueFact
          ? "you're connected, but i couldn't read your inbox just now. i'll try again in a bit."
          : `oh nice, you're connected${also}. want me to dig into ${input.extras ? "any of it" : "your email"}?`;
      return { say, tools: graduateIfSettled(s) };
    }
    case "gmail_result": {
      // Sign-in was cancelled, refused or hit a dead link. The thread has the details; say so once and move on.
      const lead = "looks like gmail didn't connect. no worries, i texted you the details.";
      if (s.gmail.status === "link_sent") return { say: lead, tools: [] };
      return { say: `${lead} ${voiceAsk(s, "en").text}`, tools: [] };
    }
    case "location_shared":
      return { say: `perfect, i can see your location. ${voiceAsk(s, "en").text}`, tools: [] };
    case "location_denied":
      return { say: "looks like your browser didn't share it. the button in messages still works whenever.", tools: [] };
    case "renamed":
      // The session already carries the new name, so every later line uses it; the rename itself goes unannounced.
      return { say: "", tools: [] };
    case "user_texted": {
      const name = s.userName?.value;
      const lead = name && input.text && fold(input.text).includes(fold(name)) ? "you just texted me your name, got it." : "got your text.";
      return { say: `${lead} ${voiceAsk(s, "en").text}`, tools: [] };
    }
  }
}

function voiceUser(s: Session, text: string): VoiceReply {
  const ctx: Context = {
    session: s,
    channel: "voice",
    lang: languageOf([text], []),
    first: false,
    expecting: nextBestAsk(s, "voice").slot,
    chips: [],
  };
  const { lang } = ctx;
  const r = read([text], ctx);

  // The call hears whether Google confirmed only after the tool runs, so this says what is under way, not that it's done.
  if (r.disconnect) return { say: "okay, disconnecting your google now.", tools: [{ name: "disconnect_google", args: {} }] };
  if (r.del === "confirm") {
    return { say: "done. i'm deleting everything now.", tools: [{ name: "delete_my_data", args: { confirmed: true } }, endCall("user_request")], end: true };
  }
  if (r.del === "ask") return { say: "i can wipe everything i have on you. say delete everything to confirm.", tools: [] };
  if (r.abusive && s.steering.abuseStrikes + r.abusive >= ABUSE_CAP - 1) {
    return { say: "let's pick this up another time. i'll text you.", tools: [endCall("abuse")], end: true };
  }
  if (CALL_ME_BACK.test(fold(text)) && !LATER.test(fold(text))) {
    return { say: pick(lang, "sure, calling you right back.", "claro, te llamo enseguida."), tools: [endCall("user_request", true)], end: true };
  }

  const proposals = proposeTools(r, ctx, [text]);
  const claimsGmail = (r.gmail === "claim" || r.injection) && s.gmail.status !== "connected";
  const linkNeeded = s.gmail.status === "not_started" || s.gmail.status === "error";
  // A yes right after the offer to skip the rest takes it: the need is saved, so setup ends here.
  const takesOffer = (graduationOfferOpen(s) || ctx.expecting === "graduation_offer") && Boolean(s.helpNeed) && AGREES.test(fold(text));
  if (takesOffer && !s.graduated) proposals.push({ name: "graduate", args: { reason: "need_first" } });
  // The link goes out right after their name, unasked, while the need is asked; on a yes to an offer of it; or in
  // answer to a fake "it's connected", so the attempt becomes a next step.
  const agrees = ctx.expecting === "gmail" && AGREES.test(fold(text));
  const named = !s.userName && Boolean(simulate(s, "voice", proposals).session.userName);
  if (linkNeeded && !takesOffer && (agrees || claimsGmail || named) && !proposals.some((p) => p.name === "send_gmail_link")) {
    proposals.push({ name: "send_gmail_link", args: { fresh: false } });
  }
  const sending = proposals.some((p) => p.name === "send_gmail_link");
  const unasked = sending && named && !agrees && !claimsGmail;

  const run = simulate(s, "voice", proposals);
  const after = run.session;
  const parts: string[] = [];

  if (claimsGmail) {
    const minted = after.gmail.linkSentAt !== s.gmail.linkSentAt;
    parts.push(minted ? "only google can flip that switch, so i just texted you the link." : "only google can flip that switch. the link's in your messages.");
  }
  if (r.retract) parts.push(pick(lang, "okay, scratch that.", "vale, olvídalo."));
  if (r.unverified) parts.push(unverifiedLine().text);
  if (r.accountPicker) parts.push("yep, pick the one you actually use. i'll never send anything without asking.");
  if (r.side) parts.push(r.side.text);
  if (r.abusive) parts.push("fair, setup is annoying. i'll keep it quick.");

  proposals.forEach((call, i) => {
    const ok = run.outputs[i]?.ok === true;
    switch (call.name) {
      case "set_agent_name":
        parts.push(ok ? `${after.agentName?.value ?? call.args.name} it is.` : "let's pick a different name.");
        break;
      case "set_user_name": {
        if (!ok) {
          parts.push(pick(lang, "sorry, didn't catch your name.", "perdona, no entendí tu nombre."));
          break;
        }
        const name = after.userName?.value ?? call.args.name;
        // With the link going out in the same breath, it joins the welcome, so the turn stays two sentences.
        const link = unasked ? pick(lang, ", i'm texting you a google link to tap whenever.", ", te mando un enlace de google para cuando quieras.") : ".";
        parts.push(s.userName ? `got it, ${name} from now on.` : pick(lang, `nice to meet you, ${name}${link}`, `mucho gusto, ${name}${link}`));
        break;
      }
      case "skip_slot":
        if (ok) parts.push(SKIP_ACKS[call.args.slot]);
        break;
      case "set_help_need":
        if (ok) parts.push(needAck(after, lang));
        break;
      case "send_gmail_link":
        if (ok && !claimsGmail && !unasked) parts.push(run.outputs[i]?.hint === LINK_ALREADY_SENT ? "the link's in your messages." : "just texted it to you.");
        break;
      case "graduate":
        if (ok) parts.push(needFirstLine(lang).text);
        break;
      case "request_location":
        parts.push(
          ok
            ? pick(lang, "i just texted you a location request, tap share my location in messages.", "te mandé una solicitud de ubicación, toca compartir en mensajes.")
            : pick(lang, "the location request's in your messages.", "la solicitud de ubicación está en tus mensajes."),
        );
        break;
      default:
        break;
    }
  });

  const lead = parts.join(" ");
  if (r.bye) return wrapUp(after, lang, proposals, lead, wantsToProceed([text]));
  // The last piece settling is not a goodbye: say they're set and ask if there's anything else, and hang up on their bye.
  if (!canGraduate(s, "all_slots").ok && canGraduate(after, "all_slots").ok) {
    return { say: [lead, voiceAsk(after, lang).text].filter(Boolean).join(" "), tools: [...proposals, { name: "graduate", args: { reason: "all_slots" } }] };
  }

  if (parts.length === 0) {
    const missed = r.unclear === "gibberish" || r.unclear === "no_words";
    parts.push(missed ? pick(lang, "sorry, didn't catch that.", "perdona, no te entendí.") : pick(lang, "got it.", "vale."));
  }
  const ask = voiceAsk(after, lang, unasked ? pick(lang, "meanwhile, ", "mientras, ") : "");
  const skipAsk = takesOffer || (sending && ask.asked === undefined && after.gmail.status === "link_sent");
  const say = skipAsk ? parts.join(" ") : `${parts.join(" ")} ${ask.text}`;
  return { say, tools: proposals };
}

// On a call the last slot can settle without the user saying a word (Gmail connecting), so these turns graduate too.
const graduateIfSettled = (s: Session): Proposal[] =>
  !s.graduated && canGraduate(s, "all_slots").ok ? [{ name: "graduate", args: { reason: "all_slots" } }] : [];

// The live transport's silence rule: quiet patience, one soft check-in, then a goodbye only after a long silence.
function silenceTurn(s: Session, count: number): VoiceReply {
  switch (silenceStep(s, count)) {
    case "check_in":
      return { say: s.gmail.status === "link_sent" ? "no rush, i'm here while you sign in." : "take your time, i'm here.", tools: [] };
    case "wait":
      return { say: "", tools: [] };
    case "goodbye":
      return { say: "i'll text you the rest.", tools: [...graduateIfSettled(s), endCall("silence")], end: true };
  }
}

/** One voice turn. Returns what to say, the tools to relay, and whether to hang up after speaking. */
export function mockVoiceTurn(session: Session, input: VoiceInput): VoiceReply {
  switch (input.type) {
    case "start":
      return opener(session);
    case "silence":
      return silenceTurn(session, input.count);
    case "system":
      return voiceNote(session, input);
    case "user":
      return voiceUser(session, input.text);
  }
}
