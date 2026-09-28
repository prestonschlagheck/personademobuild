import { z } from "zod";

// The one shared record for text and voice. Server-owned: the client only renders it.

export const SLOTS = ["agentName", "userName", "helpNeed", "gmail"] as const;
export const slotSchema = z.enum(SLOTS);
export type Slot = z.infer<typeof slotSchema>;

const sourceSchema = z.enum(["text", "voice"]);

const filled = z.object({ value: z.string(), source: sourceSchema, setAt: z.string() });
export type Filled = z.infer<typeof filled>;

export const helpCategorySchema = z.enum(["inbox", "calendar", "appointments", "bills", "subscriptions", "travel", "shopping", "calls", "other"]);
export type HelpCategory = z.infer<typeof helpCategorySchema>;

// "disconnected": they had the agent disconnect Google, so it is settled for onboarding and a new link still connects it.
const gmailStatusSchema = z.enum(["not_started", "link_sent", "connected", "denied", "error", "skipped", "disconnected"]);
export type GmailStatus = z.infer<typeof gmailStatusSchema>;

const callStatusSchema = z.enum([
  "not_offered",
  "offered",
  "ringing",
  "active",
  "ended",
  "declined",
  "missed",
  "failed",
  "scheduled",
]);
export type CallStatus = z.infer<typeof callStatusSchema>;

export const callEndReasonSchema = z.enum([
  "user_hangup",
  "agent_end",
  "network",
  // The mic could not be opened: blocked by the browser, missing from the device, or held by another app.
  "mic_denied",
  "mic_missing",
  "mic_busy",
  "tab_closed",
  "timeout",
  "error",
]);
export type CallEndReason = z.infer<typeof callEndReasonSchema>;
/** A call the mic stopped before it started. Each has its own fix, and none of them dropped. */
export const MIC_END_REASONS: readonly CallEndReason[] = ["mic_denied", "mic_missing", "mic_busy"];

export const graduationReasonSchema = z.enum(["all_slots", "user_requested", "need_first"]);
export type GraduationReason = z.infer<typeof graduationReasonSchema>;

const reminderSchema = z.object({
  id: z.string(),
  at: z.string(),
  what: z.string(),
  setAt: z.string(),
  sentAt: z.string().optional(),
  cancelledAt: z.string().optional(),
});
export type Reminder = z.infer<typeof reminderSchema>;

