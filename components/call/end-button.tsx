import { PhoneDownIcon } from "@/components/ios/icons";
import { cx, PRESS } from "@/components/ios/ui";
import styles from "./call.module.css";

type EndButtonProps = { onPress: () => void; disabled: boolean; labeled?: boolean; className?: string };

// The red hang up circle, shared by the call controls (labeled "End") and the keypad (bare, as iOS draws it there).
export function EndButton({ onPress, disabled, labeled = false, className }: EndButtonProps) {
  return (
    <button
      type="button"
      onClick={onPress}
      disabled={disabled}
      aria-label="End call"
      className={cx("flex flex-col items-center gap-8 disabled:opacity-40", PRESS, className)}
    >
      <span className={cx(styles.end, styles.round, "grid place-items-center rounded-full")}>
        <PhoneDownIcon className="size-36" />
      </span>
      {labeled && (
        <span aria-hidden className="text-ios-subhead">
          End
        </span>
      )}
    </button>
  );
}
