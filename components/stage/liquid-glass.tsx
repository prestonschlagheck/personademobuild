"use client";

import { useEffect, useId, useMemo, useState, useSyncExternalStore, type CSSProperties, type ReactNode, type RefCallback } from "react";

// iOS 26 Liquid Glass for a pill or a card: the rim bends what is behind it like a convex lens, splitting the colors
// slightly, and the face stays nearly clear. The refraction is an SVG displacement filter used as a
// backdrop-filter, which only Chromium renders; every other browser keeps the frosted fallback in CSS.

/** How far the rim bends the light at the very edge, in px. */
const BEND = 20;
/** Past this many pixels the map is drawn smaller and stretched; it is smooth, so nothing shows. */
const MAP_PIXELS = 40_000;
/** Blue bends a little less than red, which gives the rim its faint color split. */
const DISPERSION = [1, 0.92, 0.84] as const;
/** The frost over the refracted backdrop, in px. */
const FROST = 2.5;

type Size = { width: number; height: number };
/**
 * Corner radius (a pill when left out) and how deep the curved rim reaches in, both in px. A flat side is where
 * the glass joins another piece of glass, so it has no rim and the two read as one surface.
 */
type Shape = { radius?: number; bezel?: number; flat?: "top" | "bottom" };

const noop = () => () => {};

/** Attach `measure` to the glass, spread `style` onto it, and render `filter` beside it. */
export function useLiquidGlass({ radius, bezel = 22, flat }: Shape = {}): { measure: RefCallback<HTMLElement>; style?: CSSProperties; filter: ReactNode } {
  const id = `glass-${useId().replace(/:/g, "")}`;
  // userAgentData ships only in Chromium, the one engine that renders SVG filters in backdrop-filter.
  const supported = useSyncExternalStore(noop, () => "userAgentData" in navigator, () => false);
  const [size, setSize] = useState<Size | null>(null);
  const [el, setEl] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!el || !supported) return;
    const observer = new ResizeObserver(([entry]) => {
      const box = entry?.borderBoxSize[0];
      if (!box) return;
      const next = { width: Math.round(box.inlineSize), height: Math.round(box.blockSize) };
      setSize((prev) => (prev?.width === next.width && prev.height === next.height ? prev : next));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [el, supported]);

  const map = useMemo(
    () => (size && size.width > 0 && size.height > 0 ? displacementMap(size, radius ?? Math.min(size.width, size.height) / 2, bezel, flat) : null),
    [size, radius, bezel, flat],
  );
  if (!supported || !size || !map) return { measure: setEl, filter: null };

  const { width, height } = size;
  const filter = (
    <svg aria-hidden width="0" height="0" style={{ position: "absolute" }}>
      <filter id={id} x="0" y="0" width={width} height={height} filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
        <feImage href={map} x="0" y="0" width={width} height={height} preserveAspectRatio="none" result="map" />
        {DISPERSION.map((k, i) => (
          <feDisplacementMap key={i} in="SourceGraphic" in2="map" scale={2 * BEND * k} xChannelSelector="R" yChannelSelector="G" result={`d${i}`} />
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
  const backdrop = `url(#${id}) saturate(1.8) brightness(1.04)`;
  return { measure: setEl, style: { backdropFilter: backdrop, WebkitBackdropFilter: backdrop }, filter };
}

// Red and green carry where each pixel samples the backdrop from, 128 meaning in place. On the rim the
// sample moves inward along the surface normal, most at the edge and easing to none at the bezel's depth.
function displacementMap(size: Size, radius: number, bezel: number, flat?: Shape["flat"]) {
  const k = Math.min(1, Math.sqrt(MAP_PIXELS / (size.width * size.height)));
  const width = Math.max(1, Math.round(size.width * k));
  const height = Math.max(1, Math.round(size.height * k));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  const image = context.createImageData(width, height);
  // Measured in the element's own pixels, so a map drawn smaller keeps the same shape. A flat side is drawn as
  // if the shape ran on past it, far enough that its rim never reaches back in.
  const extend = flat ? radius + bezel : 0;
  const shift = flat === "top" ? extend : 0;
  const halfW = size.width / 2 - radius;
  const halfH = (size.height + extend) / 2 - radius;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = (x + 0.5) / k - size.width / 2;
      const py = (y + 0.5) / k + shift - (size.height + extend) / 2;
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
      const t = Math.min(Math.max(depth / bezel, 0), 1);
      const strength = (1 - t) ** 2;
      const i = (y * width + x) * 4;
      image.data[i] = 127.5 - nx * strength * 127.5;
      image.data[i + 1] = 127.5 - ny * strength * 127.5;
      image.data[i + 2] = 128;
      image.data[i + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  return canvas.toDataURL();
}
