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
      cx: (P[10].x + brow.x) / 2 - vx * fw * 0.05,
      cy: (P[10].y + brow.y) / 2 - vy * fw * 0.05,
      rx: fw * 0.44,
      ry: Math.max(4, foreheadHeight * 0.62 + fw * 0.08),
      angle,
      lineAngle: angle,
    },
    {
      id: "frown",
      cx: (P[107].x + P[336].x) / 2 - vx * fw * 0.02,
      cy: (P[107].y + P[336].y) / 2 - vy * fw * 0.02,
      rx: fw * 0.09,
      ry: fw * 0.11,
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
    });
  }
  return zones;
}
