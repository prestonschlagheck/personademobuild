import type { CallAcceptResponse } from "@/lib/api/contract";
import type { Session } from "@/lib/session/schema";

// The seam between the call controller and whatever carries the audio. The live transport speaks
// OpenAI Realtime over WebRTC; the mock replays the same event names from the local brain, so the
// controller cannot tell them apart.

export type Connection = CallAcceptResponse["connection"];

/** How fast the agent talks, over the voice's own pace: a touch quicker keeps the call moving. */
export const VOICE_SPEED = 1.1;

/**
 * The agent's spoken words in the product voice, live on screen and saved alike: lowercase with straight apostrophes,
 * and a spoken dash only a pause. The saved names get their own capitals on top (withNames, properCase).
 */
export const voiced = (text: string) => text.toLowerCase().replace(/[‘’]/g, "'").replace(/\s*[–—]\s*/g, ", ");

/** The subset of Realtime server events the controller acts on. */
export type ServerEvent =
  | { type: "input_audio_buffer.speech_started"; item_id?: string }
  | { type: "input_audio_buffer.speech_stopped"; item_id?: string }
  | { type: "input_audio_buffer.timeout_triggered" }
  | { type: "conversation.item.input_audio_transcription.delta"; item_id: string; delta: string }
  | { type: "conversation.item.input_audio_transcription.completed"; item_id: string; transcript: string }
  | { type: "conversation.item.input_audio_transcription.failed"; item_id: string }
  | { type: "response.created" }
  | { type: "response.output_audio_transcript.delta"; item_id: string; delta: string }
  | { type: "response.output_audio_transcript.done"; item_id: string; transcript: string }
  | { type: "response.function_call_arguments.done"; call_id: string; name: string; arguments: string; item_id?: string }
  | {
      type: "response.done";
      response?: {
        status?: string;
        output?: unknown[];
        status_details?: { type?: string; reason?: string; error?: { type?: string; code?: string } | null } | null;
      };
    }
  | { type: "output_audio_buffer.started" }
  | { type: "output_audio_buffer.stopped" }
  | { type: "output_audio_buffer.cleared" }
  // `event_id` is the id of the client event that caused it, when one did.
  | { type: "error"; error?: { code?: string; message?: string; event_id?: string } }
  // Local only (never parsed off the wire): the caller's words so far, from the browser's recognizer, before
  // Realtime's own transcript replaces them.
  | { type: "local.user_caption"; item_id: string; text: string };

const KNOWN = new Set<string>([
  "input_audio_buffer.speech_started",
  "input_audio_buffer.speech_stopped",
  "input_audio_buffer.timeout_triggered",
  "conversation.item.input_audio_transcription.delta",
  "conversation.item.input_audio_transcription.completed",
  "conversation.item.input_audio_transcription.failed",
  "response.created",
  "response.output_audio_transcript.delta",
  "response.output_audio_transcript.done",
  "response.function_call_arguments.done",
  "response.done",
  "output_audio_buffer.started",
  "output_audio_buffer.stopped",
  "output_audio_buffer.cleared",
  "error",
]);

/** Parses one data channel message. Anything the controller does not act on comes back null. */
export function parseServerEvent(raw: string): ServerEvent | null {
  try {
    const data: unknown = JSON.parse(raw);
    if (typeof data !== "object" || data === null || !("type" in data)) return null;
    return typeof data.type === "string" && KNOWN.has(data.type) ? (data as ServerEvent) : null;
  } catch {
    return null;
  }
}

/** The id prefix of tool calls a transport or the harness makes on the model's behalf. Realtime never sees their outputs. */
export const LOCAL_CALL = "local_";

/** Something that happened outside the call: said out loud, or for a rename by text, only kept in mind. */
export type CallNote = {
  note: "value_moment" | "user_texted" | "gmail_result" | "renamed" | "location_shared" | "location_denied";
  text?: string;
  /** With the value moment: the optional Google access granted with Gmail, by name ("calendar and drive"), never its details. */
  extras?: string;
  /** With a text they sent: what that text's own turn already saved, so the call never saves it again. */
  saved?: ("userName" | "helpNeed")[];
};

export type TransportHandlers = {
  onEvent: (event: ServerEvent) => void;
  /** Peer connection health. The mock never reports anything but "connected". */
  onConnectionState: (state: RTCPeerConnectionState) => void;
  /**
   * How the call's replies went, as a code with no words in it ("done:failed:rate_limit_exceeded", "dead_air:ask"),
   * for the production record of a call that went quiet. Only the live transport reports any.
   */
  onDiag?: (code: string) => void;
};

export interface VoiceTransport {
  /** Builds the local side and returns the SDP offer for /api/call/accept, when the transport needs one. */
  offer(): Promise<string | undefined>;
  /**
   * Finishes connecting with the server's answer, then has the agent speak first. `live` runs once the line is up and
   * a moment before the agent's first words, so a sound played there is over before they start.
   */
  start(connection: Connection, session: Session, live?: () => void): Promise<void>;
  /** Hands a tool result back to the model, which continues once every call in the response has one. */
  sendToolOutput(callId: string, output: unknown): void;
  /** Queued until the agent is free, then spoken. */
  sendNote(note: CallNote): void;
  /** Typed speech (the mock's "Type to talk" field, simulations). It interrupts the agent like spoken words do. */
  sendUserText(text: string): void;
  /** Stop treating input as speech. The controller has already disabled the mic track. */
  setMuted(muted: boolean): void;
  setVolume(volume: number): void;
  /** Sends a mic opened again in place of one the device took away, without renegotiating the call. */
  replaceMic(mic: MediaStream): Promise<void>;
  /** Plays the agent again if the device paused it, as a phone can after another app used the audio. */
  resume(): void;
  /** Loudness of the agent's voice right now, 0 to 1. */
  agentLevel(): number;
  /** Whether the agent's voice is sounding right now, for caption timing. Only a transport with real audio has it. */
  agentAudible?(): boolean;
  close(): void;
}
