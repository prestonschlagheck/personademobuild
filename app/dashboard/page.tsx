import type { Metadata } from "next";
import Link from "next/link";
import { PersonaWordmark } from "@/components/brand/persona-logo";
import { cx } from "@/components/ios/ui";
import { readSession, requireSession } from "@/lib/server/session-service";
import { primaryPill } from "../connect/connect-card";
import { DeleteAccount } from "./delete-account";

// The page the agent's dashboard link opens, in the style of Persona's own app: Home, and under Data privacy the
// Delete account that erases this session for good.

export const metadata: Metadata = { title: "Dashboard" };

export default async function Dashboard() {
  const owner = await requireSession().catch(() => null);
  const session = owner ? await readSession(owner).catch(() => null) : null;
  const agent = session?.agentName?.value ?? "Persona";
  return (
    <main className="flex min-h-dvh flex-col items-center bg-page px-4 py-10">
      <div className="w-full max-w-[560px]">
        <header className="flex items-center justify-between">
          <PersonaWordmark className="h-[22px] w-auto text-accent" />
          <nav aria-label="Dashboard">
            <span aria-current="page" className="rounded-full bg-tile px-3 py-1.5 text-[13px] font-medium text-ink">
              Home
            </span>
          </nav>
        </header>

        <h1 className="mt-10 font-serif text-[32px] leading-[1.1] tracking-[-0.4px] text-heading">Home</h1>

        <section aria-labelledby="privacy" className="mt-6 rounded-lg border border-hairline bg-surface p-6 sm:p-8">
          <h2 id="privacy" className="font-serif text-[22px] leading-[1.2] tracking-[-0.3px] text-heading">
            Data privacy
          </h2>
          {session ? (
            <DeleteAccount agent={agent} />
          ) : (
            <>
              <p className="mt-3 text-[15px] leading-[22px] text-pretty text-secondary">There&apos;s no account in this browser.</p>
              <Link href="/" className={cx(primaryPill, "mt-6")}>
                Back to messages
              </Link>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
