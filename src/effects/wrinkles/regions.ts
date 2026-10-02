// Wrinkle target / protected regions, expressed as ellipses that follow the eye axis.
import type { Point } from "../../core/types";

/** An ellipse that shapes where the smoothing is applied. */
export interface Region {
  x: number;
  y: number;
  rx: number;
  ry: number;
  angle: number;
  strength?: number;
  feather?: number;
  /** Removes treatment (eyes). */
  protect?: boolean;
  /** Weak, shallow-line-only continuation. */
  support?: boolean;
}

// ---------------------------------------------------------------- regions
// points: landmarks in canvas pixels. Returns ellipses that follow the eye axis.
export function wrinkleRegions(points: Point[], faceWidth: number): Region[] {
  const P = points,
    fw = faceWidth;
  const angle = Math.atan2(P[263].y - P[33].y, P[263].x - P[33].x);
  const ux = Math.cos(angle),
    uy = Math.sin(angle),
    vx = -uy,
    vy = ux;
    const regions: Region[] = [];

  // Forehead
  const brow = { x: (P[105].x + P[334].x) / 2, y: (P[105].y + P[334].y) / 2 };
  const foreheadHeight = Math.abs(
    (brow.x - P[10].x) * vx + (brow.y - P[10].y) * vy,
  );
  regions.push({
    x: (P[10].x + brow.x) / 2 - vx * fw * 0.06,
    y: (P[10].y + brow.y) / 2 - vy * fw * 0.06,
    rx: fw * 0.46,
    ry: Math.max(4, foreheadHeight * 0.7 + fw * 0.1),
    angle,
    strength: 1,
  });
  // Glabella (between the brows)
  regions.push({
    x: (P[107].x + P[336].x) / 2,
    y: (P[107].y + P[336].y) / 2,
    rx: fw * 0.115,
    ry: fw * 0.15,
    angle,
    strength: 0.95,
  });
  // Lower lateral forehead, above each brow
  for (const b of [105, 334])
    regions.push({
      x: P[b].x - vx * fw * 0.07,
      y: P[b].y - vy * fw * 0.07,
      rx: fw * 0.24,
      ry: fw * 0.11,
      angle,
      strength: 0.95,
      feather: 0.5,
    });

  // Eyes: crow's feet toward the temple, and the under-eye area
  for (const [outer, inner, lower, side] of [
    [33, 133, 145, -1],
    [263, 362, 374, 1],
  ]) {
    const ew = Math.hypot(P[outer].x - P[inner].x, P[outer].y - P[inner].y);
    regions.push({
      x: P[outer].x + ux * side * ew * 0.42,
      y: P[outer].y + uy * side * ew * 0.42,
      rx: ew * 0.78,
      ry: ew * 0.95,
      angle,
      strength: 0.95,
    });
    regions.push({
      x: (P[outer].x + P[inner].x) / 2 + vx * ew * 0.34,
      y: P[lower].y + vy * ew * 0.34,
      rx: ew * 0.75,
      ry: ew * 0.42,
      angle,
      strength: 0.85,
    });
  }

  // Eyes are protected: lashes sit just outside the lid contour, so the protection is wider
  // than the eye opening, reaches higher above the lid (upper lashes) than below it.
  for (const [outer, inner] of [
    [33, 133],
    [263, 362],
  ]) {
    const ew = Math.hypot(P[outer].x - P[inner].x, P[outer].y - P[inner].y),
      cx = (P[outer].x + P[inner].x) / 2,
      cy = (P[outer].y + P[inner].y) / 2;
    regions.push({
      protect: true,
      x: cx - vx * ew * 0.07,
      y: cy - vy * ew * 0.07,
      rx: ew * 0.62,
      ry: ew * 0.42,
      angle,
      strength: 1,
      feather: 0.3,
    });
  }

  // Cheek folds: nasolabial (nose wing -> mouth corner) and marionette (mouth corner -> jaw).
  // Ellipses lie ALONG the fold, so the lip/nose exclusions still protect the features.
  for (const [wing, corner, jaw] of [
    [48, 61, 172],
    [278, 291, 397],
  ]) {
    const a = P[wing],
      b = P[corner],
      len = Math.hypot(b.x - a.x, b.y - a.y);
    regions.push({
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
      rx: len * 0.62,
      ry: fw * 0.05,
      angle: Math.atan2(b.y - a.y, b.x - a.x),
      strength: 0.8,
      feather: 0.6,
    });
    const c = P[jaw],
      len2 = Math.hypot(c.x - b.x, c.y - b.y);
    regions.push({
      x: (b.x + c.x) / 2,
      y: (b.y + c.y) / 2,
      rx: len2 * 0.6,
      ry: fw * 0.045,
      angle: Math.atan2(c.y - b.y, c.x - b.x),
      strength: 0.7,
      feather: 0.6,
    });
  }
  // Gentle continuation through the cheeks, restricted to shallow lines.
  for (const [eye, mouth] of [
    [33, 61],
    [263, 291],
  ])
    regions.push({
      x: P[eye].x * 0.6 + P[mouth].x * 0.4,
      y: P[eye].y * 0.6 + P[mouth].y * 0.4,
      rx: fw * 0.22,
      ry: fw * 0.3,
      angle,
      strength: 0.35,
      feather: 0.65,
      support: true,
    });
  return regions;
}
