import Image from "next/image";
import type { ReactNode } from "react";
import { cx } from "@/components/ios/ui";
import { HomeIndicator } from "./home-indicator";
import { StatusBar } from "./status-bar";
import styles from "./phone.module.css";
import { VolumeButtons, VolumeHud } from "./volume-buttons";

// Persona's iPhone 17 Pro frame around a 402 x 874 pt screen. The screen is the size container that
// `.ios` measures, so everything inside is written in points and scales with the device.
export function Device({ children }: { children: ReactNode }) {
  return (
    <div className={styles.device}>
      <section aria-label="Phone" className={styles.screen} data-ph-mask>
        <div className={cx("ios", styles.root)}>
          {children}
          <StatusBar />
          <HomeIndicator />
          <VolumeHud />
        </div>
      </section>
      <Image
        src="/ios/iphone-frame.svg"
        alt=""
        width={435}
        height={906}
        loading="eager"
        draggable={false}
        className={styles.frame}
      />
      <VolumeButtons />
    </div>
  );
}
