"use client";

import { useState, type ReactNode } from "react";
import { CloseIcon, CompassIcon, EnvelopeIcon, PhoneIcon, ShareScreenIcon, VideoFillIcon } from "@/components/ios/icons";
import { cx, PRESS } from "@/components/ios/ui";
import { useStartOver } from "@/components/stage/start-over";
import { CHAT_BACKGROUNDS, useChatBackground } from "@/lib/client/chat-background";
import { contactIdentity, PERSONA_NUMBERS } from "@/lib/client/contact";
import type { Session } from "@/lib/session/schema";
import { Avatar } from "./avatar";
import { ChatBackdrop } from "./chat-backdrop";
import styles from "./messages.module.css";
import { Sheet, SheetAction, SheetGroup } from "./sheet";

type DetailsSheetProps = {
  open: boolean;
  session: Session | null;
  /** On a real phone the stage around it, with its Logs and Restart, is hidden, so they live here instead. */
  stageControls: boolean;
  call: { disabled: boolean; onPress: () => void };
  onSaveContact: () => void;
  onClose: () => void;
  onLogs: () => void;
};

const HOMEPAGES = ["https://yourpersona.com", "https://app.yourpersona.com"];
const TABS = ["Info", "Backgrounds"] as const;

type Toggles = { hideAlerts: boolean; readReceipts: boolean; sharedWithYou: boolean; focusStatus: boolean };
const TOGGLE_ROWS: { key: keyof Toggles; label: string }[] = [
  { key: "hideAlerts", label: "Hide Alerts" },
  { key: "readReceipts", label: "Send Read Receipts" },
  { key: "sharedWithYou", label: "Show in Shared with You" },
  { key: "focusStatus", label: "Share Focus Status" },
];

const ROW = "flex min-h-52 w-full items-center gap-12 px-16 py-8 text-left";

// The round trailing button on a phone or homepage row.
function RowGlyph({ children }: { children: ReactNode }) {
  return <span className="grid size-32 shrink-0 place-items-center rounded-full bg-ios-fill text-ink">{children}</span>;
}

// iOS 26 switch: a capsule knob that turns to clear glass while a finger holds it.
function Toggle({ label, on, onChange }: { label: string; on: boolean; onChange: (on: boolean) => void }) {
  const [pressed, setPressed] = useState(false);
  const release = () => setPressed(false);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      onPointerDown={() => setPressed(true)}
      onPointerUp={release}
      onPointerLeave={release}
      onPointerCancel={release}
      data-pressed={pressed || undefined}
      className={cx(ROW, styles.switch)}
    >
      <span className="flex-1 text-ios-body text-ink">{label}</span>
      <span className={cx("relative h-28 w-63 shrink-0 rounded-full transition-colors duration-200", on ? "bg-ios-green" : "bg-ios-gray")}>
        <span className={cx(styles.knob, on && "translate-x-22")} />
      </span>
    </button>
  );
}

function ActionButton({ label, disabled, onPress, children }: { label: string; disabled?: boolean; onPress?: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onPress}
      className={cx(styles.glass, PRESS, "grid size-50 place-items-center rounded-full text-ink disabled:text-ios-label-3")}
    >
      {children}
    </button>
  );
}

// Each swatch is the conversation in miniature; picking one repaints the thread behind the sheet.
function Backgrounds() {
  const [current, setBackground] = useChatBackground();
  return (
    <div role="radiogroup" aria-label="Conversation background" className="grid grid-cols-3 gap-12">
      {CHAT_BACKGROUNDS.map((background) => (
        <button
          key={background.id}
          type="button"
          role="radio"
          aria-checked={current.id === background.id}
          onClick={() => setBackground(background.id)}
          className={cx("flex flex-col items-center gap-6", PRESS)}
        >
          <ChatBackdrop
            background={background}
            className={cx(
              "relative block aspect-[402/874] w-full overflow-hidden rounded-ios-card border border-line",
              current.id === background.id && "outline-3 outline-offset-2 outline-ios-blue",
            )}
          />
          <span className="text-ios-footnote text-ink">{background.name}</span>
        </button>
      ))}
    </div>
  );
}

type EraseLabels = { idle: string; armed: string; erasing: string };

// Erasing the session cannot be undone, so the first press only arms it, as the stage's Restart does, and a wait
// or a tap elsewhere disarms it. The second erases the session and closes the sheet.
function EraseAction({ labels, tone, onErased }: { labels: EraseLabels; tone: "blue" | "red"; onErased: () => void }) {
  const { armed, erasing, press, disarm } = useStartOver(onErased);
  return (
    <SheetAction tone={armed ? "red" : tone} disabled={erasing} onClick={press} onBlur={disarm}>
      {erasing ? labels.erasing : armed ? labels.armed : labels.idle}
    </SheetAction>
  );
}

const START_OVER: EraseLabels = { idle: "Start over", armed: "Confirm: erase session", erasing: "Erasing" };
const DELETE_DATA: EraseLabels = { idle: "Delete my data", armed: "Confirm: delete my data", erasing: "Deleting" };

