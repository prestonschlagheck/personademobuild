import { describe, expect, it } from "vitest";
import { BUSINESS_DAYS, businessInNeed, businessQuery, INBOX_DAYS, needQuery, searchDays, searchesTopic } from "@/lib/gmail/queries";
import { helpCategorySchema } from "@/lib/session/schema";

describe("needQuery", () => {
  it("searches each need's own kind of mail, read or not, over its own window", () => {
    expect(needQuery("bills")).toBe('newer_than:45d -category:promotions -category:social (bill OR invoice OR statement OR "payment due" OR receipt)');
    expect(needQuery("subscriptions")).toBe(
      'newer_than:90d -category:promotions -category:social (renewal OR subscription OR membership OR "your plan" OR receipt)',
    );
    expect(needQuery("travel")).toBe(
      'newer_than:120d -category:promotions -category:social (itinerary OR confirmation OR "boarding pass" OR reservation OR booking)',
    );
    expect(needQuery("appointments")).toBe("newer_than:30d -category:promotions -category:social (appointment OR reminder OR confirmed OR reschedule)");
  });

  it("reads the week's unread for every other need, and before a need is known", () => {
    const unread = "in:inbox is:unread newer_than:7d -category:promotions -category:social";
    for (const category of ["inbox", "calendar", "shopping", "calls", "other", null] as const) {
      expect(needQuery(category)).toBe(unread);
      expect(searchDays(category)).toBe(INBOX_DAYS);
      expect(searchesTopic(category)).toBe(false);
    }
  });

  it("gives every category a window, and only reads unread mail outside the four topic needs", () => {
    for (const category of helpCategorySchema.options) {
      expect(searchDays(category)).toBeGreaterThanOrEqual(INBOX_DAYS);
      expect(needQuery(category).includes("is:unread")).toBe(!searchesTopic(category));
    }
    expect([searchDays("bills"), searchDays("subscriptions"), searchDays("travel"), searchDays("appointments")]).toEqual([45, 90, 120, 30]);
  });
});

describe("businessQuery", () => {
  it("looks for the name as a sender, and run together as a domain", () => {
    expect(businessQuery("planet fitness")).toBe(`newer_than:${BUSINESS_DAYS}d (from:"planet fitness" OR from:planetfitness)`);
    expect(businessQuery("netflix")).toBe(`newer_than:${BUSINESS_DAYS}d (from:"netflix")`);
  });
});

describe("businessInNeed", () => {
  it.each([
    ["cancel my planet fitness", "planet fitness"],
    ["Cancel my Planet Fitness membership!", "planet fitness"],
    ["stop paying for netflix", "netflix"],
    ["help me pay my verizon bill", "verizon"],
    ["where are my amazon packages", "amazon"],
    ["dispute a charge from chase", "chase"],
    ["order groceries from whole foods", "whole foods"],
    ["cancel my hulu and netflix", "hulu"],
    ["cancel McDonald's app", "mcdonald"],
  ])("finds %j -> %s", (need, name) => {
    expect(businessInNeed(need)).toBe(name);
  });

  it.each([
    "reschedule my dentist appointment",
    "track my flight to denver",
    "my inbox is a mess",
    "paying my rent on time",
    "cancel subscriptions i don't use",
    "what am I paying for",
    "cancel my gym membership",
    "sit on hold with customer service",
    "learn to cook",
    "help me not miss bills",
    "plan a trip with my family",
    "cancel my 2 subscriptions",
    "",
  ])("names no business in %j", (need) => {
    expect(businessInNeed(need)).toBeNull();
  });

  it("keeps only letters and digits, so nothing the user typed can shape the search", () => {
    const name = businessInNeed('cancel my "planet" (fitness) OR from:evil -in:trash');
    expect(name).toBe("planet fitness");
    expect(businessInNeed("cancel my plänet fïtness")).toBe("planet fitness");
    for (const need of ['cancel my "a" b) OR c', "cancel my x:y", "cancel my ‮evil"]) {
      expect(businessInNeed(need) ?? "").toMatch(/^[\p{L}\p{N} ]*$/u);
    }
  });

  it("stops at three words", () => {
    expect(businessInNeed("cancel my big blue north star gym")).toBe("big blue north");
  });
});