export const sessionSchema = z.object({
  id: z.string(),
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),

  agentName: filled.nullable(),
  userName: filled.nullable(),
  /** `label` is the need in a few words, for the state panel; `value` is the sentence the agents work from. */
  helpNeed: filled.extend({ category: helpCategorySchema, label: z.string().optional() }).nullable(),

  gmail: z.object({
    status: gmailStatusSchema,
    email: z.string().optional(),
    connectedAt: z.string().optional(),
    scopes: z.array(z.string()).optional(),
    linkSentAt: z.string().optional(),
    /**
     * A new link sent while Gmail stays connected, to grant access they left unticked (Calendar, Drive). The status
     * stays "connected", with its email and facts, until the new grant lands.
     */
    pendingLinkAt: z.string().optional(),
    /** When they opened the current link (the OAuth start), so a quiet call tab gets extra time only while they sign in. */
    openedAt: z.string().optional(),
    /** When the one reminder for the current link went out, so it is never repeated. */
    remindedAt: z.string().optional(),
    valueFact: z.string().optional(),
    /** The one Calendar fact, computed in code at connect, when read-only Calendar was granted. */
    calendarFact: z.string().optional(),
    /** The one Drive fact (top-level folder names), computed in code at connect, when read-only Drive was granted. */
    driveFact: z.string().optional(),
  }),

  call: z.object({
    status: callStatusSchema,
    attempts: z.number().int(),
    initiator: z.enum(["agent", "user"]).optional(),
    ringingAt: z.string().optional(),
    startedAt: z.string().optional(),
    endedAt: z.string().optional(),
    lastEndReason: callEndReasonSchema.optional(),
    scheduledFor: z.string().optional(),
    activeCallId: z.string().optional(),
    /** How many texts this call has put in the thread with send_text. Every ring starts a new call object, so it resets. */
    textsSent: z.number().int().optional(),
  }),

  /** `sentAt`: when send_contact_card last texted the card again, so asking twice in a row sends one. */
  contact: z.object({ savedAt: z.string().optional(), sentAt: z.string().optional() }),

  /**
   * The latest location request, tied to the need it was sent for (that need's `setAt`) when there was one. A share
   * keeps only a coarse point, rounded to two decimals (about 1 km), with the browser's accuracy in meters, and the town it
   * is in when the geocoder named one.
   */
  location: z
    .object({
      requestedAt: z.string(),
      forNeed: z.string().optional(),
      sharedAt: z.string().optional(),
      deniedAt: z.string().optional(),
      coarse: z.object({ lat: z.number(), lng: z.number(), accuracyM: z.number() }).optional(),
      /** The town that point is in, like "Columbia, SC", from the reverse geocoder (lib/server/geocode.ts). */
      place: z.string().max(120).optional(),
    })
    .optional(),

  /** The browser's IANA time zone, so "call me at 12:40" means the user's 12:40. */
  timeZone: z.string().optional(),
  /** The language of their latest text, so a call opens in it: a call starts with no thread to read it from. */
  lang: z.enum(["en", "es"]).optional(),
  /**
   * How they like to talk, computed in code from the thread (lib/agent/profile.ts) and saved with each text turn and
   * call end. Only what is known is set: labels, never their words.
   */
  profile: z
    .object({
      channel: z.enum(["text", "call"]).optional(),
      lang: z.enum(["en", "es"]).optional(),
      length: z.enum(["short", "medium", "long"]).optional(),
      tone: z.enum(["casual", "plain"]).optional(),
      pace: z.enum(["quick", "slow"]).optional(),
      /** The local hour, 0 to 23, they text at most, in the session's time zone. */
      hour: z.number().int().min(0).max(23).optional(),
    })
    .optional(),

  /**
   * Texts they asked for at a set time (set_reminder), in their own words. Each is texted once when `at` comes, unless
   * STOP cancelled it first. Missing on sessions saved before any was set, which reads as none.
   */
  reminders: z.array(reminderSchema).optional(),

  consent: z.object({
    termsShownAt: z.string().optional(),
    firstCallAt: z.string().optional(),
    stoppedAt: z.string().optional(),
  }),

  graduated: z.boolean(),
  graduatedAt: z.string().optional(),
  graduationReason: graduationReasonSchema.optional(),

  steering: z.object({
    /** The latest ask of any kind, the call and graduation offers included, so neither is made twice in a row. */
    lastAskedSlot: z.enum([...SLOTS, "call_offer", "graduation_offer"]).optional(),
    askCounts: z.record(z.string(), z.number().int()),
    /** Asks made on the current call alone, reset when a call connects, so every call gets its own tries. */
    callAskCounts: z.record(z.string(), z.number().int()).optional(),
    skipped: z.array(slotSchema),
    offTopicCount: z.number().int(),
    abuseStrikes: z.number().int(),
    /** They asked for the Google link before the agent was named. It goes out the turn it is, ahead of the call. */
    linkPromised: z.boolean().optional(),
    /** The one offer to skip the rest and start on their need went out. */
    graduationOffered: z.boolean().optional(),
    /** They said they'd rather text. No call is offered again until they ask for one themselves. */
    textOnly: z.boolean().optional(),
  }),
});
export type Session = z.infer<typeof sessionSchema>;

// Machine-readable message kinds. Tests assert on these, never on wording.
const EVENT_KINDS = [
  "greeting",
  "ask_slot",
  "confirm_slot",
  "renamed",
  "gibberish",
  "contact_card",
  "call_offer",
  "call_ringing",
  "call_started",
  "call_ended",
  "call_declined",
  "missed_call",
  "call_scheduled",
  "call_conflict",
  "ai_disclosure",
  "recovery",
  "continue_text",
  "welcome_back",
  "gmail_link",
  "dashboard_link",
  "location_request",
  "location_shared",
  "location_denied",
  "link_reminder",
  "reminder",
  "stale_link",
  "value_moment",
  "value_unavailable",
  "oauth_denied_ack",
  "unverified_explainer",
  "confirm_account",
  "mic_help",
  "injection_flag",
  "defer_offtopic",
  "offer_pause",
  "recap",
  "graduated",
  "stopped",
  "reaction",
  "transcript",
  "tool_call",
  "chat",
  "voice_diag",
  "client_error",
] as const;
const eventKindSchema = z.enum(EVENT_KINDS);
export type EventKind = z.infer<typeof eventKindSchema>;

// The six classic tapbacks, then the emoji ones iOS 18 added (a check mark, eyes), as Persona's agent uses them.
export const reactionTypeSchema = z.enum(["love", "like", "dislike", "laugh", "emphasize", "question", "check", "eyes"]);
export type ReactionType = z.infer<typeof reactionTypeSchema>;

