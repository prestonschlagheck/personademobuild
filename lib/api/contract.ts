import { z } from "zod";
import type { ToolOutput } from "@/lib/agent/tools";
import { callEndReasonSchema, reactionTypeSchema, type Snapshot } from "@/lib/session/schema";

// Request bodies for every route. The UI and the test harness both go through these.

const clientMsgId = z.uuid();

/** The longest text one message may carry. The composer stops a paste here, so the server never has to refuse one. */
export const MAX_TEXT = 2000;
/** The most texts one turn may carry. A longer burst goes out over several turns. */
export const MAX_BATCH = 10;

export const turnRequest = z.object({
  messages: z
    // replyTo: the event an inline reply threads under, as iMessage's Reply does.
    .array(z.object({ clientMsgId, text: z.string().trim().min(1).max(MAX_TEXT), replyTo: z.uuid().optional() }))
    .min(1)
    .max(MAX_BATCH),
  timeZone: z.string().max(64).optional(),
});

export const reactRequest = z.object({ targetId: z.string(), type: reactionTypeSchema.nullable() });

export const contactRequest = z.object({ saved: z.literal(true) });

// Share My Location: the browser's position, already rounded by the client and rounded again by the server, or why
// the browser gave none.
export const locationRequest = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("shared"),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    accuracy: z.number().nonnegative().max(1_000_000),
  }),
  z.object({ status: z.literal("denied"), reason: z.enum(["denied", "unavailable", "timeout"]) }),
]);
export type LocationRequest = z.infer<typeof locationRequest>;

// The dashboard's Delete account, sent only after its confirm step.
export const deleteAccountRequest = z.object({ confirmed: z.literal(true) });

export const callStartRequest = z.object({ initiator: z.enum(["agent", "user"]) });

// `sdp` is the browser's WebRTC offer in live mode; mock mode sends none.
export const callAcceptRequest = z.object({ attempt: z.number().int(), sdp: z.string().max(20000).optional() });

// `message` declines with one of the ring screen's canned texts, which the agent answers on its own.
export const callDeclineRequest = z.object({
  attempt: z.number().int(),
  action: z.enum(["decline", "remind_later", "missed", "message"]),
});

export const callEndRequest = z.object({ attempt: z.number().int(), reason: callEndReasonSchema });

export const heartbeatRequest = z.object({ attempt: z.number().int() });

export const transcriptRequest = z.object({
  attempt: z.number().int(),
  itemId: z.string().max(100),
  role: z.enum(["user", "agent"]),
  text: z.string().trim().min(1).max(2000),
  latencyMs: z.number().nonnegative().optional(),
});

// Comfortably above anything a real tool call needs (see lib/agent/tools.ts's own args schemas), so this only
// ever catches a body built to be big, not a real one.
const MAX_TOOL_ARGS_BYTES = 8 * 1024;

const toolArgs = z.unknown().refine((value) => {
  try {
    return new TextEncoder().encode(JSON.stringify(value ?? null)).length <= MAX_TOOL_ARGS_BYTES;
  } catch {
    return false;
  }
}, `args must be under ${MAX_TOOL_ARGS_BYTES} bytes once serialized`);

export const toolRequest = z.object({
  attempt: z.number().int(),
  toolCallId: z.string().max(100),
  name: z.string().max(40),
  args: toolArgs,
});

export type TurnRequest = z.infer<typeof turnRequest>;
export type CallAcceptRequest = z.infer<typeof callAcceptRequest>;
export type CallDeclineRequest = z.infer<typeof callDeclineRequest>;
export type CallEndRequest = z.infer<typeof callEndRequest>;
export type TranscriptRequest = z.infer<typeof transcriptRequest>;
export type ToolRequest = z.infer<typeof toolRequest>;

export type ApiError = { error: string; hint?: string };

// Every mutating route answers with a fresh snapshot so the client never waits for the next poll.
export type CallAcceptResponse = Snapshot & {
  connection: { mode: "live"; sdp: string; callId: string } | { mode: "mock"; callId: string };
};

export type ToolResponse = Snapshot & { output: ToolOutput };
