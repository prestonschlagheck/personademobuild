import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { MOCK_ACCOUNTS } from "@/lib/gmail/fixtures";
import { BASE_SCOPES, CALENDAR_SCOPE, DRIVE_SCOPE, extraScopes, gmailScope } from "@/lib/gmail/oauth";
import { getModes } from "@/lib/server/config";
import { ConnectCard, primaryPill, secondaryPill } from "../connect-card";

// Stands in for Google's consent screen while no Google keys are set, and does not exist once they are.
// It stays neutral, with no Google branding, and asks for exactly what the real request asks for. It
// answers the callback the way Google does: a code naming the account, the granted scopes, or
// error=access_denied.

export const metadata: Metadata = { title: "Test sign-in" };

const EXTRA_LABELS: Record<string, string> = {
  [CALENDAR_SCOPE]: "Allow read-only Calendar events",
  [DRIVE_SCOPE]: "Allow read-only Drive file names",
};

const initials = (name: string) =>
  name
    .split(" ")
    .map((part) => part[0])
    .join("");

export default async function MockSignIn({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (getModes().gmail === "live") notFound();
  const { state } = await searchParams;

  if (typeof state !== "string" || !state) redirect("/connect/done?result=expired");

  return (
    <ConnectCard title="Test sign-in">
      <p className="mt-3 text-[15px] leading-[22px] text-pretty text-secondary">
        This page stands in for Google sign-in because no Google keys are set. It asks for your email address,
        Gmail (read, draft and send with your OK), and read-only Calendar and Drive, nothing else.
      </p>

      <form action="/api/oauth/google/callback" method="get" className="mt-7">
        <input type="hidden" name="state" value={state} />
        <input type="hidden" name="scope" value={BASE_SCOPES} />

        <fieldset className="min-w-0">
          <legend className="text-[13px] font-medium text-secondary">Choose an account</legend>
          <div className="mt-2 divide-y divide-hairline overflow-hidden rounded-md border border-hairline">
            {MOCK_ACCOUNTS.map((account, i) => (
              <label
                key={account.id}
                className="flex min-h-16 cursor-pointer items-center gap-3 px-4 py-3 transition-colors duration-[140ms] has-checked:bg-sunken has-focus-visible:outline-2 has-focus-visible:-outline-offset-2 has-focus-visible:outline-focus"
              >
                <input type="radio" name="code" value={`mock.${account.id}`} defaultChecked={i === 0} className="peer sr-only" />
                <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-[10px] bg-tile text-[14px] font-semibold text-ink">
                  {initials(account.name)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-semibold tracking-[-0.2px] text-ink">{account.name}</span>
                  <span className="block truncate text-[13px] leading-[18px] text-secondary">{account.email}</span>
                  <span className="block truncate text-[13px] leading-[18px] text-secondary">{account.summary}</span>
                </span>
                <span
                  aria-hidden
                  className="grid size-5 shrink-0 place-items-center rounded-full border border-line-strong transition-colors duration-[140ms] peer-checked:border-accent peer-checked:bg-accent"
                >
                  <span className="size-2 rounded-full bg-surface" />
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <label className="mt-5 flex cursor-pointer items-start gap-3">
          <input type="checkbox" name="scope" value={gmailScope()} defaultChecked className="mt-0.5 size-[18px] shrink-0 accent-accent" />
          <span>
            <span className="block text-[15px] font-medium tracking-[-0.2px] text-ink">Allow Gmail access</span>
            <span className="block text-[13px] leading-[18px] text-secondary">Untick it to try a partial grant.</span>
          </span>
        </label>
        {extraScopes().map((scope) => (
          <label key={scope} className="mt-4 flex cursor-pointer items-start gap-3">
            <input type="checkbox" name="scope" value={scope} defaultChecked className="mt-0.5 size-[18px] shrink-0 accent-accent" />
            <span>
              <span className="block text-[15px] font-medium tracking-[-0.2px] text-ink">{EXTRA_LABELS[scope]}</span>
              <span className="block text-[13px] leading-[18px] text-secondary">Optional. Gmail still connects without it.</span>
            </span>
          </label>
        ))}

        {/* Allow comes first so Enter submits it; row-reverse puts it on the right. */}
        <div className="mt-8 flex flex-col gap-3 sm:flex-row-reverse">
          <button type="submit" className={primaryPill}>
            Allow
          </button>
          <button type="submit" name="error" value="access_denied" className={secondaryPill}>
            Cancel
          </button>
        </div>
      </form>
    </ConnectCard>
  );
}