/** What the text model took for one turn: wall time across its calls, tokens, and an estimated cost in dollars. */
export const turnMetricsSchema = z.object({
  ms: z.number(),
  calls: z.number().int(),
  inputTokens: z.number().int(),
  cachedTokens: z.number().int(),
  outputTokens: z.number().int(),
  usd: z.number(),
  /** Why the turn needed more than one call: "refused" for a refused action, else the key of each rule the reply broke. */
  retries: z.array(z.string().max(40)).max(20).optional(),
  /** Rules the first reply broke that code fixed without a second call, like a repeated privacy line. */
  fixed: z.array(z.string().max(40)).max(20).optional(),
  /** Every action the dry run refused this turn, as "tool:code", none of which was applied. */
  refused: z.array(z.string().max(60)).max(20).optional(),
  /**
   * Tools code added on its own to the reply that was applied, for what its words claimed or what they asked. One the
   * rules refused is in `refused` as well.
   */
  implied: z.array(z.string().max(40)).max(20).optional(),
  /** Tools the model listed that code took out of any draft of the turn, as "tool:code". */
  dropped: z.array(z.string().max(60)).max(20).optional(),
  /** The processing tier the provider reports it used. */
  tier: z.string().optional(),
  /** Why the live model failed, when the fallback answered instead: the error's name and message, never their words. */
  error: z.string().max(200).optional(),
});
export type TurnMetrics = z.infer<typeof turnMetricsSchema>;

export const eventMetaSchema = z.object({
  kind: eventKindSchema.optional(),
  quickReplies: z.array(z.string()).optional(),
  missing: z.array(slotSchema).optional(),
  /** A rich link card. `preview` picks its image and title; no preview means a Google link. */
  link: z
    .object({ url: z.string(), title: z.string(), subtitle: z.string(), preview: z.enum(["google", "dashboard"]).optional() })
    .optional(),
  contactCard: z.object({ name: z.string() }).optional(),
  reaction: z.object({ targetId: z.string(), type: reactionTypeSchema }).optional(),
  tool: z
    .object({ name: z.string(), args: z.unknown(), ok: z.boolean(), error: z.string().optional() })
    .optional(),
  callAttempt: z.number().int().optional(),
  callSeconds: z.number().optional(),
  latencyMs: z.number().optional(),
  /** On the first bubble of a live text turn: what that turn's model calls took. */
  turn: turnMetricsSchema.optional(),
  /** The live model failed or was refused, so the mock brain or the fixed template wrote this line. */
  fallback: z.boolean().optional(),
  /** Why a live reply fell back to its template: the error's name and message, or the check it failed. */
  error: z.string().max(200).optional(),
  /**
   * On the first bubble of a text sent because a call ended, was declined or rang out: the row that caused it, as
   * "kind:reason" with its seq, how many milliseconds after that row this text was saved, and whether the template wrote it.
   */
  followUp: z.object({ cause: z.string().max(60), causeSeq: z.number().int(), ms: z.number(), template: z.boolean() }).optional(),
  /** An inline reply: the id of the user's message this agent bubble answers, always one from the same turn. */
  replyTo: z.string().optional(),
  /**
   * On a voice_diag row: how a live call's replies went, as "seconds:code" entries with no words in them
   * (lib/client/dev-trace.ts voiceDiag, checked again in lib/server/voice-diag.ts).
   */
  diag: z.array(z.string().max(80)).max(50).optional(),
});
export type EventMeta = z.infer<typeof eventMetaSchema>;

export const eventSchema = z.object({
  seq: z.number().int(),
  id: z.string(),
  at: z.string(),
  channel: z.enum(["text", "voice", "system"]),
  role: z.enum(["user", "agent", "tool", "system"]),
  content: z.string(),
  meta: eventMetaSchema.optional(),
  clientMsgId: z.string().optional(),
  toolCallId: z.string().optional(),
});
export type SessionEvent = z.infer<typeof eventSchema>;
export type NewEvent = Omit<SessionEvent, "seq" | "id" | "at"> & { at?: string };

// Which integrations are real and which are local stand-ins. Shown in the state panel.
export type Modes = {
  text: "live" | "mock";
  voice: "live" | "mock";
  gmail: "live" | "mock";
  store: "durable" | "memory";
};

export type Snapshot = { session: Session; events: SessionEvent[]; lastSeq: number; modes: Modes };

export function newSession(id: string, now: string): Session {
  return {
    id,
    version: 0,
    createdAt: now,
    updatedAt: now,
    agentName: null,
    userName: null,
    helpNeed: null,
    gmail: { status: "not_started" },
    call: { status: "not_offered", attempts: 0 },
    contact: {},
    consent: {},
    graduated: false,
    steering: { askCounts: {}, skipped: [], offTopicCount: 0, abuseStrikes: 0 },
  };
}
