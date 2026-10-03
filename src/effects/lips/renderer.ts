// Lip filler + colour renderer. Owns its scratch canvases; takes the frame, landmarks and settings
// as arguments, so it reads no sliders, globals or DOM.
import type { Point } from "../../core/types";
import { addClosedContour, boundsOfPoints } from "../../imaging/contours";
import { computeLipTargets, type LipData, type LipParams } from "./geometry";
import { colorLips } from "./color";
import { cpuWarp, GlWarp } from "./glWarp";
import { buildMesh, sampleGrid, warpRoi } from "./warpField";
import { SNAP_REACH, snapLipOutline } from "./lipMask";

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

    if (needsWarp(p)) this.warp(target, frame, lip, targetOuter, p, w, h);

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
