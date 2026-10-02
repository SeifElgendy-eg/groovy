// What the skin effects (acne, wrinkles) need from the host app, expressed as data so the
// effects never touch app globals or the DOM.
import type { Point } from "../../core/types";
import { LM } from "../../core/landmarks";

export interface NormalizedLandmark {
  x: number;
  y: number;
}

export interface SkinInput {
  /** Draw the display-oriented frame (mirrored for the camera) into `ctx` at aw x ah. */
  drawFrame: (ctx: CanvasRenderingContext2D, aw: number, ah: number) => void;
  /** Skin segmentation mask (alpha = skin) in the model's orientation and resolution. */
  segMask: HTMLCanvasElement;
  landmarks: NormalizedLandmark[];
  /** Camera frames are mirrored. */
  mirrored: boolean;
  /** Full display size. */
  w: number;
  h: number;
}

/** Analysis resolution: the effects run on a reduced copy and only upscale their correction maps. */
export function analysisSize(w: number, h: number, mirrored: boolean) {
  const scale = Math.min(1, (mirrored ? 640 : 1024) / Math.max(w, h));
  return { aw: Math.round(w * scale), ah: Math.round(h * scale) };
}

export function toDisplayPoints(
  landmarks: NormalizedLandmark[],
  aw: number,
  ah: number,
  mirrored: boolean,
): Point[] {
  return landmarks.map((lm) =>
    mirrored
      ? { x: (1 - lm.x) * aw, y: lm.y * ah }
      : { x: lm.x * aw, y: lm.y * ah },
  );
}

export function faceWidthOf(points: Point[]): number {
  return Math.hypot(
    points[LM.faceLeft].x - points[LM.faceRight].x,
    points[LM.faceLeft].y - points[LM.faceRight].y,
  );
}

/** Draw the segmentation mask into `ctx`, flipped when the frame is mirrored. */
export function drawSegMask(
  ctx: CanvasRenderingContext2D,
  seg: HTMLCanvasElement,
  aw: number,
  ah: number,
  mirrored: boolean,
): void {
  ctx.save();
  if (mirrored) {
    ctx.translate(aw, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(seg, 0, 0, aw, ah);
  ctx.restore();
}

export function scratch(readback = false) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", readback ? { willReadFrequently: true } : undefined)!;
  return { canvas, ctx };
}
