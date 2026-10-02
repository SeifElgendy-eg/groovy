import type { Bounds, PathContext, Point } from "../core/types";

export function boundsOfPoints(pts: Point[]): Bounds {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity,
    sx = 0,
    sy = 0;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
    sx += p.x;
    sy += p.y;
  }
  return {
    minX,
    minY,
    maxX,
    maxY,
    cx: sx / pts.length,
    cy: sy / pts.length,
    width: maxX - minX,
    height: maxY - minY,
  };
}

export function addClosedContour(context: PathContext, pts: Point[]): void {
  if (!pts.length) return;
  context.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) context.lineTo(pts[i].x, pts[i].y);
  context.closePath();
}

/** Punch landmark-index contours out of a mask (caller sets destination-out). */
export function carveContours(
  context: PathContext,
  contours: number[][],
  points: Point[],
  lineWidth: number,
): void {
  context.lineJoin = "round";
  context.lineWidth = lineWidth;
  for (const ids of contours) {
    context.beginPath();
    addClosedContour(
      context,
      ids.map((i) => points[i]),
    );
    context.fill();
    context.stroke();
  }
}
