// Lip filler + colour renderer. Owns its scratch canvases; takes the frame, landmarks and settings
// as arguments, so it reads no sliders, globals or DOM.
import type { Point } from "../../core/types";
import { addClosedContour, boundsOfPoints } from "../../imaging/contours";
import { computeLipTargets, fillerLevel, type LipData, type LipParams } from "./geometry";
import { colorLips } from "./color";
import { cpuWarp, GlWarp } from "./glWarp";
import { buildMesh, sampleGrid, warpRoi } from "./warpField";
import { SNAP_REACH, snapLipOutline } from "./lipMask";
import { borderLight, borderLightTone, glintAlpha, lipShading, shadowTone, type ShadeSpot } from "./shading";

function scratch(read = false): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  return { canvas, ctx: canvas.getContext("2d", { willReadFrequently: read })! };
}

/** True when the volume warp runs, i.e. the caller must supply a fresh display frame. */
export const needsWarp = (p: LipParams): boolean => p.amount > 0.001;

export class LipRenderer {
  private mask = scratch(true);
  private feather = scratch(true);
  /** The frame's warp ROI (input), and the CPU fallback's output. */
  private roiFrame = scratch();
  private warped = scratch();
  private glint = scratch();
  /** Created on first use; null when WebGL2 is unavailable. */
  private gl: GlWarp | null | undefined;

  resize(w: number, h: number): void {
    // The mask canvases are sized to the lips on each render; nothing else is frame-sized.
    void w;
    void h;
  }

  /**
   * Draw the effect onto `target` (which already holds the photo when the effect paints it).
   * `frame` is the display-oriented source frame the warp samples from.
   */
  render(
    target: CanvasRenderingContext2D,
    frame: HTMLCanvasElement,
    lip: LipData,
    p: LipParams,
    w: number,
    h: number,
  ): void {
    const { targetOuter, targetInner } = computeLipTargets(lip, p);

    if (needsWarp(p)) {
      this.warp(target, frame, lip, targetOuter, p, w, h);
      // Light and shadow of fuller lips, under any lipstick colour (which keeps the lightness).
      this.shade(target, targetOuter, targetInner, p);
    }

    this.renderColor(target, targetOuter, targetInner, p, w, h);
    // Preserve the photographed lighting; do not add synthetic reflections.

    if (p.showOutline) {
      target.save();
      target.lineWidth = 2;
      target.strokeStyle = "rgba(214,255,93,.95)";
      target.beginPath();
      addClosedContour(target, targetOuter);
      target.stroke();
      target.strokeStyle = "rgba(80,220,255,.95)";
      target.beginPath();
      addClosedContour(target, targetInner);
      target.stroke();
      target.restore();
    }
  }

  /** Draw the volume shading (see shading.ts): soft light on the lips, light and shadow on the skin. */
  private shade(target: CanvasRenderingContext2D, outer: Point[], inner: Point[], p: LipParams): void {
    const spots = lipShading(outer, inner, fillerLevel(p.amount));
    if (!spots.length) return;
    const b = boundsOfPoints(outer);
    // Shadow colours come from the surface each shadow falls on, sampled before anything is drawn.
    const tones = spots.map((sp) => (sp.kind === "shadow" ? this.shadowToneFor(target, sp, outer) : null));
    for (const [k, sp] of spots.entries()) {
      target.save();
      // Clip to the lips (outline minus opening) or to the skin around them.
      target.beginPath();
      if (sp.region === "lips") {
        addClosedContour(target, outer);
        addClosedContour(target, inner);
      } else {
        target.rect(b.minX - b.width, b.minY - b.width, b.width * 3, b.height + b.width * 2);
        addClosedContour(target, outer);
      }
      target.clip("evenodd");
      target.translate(sp.cx, sp.cy);
      target.rotate(sp.angle);
      target.scale(sp.rx, sp.ry);
      const g = target.createRadialGradient(0, 0, 0, 0, 0, 1);
      const tone = tones[k];
      const rgb = tone ? tone.rgb.join(",") : "255,250,245";
      const alpha = sp.alpha * (tone ? tone.scale : 1);
      g.addColorStop(0, `rgba(${rgb},${alpha})`);
      g.addColorStop(0.55, `rgba(${rgb},${alpha * 0.45})`);
      g.addColorStop(1, `rgba(${rgb},0)`);
      target.globalCompositeOperation = sp.kind === "light" ? "screen" : "multiply";
      target.fillStyle = g;
      target.fillRect(-1, -1, 2, 2);
      target.restore();
    }
    // The light along the upper border: one soft stroke across the border, fading to the corners.
    const line = borderLight(outer, inner, fillerLevel(p.amount));
    if (line.alpha > 0) {
      const a = line.points[0],
        z = line.points[line.points.length - 1];
      // Tinted and scaled by this face's own skin just above the lip (see borderLightTone); no
      // clip: it straddles the border and blends lip into skin.
      const tone = borderLightTone(this.skinAbove(target, line.points, outer, inner, 0.45), this.skinAbove(target, line.points, outer, inner, 0));
      const alpha = line.alpha * tone.scale;
      const rgb = tone.rgb.join(",");
      const g = target.createLinearGradient(a.x, a.y, z.x, z.y);
      g.addColorStop(0, `rgba(${rgb},0)`);
      g.addColorStop(0.3, `rgba(${rgb},${alpha})`);
      g.addColorStop(0.7, `rgba(${rgb},${alpha})`);
      g.addColorStop(1, `rgba(${rgb},0)`);
      target.save();
      target.globalCompositeOperation = "screen";
      target.filter = `blur(${line.blur}px)`;
      target.strokeStyle = g;
      target.lineWidth = line.width;
      target.lineCap = "round";
      target.lineJoin = "round";
      target.beginPath();
      line.points.forEach((q, i) => (i ? target.lineTo(q.x, q.y) : target.moveTo(q.x, q.y)));
      target.stroke();
      target.restore();
    }
    this.gloss(target, outer, inner, spots[0], fillerLevel(p.amount));
  }

