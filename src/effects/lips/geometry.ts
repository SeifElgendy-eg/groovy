// Lip landmarks -> display-space geometry, and the outer-lip growth model. Pure functions.
import type { Bounds, Point } from "../../core/types";
import { INNER_MOUTH, OUTER_LIP } from "../../core/landmarks";
import { boundsOfPoints } from "../../imaging/contours";

export interface LipData {
  outerPts: Point[];
  innerPts: Point[];
  outer: Bounds;
  inner: Bounds;
  cy: number;
}

/** User-facing settings, all normalised to 0..1 (colour is a #RRGGBB string or ""). */
export interface LipParams {
  /** Filler volume. */
  amount: number;
  /** "Lip Roll": how much the tissue rolls outward rather than stretching flat. */
  roll: number;
  /** "Edge Blend": feather width of the lip mask. */
  blend: number;
  colorIntensity: number;
  shadeHex: string;
  /** Lipstick finish: how the lip's own highlights are shown. */
  finish: "natural" | "matte" | "gloss";
  showOutline: boolean;
}

export interface NormalizedPoint {
  x: number;
  y: number;
}

/** Camera frames are shown mirrored, so landmarks flip horizontally with them. */
export function buildLipData(
  landmarks: NormalizedPoint[],
  w: number,
  h: number,
  mirrored: boolean,
): LipData {
  const toDisplay = (lm: NormalizedPoint): Point =>
    mirrored ? { x: (1 - lm.x) * w, y: lm.y * h } : { x: lm.x * w, y: lm.y * h };
  const outerPts = OUTER_LIP.map((i) => toDisplay(landmarks[i]));
  const innerPts = INNER_MOUTH.map((i) => toDisplay(landmarks[i]));
  const outer = boundsOfPoints(outerPts);
  const inner = boundsOfPoints(innerPts);
  return { outerPts, innerPts, outer, inner, cy: (outer.cy + inner.cy) / 2 };
}

/**
 * Lower : upper lip height ratio that filler steers toward. Natural lips are ~1.6; filled lips
 * end nearer 1.3 because the upper lip takes more volume (it is usually the thinner one).
 */
export const FILLED_RATIO = 1.3;

/** Volume per unit of filler level, as a share of each lip's own height (before steering). */
const GROWTH = 0.55;
/** Largest growth per unit level, as a share of mouth width: upper, lower (no droop). */
const CAP = { upper: 0.06, lower: 0.055 };

const bump = (t: number, c: number, s: number) => Math.exp(-(((t - c) / s) ** 2));

/**
 * Grow the outer lip contour, in the mouth's own coordinate system (like the 1-4 ml clinic
 * ladder): both lips gain volume in proportion to their height, steered toward FILLED_RATIO, so
 * the upper lip usually grows more. The upper lip's volume peaks under the Cupid's bow; the lower
 * lip's in its two central lobes; both taper to fixed corners. The mouth opening stays put.
 */
export function transformOuterLip(
  pts: Point[],
  inner: Point[],
  amount: number,
  verticalBias: number,
): Point[] {
  const left = pts[0],
    right = pts[10];
  const width = Math.hypot(right.x - left.x, right.y - left.y);
  if (width < 1) return pts;
  const ux = (right.x - left.x) / width,
    uy = (right.y - left.y) / width;
  let nx = -uy,
    ny = ux;
  if ((pts[15].x - inner[15].x) * nx + (pts[15].y - inner[15].y) * ny < 0) {
    nx = -nx;
    ny = -ny;
  }
  const heightAt = (i: number) => Math.abs((pts[i].x - inner[i].x) * nx + (pts[i].y - inner[i].y) * ny);
  const r = Math.max(1, heightAt(15)) / Math.max(1, heightAt(5));
  const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
  const bias = { upper: clamp(r / FILLED_RATIO, 0.6, 1.6), lower: clamp(FILLED_RATIO / r, 0.6, 1.6) };
  const level = amount / 0.4;
  const roll = 0.35 + 1.3 * clamp((verticalBias - 0.2) / 0.8, 0, 1);
  return pts.map((p, i) => {
    if (i === 0 || i === 10) return { ...p };
    const t = (i % 10) / 10;
    const edge = Math.pow(Math.sin(Math.PI * t), 0.9);
    const upper = i < 10;
    // Where the volume goes along each lip (1 = average).
    const shape = upper
      ? 0.72 + 0.4 * (bump(t, 0.36, 0.12) + bump(t, 0.64, 0.12))
      : 0.75 + 0.3 * (bump(t, 0.38, 0.15) + bump(t, 0.62, 0.15));
    const growth =
      Math.min(heightAt(i) * GROWTH * (upper ? bias.upper : bias.lower), width * (upper ? CAP.upper : CAP.lower)) *
      level * edge * shape * roll;
    const side = (t < 0.5 ? -1 : 1) * (upper ? 1 : -1);
    const spread = width * level * 0.01 * edge * Math.abs(2 * t - 1) * side;
    return {
      x: p.x + nx * growth * (upper ? -1 : 1) + ux * spread,
      y: p.y + ny * growth * (upper ? -1 : 1) + uy * spread,
    };
  });
}

/**
 * Cross-section of the grown lip: where tissue at fraction t (0 mouth opening .. 1 lip edge) ends
 * up, as a fraction of the new height. A gentle outward roll; kept mild so the stretch is spread
 * through the lip instead of smearing the lip lines near the opening.
 */
export function rollProfile(amount: number, roll: number): (t: number) => number {
  const r = Math.max(0, Math.min(1, (roll - 0.2) / 0.8));
  const k = amount * (0.03 + r * 0.14);
  return (t: number) => t + k * Math.sin(Math.PI * t);
}

/** Where the lip contours end up for the given settings. */
export function computeLipTargets(lip: LipData, p: LipParams) {
  const targetOuter =
    p.amount > 0.001
      ? transformOuterLip(lip.outerPts, lip.innerPts, p.amount, p.roll)
      : lip.outerPts;
  return { targetOuter, targetInner: lip.innerPts };
}
