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

// Work in the mouth's local coordinate system. Cap lower-lip growth by
// mouth width, so a naturally thick lower lip is not multiplied into a droop.
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
  const level = amount / 0.4;
  return pts.map((p, i) => {
    if (i === 0 || i === 10) return { ...p };
    const t = (i % 10) / 10;
    const edge = Math.pow(Math.sin(Math.PI * t), 0.9);
    const upper = i < 10;
    const thickness = Math.abs(
      (p.x - inner[i].x) * nx + (p.y - inner[i].y) * ny,
    );
    // Upper lobes lift; lower volume spreads across the shoulders with a
    // restrained centre. The inner mouth and corners remain unchanged.
    const lobes = upper
      ? 0.62 + 0.38 * Math.pow(Math.sin(2 * Math.PI * t), 2)
      : 0.55 + 0.45 * Math.pow(Math.sin(2 * Math.PI * t), 2);
    const cap = width * (upper ? 0.052 : 0.026);
    const growth =
      Math.min(thickness * (upper ? 0.55 : 0.25), cap) *
      level *
      edge *
      lobes *
      (0.35 + 1.3 * Math.max(0, Math.min(1, (verticalBias - 0.2) / 0.8)));
    const side = (t < 0.5 ? -1 : 1) * (upper ? 1 : -1);
    const spread = width * level * 0.012 * edge * Math.abs(2 * t - 1) * side;
    return {
      x: p.x + nx * growth * (upper ? -1 : 1) + ux * spread,
      y: p.y + ny * growth * (upper ? -1 : 1) + uy * spread,
    };
  });
}

/** Where the lip contours end up for the given settings. */
export function computeLipTargets(lip: LipData, p: LipParams) {
  const targetOuter =
    p.amount > 0.001
      ? transformOuterLip(lip.outerPts, lip.innerPts, p.amount, p.roll)
      : lip.outerPts;
  return { targetOuter, targetInner: lip.innerPts };
}
