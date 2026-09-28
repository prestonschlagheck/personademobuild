import { PersonaMark } from "@/components/brand/persona-logo";
import type { ChatBackground } from "@/lib/client/chat-background";

// A conversation background: the tint, and the mark sized in percent so a swatch is the screen in miniature.
export function ChatBackdrop({ background, className }: { background: ChatBackground; className?: string }) {
  return (
    <span aria-hidden className={className} style={{ background: background.color, color: background.mark ?? undefined }}>
      {background.mark && (
        <PersonaMark className="absolute -right-[34%] -bottom-[7%] aspect-[23.6813/23] h-[64%] w-auto" />
      )}
    </span>
  );
}