  /** Tint and strength for a shadow spot: sampled inside it, and (on skin) a little further out. */
  private shadowToneFor(target: CanvasRenderingContext2D, sp: ShadeSpot, outer: Point[]) {
    const { width, height } = target.canvas;
    const cos = Math.cos(sp.angle),
      sin = Math.sin(sp.angle);
    const at = (u: number, v: number, into: number[][]) => {
      const x = Math.round(sp.cx + u * cos - v * sin),
        y = Math.round(sp.cy + u * sin + v * cos);
      if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1) return;
      const d = target.getImageData(x - 1, y - 1, 3, 3).data;
      for (let i = 0; i < d.length; i += 4) into.push([d[i], d[i + 1], d[i + 2]]);
    };
    const here: number[][] = [];
    for (const [u, v] of [[0, 0], [-0.4, 0], [0.4, 0], [0, -0.3], [0, 0.3]]) at(u * sp.rx, v * sp.ry, here);
    if (sp.region !== "skin") return shadowTone(here);
    // Further away from the lips than the shadow (the skin it should be compared with).
    const lip = outer[15];
    const away = Math.sign((sp.cx - lip.x) * -sin + (sp.cy - lip.y) * cos) || 1;
    const reference: number[][] = [];
    for (const u of [-0.4, 0, 0.4]) at(u * sp.rx, away * sp.ry * 1.6, reference);
    return shadowTone(here, reference);
  }

  /**
   * RGB samples along the upper lip border, pushed `away` x the upper lip's height outward
   * (0.45: the skin just above the lip; 0: on the border itself).
   */
  private skinAbove(target: CanvasRenderingContext2D, border: Point[], outer: Point[], inner: Point[], away: number): number[][] {
    const upperH = Math.hypot(outer[5].x - inner[5].x, outer[5].y - inner[5].y);
    const out: number[][] = [];
    const { width, height } = target.canvas;
    for (const q of border.slice(1, -1)) {
      // Outward = away from the mouth opening below this point.
      const dx = q.x - inner[5].x,
        dy = q.y - inner[5].y;
      const len = Math.hypot(dx, dy) || 1;
      const x = Math.round(q.x + (dx / len) * upperH * away),
        y = Math.round(q.y + (dy / len) * upperH * away);
      if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1) continue;
      const d = target.getImageData(x - 1, y - 1, 3, 3).data;
      for (let i = 0; i < d.length; i += 4) out.push([d[i], d[i + 1], d[i + 2]]);
    }
    return out;
  }

  /** Gloss glints on the lower lip (see glintAlpha), drawn as light, on the lips only. */
  private gloss(target: CanvasRenderingContext2D, outer: Point[], inner: Point[], sheen: ShadeSpot, strength: number): void {
    const r = Math.ceil(Math.max(sheen.rx, sheen.ry)) + 2;
    const x = Math.max(0, Math.floor(sheen.cx - r)),
      y = Math.max(0, Math.floor(sheen.cy - r));
    const w = Math.min(target.canvas.width - x, 2 * r),
      h = Math.min(target.canvas.height - y, 2 * r);
    if (w < 4 || h < 4) return;
    const img = target.getImageData(x, y, w, h);
    const alpha = glintAlpha(img.data, w, h, { ...sheen, cx: sheen.cx - x, cy: sheen.cy - y, ry: sheen.ry * 0.85 }, strength);
    for (let p = 0; p < alpha.length; p++) {
      img.data[p * 4] = 255;
      img.data[p * 4 + 1] = 252;
      img.data[p * 4 + 2] = 248;
      img.data[p * 4 + 3] = alpha[p];
    }
    const { canvas, ctx } = this.glint;
    canvas.width = w;
    canvas.height = h;
    ctx.putImageData(img, 0, 0);
    target.save();
    target.beginPath();
    addClosedContour(target, outer);
    addClosedContour(target, inner);
    target.clip("evenodd");
    target.drawImage(canvas, x, y);
    target.restore();
  }

  /** Create the WebGL context and compile the shader now, not on the customer's first move. */
  warmUp(): void {
    if (this.gl === undefined) this.gl = GlWarp.create();
    if (!this.gl) return;
    const tiny = scratch();
    tiny.canvas.width = tiny.canvas.height = 4;
    this.gl.render(tiny.canvas, { roi: { x: 0, y: 0, w: 4, h: 4 }, cols: 2, rows: 2, sx: 4, sy: 4, data: new Float32Array(8) });
  }

  /**
   * Grow the lips: one continuous warp of the lip region (see warpField.ts), drawn by the GPU when
   * WebGL2 is available, else on the CPU. Only the warp's ROI is read and redrawn.
   */
  private warp(
    target: CanvasRenderingContext2D,
    frame: HTMLCanvasElement,
    lip: LipData,
    targetOuter: Point[],
    p: LipParams,
    w: number,
    h: number,
  ): void {
    const mesh = buildMesh(lip, targetOuter, p);
    const roi = warpRoi(mesh, w, h);
    if (roi.w < 2 || roi.h < 2) return;
    const grid = sampleGrid(mesh, roi);
    const { canvas: roiCanvas, ctx: roiCtx } = this.roiFrame;
    if (roiCanvas.width !== roi.w || roiCanvas.height !== roi.h) {
      roiCanvas.width = roi.w;
      roiCanvas.height = roi.h;
    }
    roiCtx.clearRect(0, 0, roi.w, roi.h);
    roiCtx.drawImage(frame, roi.x, roi.y, roi.w, roi.h, 0, 0, roi.w, roi.h);
    if (this.gl === undefined) this.gl = GlWarp.create();
    let patch: HTMLCanvasElement;
    if (this.gl && !this.gl.lost) {
      patch = this.gl.render(roiCanvas, grid);
      document.body.dataset.lipWarp = "webgl";
    } else {
      patch = cpuWarp(roiCanvas, grid, this.warped.canvas);
      document.body.dataset.lipWarp = "cpu";
    }
    target.drawImage(patch, roi.x, roi.y);
  }

  /**
   * The lip colour mask over `roi`: the landmark outline snapped to the photo's real lip border
   * (lipMask.ts), filled minus the mouth opening, then feathered by Edge Blend. ROI-sized canvases.
   */
  private buildFeather(
    roiPixels: Uint8ClampedArray,
    roi: { x: number; y: number; w: number; h: number },
    targetOuter: Point[],
    targetInner: Point[],
    blend: number,
  ): Uint8ClampedArray {
    const snap = snapLipOutline({
      pixels: roiPixels,
      x0: roi.x,
      y0: roi.y,
      width: roi.w,
      height: roi.h,
      outer: targetOuter,
      inner: targetInner,
    });
    document.body.dataset.lipSeparation = snap.separation.toFixed(2);
    const { canvas: maskCanvas, ctx: m } = this.mask;
    maskCanvas.width = roi.w;
    maskCanvas.height = roi.h;
    m.setTransform(1, 0, 0, 1, -roi.x, -roi.y);
    m.beginPath();
    addClosedContour(m, snap.outer);
    addClosedContour(m, targetInner);
    m.fillStyle = "white";
    m.fill("evenodd");
    m.setTransform(1, 0, 0, 1, 0, 0);

    const { canvas: featherCanvas, ctx: f } = this.feather;
    featherCanvas.width = roi.w;
    featherCanvas.height = roi.h;
    const mouthWidth = boundsOfPoints(targetOuter).width;
    // Soft edge, like real lipstick fading into the skin (Edge Blend 0..1 sets how soft).
    f.filter = `blur(${Math.max(0.5, mouthWidth * (0.006 + blend * 0.014))}px)`;
    f.drawImage(maskCanvas, 0, 0);
    f.filter = "none";
    return f.getImageData(0, 0, roi.w, roi.h).data;
  }

  private renderColor(
    target: CanvasRenderingContext2D,
    targetOuter: Point[],
    targetInner: Point[],
    p: LipParams,
    w: number,
    h: number,
  ): void {
    const intensity = p.colorIntensity;
    if (!p.shadeHex || intensity <= 0.001) return;

    const bounds = boundsOfPoints(targetOuter);
    // Room for the snapping band and the skin colour samples outside it, plus the feather.
    const pad = Math.ceil(bounds.width * (SNAP_REACH[0] * 3.2 + 0.02) + 3);
    const x = Math.max(0, Math.floor(bounds.minX - pad)),
      y = Math.max(0, Math.floor(bounds.minY - pad));
    const rw = Math.min(w - x, Math.ceil(bounds.maxX + pad) - x);
    const rh = Math.min(h - y, Math.ceil(bounds.maxY + pad) - y);
    if (rw <= 0 || rh <= 0) return;
    const pixels = target.getImageData(x, y, rw, rh);
    const mask = this.buildFeather(pixels.data, { x, y, w: rw, h: rh }, targetOuter, targetInner, p.blend);
    colorLips(pixels.data, mask, p.shadeHex, intensity, p.finish);
    target.putImageData(pixels, x, y);
  }
}
