"use client";

import { cx } from "@/components/ios/ui";
import { Pill } from "@/components/stage/pill";
import { useCall } from "@/lib/client/call-context";
import { clockTime, formatDuration } from "@/lib/client/format";
import { useOnboarding } from "@/lib/client/onboarding";
import type { Filled, Session, SessionEvent } from "@/lib/session/schema";
import { CALL_STATUS, END_REASON, GMAIL_STATUS, capitalized, needLabel, seconds } from "./format";
import { Row, Rows, Section } from "./panel-ui";
import styles from "./xray.module.css";

// The live session as the server sees it. Every value here is read from the polled
// snapshot; nothing is kept on the client.
export function StatePanel({ onClose }: { onClose?: () => void }) {
  const { snapshot } = useOnboarding();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Docked, the pressed Logs segment above already names the panel; the sheet only needs a way out. */}
      {onClose && (
        <header className="flex h-13 flex-none items-center justify-end border-b border-hairline px-5">
          <Pill onClick={onClose}>Done</Pill>
        </header>
      )}

      <div className={cx(styles.scroll, "min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5")}>
        {snapshot ? (
          <>
            <OnboardingSection session={snapshot.session} />
            <CallSection session={snapshot.session} events={snapshot.events} />
            <GmailSection gmail={snapshot.session.gmail} />
          </>
        ) : (
          <p className="py-12 text-center text-[14px] text-ink-soft">Waiting for the session.</p>
        )}
      </div>
    </div>
  );
}

function SlotRow({ label, slot }: { label: string; slot: Filled | null }) {
  return <Row label={label} watch={slot?.value} value={slot && capitalized(slot.value)} empty="Not set" mask done={slot !== null} />;
}

// Where a shared location is, by town and state, never the point itself.
function locationValue(location: NonNullable<Session["location"]>) {
  if (location.sharedAt) return location.place ?? "Shared";
  return location.deniedAt ? "Browser declined" : "Requested";
}

function OnboardingSection({ session }: { session: Session }) {
  const { agentName, userName, helpNeed, gmail, contact, location } = session;
  const connected = gmail.status === "connected";
  const steps = [agentName !== null, userName !== null, helpNeed !== null, connected, Boolean(contact.savedAt), Boolean(location?.sharedAt)];
  const done = steps.filter(Boolean).length;

  return (
    <Section title="Onboarding" meta={`${done} of ${steps.length}`}>
      <Rows>
        <SlotRow label="Agent name" slot={agentName} />
        <SlotRow label="Your name" slot={userName} />
        <Row
          label="Help with"
          watch={helpNeed?.value}
          value={helpNeed && needLabel(helpNeed)}
          empty="Not set"
          mask
          done={helpNeed !== null}
        />
        <Row
          label="Gmail"
          watch={gmail.status}
          value={gmail.status !== "not_started" && GMAIL_STATUS[gmail.status]}
          empty="Not set"
          mask
          done={connected}
        />
        <Row label="Contact card" value={contact.savedAt && `Saved ${clockTime(contact.savedAt)}`} empty="Not saved" done={Boolean(contact.savedAt)} />
        <Row label="Location" watch={location?.sharedAt} value={location && locationValue(location)} empty="Not asked" mask done={Boolean(location?.sharedAt)} />
      </Rows>
    </Section>
  );
}

function CallSection({ session, events }: { session: Session; events: SessionEvent[] }) {
  const call = useCall();
  const { status, attempts, lastEndReason, scheduledFor } = session.call;
  const lastSeconds = events.findLast((event) => event.meta?.kind === "call_ended")?.meta?.callSeconds;
  // The average reply on the latest call rather than the last one alone, which is often a slow tool turn.
  const replies = events.flatMap(({ meta }) => (meta?.callAttempt === attempts && meta.latencyMs !== undefined ? [meta.latencyMs] : []));
  const latency = replies.length > 0 ? replies.reduce((sum, ms) => sum + ms, 0) / replies.length : call.lastLatencyMs;
  const duration = call.screen === "active" ? call.seconds : lastSeconds;
  const firstCallAt = session.consent.firstCallAt;

  return (
    <Section title="Call" meta={attempts === 1 ? "1 attempt" : `${attempts} attempts`}>
      <Rows>
        <Row label="Status" value={call.otherTab ? `${CALL_STATUS[status]} in another tab` : CALL_STATUS[status]} />
        {status === "scheduled" && scheduledFor && <Row label="Callback" value={clockTime(scheduledFor)} />}
        <Row label="Duration" watch={null} value={duration !== undefined && formatDuration(duration)} empty="No calls yet" />
        <Row label="Last end" value={lastEndReason && END_REASON[lastEndReason]} />
        <Row label="Voice latency" value={latency !== null && seconds(latency)} empty="Not measured" />
        <Row label="First call" value={firstCallAt && clockTime(firstCallAt)} empty="Not yet" />
      </Rows>
    </Section>
  );
}

// A long address wraps at the @, never in the middle of a name.
function Email({ address }: { address: string }) {
  const at = address.indexOf("@");
  if (at < 0) return address;
  return (
    <>
      {address.slice(0, at)}
      <wbr />
      {address.slice(at)}
    </>
  );
}

function GmailSection({ gmail }: { gmail: Session["gmail"] }) {
  return (
    <Section title="Google">
      <Rows>
        <Row label="Status" value={GMAIL_STATUS[gmail.status]} />
        {gmail.linkSentAt && <Row label="Link sent" value={clockTime(gmail.linkSentAt)} />}
        <Row label="Account" watch={gmail.email} value={gmail.email && <Email address={gmail.email} />} mask />
      </Rows>
    </Section>
  );
}
