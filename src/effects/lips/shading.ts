// Volume shading for lip filler (pure geometry; the renderer draws it).
//
// A bigger outline alone reads as "bigger mouth"; what reads as "fuller lips" is light: fuller lips
// project, so the lower lip catches a highlight, the upper lip's centre and the border just above it
// catch light, and the lower lip casts a deeper shadow onto the chin below it. Every spot here is a
// soft ellipse placed in the mouth's own frame and scaled with the filler level, so 0 ml adds
// nothing and the shading grows smoothly with volume.
import type { Point } from "../../core/types";

export interface ShadeSpot {
  /** Centre and half-axes (display pixels), and rotation of the rx axis (radians). */
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  angle: number;
  kind: "light" | "shadow";
  /** Peak strength 0..1 at the centre (fades to 0 at the ellipse's edge). */
  alpha: number;
  /** Where it may draw: on the lips, or on the skin around them. */
  region: "lips" | "skin";
}

/** Peak strengths at full volume. */
export const SHADE = {
  lowerGloss: 0.3,
  upperGloss: 0.2,
  borderLight: 0.18,
  underShadow: 0.6,
  /** The upper lip turning inward toward the lip line, and the lower lip rolling away at its edge. */
  upperTuck: 0.28,
  lowerEdge: 0.16,
};

/**
 * Shading spots for grown lips. `outer` is the grown outline and `inner` the mouth opening (20
 * landmark-ordered points each: 0 left corner, 1-9 upper, 10 right corner, 11-19 lower);
 * `strength` is the filler level 0..1.
 */
export function lipShading(outer: Point[], inner: Point[], strength: number): ShadeSpot[] {
  const s = Math.max(0, Math.min(1, strength));
  if (s <= 0) return [];
  const left = outer[0],
    right = outer[10];
  const width = Math.hypot(right.x - left.x, right.y - left.y);
  if (width < 4) return [];
  const angle = Math.atan2(right.y - left.y, right.x - left.x);
  // Unit normal pointing from the upper lip to the lower lip.
  let nx = -Math.sin(angle),
    ny = Math.cos(angle);
  if ((outer[15].x - inner[15].x) * nx + (outer[15].y - inner[15].y) * ny < 0) {
    nx = -nx;
    ny = -ny;
  }
  const along = (a: Point, b: Point, t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const upperH = Math.hypot(outer[5].x - inner[5].x, outer[5].y - inner[5].y),
    lowerH = Math.hypot(outer[15].x - inner[15].x, outer[15].y - inner[15].y);
  const spot = (p: Point, rx: number, ry: number, kind: ShadeSpot["kind"], alpha: number, region: ShadeSpot["region"]): ShadeSpot => ({
    cx: p.x, cy: p.y, rx, ry, angle, kind, alpha: alpha * s, region,
  });
  const lowerBody = along(inner[15], outer[15], 0.45);
  const upperBody = along(inner[5], outer[5], 0.55);
  const under = { x: outer[15].x + nx * lowerH * 0.32, y: outer[15].y + ny * lowerH * 0.32 };
  const tuck = along(inner[5], outer[5], 0.12);
  const lowerRim = along(inner[15], outer[15], 0.9);
  return [
    spot(lowerBody, width * 0.2, lowerH * 0.32, "light", SHADE.lowerGloss, "lips"),
    spot(upperBody, width * 0.11, upperH * 0.3, "light", SHADE.upperGloss, "lips"),
    spot(tuck, width * 0.3, upperH * 0.28, "shadow", SHADE.upperTuck, "lips"),
    spot(lowerRim, width * 0.22, lowerH * 0.22, "shadow", SHADE.lowerEdge, "lips"),
    spot(under, width * 0.24, lowerH * 0.38, "shadow", SHADE.underShadow, "skin"),
  ];
}

/** The light line just above the upper border (the "white roll" catching light), as a path. */
export function borderLight(outer: Point[], inner: Point[], strength: number) {
  const s = Math.max(0, Math.min(1, strength));
  const upperH = Math.hypot(outer[5].x - inner[5].x, outer[5].y - inner[5].y);
  const angle = Math.atan2(outer[10].y - outer[0].y, outer[10].x - outer[0].x);
  let nx = Math.sin(angle),
    ny = -Math.cos(angle); // toward the nose
  if ((outer[5].x - inner[5].x) * nx + (outer[5].y - inner[5].y) * ny < 0) {
    nx = -nx;
    ny = -ny;
  }
  const off = upperH * 0.03; // straddles the border: half on the lip, half on the skin
  return {
    points: outer.slice(1, 10).map((q) => ({ x: q.x + nx * off, y: q.y + ny * off })),
    width: Math.max(2, upperH * 0.22),
    blur: Math.max(1, upperH * 0.12),
    alpha: SHADE.borderLight * s,
  };
}

/** Gloss glints at full volume: how strongly the lip's own bright texture is lifted. */
export const GLINT = { gain: 5, base: 0.06, max: 0.6 };

/**
 * Gloss glints: lip gloss catches light on the lip's own ridges, so the highlight is broken and
 * follows the lip lines rather than being a smooth blob. Returns a 0..255 alpha (to draw as white
 * light) for an RGBA region: pixels brighter than their neighbourhood (box radius `r`), weighted
 * by the soft ellipse `spot` (in the region's own coordinates).
 */
export function glintAlpha(
  pixels: Uint8ClampedArray,
  w: number,
  h: number,
  spot: { cx: number; cy: number; rx: number; ry: number; angle: number },
  strength: number,
  r = 3,
): Uint8ClampedArray {
  const n = w * h;
  const lum = new Float32Array(n);
  for (let p = 0; p < n; p++) lum[p] = (0.2126 * pixels[p * 4] + 0.7152 * pixels[p * 4 + 1] + 0.0722 * pixels[p * 4 + 2]) / 255;
  // Local mean (separable box).
  const tmp = new Float32Array(n),
    mean = new Float32Array(n);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let a = 0,
        c = 0;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++, c++) a += lum[y * w + k];
      tmp[y * w + x] = a / c;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let a = 0,
        c = 0;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++, c++) a += tmp[k * w + x];
      mean[y * w + x] = a / c;
    }
  const cos = Math.cos(spot.angle),
    sin = Math.sin(spot.angle);
  const s = Math.max(0, Math.min(1, strength));
  const out = new Uint8ClampedArray(n);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const dx = x + 0.5 - spot.cx,
        dy = y + 0.5 - spot.cy;
      const u = (dx * cos + dy * sin) / spot.rx,
        v = (-dx * sin + dy * cos) / spot.ry;
      const d2 = u * u + v * v;
      if (d2 >= 1) continue;
      const fall = (1 - d2) * (1 - d2);
      const p = y * w + x;
      const ridge = Math.max(0, lum[p] - mean[p]) * GLINT.gain;
      out[p] = Math.round(Math.min(GLINT.max, ridge + GLINT.base) * fall * s * 255);
    }
  return out;
}

