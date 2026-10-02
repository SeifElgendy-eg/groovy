// The stage canvas and the frame buffers: which source is visible, how big it is, and how to
// draw it for display (mirrored for the camera).
import { dom } from "../ui/dom";
import { lipRenderer, skinBrightness } from "./effects";
import { state } from "./state";

export const stageCtx = dom.stage.getContext("2d")!;
/** Frozen copy of the camera frame the models analysed, so effects draw over exactly that. */
export const cameraSnapshot = document.createElement("canvas");
const cameraSnapshotCtx = cameraSnapshot.getContext("2d")!;
/** Un-mirrored frame handed to the models (and sampled by the lip warp). */
export const sourceCanvas = document.createElement("canvas");
export const sourceCtx = sourceCanvas.getContext("2d")!;

/**
 * A photo taken with the camera is kept as the canvas it was captured into and shown directly,
 * instead of being saved as a PNG file and loaded back into the <img> (about 1.4 s for a 4K frame;
 * the canvas route takes well under 0.1 s and gives the same pixels).
 */
let still: HTMLCanvasElement | null = null;

/** Show `canvas` as the current photo (null: back to the <img>). */
export function setStill(canvas: HTMLCanvasElement | null): void {
  still?.remove();
  still = canvas;
  if (canvas) {
    canvas.className = "captured-still";
    dom.stage.before(canvas); // under the effect canvas, like the <img>
  }
}

export function hasStill(): boolean {
  return !!still;
}

function getVisibleSource(): HTMLImageElement | HTMLVideoElement | HTMLCanvasElement {
  return state.sourceMode === "photo" ? (still ?? dom.photo) : dom.video;
}

export function getSourceDims(): { w: number; h: number } {
  const { photo, video } = dom;
  if (state.sourceMode === "photo" && still) return { w: still.width, h: still.height };
  if (state.sourceMode === "photo" && photo.naturalWidth) {
    return { w: photo.naturalWidth, h: photo.naturalHeight };
  }
  const vw = video.videoWidth || 1280,
    vh = video.videoHeight || 720;
  const scale = Math.min(1, 640 / Math.max(vw, vh));
  return { w: Math.round(vw * scale), h: Math.round(vh * scale) };
}

export function ensureSizes(w: number, h: number): void {
  for (const c of [dom.stage, skinBrightness.canvas, sourceCanvas]) {
    c.width = w;
    c.height = h;
  }
  lipRenderer.resize(w, h);
}

/** Copy the current camera frame into the snapshot (camera mode only). */
export function snapshotCamera(w: number, h: number): void {
  cameraSnapshot.width = w;
  cameraSnapshot.height = h;
  cameraSnapshotCtx.drawImage(dom.video, 0, 0, w, h);
}

/** The frame the models analyse: the snapshot for the camera, the photo otherwise. */
export function analysisSource(): CanvasImageSource {
  return state.sourceMode === "camera" ? cameraSnapshot : getVisibleSource();
}

export function drawForDisplay(
  targetCtx: CanvasRenderingContext2D,
  w: number,
  h: number,
  filter = "none",
): void {
  const mirrored = state.sourceMode === "camera";
  targetCtx.save();
  targetCtx.filter = filter;
  if (mirrored) {
    targetCtx.translate(w, 0);
    targetCtx.scale(-1, 1);
  }
  targetCtx.drawImage(analysisSource(), 0, 0, w, h);
  targetCtx.restore();
  targetCtx.filter = "none";
}
