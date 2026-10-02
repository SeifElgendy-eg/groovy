// Wrinkle ("botox") smoothing. Builds a face-only skin mask, finds the treatable regions, and
// computes a signed correction (multiply + add layers) that the caller composites over the photo.
import { addClosedContour, carveContours } from "../../imaging/contours";
import { WRINKLE_EXCLUSION_CONTOURS } from "../../core/landmarks";
import { faceOval, guardContours } from "../../face/mask";
import {
  analysisSize,
  drawSegMask,
  faceWidthOf,
  scratch,
  toDisplayPoints,
  type SkinInput,
} from "../skin/input";
import { runWrinkles } from "../skin/client";

export class WrinklesEffect {
  private stale = true;
  private gen = 0;
  /** A prepare() is running (its pixel work happens in a Web Worker). */
  busy = false;
  /** The prepared correction matches the current face, mask and source. */
  ready = false;

  /** Set when the face, mask or source changed; the next render re-runs prepare(). */
  get dirty(): boolean {
    return this.stale;
  }
  set dirty(v: boolean) {
    this.stale = v;
    if (v) {
      this.ready = false;
      this.gen++; // any prepare() still running is now out of date
    }
  }
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

  /** Resolves true when the result was applied, false when the input changed meanwhile. */
  async prepare(input: SkinInput): Promise<boolean> {
    const gen = this.gen;
    this.busy = true;
    try {
      return await this.run(input, gen);
    } finally {
      this.busy = false;
    }
  }

  private async run(input: SkinInput, gen: number): Promise<boolean> {
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
  const result = await runWrinkles({
    original: work.ctx.getImageData(0, 0, aw, ah).data,
    mask: mask.ctx.getImageData(0, 0, aw, ah).data,
    aw,
    ah,
    points,
    faceWidth,
  });
  if (gen !== this.gen) return false;
  mask.ctx.putImageData(new ImageData(result.faded, aw, ah), 0, 0);
  addLayer.ctx.putImageData(new ImageData(result.add, aw, ah), 0, 0);
  mulLayer.ctx.putImageData(new ImageData(result.mul, aw, ah), 0, 0);
  this.stale = false;
  this.ready = true;
  return true;
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
