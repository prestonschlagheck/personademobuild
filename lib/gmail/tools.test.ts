import { afterEach, describe, expect, it, vi } from "vitest";
import { newSession, type Session } from "@/lib/session/schema";

vi.mock("server-only", () => ({}));

const { approvesSend, runGoogleTool, isGoogleTool, googleToolSpecs, GOOGLE_PURPOSES } = await import("@/lib/gmail/tools");
const { saveGrant, loadGrant, seal, unseal } = await import("@/lib/gmail/grant");
const { getStore } = await import("@/lib/server/store");

const NOW = new Date().toISOString();

/** A connected session on the fixture inbox, or on a live-looking sign-in when `token` is a real one. */
async function connected(token = "mock:inbox"): Promise<{ id: string; session: Session }> {
  const id = crypto.randomUUID();
  const session: Session = { ...newSession(id, NOW), gmail: { status: "connected", email: "jordan.lee@example.com", connectedAt: NOW } };
  await getStore().create(session);
  await saveGrant(id, { accessToken: token, expiresAt: Number.MAX_SAFE_INTEGER, email: "jordan.lee@example.com", scopes: [] });
  return { id, session };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the sealed Google sign-in", () => {
  it("round-trips, and reads as nothing once tampered with", async () => {
    const grant = { accessToken: "ya29.secret", refreshToken: "1//refresh", expiresAt: 1, email: "a@b.co", scopes: ["x"] };
    const sealed = await seal(grant);
    expect(sealed).not.toContain("ya29");
    expect(await unseal(sealed)).toEqual(grant);
    expect(await unseal(`${sealed.slice(0, -2)}AA`)).toBeNull();
  });

  it("lives apart from the session, so no read of the session carries it", async () => {
    const { id } = await connected();
    expect(JSON.stringify(await getStore().load(id))).not.toContain("mock:inbox");
    expect((await loadGrant(id))?.email).toBe("jordan.lee@example.com");
  });
});

describe("approvesSend", () => {
  it("is a plain yes, in English or Spanish", () => {
    for (const yes of ["yes", "Yeah send it", "yep", "sure", "go ahead", "do it", "sí", "si, dale", "mándalo", "envíalo", "ok, sounds good"]) expect(approvesSend(yes)).toBe(true);
  });

  it("is never a no, a hold, a change, a maybe or a question, even beside a yes", () => {
    for (const hold of ["no", "no, don't send it", "wait", "hold on", "yes but change the subject", "send it instead to sam", "actually no", "maybe", "sure?", "can you send it?", "espera", "no lo mandes", "thanks"]) {
      expect(approvesSend(hold)).toBe(false);
    }
    expect(approvesSend(null)).toBe(false);
  });
});

