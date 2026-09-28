import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { GoogleError, listLabels, searchMail } = await import("@/lib/gmail/mail-api");

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

/** Gmail, answering each request by its path, and keeping every URL it was asked for. */
function gmail(answer: (path: string, url: URL) => unknown) {
  const urls: URL[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      urls.push(url);
      const body = answer(url.href.slice(GMAIL.length).split("?")[0] ?? "", url);
      return body instanceof Response ? body : Response.json(body);
    }),
  );
  return urls;
}

const meta = (id: string) => ({ id, threadId: `t-${id}`, snippet: "hi", payload: { headers: [{ name: "Subject", value: `subject ${id}` }] } });

afterEach(() => vi.unstubAllGlobals());

describe("searchMail", () => {
  it("sends only the query, with no label filter, so it covers every folder and archived mail", async () => {
    const urls = gmail((path) => (path === "/messages" ? { messages: [], resultSizeEstimate: 0 } : {}));
    await searchMail("tok", "from:maya", 5);
    const list = urls[0];
    expect(list?.pathname).toBe("/gmail/v1/users/me/messages");
    expect([...(list?.searchParams.keys() ?? [])].sort()).toEqual(["maxResults", "q"]);
    expect(list?.searchParams.get("q")).toBe("from:maya");
    expect(list?.searchParams.has("labelIds")).toBe(false);
    expect(list?.searchParams.has("includeSpamTrash")).toBe(false);
  });

  it("gives Gmail's estimate of every match, beside the newest few it read", async () => {
    gmail((path) => (path === "/messages" ? { messages: [{ id: "a" }, { id: "b" }], resultSizeEstimate: 137 } : meta(path.split("/").at(-1) ?? "")));
    const found = await searchMail("tok", "has:attachment", 2);
    expect(found.estimate).toBe(137);
    expect(found.messages.map((m) => m.subject)).toEqual(["subject a", "subject b"]);
  });

  it("counts exactly when fewer came back than it asked for, and never below what it read", async () => {
    gmail((path) => (path === "/messages" ? { messages: [{ id: "a" }], resultSizeEstimate: 9 } : meta("a")));
    expect((await searchMail("tok", "dana", 5)).estimate).toBe(1);
    gmail((path) => (path === "/messages" ? { messages: [{ id: "a" }, { id: "b" }] } : meta(path.split("/").at(-1) ?? "")));
    expect((await searchMail("tok", "dana", 2)).estimate).toBe(2);
    gmail(() => ({ resultSizeEstimate: 0 }));
    expect(await searchMail("tok", "nothing", 5)).toEqual({ messages: [], estimate: 0 });
  });
});

describe("listLabels", () => {
  const all = [
    { id: "INBOX", name: "INBOX", type: "system" },
    { id: "SPAM", name: "SPAM", type: "system" },
    { id: "TRASH", name: "TRASH", type: "system" },
    { id: "IMPORTANT", name: "IMPORTANT", type: "system" },
    { id: "SENT", name: "SENT", type: "system" },
    { id: "Label_1", name: "Job Applications", type: "user" },
    { id: "Label_2", name: "Receipts/2026", type: "user" },
  ];
  const counts: Record<string, { messagesTotal: number; messagesUnread: number }> = {
    INBOX: { messagesTotal: 1_204, messagesUnread: 30 },
    SENT: { messagesTotal: 400, messagesUnread: 0 },
    Label_1: { messagesTotal: 42, messagesUnread: 3 },
    Label_2: { messagesTotal: 10, messagesUnread: 0 },
  };
  const labelsGmail = (fails: (id: string) => boolean = () => false) =>
    gmail((path) => {
      if (path === "/labels") return { labels: all };
      const id = decodeURIComponent(path.slice("/labels/".length));
      return fails(id) ? new Response("slow down", { status: 429 }) : { id, ...counts[id] };
    });

  it("lists their own labels first, then only the inbox and sent mail, in their own case with counts", async () => {
    const urls = labelsGmail();
    expect(await listLabels("tok")).toEqual([
      { name: "Job Applications", type: "user", total: 42, unread: 3 },
      { name: "Receipts/2026", type: "user", total: 10, unread: 0 },
      { name: "INBOX", type: "system", total: 1_204, unread: 30 },
      { name: "SENT", type: "system", total: 400, unread: 0 },
    ]);
    expect(urls.some((u) => /SPAM|TRASH|IMPORTANT/.test(u.pathname))).toBe(false);
  });

  it("keeps the list when one label can't be counted, naming that one without counts", async () => {
    labelsGmail((id) => id === "Label_2");
    const list = await listLabels("tok");
    expect(list).toHaveLength(4);
    expect(list[0]).toMatchObject({ name: "Job Applications", total: 42 });
    expect(list[1]).toEqual({ name: "Receipts/2026", type: "user", total: null, unread: null });
  });

  it("fails as Google's error when no label could be counted", async () => {
    labelsGmail(() => true);
    await expect(listLabels("tok")).rejects.toBeInstanceOf(GoogleError);
  });

  it("stops at 50 labels, cutting their own and never the inbox or sent mail", async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ id: `Label_${i}`, name: `Folder ${i}`, type: "user" }));
    const system = [
      { id: "INBOX", name: "INBOX", type: "system" },
      { id: "SENT", name: "SENT", type: "system" },
    ];
    gmail((path) => (path === "/labels" ? { labels: [...system, ...many] } : { messagesTotal: 1, messagesUnread: 0 }));
    const list = await listLabels("tok");
    expect(list).toHaveLength(50);
    expect(list.slice(-3).map((l) => l.name)).toEqual(["Folder 47", "INBOX", "SENT"]);
  });
});
