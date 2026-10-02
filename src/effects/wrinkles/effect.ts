// Wrinkle ("botox") smoothing. Builds a face-only skin mask, finds the treatable regions, and
// computes a signed correction (multiply + add layers) that the caller composites over the photo.
import { addClosedContour, carveContours } from "../../imaging/contours";
import { insetSkinMask } from "../../imaging/maskOps";
import { WRINKLE_EXCLUSION_CONTOURS } from "../../core/landmarks";
import { faceOval, guardContours, refineSkinMask } from "../../face/mask";
import {
  analysisSize,
  drawSegMask,
  faceWidthOf,
  scratch,
  toDisplayPoints,
  type SkinInput,
} from "../skin/input";
import { reduceWrinkles } from "./reduce";
import { wrinkleRegions } from "./regions";

export class WrinklesEffect {
  /** Set when the face, mask or source changed; the next render re-runs prepare(). */
  dirty = true;
  /** "add" layer: light that fills creases. */
  private addLayer = scratch();
  /** "multiply" layer: gain that darkens ridges. */
  private mulLayer = scratch();
  private work = scratch(true);
  private mask = scratch(true);

  /** The final treatable-skin mask, for the "show face mask" debug view. */
  get maskCanvas(): HTMLCanvasElement {
    return this.mask.canvas;
  }

  prepare(input: SkinInput): void {
    const { aw, ah } = analysisSize(input.w, input.h, input.mirrored);
    const { addLayer, mulLayer, work, mask } = this;
    for (const c of [addLayer, mulLayer, work, mask]) {
      c.canvas.width = aw;
      c.canvas.height = ah;
    }
    input.drawFrame(work.ctx, aw, ah);
    drawSegMask(mask.ctx, input.segMask, aw, ah, input.mirrored);
    const points = toDisplayPoints(input.landmarks, aw, ah, input.mirrored);
    const faceWidth = faceWidthOf(points);

  // 1. Face only: clip to the landmark oval so ears (and anything else the segmenter calls
  //    skin outside the face) can never be treated.
  mask.ctx.save();
  mask.ctx.globalCompositeOperation = "destination-in";
  mask.ctx.fillStyle = "#fff";
  mask.ctx.beginPath();
  addClosedContour(mask.ctx, faceOval(points, faceWidth));
  mask.ctx.fill();
  mask.ctx.restore();

  mask.ctx.save();
  mask.ctx.globalCompositeOperation = "destination-out";
  carveContours(
    mask.ctx,
    WRINKLE_EXCLUSION_CONTOURS,
    points,
    Math.max(1, faceWidth * 0.005),
  );
  // 2. Lashes and eyebrows: full loops grown outward, with a rounded edge.
  mask.ctx.lineJoin = "round";
  mask.ctx.lineWidth = Math.max(1.5, faceWidth * 0.008);
  for (const poly of guardContours(points, faceWidth)) {
    mask.ctx.beginPath();
    addClosedContour(mask.ctx, poly);
    mask.ctx.fill();
    mask.ctx.stroke();
  }
  // The bridge and sidewalls are facial shape, not wrinkle creases.
  // Protect the complete nose, with an inward feather below.
  const noseTop = points[6],
    noseBottom = points[2];
  const nx = (noseTop.x + noseBottom.x) / 2,
    ny = (noseTop.y + noseBottom.y) / 2;
  const noseHeight = Math.hypot(
    noseBottom.x - noseTop.x,
    noseBottom.y - noseTop.y,
  );
  const noseWidth = Math.hypot(
    points[98].x - points[327].x,
    points[98].y - points[327].y,
  );
  mask.ctx.beginPath();
  mask.ctx.ellipse(
    nx,
    ny,
    Math.max(4, noseWidth * 0.8),
    Math.max(6, noseHeight * 0.68),
    -Math.atan2(noseBottom.x - noseTop.x, noseBottom.y - noseTop.y),
    0,
    Math.PI * 2,
  );
  mask.ctx.fill();
  mask.ctx.restore();
  const original = work.ctx.getImageData(0, 0, aw, ah).data;
  // 3. Snap the soft 256px segmentation edge to the real hairline using the photo's own
  //    colours, then fade inward. Small margin/feather = treatment runs close to the hair.
  const refined = refineSkinMask(
    mask.ctx.getImageData(0, 0, aw, ah).data,
    original,
    aw,
    ah,
    Math.max(3, Math.round(faceWidth * 0.02)),
  );
  const faded = insetSkinMask(
    refined,
    aw,
    ah,
    1,
    Math.max(3, faceWidth * 0.01),
  );
  mask.ctx.putImageData(new ImageData(faded, aw, ah), 0, 0);
  const regions = wrinkleRegions(points, faceWidth);
  // reduceWrinkles returns a signed correction: `mul` (gain <= 1) and `add` (light).
  // Only these smooth maps are upscaled, never a downsampled copy of the skin, so the
  // full-resolution photo keeps its own texture inside and outside the treated areas.
  const { add, mul } = reduceWrinkles(
    original,
    faded,
    aw,
    ah,
    Math.max(2, Math.round(faceWidth * 0.012)),
    regions,
    // Smoothing strength. smoothing: how big a fold the filter flattens (default 1, max ~2.2).
    // lines: removal of faint thin lines (default 1). texture: pore detail kept (default 0.9;
    // lower = smoother but more "plastic").
    { smoothing: 1.25, lines: 1.3, texture: 0.82 },
  );
  addLayer.ctx.putImageData(new ImageData(add, aw, ah), 0, 0);
  mulLayer.ctx.putImageData(new ImageData(mul, aw, ah), 0, 0);
  this.dirty = false;
  }

  /**
   * Composite the correction over `target` at the given strength (0..1). Only these smooth maps
   * are upscaled, so the full-resolution photo keeps its own texture.
   */
  draw(target: CanvasRenderingContext2D, w: number, h: number, amount: number): void {
    target.save();
    target.globalAlpha = amount;
    target.imageSmoothingEnabled = true;
    target.globalCompositeOperation = "multiply";
    target.drawImage(this.mulLayer.canvas, 0, 0, w, h); // darken ridges
    target.globalCompositeOperation = "lighter";
    target.drawImage(this.addLayer.canvas, 0, 0, w, h); // fill creases
    target.restore();
  }
}
