"use client";

import { AnimatePresence, motion } from "motion/react";
import { useId, useRef, useState, type KeyboardEvent } from "react";
import { cx } from "@/components/ios/ui";
import { SHEET } from "@/lib/client/motion";
import { BAR_RADIUS, useStageUi } from "@/lib/client/stage-ui";
import { useMediaQuery } from "@/lib/client/use-media-query";
import { ChevronIcon, LogsIcon } from "./control-bar-icons";
import styles from "./control-bar.module.css";
import { DemoMenu, MenuToggle, type MenuFocus } from "./demo-menu";
import { useLiquidGlass } from "./liquid-glass";
import glassStyles from "./liquid-glass.module.css";
import { Segment } from "./segment";
import { StartOver, StartOverItem } from "./start-over";
import { SoundSegment, useVolumePanel, VolumePanel, VolumeSliders } from "./volume-panel";

/** Too narrow for every segment beside the wordmark. Mirrored in control-bar.module.css. */
const COMPACT_QUERY = "(max-width: 640px)";

// One glass bar over the stage: Logs, Sound and Restart, each the same size, an icon and its name. With the logs
// docked, the panel hangs from the bar as one piece of glass. In a narrow window the segments fold into one menu button.
export function ControlBar() {
  const { xrayOpen, setXrayOpen, wide, hydrated, barCorner } = useStageUi();
  const soundButton = useRef<HTMLButtonElement>(null);
  const volume = useVolumePanel(soundButton);
  const volumeId = useId();
  // CSS picks which segments show, so the server markup is right; this only decides whether the menu can open.
  const compact = useMediaQuery(COMPACT_QUERY);
  const [menu, setMenu] = useState<MenuFocus | null>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  // Before hydration CSS fuses the bar to the default docked panel (control-bar.module.css).
  const docked = hydrated && wide && xrayOpen;
  // Square along the bottom while the panel hangs from it; the panel itself squares and rounds the corners (barCorner).
  const { measure, style: glassStyle, filter: glassFilter } = useLiquidGlass({ flat: docked ? "bottom" : undefined });

  const closeMenu = (restoreFocus: boolean) => {
    setMenu(null);
    if (restoreFocus) menuButton.current?.focus();
  };

  return (
    <>
      {glassFilter}
      <motion.div
        ref={measure}
        layout
        role="group"
        aria-label="Demo controls"
        className={cx(glassStyles.liquid, styles.bar)}
        // Set here rather than in CSS so the layout animation keeps the pill round while it resizes.
        transition={SHEET}
        style={
          hydrated
            ? { borderTopLeftRadius: BAR_RADIUS, borderTopRightRadius: BAR_RADIUS, borderBottomLeftRadius: barCorner, borderBottomRightRadius: barCorner, ...glassStyle }
            : undefined
        }
      >
        <Segment
          icon
          aria-label="Demo menu"
          className={styles.compactOnly}
          ref={menuButton}
          aria-haspopup="menu"
          aria-expanded={menu !== null}
          aria-controls={menu ? menuId : undefined}
          onClick={() => setMenu(menu ? null : "first")}
          onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            event.preventDefault();
            setMenu(event.key === "ArrowDown" ? "first" : "last");
          }}
        >
          <ChevronIcon large />
        </Segment>
        <Segment wide aria-pressed={xrayOpen} className={cx(styles.selectable, styles.wideOnly)} onClick={() => setXrayOpen(!xrayOpen)}>
          <LogsIcon />
          Logs
        </Segment>
        <SoundSegment
          ref={soundButton}
          open={volume.open}
          panelId={volumeId}
          hover={volume.hover}
          onOpen={(byKeyboard) => {
            setMenu(null);
            volume.show(byKeyboard);
          }}
          onClose={volume.close}
        />
        <StartOver className={styles.wideOnly} />
      </motion.div>
      <AnimatePresence>
        {volume.open && !compact && <VolumePanel id={volumeId} anchor={soundButton} focus={volume.focus} hover={volume.hover} onClose={volume.close} />}
      </AnimatePresence>
      <AnimatePresence>
        {menu && compact && (
          <DemoMenu id={menuId} focus={menu} anchor={menuButton} onClose={closeMenu}>
            <MenuToggle
              checked={xrayOpen}
              onClick={() => {
                // Below the docked width the panel is a sheet, which takes the screen and the focus.
                closeMenu(false);
                setXrayOpen(!xrayOpen);
              }}
            >
              Logs
            </MenuToggle>
            <div className={styles.volumes}>
              <VolumeSliders inMenu />
            </div>
            <StartOverItem onErased={() => closeMenu(true)} />
          </DemoMenu>
        )}
      </AnimatePresence>
    </>
  );
}