/** Skin lightness (Rec.709 luma, 0..1) at which the border light is drawn at full strength. */
export const BORDER_SKIN_REF = 0.72;

/**
 * Colour and strength of the border light for this face, from skin samples just above the lip.
 * A fixed light reads as a pale outline on darker skin (screen lifts dark pixels the most), so the
 * light scales with the skin's lightness and takes its tint from the skin itself (a lighter
 * version of it), so it reads as that skin catching light. `border` = samples on the lip border
 * itself (optional).
 */
export function borderLightTone(
  samples: number[][],
  border: number[][] = [],
): { scale: number; rgb: [number, number, number] } {
  if (!samples.length) return { scale: 1, rgb: [255, 236, 224] };
  const mean = (xs: number[][]) => [0, 1, 2].map((c) => xs.reduce((a, s) => a + s[c], 0) / xs.length);
  const luma = (v: number[]) => (0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]) / 255;
  const m = mean(samples);
  const lum = luma(m);
  let scale = Math.max(0.3, Math.min(1, lum / BORDER_SKIN_REF));
  // The photo may already have a bright lip border (side light on the "white roll"): add less
  // light the brighter it already is than the skin above, so the highlight is not doubled.
  if (border.length) {
    const already = luma(mean(border)) - lum;
    scale *= Math.max(0.3, Math.min(1, 1 - already / 0.12));
  }
  // 55% of the way from the skin's colour to white keeps the skin's hue.
  const rgb = m.map((v) => Math.round(v + (255 - v) * 0.55)) as [number, number, number];
  return { scale, rgb };
}

/**
 * Colour and strength of an added shadow, from the surface it falls on. Real shadows keep the
 * hue of that surface, so the tint is the surface's own colour, darkened. With `reference` (the
 * skin a little further out, for the shadow under the lower lip), the shadow is weakened where the
 * photo already has one there (no doubled shadow), and is a little gentler on darker skin, where
 * a multiplied shadow turns muddy.
 */
export function shadowTone(
  here: number[][],
  reference: number[][] = [],
): { scale: number; rgb: [number, number, number] } {
  if (!here.length) return { scale: 1, rgb: [95, 55, 45] };
  const mean = (xs: number[][]) => [0, 1, 2].map((c) => xs.reduce((a, s) => a + s[c], 0) / xs.length);
  const luma = (v: number[]) => (0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]) / 255;
  const m = mean(here);
  const rgb = m.map((v) => Math.round(v * SHADOW_DARKEN)) as [number, number, number];
  let scale = 1;
  if (reference.length) {
    const ref = luma(mean(reference));
    const already = ref - luma(m); // how much darker the photo already is here
    scale *= Math.max(0.3, Math.min(1, 1 - already / 0.12));
    scale *= Math.max(0.5, Math.min(1, ref / BORDER_SKIN_REF));
  }
  return { scale, rgb };
}

/** Shadow tint = the surface's own colour times this. */
export const SHADOW_DARKEN = 0.5;
