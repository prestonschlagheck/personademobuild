import type { CSSProperties } from "react";
import styles from "./messages.module.css";

// Blur bands, each reaching a little less far down, so the blur stacks up under the status bar and header
// buttons and fades in steps too small to see. Bands, not a mask: Chromium skips a mask on a backdrop-filter
// inside the phone's clipped screen, which leaves a hard line where the blur ends.
const BANDS = [
  { reach: 100, blur: 1.5 },
  { reach: 82, blur: 2 },
  { reach: 64, blur: 2.5 },
];

// The iOS 26 scroll edge under the status bar and header: a wash that keeps the time, the buttons and the name
// pill clear of the text scrolling under them, easing out just below the pill. The composer has none; only its
// own glass blurs the thread.
export function ScrollEdge() {
  return (
    <div aria-hidden className={styles.scrollEdge}>
      {BANDS.map(({ reach, blur }) => {
        const filter = `blur(calc(var(--pt) * ${blur}))`;
        const band: CSSProperties = { height: `${reach}%`, WebkitBackdropFilter: filter, backdropFilter: filter };
        return <span key={reach} className={styles.scrollEdgeBand} style={band} />;
      })}
      <span className={styles.scrollEdgeWash} />
    </div>
  );
}
