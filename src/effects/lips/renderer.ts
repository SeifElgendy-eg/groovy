// Lip filler + colour renderer. Owns its scratch canvases; takes the frame, landmarks and settings
// as arguments, so it reads no sliders, globals or DOM.
import type { Point } from "../../core/types";
import { addClosedContour, boundsOfPoints } from "../../imaging/contours";
import { computeLipTargets, type LipData, type LipParams } from "./geometry";
import { colorLips } from "./color";

function scratch(): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  return { canvas, ctx: canvas.getContext("2d")! };
}

/** True when the volume warp runs, i.e. the caller must supply a fresh display frame. */
export const needsWarp = (p: LipParams): boolean => p.amount > 0.001;

export class LipRenderer {
  private mask = scratch();
  private warped = scratch();
  private feather = scratch();

  resize(w: number, h: number): void {
    for (const { canvas } of [this.mask, this.warped, this.feather]) {
      canvas.width = w;
      canvas.height = h;
    }
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
      this.warped.ctx.clearRect(0, 0, w, h);
      // A fixed surrounding ring joins the expanded lips back to nearby skin.
      const rim = lip.outerPts.map((pt) => ({
        x: lip.outer.cx + (pt.x - lip.outer.cx) * 2.2,
        y: lip.cy + (pt.y - lip.cy) * 2.8,
      }));
      // Nonlinear cross-section rolls the tissue outward instead of stretching it flat.
      let previousSource = lip.innerPts,
        previousTarget = targetInner;
      const steps = 6;
      for (let band = 1; band <= steps; band++) {
        const t = band / steps;
        const roll = Math.max(0, Math.min(1, (p.roll - 0.2) / 0.8));
        const rolled = t + p.amount * (0.04 + roll * 0.44) * Math.sin(Math.PI * t);
        const sourceRing = lip.outerPts.map((pt, i) => ({
          x: lip.innerPts[i].x + (pt.x - lip.innerPts[i].x) * t,
          y: lip.innerPts[i].y + (pt.y - lip.innerPts[i].y) * t,
        }));
        const targetRing = targetOuter.map((pt, i) => ({
          x: targetInner[i].x + (pt.x - targetInner[i].x) * rolled,
          y: targetInner[i].y + (pt.y - targetInner[i].y) * rolled,
        }));
        this.warpRing(frame, previousSource, sourceRing, previousTarget, targetRing);
        previousSource = sourceRing;
        previousTarget = targetRing;
      }
      this.warpRing(frame, lip.outerPts, rim, targetOuter, rim);
      target.drawImage(this.warped.canvas, 0, 0);
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

  // Affine texture mapping makes the actual lip tissue follow its new contour.
  private warpTriangle(frame: HTMLCanvasElement, source: Point[], target: Point[]): void {
    const [a, b, c] = source,
      [u, v, z] = target;
    const det = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
    if (Math.abs(det) < 0.001) return;
    const A = ((v.x - u.x) * (c.y - a.y) - (z.x - u.x) * (b.y - a.y)) / det;
    const C = ((z.x - u.x) * (b.x - a.x) - (v.x - u.x) * (c.x - a.x)) / det;
    const B = ((v.y - u.y) * (c.y - a.y) - (z.y - u.y) * (b.y - a.y)) / det;
    const D = ((z.y - u.y) * (b.x - a.x) - (v.y - u.y) * (c.x - a.x)) / det;
    const ctx = this.warped.ctx;
    ctx.save();
    ctx.beginPath();
    addClosedContour(ctx, target);
    ctx.clip();
    ctx.setTransform(A, B, C, D, u.x - A * a.x - C * a.y, u.y - B * a.x - D * a.y);
    ctx.drawImage(frame, 0, 0);
    ctx.restore();
  }

  private warpRing(
    frame: HTMLCanvasElement,
    inner: Point[],
    outer: Point[],
    targetInner: Point[],
    targetOuter: Point[],
  ): void {
    for (let i = 0; i < outer.length; i++) {
      const j = (i + 1) % outer.length;
      this.warpTriangle(
        frame,
        [inner[i], outer[i], outer[j]],
        [targetInner[i], targetOuter[i], targetOuter[j]],
      );
      this.warpTriangle(
        frame,
        [inner[i], outer[j], inner[j]],
        [targetInner[i], targetOuter[j], targetInner[j]],
      );
    }
  }

  private buildFeather(targetOuter: Point[], targetInner: Point[], blend: number, w: number, h: number): void {
    const { ctx: maskCtx, canvas: maskCanvas } = this.mask;
    maskCtx.clearRect(0, 0, w, h);
    maskCtx.beginPath();
    addClosedContour(maskCtx, targetOuter);
    addClosedContour(maskCtx, targetInner);
    maskCtx.fillStyle = "white";
    maskCtx.fill("evenodd");

    const f = this.feather.ctx;
    f.clearRect(0, 0, w, h);
    f.save();
    f.filter = `blur(${Math.max(0.35, boundsOfPoints(targetOuter).width * (0.002 + blend * 0.004))}px)`;
    f.drawImage(maskCanvas, 0, 0, w, h);
    f.restore();
    f.filter = "none";
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

    this.buildFeather(targetOuter, targetInner, p.blend, w, h);
    const bounds = boundsOfPoints(targetOuter);
    const pad = Math.ceil(bounds.width * 0.02 + 3);
    const x = Math.max(0, Math.floor(bounds.minX - pad)),
      y = Math.max(0, Math.floor(bounds.minY - pad));
    const rw = Math.min(w - x, Math.ceil(bounds.maxX + pad) - x);
    const rh = Math.min(h - y, Math.ceil(bounds.maxY + pad) - y);
    if (rw <= 0 || rh <= 0) return;
    const pixels = target.getImageData(x, y, rw, rh);
    const mask = this.feather.ctx.getImageData(x, y, rw, rh).data;
    colorLips(pixels.data, mask, p.shadeHex, intensity, p.finish);
    target.putImageData(pixels, x, y);
  }
}
