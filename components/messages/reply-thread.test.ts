import { describe, expect, it } from "vitest";
import { replyPath } from "./reply-thread";

// Row coordinates at 1 px per point: the line runs at x 18, bends at radius 16, and its stubs end at x 56.
const bubble = (top: number, height: number, side: "user" | "agent") => ({ top, bottom: top + height, side });

describe("reply line", () => {
  it("drops from under a message on the left and bends out to a reply on the right", () => {
    expect(replyPath(bubble(0, 40, "agent"), bubble(80, 40, "user"), 1)).toBe("M 18 50 V 84 Q 18 100 34 100 H 56");
  });

  it("bends in from a message on the right and drops to just above a reply on the left", () => {
    expect(replyPath(bubble(0, 40, "user"), bubble(80, 40, "agent"), 1)).toBe("M 56 20 H 34 Q 18 20 18 36 V 76");
  });

  it("brackets two bubbles on the right", () => {
    expect(replyPath(bubble(0, 40, "user"), bubble(80, 40, "user"), 1)).toBe("M 56 20 H 34 Q 18 20 18 36 V 84 Q 18 100 34 100 H 56");
  });

  it("runs straight down between two bubbles on the left", () => {
    expect(replyPath(bubble(0, 40, "agent"), bubble(80, 40, "agent"), 1)).toBe("M 18 50 V 76");
  });

  it("tightens its bends when the bubbles sit close together", () => {
    expect(replyPath(bubble(0, 40, "user"), bubble(30, 20, "user"), 1)).toBe("M 56 20 H 28 Q 18 20 18 30 V 30 Q 18 40 28 40 H 56");
  });

  it("scales with the point size", () => {
    expect(replyPath(bubble(0, 80, "agent"), bubble(160, 80, "user"), 2)).toBe("M 36 100 V 168 Q 36 200 68 200 H 112");
  });
});