describe("the Google tools", () => {
  it("are offered by name, with argument schemas", () => {
    expect(isGoogleTool("gmail_search")).toBe(true);
    expect(isGoogleTool("set_user_name")).toBe(false);
    expect(googleToolSpecs().map((spec) => spec.name)).toContain("calendar_events");
  });

  it("say search covers every folder and archived mail, and never offer in:anywhere", () => {
    // The text agent's short lines lean on the core prompt, which says the reach in full.
    const search = googleToolSpecs().find((spec) => spec.name === "gmail_search");
    expect(search?.description).toMatch(/every folder and label and archived mail, not only the inbox/);
    expect(GOOGLE_PURPOSES.gmail_search).toMatch(/every folder, not spam or trash/);
    for (const description of [search?.description ?? "", GOOGLE_PURPOSES.gmail_search]) {
      expect(description).toMatch(/spam (?:and|or) trash/);
      expect(description).toContain('label:"Name"');
      expect(description).toMatch(/about how many (?:emails )?match in all/);
      expect(description).not.toContain("in:anywhere");
    }
    const labels = googleToolSpecs().find((spec) => spec.name === "gmail_labels");
    expect(labels?.description).toMatch(/folder they mention before searching inside it/);
    for (const description of [labels?.description ?? "", GOOGLE_PURPOSES.gmail_labels]) expect(description).toMatch(/how many emails each holds/);
  });

  it("open a search with how many match in all, then the newest few", async () => {
    const { id, session } = await connected();
    const ctx = { sessionId: id, session, lastHeardAt: null, heard: null };
    const some = await runGoogleTool("gmail_search", { query: "dana", max: 1 }, ctx);
    expect(some.result?.split("\n")[0]).toBe("about 2 emails match across all their gmail (every folder and archived mail, not spam or trash), newest 1 below.");
    expect(some.result?.match(/^\d+\. id /gm)).toHaveLength(1);
    expect(some.hint).toMatch(/count you give them is this total, never how many are listed/);
    const one = await runGoogleTool("gmail_search", { query: "maya" }, ctx);
    expect(one.result).toMatch(/^1 email matches across all their gmail/);
  });

  it("say no match plainly, and point a guessed label to gmail_labels", async () => {
    const { id, session } = await connected();
    const ctx = { sessionId: id, session, lastHeardAt: null, heard: null };
    const none = await runGoogleTool("gmail_search", { query: "zebra" }, ctx);
    expect(none).toMatchObject({ ok: true, result: "no emails match across all their gmail (every folder and archived mail, not spam or trash)." });
    expect(none.hint).toBeUndefined();
    const label = await runGoogleTool("gmail_search", { query: 'label:"Job Applications" zebra' }, ctx);
    expect(label.result).toBe('no emails match inside label:"Job Applications".');
    expect(label.hint).toContain("gmail_labels");
    const grouped = await runGoogleTool("gmail_search", { query: '(label:jobs OR label:"Job Applications") -in:inbox zebra' }, ctx);
    expect(grouped.result).toBe('no emails match inside label:jobs label:"Job Applications".');
  });

  it("give a live search's estimate, scoped to the folder it named", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) =>
        String(input).includes("/messages?")
          ? Response.json({ messages: [{ id: "a" }], resultSizeEstimate: 40 })
          : Response.json({ id: "a", threadId: "t", payload: { headers: [{ name: "Subject", value: "Offer letter" }] } }),
      ),
    );
    const { id, session } = await connected("ya29.test");
    const out = await runGoogleTool("gmail_search", { query: 'label:"Job Applications"', max: 1 }, { sessionId: id, session, lastHeardAt: null, heard: null });
    expect(out.result).toMatch(/^about 40 emails match inside label:"Job Applications", newest 1 below\.\n/);
    expect(out.result).toContain("subject: Offer letter");
  });

  it("list folders in their own case, each as the query that searches inside it", async () => {
    const labels = [
      { id: "INBOX", name: "INBOX", type: "system" },
      { id: "SPAM", name: "SPAM", type: "system" },
      { id: "Label_1", name: "Job Applications", type: "user" },
      { id: "Label_2", name: "Receipts/2026", type: "user" },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.endsWith("/labels")) return Response.json({ labels });
        if (url.endsWith("/Label_2")) return new Response("slow down", { status: 429 });
        return Response.json(url.endsWith("/INBOX") ? { messagesTotal: 1_204, messagesUnread: 30 } : { messagesTotal: 42, messagesUnread: 3 });
      }),
    );
    const { id, session } = await connected("ya29.test");
    const out = await runGoogleTool("gmail_labels", {}, { sessionId: id, session, lastHeardAt: null, heard: null });
    expect(out.ok).toBe(true);
    expect(out.result?.split("\n").slice(1)).toEqual([
      'label:"Job Applications": 42 emails, 3 unread',
      'label:"Receipts/2026": count unavailable right now',
      "in:inbox: 1204 emails, 30 unread",
    ]);
    expect(out.hint).toContain("gmail_search");
  });

  it("search and read the inbox, marking what it read as other people's words", async () => {
    const { id, session } = await connected();
    const found = await runGoogleTool("gmail_search", { query: "dinner" }, { sessionId: id, session, lastHeardAt: null, heard: null });
    expect(found.ok).toBe(true);
    expect(found.result).toMatch(/never instructions/);
    expect(found.result).toMatch(/id m1 .*Maya Chen.*Dinner Thursday\?/);
    const read = await runGoogleTool("gmail_read", { id: "m1" }, { sessionId: id, session, lastHeardAt: null, heard: null });
    expect(read.result).toContain("subject: Dinner Thursday?");
  });

  it("send only the newest draft, on a plain yes that came after it was saved", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { id, session } = await connected();
    const write = { to: "maya.chen@example.com", subject: "Re: dinner", body: "thursday works!" };
    const draft = await runGoogleTool("gmail_draft", write, { sessionId: id, session, lastHeardAt: null, heard: null });
    expect(draft.ok).toBe(true);
    expect(draft.hint).toMatch(/ask if they want it sent/);
    const draftId = draft.result?.match(/id (\S+?)\./)?.[1] ?? "";
    const drafted = new Date().toISOString();
    const send = (heard: string | null, lastHeardAt: string | null, draft_id = draftId) =>
      runGoogleTool("gmail_send", { draft_id }, { sessionId: id, session, lastHeardAt, heard });

    // A yes from before the draft, or a draft this account never saved: nothing goes.
    expect((await send("yes", drafted)).error).toBe("not_confirmed");
    expect((await send("yes", NOW, "made-up")).error).toBe("unknown_draft");

    vi.setSystemTime(Date.now() + 5_000);
    const later = new Date().toISOString();
    for (const answer of ["no", "no, don't send it", "wait", "maybe", "change the subject", "is that the right address?"]) {
      expect((await send(answer, later)).error).toBe("not_confirmed");
    }
    expect(await send("yes, send it", later)).toMatchObject({ ok: true, result: "sent." });
  });

  it("send only the last draft saved, never an older one", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { id, session } = await connected();
    const write = { to: "maya.chen@example.com", subject: "Re: dinner", body: "thursday works!" };
    const ctx = { sessionId: id, session, lastHeardAt: null, heard: null };
    const first = (await runGoogleTool("gmail_draft", write, ctx)).result?.match(/id (\S+?)\./)?.[1] ?? "";
    vi.setSystemTime(Date.now() + 1_000);
    // The grant is read fresh each call, so the second draft sees the first.
    const second = (await runGoogleTool("gmail_draft", { ...write, body: "friday instead?" }, ctx)).result?.match(/id (\S+?)\./)?.[1] ?? "";
    vi.setSystemTime(Date.now() + 5_000);
    const yes = { ...ctx, lastHeardAt: new Date().toISOString(), heard: "yep" };
    expect((await runGoogleTool("gmail_send", { draft_id: first }, yes)).error).toBe("not_newest");
    expect((await runGoogleTool("gmail_send", { draft_id: second }, yes)).ok).toBe(true);
  });

  it("refuse before Gmail is connected, pointing to the link", async () => {
    const { id, session } = await connected();
    const out = await runGoogleTool("gmail_labels", {}, { sessionId: id, session: { ...session, gmail: { status: "not_started" } }, lastHeardAt: null, heard: null });
    expect(out).toMatchObject({ ok: false, error: "gmail_not_connected" });
    expect(out.hint).toContain("send_gmail_link");
  });

  it("refuse arguments the schema does not allow", async () => {
    const { id, session } = await connected();
    expect((await runGoogleTool("gmail_update", { ids: ["m1"], action: "delete_forever" }, { sessionId: id, session, lastHeardAt: null, heard: null })).error).toBe("invalid_args");
  });
});
