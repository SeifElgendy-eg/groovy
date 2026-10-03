// Botox areas (forehead, frown lines, crow's feet) as zones that follow the eye axis.
import type { Point } from "../../core/types";
import type { Zone } from "./lines";

/**
 * The three botox areas as zones for the line finder (lines.ts), from landmarks in the same pixel
 * space: the forehead (lines run across it), the frown lines between the brows (they run up and
 * down) and the crow's feet at each outer eye corner (they fan out from the corner).
 */
export function botoxZones(points: Point[], faceWidth: number): Zone[] {
  const P = points,
    fw = faceWidth;
  const angle = Math.atan2(P[263].y - P[33].y, P[263].x - P[33].x);
  const ux = Math.cos(angle),
    uy = Math.sin(angle),
    vx = -uy,
    vy = ux; // v points down the face
  const brow = { x: (P[105].x + P[334].x) / 2, y: (P[105].y + P[334].y) / 2 };
  const foreheadHeight = Math.abs((brow.x - P[10].x) * vx + (brow.y - P[10].y) * vy);
  const zones: Zone[] = [
    {
      id: "forehead",
      // Up to the hairline (the face mesh stops below it; the skin mask keeps the hair out).
      cx: (P[10].x + brow.x) / 2 - vx * fw * 0.08,
      cy: (P[10].y + brow.y) / 2 - vy * fw * 0.08,
      rx: fw * 0.46,
      ry: Math.max(4, foreheadHeight * 0.75 + fw * 0.12),
      angle,
      lineAngle: angle,
    },
    {
      id: "frown",
      // Between the brows, from a little above them down to the top of the nose.
      cx: (P[107].x + P[336].x) / 2 + vx * fw * 0.02,
      cy: (P[107].y + P[336].y) / 2 + vy * fw * 0.02,
      rx: fw * 0.11,
      ry: fw * 0.14,
      angle,
      lineAngle: angle + Math.PI / 2,
    },
  ];
  for (const [outer, inner, side] of [
    [33, 133, -1],
    [263, 362, 1],
  ]) {
    const ew = Math.hypot(P[outer].x - P[inner].x, P[outer].y - P[inner].y);
    zones.push({
      id: "crows",
      cx: P[outer].x + ux * side * ew * 0.72,
      cy: P[outer].y + uy * side * ew * 0.72,
      rx: ew * 0.9,
      ry: ew * 1.0,
      angle,
      from: { x: P[outer].x - ux * side * ew * 0.1, y: P[outer].y - uy * side * ew * 0.1 },
      // Crow's feet curve as they fan out: a wider direction tolerance than the forehead's.
      tolerance: [35, 65],
      fine: true,
    });
    // ...and they run on, down and out from the corner over the upper cheek.
    zones.push({
      id: "crows",
      cx: P[outer].x + ux * side * ew * 0.45 + vx * ew * 0.85,
      cy: P[outer].y + uy * side * ew * 0.45 + vy * ew * 0.85,
      rx: ew * 0.85,
      ry: ew * 0.75,
      angle,
      from: { x: P[outer].x - ux * side * ew * 0.1, y: P[outer].y - uy * side * ew * 0.1 },
      tolerance: [40, 70],
      fine: true,
    });
  }
  // Under the eyes: the crepey band below the lower lid, inner to outer corner (lashes and the
  // lid margin are carved out of the skin mask). Lines here run every way.
  for (const [outer, inner, lower] of [
    [33, 133, 145],
    [263, 362, 374],
  ]) {
    const ew = Math.hypot(P[outer].x - P[inner].x, P[outer].y - P[inner].y);
    const mx = (P[outer].x + P[inner].x) / 2;
    // Lower under-eye: crepe in every direction.
    zones.push({
      id: "undereye",
      cx: mx + ux * 0 + vx * ew * 0.6,
      cy: P[lower].y + vy * ew * 0.6,
      rx: ew * 0.85,
      ry: ew * 0.45,
      angle,
      anyDirection: true,
      fine: true,
    });
    // Right below the lid: only lines running along the lid (the under-lid line), never the
    // lashes, which cross it.
    zones.push({
      id: "undereye",
      cx: mx + vx * ew * 0.2,
      cy: P[lower].y + vy * ew * 0.2,
      rx: ew * 0.7,
      ry: ew * 0.2,
      angle,
      lineAngle: angle,
      tolerance: [20, 40],
      strict: true,
      fine: true,
    });
  }
  return zones;
}
