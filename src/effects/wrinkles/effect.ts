// Botox. Builds a face-only treatable-skin mask (analysis resolution), then finds and softens the
// expression lines of each botox area at the photo's full resolution (lines.ts). Each area keeps
// its own correction layers, so areas and dose change instantly, without a recompute.
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
import { runLines, runWrinkles } from "../skin/client";
import { AREAS, type AreaId, type Layers } from "./lines";
import { botoxZones } from "./regions";

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
  /** Per-area correction layers over the face crop at (x, y), full resolution. */
  private areas: { x: number; y: number; layers: Record<AreaId, { mul: HTMLCanvasElement; add: HTMLCanvasElement }> } | null = null;
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
    const { work, mask } = this;
    for (const c of [work, mask]) {
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
  for (const poly of guardContours(points, faceWidth, { lowerLid: 0.09 })) {
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
    faceWidth,
  });
  if (gen !== this.gen) return false;
  mask.ctx.putImageData(new ImageData(result.faded, aw, ah), 0, 0);
  const areas = await this.prepareLines(input, mask.canvas, aw, ah);
  if (gen !== this.gen) return false;
  this.areas = areas;
  this.stale = false;
  this.ready = true;
  return true;
  }

  /** Find and soften the lines at full resolution, on the face crop around the botox areas. */
  private async prepareLines(input: SkinInput, faded: HTMLCanvasElement, aw: number, ah: number) {
    const { w, h } = input;
    const points = toDisplayPoints(input.landmarks, w, h, input.mirrored);
    const faceWidth = faceWidthOf(points);
    const zones = botoxZones(points, faceWidth);
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const z of zones) {
      const r = Math.max(z.rx, z.ry);
      minX = Math.min(minX, z.cx - r);
      maxX = Math.max(maxX, z.cx + r);
      minY = Math.min(minY, z.cy - r);
      maxY = Math.max(maxY, z.cy + r);
    }
    const pad = faceWidth * 0.04;
    const x = Math.max(0, Math.floor(minX - pad)),
      y = Math.max(0, Math.floor(minY - pad));
    const cw = Math.min(w, Math.ceil(maxX + pad)) - x,
      ch = Math.min(h, Math.ceil(maxY + pad)) - y;
    if (cw < 8 || ch < 8) return null;
    const crop = scratch(true);
    crop.canvas.width = cw;
    crop.canvas.height = ch;
    crop.ctx.translate(-x, -y);
    input.drawFrame(crop.ctx, w, h);
    const pixels = crop.ctx.getImageData(0, 0, cw, ch).data;
    crop.ctx.clearRect(x, y, cw, ch);
    crop.ctx.imageSmoothingEnabled = true;
    crop.ctx.drawImage(faded, 0, 0, aw, ah, 0, 0, w, h);
    const maskPixels = crop.ctx.getImageData(0, 0, cw, ch).data;
    const local = zones.map((z) => ({ ...z, cx: z.cx - x, cy: z.cy - y, from: z.from && { x: z.from.x - x, y: z.from.y - y } }));
    const r = await runLines({ pixels, mask: maskPixels, width: cw, height: ch, faceWidth, zones: local });
    const toCanvas = (data: Uint8ClampedArray<ArrayBuffer>) => {
      const c = document.createElement("canvas");
      c.width = cw;
      c.height = ch;
      c.getContext("2d")!.putImageData(new ImageData(data, cw, ch), 0, 0);
      return c;
    };
    const layers = (l: Layers) => ({ mul: toCanvas(l.mul), add: toCanvas(l.add) });
    return { x, y, layers: Object.fromEntries(AREAS.map((id) => [id, layers(r[id])])) as Record<AreaId, { mul: HTMLCanvasElement; add: HTMLCanvasElement }> };
  }

  /** Composite each area's softening over `target` at its own dose (0..1; 0 = untreated). */
  draw(target: CanvasRenderingContext2D, doses: Partial<Record<AreaId, number>>): void {
    const a = this.areas;
    if (!a) return;
    target.save();
    for (const id of AREAS) {
      const dose = Math.max(0, Math.min(1, doses[id] ?? 0));
      if (dose <= 0) continue;
      target.globalAlpha = dose;
      target.globalCompositeOperation = "multiply";
      target.drawImage(a.layers[id].mul, a.x, a.y);
      target.globalCompositeOperation = "lighter";
      target.drawImage(a.layers[id].add, a.x, a.y);
    }
    target.restore();
  }
}
