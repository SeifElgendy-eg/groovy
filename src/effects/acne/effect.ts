// Acne treatment: finds small red blemishes inside the skin mask and repairs them from the
// surrounding skin. Runs on a reduced analysis copy; the caller scales the result to the display.
import { carveContours, addClosedContour } from "../../imaging/contours";
import { guardContours } from "../../face/mask";
import { ACNE_EXCLUSION_CONTOURS, NOSE_WING_EDGES, OUTER_LIP } from "../../core/landmarks";
import {
  analysisSize,
  drawSegMask,
  faceWidthOf,
  scratch,
  toDisplayPoints,
  type SkinInput,
} from "../skin/input";
import { Cancelled, cancel, runAcne, runTexture } from "../skin/client";
import type { Layers } from "./texture";
import { boundsOfPoints } from "../../imaging/contours";

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
  /** Scars and pores: full-resolution layers for the face crop (see texture.ts). */
  private texture: {
    x: number;
    y: number;
    pores: { mul: HTMLCanvasElement; add: HTMLCanvasElement };
    scars: { mul: HTMLCanvasElement; add: HTMLCanvasElement };
    redness: { mul: HTMLCanvasElement; add: HTMLCanvasElement };
  } | null = null;

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
    } catch (err) {
      if (err instanceof Cancelled) return false;
      throw err;
    } finally {
      this.busy = false;
    }
  }

  /** Stop a running prepare() whose input is out of date (it resolves false at once). */
  cancel(): void {
    if (this.busy && this.stale) cancel("acne");
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
  // Lashes, lid margins and brow hair: the same grown guards the wrinkle filter uses, so the
  // naturally pinker lid skin and lash shadows are never "repaired".
  for (const poly of guardContours(points, faceWidth)) {
    mask.ctx.beginPath();
    addClosedContour(mask.ctx, poly);
    mask.ctx.fill();
  }
  // Nostril wings and the crease where they meet the cheek: a facial contour, slightly red by
  // nature, not a blemish. A band along each wing's outer edge (landmarks plotted and checked).
  mask.ctx.lineCap = "round";
  mask.ctx.lineJoin = "round";
  mask.ctx.lineWidth = Math.max(3, faceWidth * 0.06);
  for (const wing of NOSE_WING_EDGES) {
    mask.ctx.beginPath();
    wing.forEach((i, k) => (k ? mask.ctx.lineTo(points[i].x, points[i].y) : mask.ctx.moveTo(points[i].x, points[i].y)));
    mask.ctx.stroke();
  }
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
  const texture = await this.prepareTexture(input, mask.canvas, aw, ah);
  if (gen !== this.gen) return false;
  this.texture = texture;
  this.stale = false;
  this.ready = true;
  return true;
  }

  /**
   * Scars and pores work on the photo's full resolution (pores are too small for the reduced
   * analysis copy), limited to the face's bounding box to keep it fast.
   */
  private async prepareTexture(input: SkinInput, faded: HTMLCanvasElement, aw: number, ah: number) {
    const { w, h } = input;
    const points = toDisplayPoints(input.landmarks, w, h, input.mirrored);
    // The crop covers the landmarks and the whole skin mask (which reaches above the landmarks, up
    // to the hairline), plus the scar window: a crop edge inside the mask shows as a straight seam.
    const lm = boundsOfPoints(points);
    const mb = maskBounds(faded, aw, ah, w / aw, h / ah) ?? lm;
    const pad = faceWidthOf(points) * 0.05;
    const x = Math.max(0, Math.floor(Math.min(lm.minX, mb.minX) - pad)),
      y = Math.max(0, Math.floor(Math.min(lm.minY, mb.minY) - pad));
    const cw = Math.min(w, Math.ceil(Math.max(lm.maxX, mb.maxX) + pad)) - x,
      ch = Math.min(h, Math.ceil(Math.max(lm.maxY, mb.maxY) + pad)) - y;
    if (cw < 8 || ch < 8) return null;
    const crop = scratch(true);
    crop.canvas.width = cw;
    crop.canvas.height = ch;
    crop.ctx.translate(-x, -y);
    input.drawFrame(crop.ctx, w, h);
    // Texture is measured on the real photo. (Where spots get repaired, draw() removes the texture
    // correction under the repair, in proportion to the spot slider.)
    const pixels = crop.ctx.getImageData(0, 0, cw, ch).data;
    // The acne mask (analysis resolution, already feathered and with features carved out),
    // scaled up onto the crop.
    crop.ctx.clearRect(0, 0, w, h);
    crop.ctx.imageSmoothingEnabled = true;
    crop.ctx.drawImage(faded, 0, 0, aw, ah, 0, 0, w, h);
    const maskPixels = crop.ctx.getImageData(0, 0, cw, ch).data;
    const r = await runTexture({ pixels, mask: maskPixels, width: cw, height: ch, faceWidth: faceWidthOf(points) });
    const toCanvas = (data: Uint8ClampedArray<ArrayBuffer>) => {
      const c = document.createElement("canvas");
      c.width = cw;
      c.height = ch;
      c.getContext("2d")!.putImageData(new ImageData(data, cw, ch), 0, 0);
      return c;
    };
    const layers = (l: Layers) => ({ mul: toCanvas(l.mul), add: toCanvas(l.add) });
    return { x, y, pores: layers(r.pores), scars: layers(r.scars), redness: layers(r.redness) };
  }

  /**
   * Composite the prepared corrections over `target`: spots at `amount`, then scars and pores at
   * their own strengths (all 0..1).
   */
  draw(target: CanvasRenderingContext2D, w: number, h: number, amount: number, scars = 0, pores = 0, redness = 0): void {
    target.save();
    target.imageSmoothingEnabled = true;
    if (amount > 0) {
      target.globalAlpha = amount;
      target.drawImage(this.out.canvas, 0, 0, w, h);
    }
    const t = this.texture;
    if (t) {
      for (const [layer, strength] of [[t.scars, scars], [t.pores, pores], [t.redness, redness]] as const) {
        if (strength <= 0) continue;
        target.globalAlpha = strength;
        target.globalCompositeOperation = "multiply";
        target.drawImage(this.withoutSpots(layer.mul, t.x, t.y, w, h, amount), t.x, t.y);
        target.globalCompositeOperation = "lighter";
        target.drawImage(this.withoutSpots(layer.add, t.x, t.y, w, h, amount), t.x, t.y);
        target.globalCompositeOperation = "source-over";
      }
    }
    target.restore();
  }

  private holes = scratch();

  /**
   * The texture layer with holes where spots are being repaired (the repair already replaces those
   * pixels; texture computed from the pimple would leave rings). Transparent pixels change nothing
   * under both multiply and lighter compositing.
   */
  private withoutSpots(layer: HTMLCanvasElement, x: number, y: number, w: number, h: number, amount: number): HTMLCanvasElement {
    if (amount <= 0) return layer;
    const { canvas, ctx } = this.holes;
    if (canvas.width !== layer.width || canvas.height !== layer.height) {
      canvas.width = layer.width;
      canvas.height = layer.height;
    }
    ctx.globalCompositeOperation = "copy";
    ctx.globalAlpha = 1;
    ctx.drawImage(layer, 0, 0);
    ctx.globalCompositeOperation = "destination-out";
    ctx.globalAlpha = amount;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.out.canvas, -x, -y, w, h);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    return canvas;
  }
}

/** Bounds (display pixels) of a mask canvas's non-transparent pixels, or null if it is empty. */
function maskBounds(mask: HTMLCanvasElement, mw: number, mh: number, sx: number, sy: number) {
  const data = mask.getContext("2d")!.getImageData(0, 0, mw, mh).data;
  let minX = mw,
    minY = mh,
    maxX = -1,
    maxY = -1;
  for (let y = 0; y < mh; y++)
    for (let x = 0; x < mw; x++)
      if (data[(y * mw + x) * 4 + 3] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
  if (maxX < 0) return null;
  return { minX: minX * sx, minY: minY * sy, maxX: (maxX + 1) * sx, maxY: (maxY + 1) * sy };
}
