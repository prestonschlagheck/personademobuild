"use client";

import { MotionConfig } from "motion/react";
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { cx } from "@/components/ios/ui";
import { isCallLive, locationOpen } from "@/lib/agent/policy";
import { useCall } from "@/lib/client/call-context";
import { useChatBackground } from "@/lib/client/chat-background";
import { contactIdentity } from "@/lib/client/contact";
import { useOnboarding, type StagedLocation } from "@/lib/client/onboarding";
import { sounds } from "@/lib/client/sounds";
import { useStageUi } from "@/lib/client/stage-ui";
import { useAfter } from "@/lib/client/use-after";
import { useMediaQuery } from "@/lib/client/use-media-query";
import type { ReactionType } from "@/lib/session/schema";
import { ChatBackdrop } from "./chat-backdrop";
import { ComposerArea } from "./composer";
import { ContactSheet } from "./contact-sheet";
import { DetailsSheet } from "./details-sheet";
import { Header, NetworkBanner } from "./header";
import { ScrollEdge } from "./scroll-edge";
import styles from "./messages.module.css";
import { ReplyBackdrop, Tapback, tapbackTarget, type TapbackTarget } from "./tapback";
import { Thread } from "./thread";
import { ThreadSheet } from "./thread-sheet";
import { buildThread, type BubbleItem } from "./thread-model";
import { useInAppBrowser } from "./use-in-app-browser";
import { useReveal } from "./use-reveal";

const FIRST_MESSAGE = "Hey, what's a persona?";
// The only pages a link card may open, each in its own named window.
const LINK_WINDOWS: Record<string, string> = { "/api/oauth/google/start": "persona-google", "/dashboard": "persona-dashboard" };
// Replies usually land fast enough to just arrive, as iMessage shows them; the dots only cover a slow one.
const SLOW_REPLY_MS = 1500;

// Only the server's own sign-in route and dashboard ever open, whatever a message claims to link to.
function linkTarget(url: string) {
  try {
    const target = new URL(url, window.location.href);
    const name = target.origin === window.location.origin ? LINK_WINDOWS[target.pathname] : undefined;
    return name ? { href: target.href, name } : null;
  } catch {
    return null;
  }
}

type SheetState = { kind: "details" } | { kind: "contact"; name: string } | { kind: "thread"; eventId: string } | null;

