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
import { runAcne, runTexture } from "../skin/client";
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
    const b = boundsOfPoints(points);
    const padX = b.width * 0.08,
      padY = b.height * 0.08;
    const x = Math.max(0, Math.floor(b.minX - padX)),
      y = Math.max(0, Math.floor(b.minY - padY));
    const cw = Math.min(w, Math.ceil(b.maxX + padX)) - x,
      ch = Math.min(h, Math.ceil(b.maxY + padY)) - y;
    if (cw < 8 || ch < 8) return null;
    const crop = scratch(true);
    crop.canvas.width = cw;
    crop.canvas.height = ch;
    crop.ctx.translate(-x, -y);
    input.drawFrame(crop.ctx, w, h);
    // Texture is measured on the picture with the spots already repaired, so pimples (and their
    // edges) do not show up as "pits" and leave rings around the repairs.
    crop.ctx.imageSmoothingEnabled = true;
    crop.ctx.drawImage(this.out.canvas, 0, 0, w, h);
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
    return { x, y, pores: layers(r.pores), scars: layers(r.scars) };
  }

  /**
   * Composite the prepared corrections over `target`: spots at `amount`, then scars and pores at
   * their own strengths (all 0..1).
   */
  draw(target: CanvasRenderingContext2D, w: number, h: number, amount: number, scars = 0, pores = 0): void {
    target.save();
    target.imageSmoothingEnabled = true;
    if (amount > 0) {
      target.globalAlpha = amount;
      target.drawImage(this.out.canvas, 0, 0, w, h);
    }
    const t = this.texture;
    if (t) {
      for (const [layer, strength] of [[t.scars, scars], [t.pores, pores]] as const) {
        if (strength <= 0) continue;
        target.globalAlpha = strength;
        target.globalCompositeOperation = "multiply";
        target.drawImage(layer.mul, t.x, t.y);
        target.globalCompositeOperation = "lighter";
        target.drawImage(layer.add, t.x, t.y);
        target.globalCompositeOperation = "source-over";
      }
    }
    target.restore();
  }
}
