// The deterministic brain for no-key mode and the fallback when a live turn fails. Isomorphic: the browser's mock
// voice transport runs it too.
export { mockTextTurn } from "@/lib/agent/mock/text";
export { mockVoiceTurn, type VoiceInput } from "@/lib/agent/mock/voice";