// iMessage inside the phone screen. It renders the server session and sends intents; it never decides state.
export function MessagesApp() {
  const { snapshot, pending, agentTyping, offline, send, retry, react, saveContact, locate, sendLocation } = useOnboarding();
  const call = useCall();
  const { handheld, setXrayOpen } = useStageUi();
  const finePointer = useMediaQuery("(pointer: fine)");
  const inAppBrowser = useInAppBrowser();
  const root = useRef<HTMLDivElement>(null);
  const chrome = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);
  // The desktop keyboard covers most of the thread, so it rests until the person types or presses the field: not on
  // load, where the field takes focus for the prefilled text, and again after every send, so the reply lands in
  // view. The field keeps its focus throughout, so typing carries straight on.
  const [keyboardResting, setKeyboardResting] = useState(true);
  const [sheet, setSheet] = useState<SheetState>(null);
  const [tapback, setTapback] = useState<TapbackTarget | null>(null);
  const [replying, setReplying] = useState<BubbleItem | null>(null);
  const [background] = useChatBackground();
  const [stagedPoint, setStagedPoint] = useState<StagedLocation | null>(null);

  const reveal = useReveal(snapshot, () => {
    if (!call.fullscreen) sounds.play("receive");
  });
  const items = useMemo(
    () => (snapshot ? buildThread({ events: snapshot.events, cursor: reveal.cursor, baseline: reveal.baseline, pending }) : []),
    [snapshot, reveal.cursor, reveal.baseline, pending],
  );

  const session = snapshot?.session ?? null;
  const agentName = session?.agentName?.value ?? null;
  const title = agentName ?? "Persona";
  const slowReply = useAfter(agentTyping, SLOW_REPLY_MS);
  const desktopKeyboard = finePointer && !handheld;
  const keyboardOpen = desktopKeyboard && focused && !keyboardResting;
  const wakeKeyboard = useCallback(() => setKeyboardResting(false), []);

  const onCallScreen = call.screen !== "none";
  const canCall = session !== null && !isCallLive(session) && !onCallScreen;
  const callButton =
    onCallScreen && !call.fullscreen
      ? { label: "Return to call", disabled: false, onPress: call.returnToCall }
      : { label: `Call ${title}`, disabled: !canCall, onPress: call.dial };

  // Share My Location asks the browser, then the point waits in the composer for Send, as in Messages. It only waits
  // while the request is open: a stop or a taken-back need drops it.
  const requestOpen = session !== null && locationOpen(session);
  const device = session?.userName ? `${session.userName.value}’s iPhone` : "iPhone";
  const stageLocation = useCallback(async () => {
    const point = await locate();
    if (point) setStagedPoint(point);
  }, [locate]);
  const staged =
    stagedPoint && requestOpen
      ? {
          device,
          onRemove: () => setStagedPoint(null),
          onSend: (comment: string) => {
            setStagedPoint(null);
            setKeyboardResting(true);
            sounds.play("send");
            // The comment goes after the location, as its own message.
            void sendLocation(stagedPoint).then(() => {
              if (comment.trim()) send(comment);
            });
          },
        }
      : null;

  const hasUserText = snapshot?.events.some((e) => e.role === "user") ?? true;
  const prefill = session && !hasUserText && pending.length === 0 ? { sessionId: session.id, text: FIRST_MESSAGE } : null;

  // The thread reserves room for whatever sits at the bottom, such as a multi-line composer. Measured in a
  // layout effect, so a reload lands at the bottom without a scroll animation.
  useLayoutEffect(() => {
    const el = chrome.current;
    const screen = root.current;
    if (!el || !screen) return;
    const measure = () => screen.style.setProperty("--chrome-h", `${el.offsetHeight}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const submit = useCallback(
    (text: string) => {
      if (!text.trim()) return false;
      send(text, replying?.eventId);
      setReplying(null);
      setKeyboardResting(true);
      sounds.play("send");
      return true;
    },
    [send, replying],
  );

  const openTapback = useCallback((item: BubbleItem, bubble: HTMLElement) => {
    const screen = root.current;
    const floor = chrome.current?.getBoundingClientRect().top;
    if (screen && floor !== undefined) setTapback(tapbackTarget(item, bubble, screen, floor));
  }, []);

  const pickTapback = (type: ReactionType | null) => {
    if (tapback?.item.eventId) react(tapback.item.eventId, type);
    setTapback(null);
  };

  // Reply means to type, so the keyboard comes up with the field.
  const replyTapback = () => {
    if (tapback) {
      setReplying(tapback.item);
      setKeyboardResting(false);
    }
    setTapback(null);
  };

  const copyTapback = () => {
    if (tapback) void navigator.clipboard?.writeText(tapback.item.text).catch(() => undefined);
    setTapback(null);
  };

  // Google sign-in and the dashboard open as a popup beside the phone on desktop and in a new tab on a real phone,
  // so the call in this tab keeps going either way. A blocked popup tries a plain tab; only with no call to lose does
  // it fall back to leaving the page.
  const callLive = session !== null && isCallLive(session);
  const openLink = useCallback(
    (url: string) => {
      const target = linkTarget(url);
      if (!target) return;
      const opened = handheld ? window.open(target.href, "_blank") : window.open(target.href, target.name, "popup,width=480,height=680");
      if (opened) return;
      if (!(handheld ? null : window.open(target.href, "_blank")) && !callLive) window.location.assign(target.href);
    },
    [handheld, callLive],
  );

  const openContact = useCallback((name: string) => setSheet({ kind: "contact", name }), []);
  const openReplies = useCallback((eventId: string) => setSheet({ kind: "thread", eventId }), []);
  const threadOf = sheet?.kind === "thread" ? sheet.eventId : null;
  const bubbles = items.filter((item): item is BubbleItem => item.type === "bubble");

  return (
    <MotionConfig reducedMotion="user">
      {/* overflow-clip, not hidden: the parked keyboard sits below the screen, and hidden would let focus scroll to it. */}
      <div
        ref={root}
        data-ph-mask
        data-handheld={handheld || undefined}
        className={cx(styles.root, "absolute inset-0 overflow-clip text-ink")}
        style={{ "--chat-bg": background.color } as CSSProperties}
      >
        <ChatBackdrop background={background} className="absolute inset-0 overflow-hidden" />
        <Thread
          items={items}
          typing={slowReply}
          agentName={agentName}
          device={device}
          locationOpen={requestOpen}
          inAppBrowser={inAppBrowser}
          keyboardOpen={keyboardOpen}
          onTapback={openTapback}
          onRetry={retry}
          onContact={openContact}
          onLink={openLink}
          onShareLocation={stageLocation}
          onReplies={openReplies}
        />
        <ScrollEdge />
        <Header contact={contactIdentity(session)} call={callButton} onDetails={() => setSheet({ kind: "details" })} />
        <NetworkBanner offline={offline} />
        <ReplyBackdrop open={replying !== null} onClose={() => setReplying(null)} />
        <ComposerArea
          chromeRef={chrome}
          placeholder={replying ? "Reply" : session?.graduated ? `Text ${title}` : "iMessage"}
          prefill={prefill}
          keyboard={{ enabled: desktopKeyboard, open: keyboardOpen, wake: wakeKeyboard }}
          micAllowed={!onCallScreen && !callLive}
          replying={replying && { item: replying, onCancel: () => setReplying(null) }}
          onShareLocation={requestOpen && !staged ? stageLocation : null}
          staged={staged}
          onSubmit={submit}
          onFocusChange={setFocused}
        />
        <Tapback target={tapback} onPick={pickTapback} onReply={replyTapback} onCopy={copyTapback} onClose={() => setTapback(null)} />
        <DetailsSheet
          open={sheet?.kind === "details"}
          session={session}
          stageControls={handheld}
          call={callButton}
          onSaveContact={saveContact}
          onClose={() => setSheet(null)}
          onLogs={() => {
            setSheet(null);
            setXrayOpen(true);
          }}
        />
        <ThreadSheet
          original={bubbles.find((item) => item.eventId === threadOf) ?? null}
          replies={bubbles.filter((item) => threadOf !== null && item.replyTo === threadOf)}
          sender={title}
          onClose={() => setSheet(null)}
        />
        <ContactSheet
          name={sheet?.kind === "contact" ? sheet.name : null}
          saved={Boolean(session?.contact.savedAt)}
          onSave={saveContact}
          onClose={() => setSheet(null)}
        />
      </div>
    </MotionConfig>
  );
}
