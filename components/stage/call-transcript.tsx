"use client";

import { Fragment, useState, type CSSProperties } from "react";
import { properCase } from "@/lib/agent/messages";
import { useCall, useCallCaptions } from "@/lib/client/call-context";
import { useOnboarding } from "@/lib/client/onboarding";
import styles from "./call-transcript.module.css";

// The call's words beside the phone while it is live: each line as it is spoken (the agent's as its voice is
// generated, the caller's as they talk), newest at the bottom, the conversation climbing into a fade at the top.
// Tone on tone like the mark behind it, so it reads as the conversation's trace rather than a panel.
// Masked for session replay like the phone itself, since it carries what the caller said.
export function CallTranscript() {
  const { phase } = useCall();
  const captions = useCallCaptions();
  const session = useOnboarding().snapshot?.session;
  const names = [session?.agentName?.value, session?.userName?.value];
  const shown = phase === "active" || phase === "ended";

  return (
    <div role="log" aria-label="Call transcript" aria-live="off" data-ph-mask data-ended={phase === "ended" || undefined} className={styles.transcript}>
      <div className={styles.lines}>
        {shown &&
          captions
            .filter((line) => line.text.trim())
            .map((line) => <Line key={line.id} role={line.role} text={properCase(line.text.trim(), names)} />)}
      </div>
    </div>
  );
}

// Each word develops in on its own as it arrives. Words that land together (a line let out in full, a burst of the
// caller's speech) follow one another in a short cascade rather than appearing as a block.
// Lines arrive in standard English casing (properCase), whoever says it, from the first word on rather than once a
// transcript lands, since speech has no case and the voice's own text is the lowercase product voice.
function Line({ role, text }: { role: string; text: string }) {
  const words = text.split(/\s+/);
  const [seen, setSeen] = useState(words.length);
  const [from, setFrom] = useState(0);
  if (words.length !== seen) {
    setFrom(Math.min(seen, words.length));
    setSeen(words.length);
  }

  return (
    <p data-role={role} className={styles.line}>
      {words.map((word, i) => (
        <Fragment key={i}>
          {i > 0 && " "}
          <span className={styles.word} style={{ "--i": Math.min(8, Math.max(0, i - from)) } as CSSProperties}>
            {word}
          </span>
        </Fragment>
      ))}
    </p>
  );
}
