import { ImageResponse } from "next/og";
import { MARK } from "@/components/brand/persona-logo";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

// ImageResponse cannot read CSS variables; these are --color-surface and --color-accent.
const SURFACE = "#ffffff";
const INK = "#090909";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ display: "flex", width: "100%", height: "100%", alignItems: "center", justifyContent: "center", background: SURFACE }}>
        <svg width="103" height="100" viewBox="0 0 23.6813 23">
          <path d={MARK} fill={INK} />
        </svg>
      </div>
    ),
    size,
  );
}
