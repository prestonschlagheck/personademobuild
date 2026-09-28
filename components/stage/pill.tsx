import type { ComponentProps } from "react";
import { cx } from "@/components/ios/ui";
import styles from "./pill.module.css";

type PillProps = ComponentProps<"button">;

export function Pill({ className, type = "button", ...props }: PillProps) {
  return <button type={type} className={cx(styles.pill, className)} {...props} />;
}
