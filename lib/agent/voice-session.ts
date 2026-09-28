import { eventText } from "@/lib/agent/messages";
import { fold, usedStockPhrases } from "@/lib/agent/policy";
import { profileLine, withProfile } from "@/lib/agent/profile";
import { buildSystemPrompt } from "@/lib/agent/prompt";
import { toolSpecs } from "@/lib/agent/tools";
import { googleToolSpecs } from "@/lib/gmail/tools";
import { voiceTurnDetection } from "@/lib/server/config";
import type { Session, SessionEvent } from "@/lib/session/schema";
import { VOICE_SPEED } from "@/lib/voice/transport";
import { turnDetectionFor } from "@/lib/voice/turn-detection";

// The OpenAI Realtime session for one call. Instructions and tools come from the same prompt builder
// and tool table as the text agent, so both runtimes share one brain.

// Onboarding is short and simple: the mini model sounds the same (same voices), answers faster, and its
// audio costs about a third of gpt-realtime-2.1 ($20 vs $64 per million output tokens).
const REALTIME_MODEL = "gpt-realtime-2.1-mini";

// The onboarding tools plus the Google tools, which refuse until Gmail is connected.
const VOICE_TOOLS = [...toolSpecs("voice"), ...googleToolSpecs()].map((spec) => ({ type: "function" as const, ...spec }));
const VOICE_TOOL_NAMES = new Set(VOICE_TOOLS.map((tool) => tool.name));

export const isVoiceTool = (name: string) => VOICE_TOOL_NAMES.has(name);

// How much of the thread a call opens knowing. The instructions are re-read by every reply on the call, and the voice
// model's tokens per minute run out fast, so this stays to the recent thread.
// About the last 10 back-and-forths.
const CONTEXT_EVENTS = 20;
// Long enough for most of a list they texted, which a call is often asked about.
const CONTEXT_LINE = 600;
// A text that only asks for the call ("call me", "ring me back", "can you call me to set up"), which raises no topic.
const CALL_ASK =
  /^(?:[\p{L}']+[\s,]+){0,3}(?:call|ring|phone) me(?:\s+(?:back|now|again|please|pls|asap))*(?:\s+to (?:set ?(?:it |this |things |everything )?up|finish(?: (?:setup|up|this))?))?[\s.!?]*$/u;

/**
 * What happened before this call, oldest first: the text thread and earlier calls. The call's own words live in the
 * Realtime conversation, so they are left out here. Without it a call knows the saved state but not what was said.
 */
export function priorConversation(session: Session, events: SessionEvent[]): string | null {
  const lines = events
    .filter((e) => !(e.channel === "voice" && e.meta?.callAttempt === session.call.attempts))
    .filter((e) => !["reaction", "tool_call", "contact_card", "voice_diag", "client_error"].includes(e.meta?.kind ?? ""))
    .slice(-CONTEXT_EVENTS)
    .map((e) => {
      if (e.channel === "system") return `[${e.meta?.kind ?? "event"}] ${e.content}`;
      const who = e.role === "user" ? "them" : "you";
      return `${who}${e.channel === "voice" ? " (on an earlier call)" : ""}: ${eventText(e).slice(0, CONTEXT_LINE)}`;
    });
  if (!lines.length) return null;
  // What they last texted may be why they're on the phone now, so it is named outright, not left for the model to find
  // at the end of a long thread. A saved need is what the call is about, and a text that only asked for the call
  // raises nothing, so neither leads: a quoted "call me" only gets said back to them.
  const latest = session.helpNeed
    ? []
    : events
        .filter((e) => e.channel === "text" && e.role === "user" && e.meta?.kind !== "reaction")
        .slice(-3)
        .filter((e) => !CALL_ASK.test(fold(e.content).trim()));
  const lead = latest.length
    ? `\ntheir latest texts, newest last: ${latest.map((e) => `"${e.content.slice(0, CONTEXT_LINE)}"`).join(", ")}. if one raises something they want to talk about or get help with, start there, without quoting it back; setup chatter is not that.`
    : "";
  return `## the conversation so far\noldest first. use it to remember what they asked for and said; the state above is the truth for what is saved.\n${lines.join("\n")}${lead}`;
}

/** The stock phrases the thread already used, which a call never says again (the text side holds its own lines to it). */
function usedPhrasesRule(events: SessionEvent[]): string | null {
  const used = usedStockPhrases(events.filter((e) => e.role === "agent" && e.channel !== "system").map((e) => e.content));
  return used.length ? `## already said\nthe thread already used these stock phrases, so never say them on this call: ${used.map((phrase) => `"${phrase}"`).join(", ")}.` : null;
}

export const liveTurnDetection = () => turnDetectionFor(voiceTurnDetection());

export function buildVoiceSession(session: Session, events: SessionEvent[] = []) {
  const context = priorConversation(session, events);
  const used = usedPhrasesRule(events);
  // How they like to talk, from the thread as it stands when the call starts, right after the state it belongs to.
  const current = withProfile(session, events);
  const person = profileLine(current.profile);
  return {
    type: "realtime",
    model: REALTIME_MODEL,
    instructions: [buildSystemPrompt(current, "voice"), ...(person ? [person] : []), ...(context ? [context] : []), ...(used ? [used] : [])].join("\n\n"),
    output_modalities: ["audio"],
    audio: {
      input: {
        transcription: { model: "gpt-transcribe" },
        // Tuned for a phone held close or a laptop mic, so room noise does not read as speech.
        noise_reduction: { type: "near_field" },
        // No idle_timeout_ms: the browser times silence itself (lib/voice/webrtc.ts), so the check-in, the
        // patience during Google sign-in and the goodbye follow one rule instead of whatever the model decides.
        turn_detection: liveTurnDetection(),
      },
      // OpenAI's most natural voice, and the one Persona-style casual speech sounds best in, a touch quicker than
      // its own pace so the call keeps moving.
      output: { voice: "marin", speed: VOICE_SPEED },
    },
    tools: VOICE_TOOLS,
    tool_choice: "auto",
  };
}
