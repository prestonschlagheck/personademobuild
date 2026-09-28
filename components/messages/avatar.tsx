import { PersonaMark } from "@/components/brand/persona-logo";
import { cx, pt } from "@/components/ios/ui";

// Persona's mark once its contact card is saved (the card carries it as the photo), iOS's blank contact before.
export function Avatar({ unknown = false, size, className }: { unknown?: boolean; size: number; className?: string }) {
  return (
    <span
      aria-hidden
      className={cx(
        "grid shrink-0 place-items-center overflow-hidden rounded-full",
        unknown ? "bg-[url(/ios/default-contact.webp)] bg-cover" : "border border-line/50 bg-surface text-ink",
        className,
      )}
      style={{ width: pt(size), height: pt(size) }}
    >
      {!unknown && <PersonaMark className="h-[55%] w-auto overflow-visible" />}
    </span>
  );
}