// The contact's card as iOS 26 draws it, with Persona's real lines and homepages.
export function DetailsSheet({ open, session, stageControls, call, onSaveContact, onClose, onLogs }: DetailsSheetProps) {
  const contact = contactIdentity(session);
  const [tab, setTab] = useState<(typeof TABS)[number]>("Info");
  const [toggles, setToggles] = useState<Toggles>({ hideAlerts: false, readReceipts: false, sharedWithYou: true, focusStatus: true });

  const dial = () => {
    onClose();
    call.onPress();
  };
  const lines = contact.saved
    ? [
        { label: "mobile", number: PERSONA_NUMBERS.text, recent: true },
        { label: "Calls only", number: PERSONA_NUMBERS.call, recent: false },
      ]
    : [{ label: "mobile", number: PERSONA_NUMBERS.text, recent: true }];

  return (
    <Sheet open={open} onClose={onClose} label={`${contact.name} details`}>
      <div className="relative flex flex-col items-center pb-8">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className={cx(styles.glass, PRESS, "absolute left-0 top-0 grid size-44 place-items-center rounded-full text-ink")}
        >
          <CloseIcon className="size-18" />
        </button>
        <span aria-hidden className={cx(styles.glass, "absolute right-0 top-0 flex h-44 items-center rounded-full px-16 text-ios-body font-semibold text-ink")}>
          Edit
        </span>
        <Avatar unknown={!contact.saved} size={84} />
        <h2 className="mt-8 max-w-full truncate text-ios-title1 font-bold text-ink">{contact.name}</h2>
        <div className="mt-16 flex gap-20">
          <ActionButton label={`Call ${contact.name}`} disabled={call.disabled} onPress={dial}>
            <PhoneIcon className="size-24" />
          </ActionButton>
          <ActionButton label={`FaceTime ${contact.name}`} disabled={call.disabled} onPress={dial}>
            <VideoFillIcon className="size-24" />
          </ActionButton>
          <ActionButton label="Mail, no email address" disabled>
            <EnvelopeIcon className="size-24" />
          </ActionButton>
          <span aria-hidden className={cx(styles.glass, "grid size-50 place-items-center rounded-full text-ink")}>
            <ShareScreenIcon className="size-24" />
          </span>
        </div>
        <div role="tablist" aria-label="Contact" className="mt-20 flex gap-4">
          {TABS.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={cx(
                "h-36 rounded-full px-16 text-ios-body transition-colors",
                tab === t ? "bg-ios-fill font-semibold text-ink" : "text-ink-soft",
              )}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {tab === "Backgrounds" ? (
        <div className="mt-12">
          <Backgrounds />
        </div>
      ) : (
        <>
          <SheetGroup>
            <button type="button" disabled className={cx(ROW, "text-ios-body text-ios-label-3")}>
              Request Location
            </button>
            <button type="button" disabled className={cx(ROW, "text-ios-body text-ios-label-3")}>
              Share My Location
            </button>
          </SheetGroup>

          <SheetGroup>
            {lines.map((line) => (
              <button
                key={line.number}
                type="button"
                onClick={dial}
                disabled={call.disabled}
                aria-label={`Call ${line.label} ${line.number}`}
                className={cx(ROW, PRESS)}
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-6 text-ios-subhead text-ink-soft">
                    {line.label}
                    {line.recent && (
                      <span className="rounded-[calc(var(--pt)*4)] bg-ios-fill px-4 text-ios-caption2 font-bold tracking-wide text-ink-soft uppercase">
                        Recent
                      </span>
                    )}
                  </span>
                  <span className="block text-ios-body text-ink">{line.number}</span>
                </span>
                <RowGlyph>
                  <PhoneIcon className="size-16" />
                </RowGlyph>
              </button>
            ))}
          </SheetGroup>

          {contact.saved ? (
            <SheetGroup>
              {HOMEPAGES.map((url) => (
                <a key={url} href={url} target="_blank" rel="noopener noreferrer" className={cx(ROW, PRESS)}>
                  <span className="min-w-0 flex-1">
                    <span className="block text-ios-subhead text-ink-soft">homepage</span>
                    <span className="block truncate text-ios-body text-ink">{url}</span>
                  </span>
                  <RowGlyph>
                    <CompassIcon className="size-18" />
                  </RowGlyph>
                </a>
              ))}
            </SheetGroup>
          ) : (
            <SheetGroup>
              <SheetAction onClick={onSaveContact}>Create New Contact</SheetAction>
              <SheetAction onClick={onSaveContact}>Add to Existing Contact</SheetAction>
            </SheetGroup>
          )}

          <SheetGroup>
            {TOGGLE_ROWS.map(({ key, label }) => (
              <Toggle key={key} label={label} on={toggles[key]} onChange={(on) => setToggles((t) => ({ ...t, [key]: on }))} />
            ))}
          </SheetGroup>

          {contact.saved && (
            <SheetGroup>
              <button type="button" disabled className={cx(ROW, "text-ios-body text-ios-label-3")}>
                Show in Contacts
              </button>
            </SheetGroup>
          )}

          {stageControls && (
            <SheetGroup>
              <SheetAction onClick={onLogs}>Logs</SheetAction>
              <EraseAction labels={START_OVER} tone="blue" onErased={onClose} />
            </SheetGroup>
          )}

          <SheetGroup>
            <EraseAction labels={DELETE_DATA} tone="red" onErased={onClose} />
          </SheetGroup>
        </>
      )}
    </Sheet>
  );
}
