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
export const SHADE = { lowerGloss: 0.3, upperGloss: 0.2, borderLight: 0.16, underShadow: 0.5 };

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
  const peaks = [outer[4], outer[6]].map((q) => ({ x: q.x - nx * upperH * 0.14, y: q.y - ny * upperH * 0.14 }));
  return [
    spot(lowerBody, width * 0.2, lowerH * 0.32, "light", SHADE.lowerGloss, "lips"),
    spot(upperBody, width * 0.11, upperH * 0.3, "light", SHADE.upperGloss, "lips"),
    ...peaks.map((q) => spot(q, width * 0.1, Math.max(1.5, upperH * 0.14), "light", SHADE.borderLight, "skin")),
    spot(under, width * 0.24, lowerH * 0.38, "shadow", SHADE.underShadow, "skin"),
  ];
}
