"use client";

import { cx } from "@/components/ios/ui";
import { BubbleView } from "./bubble";
import { Sheet, SheetDone } from "./sheet";
import type { BubbleItem } from "./thread-model";

type ThreadSheetProps = { original: BubbleItem | null; replies: BubbleItem[]; sender: string; onClose: () => void };

// What "N Replies" opens: the message on its own with every inline reply to it, as iMessage shows a thread.
export function ThreadSheet({ original, replies, sender, onClose }: ThreadSheetProps) {
  const count = replies.length;
  return (
    <Sheet open={original !== null} onClose={onClose} label={`${count} ${count === 1 ? "Reply" : "Replies"}`}>
      <SheetDone onClose={onClose} />
      <p className="pb-12 text-center text-ios-footnote font-semibold text-ink-soft">
        {count} {count === 1 ? "Reply" : "Replies"}
      </p>
      {original && (
        <div className="flex flex-col gap-8">
          {[original, ...replies].map((item) => {
            const user = item.side === "user";
            return (
              <div key={item.key} className={cx("flex", user ? "justify-end" : "justify-start")}>
                <BubbleView side={item.side} tail reactions={item.reactions} className="max-w-[75%]">
                  <span className="sr-only">{user ? "You" : sender}: </span>
                  {item.text}
                </BubbleView>
              </div>
            );
          })}
        </div>
      )}
    </Sheet>
  );
}
