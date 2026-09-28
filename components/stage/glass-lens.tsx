"use client";

import { useId, useMemo, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";

// A small Liquid Glass lens, for a slider's thumb: it magnifies what is under it a little, bends it harder at the
// rim, splits the colors there, and frosts it lightly. The pill-sized refraction in liquid-glass.tsx bends 20px,
// which smears a 24px thumb, so a lens this small gets its own gentler map. Chromium only, like that one.

/** Magnification at the center. */
const ZOOM = 1.28;
/** Extra inward bend at the very rim, in px. */
const BEND = 6;
/** How deep the rim reaches in, in px. */
const BEZEL = 10;
/** The largest displacement the map can hold, in px, either way. */
const RANGE = 14;
const DISPERSION = [1, 0.9, 0.8] as const;
const FROST = 0.8;

const noop = () => () => {};

/** Spread `style` onto an element of exactly `width` x `height` px (before any transform) and render `filter` beside it. */
export function useGlassLens(width: number, height: number): { style?: CSSProperties; filter: ReactNode } {
  const id = `lens-${useId().replace(/:/g, "")}`;
  const supported = useSyncExternalStore(noop, () => "userAgentData" in navigator, () => false);
  const map = useMemo(() => (supported ? lensMap(width, height) : null), [supported, width, height]);
  if (!map) return { filter: null };

  const filter = (
    <svg aria-hidden width="0" height="0" style={{ position: "absolute" }}>
      <filter id={id} x="0" y="0" width={width} height={height} filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
        <feImage href={map} x="0" y="0" width={width} height={height} preserveAspectRatio="none" result="map" />
        {DISPERSION.map((k, i) => (
          <feDisplacementMap key={i} in="SourceGraphic" in2="map" scale={2 * RANGE * k} xChannelSelector="R" yChannelSelector="G" result={`d${i}`} />
        ))}
        <feColorMatrix in="d0" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="r" />
        <feColorMatrix in="d1" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="g" />
        <feColorMatrix in="d2" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="b" />
        <feBlend in="r" in2="g" mode="screen" result="rg" />
        <feBlend in="rg" in2="b" mode="screen" result="rgb" />
        <feGaussianBlur in="rgb" stdDeviation={FROST} />
      </filter>
    </svg>
  );
  // Lower contrast and a clear lift, so the black fill under the lens reads as a light grey, never a dark blot.
  const backdrop = `url(#${id}) contrast(0.62) brightness(1.45) saturate(1.4)`;
  return { style: { backdropFilter: backdrop, WebkitBackdropFilter: backdrop }, filter };
}

// Red and green carry where each pixel samples the backdrop from, 128 meaning in place. Every sample moves toward
// the center (the zoom), and on the rim further in along the surface normal (the bend).
function lensMap(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  const image = context.createImageData(width, height);
  const radius = Math.min(width, height) / 2;
  const halfW = width / 2 - radius;
  const halfH = height / 2 - radius;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = x + 0.5 - width / 2;
      const py = y + 0.5 - height / 2;
      const qx = Math.abs(px) - halfW;
      const qy = Math.abs(py) - halfH;
      let nx = 0;
      let ny = 0;
      let depth: number;
      if (qx > 0 && qy > 0) {
        const length = Math.hypot(qx, qy);
        depth = radius - length;
        nx = (qx / length) * Math.sign(px);
        ny = (qy / length) * Math.sign(py);
      } else if (qx > qy) {
        depth = radius - qx;
        nx = Math.sign(px);
      } else {
        depth = radius - qy;
        ny = Math.sign(py);
      }
      const rim = (1 - Math.min(Math.max(depth / BEZEL, 0), 1)) ** 2 * BEND;
      const dx = -px * (1 - 1 / ZOOM) - nx * rim;
      const dy = -py * (1 - 1 / ZOOM) - ny * rim;
      const i = (y * width + x) * 4;
      image.data[i] = channel(dx);
      image.data[i + 1] = channel(dy);
      image.data[i + 2] = 128;
      image.data[i + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  return canvas.toDataURL();
}

const channel = (offset: number) => Math.round(127.5 + (Math.max(-RANGE, Math.min(RANGE, offset)) / (2 * RANGE)) * 255);
