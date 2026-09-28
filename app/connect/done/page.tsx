import type { Metadata } from "next";
import Link from "next/link";
import { PersonaWordmark } from "@/components/brand/persona-logo";
import { CheckIcon, CloseIcon } from "@/components/ios/icons";
import { cx } from "@/components/ios/ui";
import { connectedEmail, type OAuthResult } from "@/lib/gmail/oauth";
import { ConnectCard, primaryPill } from "../connect-card";
import { ReportToOpener } from "./report-to-opener";

// Where Google sign-in returns, mirroring Persona's own return page. It says what happened in one line
// and links back to the thread; opened from the thread, it also reports the result there and closes.

const RESULTS = {
  connected: { title: "Gmail connected", body: "You're all set. Head back to your messages." },
  denied: { title: "No problem", body: "Nothing was connected. You can keep going over text." },
  partial: { title: "Gmail wasn't allowed", body: "Nothing was connected. Ask for a new link and tick Gmail." },
  expired: { title: "Link expired", body: "This link already worked or expired. Ask for a new one in messages." },
  error: { title: "Sign-in didn't finish", body: "Something went wrong with Google. Ask for a new link in messages." },
  unreadable: { title: "Couldn't read Gmail", body: "You signed in, but your inbox couldn't be read just now. Ask for a new link in messages." },
} as const satisfies Record<OAuthResult, { title: string; body: string }>;

const isResult = (value: unknown): value is OAuthResult => typeof value === "string" && Object.hasOwn(RESULTS, value);

async function resultOf(searchParams: PageProps<"/connect/done">["searchParams"]): Promise<OAuthResult> {
  const { result } = await searchParams;
  return isResult(result) ? result : "error";
}

export async function generateMetadata({ searchParams }: PageProps<"/connect/done">): Promise<Metadata> {
  return { title: RESULTS[await resultOf(searchParams)].title };
}

function AlertGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" className={className} aria-hidden>
      <path d="M12 5.5v8.5M12 18.5v.01" />
    </svg>
  );
}

function ResultIcon({ result }: { result: OAuthResult }) {
  const connected = result === "connected";
  return (
    <span
      className={cx(
        "grid size-12 place-items-center rounded-full",
        "motion-safe:transition-[opacity,scale] motion-safe:duration-[320ms] motion-safe:ease-(--ease-house) motion-safe:starting:scale-75 motion-safe:starting:opacity-0",
        connected ? "bg-accent text-surface" : "bg-tile text-ink",
      )}
    >
      {connected ? <CheckIcon className="size-6" /> : result === "denied" ? <CloseIcon className="size-5" /> : <AlertGlyph className="size-6" />}
    </span>
  );
}

export default async function ConnectDone({ searchParams }: PageProps<"/connect/done">) {
  const result = await resultOf(searchParams);
  const email = result === "connected" ? await connectedEmail() : null;
  const { title, body } = RESULTS[result];
  return (
    <ConnectCard
      title={title}
      icon={<ResultIcon result={result} />}
      footer={<PersonaWordmark className="h-[22px] w-auto text-accent" />}
    >
      <ReportToOpener result={result} />
      <p className="mt-3 text-[15px] leading-[22px] text-pretty text-secondary">
        {email ? (
          <>
            <span className="font-medium text-ink wrap-anywhere">{email}</span> is connected. Head back to your messages.
          </>
        ) : (
          body
        )}
      </p>
      <Link href="/" className={cx(primaryPill, "mt-8 w-full")}>
        Back to messages
      </Link>
    </ConnectCard>
  );
}
