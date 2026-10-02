// Acne treatment: finds small red blemishes inside the skin mask and repairs them from the
// surrounding skin. Runs on a reduced analysis copy; the caller scales the result to the display.
import { carveContours, addClosedContour } from "../../imaging/contours";
import { ACNE_EXCLUSION_CONTOURS, OUTER_LIP } from "../../core/landmarks";
import {
  analysisSize,
  drawSegMask,
  faceWidthOf,
  scratch,
  toDisplayPoints,
  type SkinInput,
} from "../skin/input";
import { runAcne } from "../skin/client";

export class AcneEffect {
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
  private out = scratch();
  private work = scratch(true);
  private blur = scratch(true);
  private mask = scratch(true);

  /** The correction layer's final feathered mask, for the "show face mask" debug view. */
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
    const { out, work, blur, mask } = this;
    for (const c of [out, work, blur, mask]) {
      c.canvas.width = aw;
      c.canvas.height = ah;
    }
    input.drawFrame(work.ctx, aw, ah);
    drawSegMask(mask.ctx, input.segMask, aw, ah, input.mirrored);
    const points = toDisplayPoints(input.landmarks, aw, ah, input.mirrored);
    const faceWidth = faceWidthOf(points);
  const radius = Math.max(5, faceWidth * 0.035);
  // Tight feature contours leave the forehead, under-eye skin, nose and chin
  // available for blemish repair, rather than excluding large bounding ellipses.
  mask.ctx.save();
  mask.ctx.globalCompositeOperation = "destination-out";
  carveContours(
    mask.ctx,
    ACNE_EXCLUSION_CONTOURS,
    points,
    Math.max(1, faceWidth * 0.005),
  );
  // Protect lip corners and the natural dark crease beside the mouth.
  // Expand in the mouth's local axes, so protection follows head rotation.
  const mouth = OUTER_LIP.map((i) => points[i]);
  const mx = (mouth[0].x + mouth[10].x) / 2,
    my = (mouth[0].y + mouth[10].y) / 2;
  const angle = Math.atan2(mouth[10].y - mouth[0].y, mouth[10].x - mouth[0].x);
  const ux = Math.cos(angle),
    uy = Math.sin(angle);
  const protectedMouth = mouth.map((p) => {
    const dx = p.x - mx,
      dy = p.y - my,
      u = (dx * ux + dy * uy) * 1.3,
      v = (-dx * uy + dy * ux) * 1.35;
    return { x: mx + u * ux - v * uy, y: my + u * uy + v * ux };
  });
  mask.ctx.beginPath();
  addClosedContour(mask.ctx, protectedMouth);
  mask.ctx.fill();
  mask.ctx.lineWidth = Math.max(2, faceWidth * 0.012);
  mask.ctx.stroke();
  mask.ctx.restore();
  blur.ctx.filter = `blur(${radius * 0.65}px)`;
  blur.ctx.drawImage(work.canvas, 0, 0);
  blur.ctx.filter = "none";
  const result = await runAcne({
    work: work.ctx.getImageData(0, 0, aw, ah).data,
    blur: blur.ctx.getImageData(0, 0, aw, ah).data,
    mask: mask.ctx.getImageData(0, 0, aw, ah).data,
    aw,
    ah,
    faceWidth,
    radius,
  });
  if (gen !== this.gen) return false;
  mask.ctx.putImageData(new ImageData(result.faded, aw, ah), 0, 0);
  out.ctx.putImageData(new ImageData(result.corrected, aw, ah), 0, 0);
  this.stale = false;
  this.ready = true;
  return true;
  }

  /** Composite the prepared correction over `target` at the given strength (0..1). */
  draw(target: CanvasRenderingContext2D, w: number, h: number, amount: number): void {
    target.save();
    target.globalAlpha = amount;
    target.imageSmoothingEnabled = true;
    target.drawImage(this.out.canvas, 0, 0, w, h);
    target.restore();
  }
}
