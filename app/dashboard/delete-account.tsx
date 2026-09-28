"use client";

import Link from "next/link";
import { useState } from "react";
import { cx } from "@/components/ios/ui";
import { api } from "@/lib/client/api";
import { pill, primaryPill, secondaryPill } from "../connect/connect-card";

type Step = "idle" | "confirm" | "deleting" | "done" | "failed";

const dangerPill = `${pill} bg-danger text-surface active:opacity-75 disabled:opacity-50`;
const quietDangerPill = `${pill} border border-button-border bg-surface text-danger hover:bg-sunken active:bg-tile`;

// Delete account, with the one confirm step before it. The server runs the same delete as the agent's
// delete_my_data, and the thread starts over on a fresh session.
export function DeleteAccount({ agent }: { agent: string }) {
  const [step, setStep] = useState<Step>("idle");

  const remove = async () => {
    setStep("deleting");
    try {
      await api("/api/account/delete", { body: { confirmed: true } });
      setStep("done");
    } catch {
      setStep("failed");
    }
  };

  if (step === "done") {
    return (
      <div role="status">
        <p className="mt-3 text-[15px] leading-[22px] text-pretty text-secondary">
          Your account is deleted. Your chats, connections and everything {agent} knew about you are gone.
        </p>
        <Link href="/" className={cx(primaryPill, "mt-6")}>
          Back to messages
        </Link>
      </div>
    );
  }

  const confirming = step !== "idle";
  return (
    <div className="mt-5 border-t border-hairline pt-5">
      <h3 className="text-[15px] font-semibold tracking-[-0.2px] text-ink">Delete account</h3>
      <p className="mt-1 text-[15px] leading-[22px] text-pretty text-secondary">
        {confirming
          ? "This permanently erases your chats, connections and account. There's no undo."
          : `Erase your chats with ${agent}, your connections and your account.`}
      </p>
      {step === "failed" && (
        <p role="alert" className="mt-3 text-[15px] leading-[22px] text-danger">
          That didn&apos;t go through. Try again.
        </p>
      )}
      <div className="mt-5 flex flex-wrap gap-3">
        {confirming ? (
          <>
            <button type="button" onClick={remove} disabled={step === "deleting"} className={dangerPill}>
              {step === "deleting" ? "Deleting..." : "Delete account"}
            </button>
            <button type="button" onClick={() => setStep("idle")} disabled={step === "deleting"} className={secondaryPill}>
              Cancel
            </button>
          </>
        ) : (
          <button type="button" onClick={() => setStep("confirm")} className={quietDangerPill}>
            Delete account
          </button>
        )}
      </div>
    </div>
  );
}
