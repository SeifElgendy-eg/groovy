export interface Point {
  x: number;
  y: number;
}

/** Axis-aligned bounds plus centroid of a point set. */
export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  cx: number;
  cy: number;
  width: number;
  height: number;
}

/** Inclusive pixel rectangle. */
export interface Box {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** Any 2D context that can hold a path (canvas, offscreen canvas). */
export type PathContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
