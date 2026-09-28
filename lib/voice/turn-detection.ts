// How a call hears the caller. The server's voice detection only marks where their speech starts and stops; the
// browser (lib/voice/webrtc.ts) decides what gets an answer and when the agent is cut off, since only it can tell
// the caller's words from the agent's own voice coming back through a speaker.

export type TurnDetection =
  | { type: "server_vad"; threshold: number; silence_duration_ms: number; prefix_padding_ms: number; create_response: false; interrupt_response: false }
  | { type: "semantic_vad"; eagerness: "auto"; create_response: false; interrupt_response: false };

/** "server" marks the end of a turn 400 ms into silence; "semantic" judges from the words, which can take seconds. */
export function turnDetectionFor(mode: "server" | "semantic"): TurnDetection {
  return mode === "semantic"
    ? { type: "semantic_vad", eagerness: "auto", create_response: false, interrupt_response: false }
    : { type: "server_vad", threshold: 0.6, silence_duration_ms: 400, prefix_padding_ms: 300, create_response: false, interrupt_response: false };
}
