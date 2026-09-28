"use client";

import { useEffect, useRef } from "react";
import type { PostHog } from "posthog-js";
import { useCall } from "@/lib/client/call-context";
import { useOnboarding } from "@/lib/client/onboarding";
import { isFilled } from "@/lib/agent/policy";
import { SLOTS, type Session, type Slot } from "@/lib/session/schema";

// Product analytics and session replay, off unless NEXT_PUBLIC_POSTHOG_KEY is set. Only kinds,
// channels, screens and slot names are sent. Replay masks every input and every text node and label
// attribute under data-ph-mask (the phone screen and the panel values), blocks data-ph-block (the
// desktop keyboard, whose key popups would spell out typing), and records no network payloads or
// console, so no message or state value leaves the page whatever the project settings say.

const KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const analyticsEnabled = Boolean(KEY);

let client: PostHog | null = null;
const queued: [string, Record<string, string>][] = [];

function track(event: string, properties: Record<string, string>) {
  if (client) client.capture(event, properties);
  else queued.push([event, properties]);
}

const MASKED_ATTRIBUTES = /^(?:aria-label|placeholder|title|alt|value)$/;

// Attributes can carry the same text as the masked nodes (an accessible name, a placeholder).
function maskAttribute(name: string, value: string, element?: Element) {
  return element?.closest("[data-ph-mask]") && MASKED_ATTRIBUTES.test(name) ? "*".repeat(value.length) : value;
}

/** Which slots are filled, and from where: text, voice, or the OAuth callback for Gmail. */
function slotSources(session: Session) {
  const sources = new Map<Slot, string>();
  for (const slot of SLOTS) {
    if (!isFilled(session, slot)) continue;
    sources.set(slot, slot === "gmail" ? "oauth" : (session[slot]?.source ?? "text"));
  }
  return sources;
}

export function PostHogAnalytics() {
  return analyticsEnabled ? <Tracker /> : null;
}

function Tracker() {
  const { snapshot } = useOnboarding();
  const { screen } = useCall();
  const seen = useRef<{ sessionId: string; seq: number; slots: Map<Slot, string> } | null>(null);

  useEffect(() => {
    if (!KEY) return;
    // Loaded on demand so the bundle carries no analytics code when it is off.
    void import("posthog-js").then(({ default: posthog }) => {
      if (client) return;
      posthog.init(KEY, {
        api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com",
        person_profiles: "identified_only",
        capture_pageview: true,
        autocapture: false,
        capture_dead_clicks: false,
        capture_heatmaps: false,
        disable_surveys: true,
        mask_all_text: true,
        mask_all_element_attributes: true,
        enable_recording_console_log: false,
        session_recording: {
          maskAllInputs: true,
          maskTextSelector: "[data-ph-mask]",
          maskAttributeFn: maskAttribute,
          blockSelector: "[data-ph-block]",
          recordHeaders: false,
          recordBody: false,
          maskCapturedNetworkRequestFn: (request) => (request.name.includes("/api/") ? null : request),
        },
      });
      client = posthog;
      for (const [event, properties] of queued.splice(0)) posthog.capture(event, properties);
    });
  }, []);

  useEffect(() => {
    if (!snapshot) return;
    const { session, events, lastSeq } = snapshot;
    const previous = seen.current;
    const slots = slotSources(session);
    seen.current = { sessionId: session.id, seq: lastSeq, slots };
    // The first snapshot is history from before this page view.
    if (!previous) return;

    const sameSession = previous.sessionId === session.id;
    for (const event of events) {
      if (sameSession && event.seq <= previous.seq) continue;
      track("session_event", { kind: event.meta?.kind ?? event.role, channel: event.channel });
    }
    for (const [slot, source] of slots) {
      if (!sameSession || !previous.slots.has(slot)) track("slot_filled", { slot, source });
    }
  }, [snapshot]);

  useEffect(() => {
    if (screen !== "none") track("call_screen", { screen });
  }, [screen]);

  return null;
}
