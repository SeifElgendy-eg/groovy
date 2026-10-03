// Model inference: runs face landmarks + skin segmentation on the current source and publishes
// the results into `state` and the shared masks.
import { buildLipData } from "../effects/lips/geometry";
import { metaOf } from "../effects/registry";
import { headPose } from "../face/alignment";
import { faceCropRect, mergeCrop, probToAlpha } from "../face/segmentation";
import type { NormalizedLandmark } from "../effects/skin/input";
import { insetSkinMask } from "../imaging/maskOps";
import type { FaceLandmarker, ImageSegmenter, ImageSegmenterResult } from "@mediapipe/tasks-vision";
import { loadModels, loadVideoLandmarker, type Models } from "../ml/models";
import { tracked } from "./activity";
import { setStatus } from "../ui/status";
import { updateFaceGuide } from "../ui/faceGuide";
import { dom } from "../ui/dom";
import { lipRenderer, markEffectsDirty, segMask, skinEffectMask } from "./effects";
import {
  analysisSource,
  getSourceDims,
  snapshotCamera,
  sourceCanvas,
  sourceCtx,
} from "./frames";
import { cameraNeedsEffect, renderAll } from "./render";
import { state } from "./state";

/** IMAGE-mode models for photos (landmarks + skin segmentation). */
let models: Models | null = null;
/** VIDEO-mode landmarker for the live camera, created in the background after `models`. */
let videoLandmarker: Promise<FaceLandmarker> | null = null;
let liveLandmarker: FaceLandmarker | null = null;
let processing = false;
let processingPending = false;

/** Live-analysis counters: frames since the last badge refresh, last second's rate, avg cost. */
export const perf = { frames: 0, fps: 0, avgMs: 0 };

export async function initModels(): Promise<void> {
  try {
    setStatus("Loading models…");
    models = await tracked("loading the AI models", loadModels);
    // Warm-up: the first real run compiles GPU shaders and allocates buffers (seconds on some
    // laptops). Do it now, behind "Loading models", instead of on the customer's first photo.
    await tracked("warming up the AI models", () => {
      const warm = document.createElement("canvas");
      warm.width = warm.height = 256;
      const m = models!;
      m.faceLandmarker.detect(warm);
      closeSegmentation(m.segmenter.segment(warm));
      lipRenderer.warmUp();
    });
    state.modelReady = true;
    // The live-camera model is built right after, in the background, so the first camera start
    // does not wait for it and a photo capture never has to rebuild a model.
    setTimeout(() => void liveModel(), 0);
    dom.startBtn.disabled = false;
    setStatus("Models ready", "ready");
    if (state.running) {
      await processCurrentSource();
      renderAll();
    }
  } catch (err) {
    console.error(err);
    setStatus("Model loading failed", "error");
  }
}

function liveModel(): Promise<FaceLandmarker> {
  videoLandmarker ??= tracked("preparing the live-camera model", async () => {
    const m = await loadVideoLandmarker();
    const warm = document.createElement("canvas");
    warm.width = warm.height = 256;
    m.detectForVideo(warm, performance.now()); // warm-up, as for the photo models
    return m;
  }).then((m) => (liveLandmarker = m));
  return videoLandmarker;
}

/** Forget the detected face (new photo, lost face, error). */
export function clearFace(): void {
  state.facePoints = null;
  state.lipData = null;
  markEffectsDirty();
}

/** Face-skin class of the multiclass selfie model. */
const FACE_SKIN = 3;

function closeSegmentation(r: ImageSegmenterResult): void {
  r.categoryMask?.close();
  r.confidenceMasks?.forEach((m) => m.close());
}

/** Face-skin probability over the whole result (mask size), or null. */
function skinProbability(r: ImageSegmenterResult): { prob: Float32Array; width: number; height: number } | null {
  const m = r.confidenceMasks?.[FACE_SKIN];
  const out = m ? { prob: new Float32Array(m.getAsFloat32Array()), width: m.width, height: m.height } : null;
  closeSegmentation(r);
  return out;
}

const cropCanvas = document.createElement("canvas");
const cropCtx = cropCanvas.getContext("2d", { willReadFrequently: false })!;

/**
 * Skin segmentation of `source`: the whole frame, then (when the face is known) the face's crop
 * at the model's full resolution, merged in (see face/segmentation.ts).
 */
function segmentSkin(segmenter: ImageSegmenter, source: HTMLCanvasElement, points: NormalizedLandmark[] | null): void {
  const full = skinProbability(segmenter.segment(source));
  if (!full) return;
  const rect = points ? faceCropRect(points, full.width, full.height) : null;
  if (rect) {
    // The mask is the source's size; map the rect back in case it is not.
    const sx = source.width / full.width,
      sy = source.height / full.height;
    cropCanvas.width = rect.w;
    cropCanvas.height = rect.h;
    cropCtx.drawImage(source, rect.x * sx, rect.y * sy, rect.w * sx, rect.h * sy, 0, 0, rect.w, rect.h);
    const crop = skinProbability(segmenter.segment(cropCanvas));
    if (crop && crop.width === rect.w && crop.height === rect.h) mergeCrop(full.prob, full.width, full.height, crop.prob, rect);
  }
  publishSkinMask(full.prob, full.width, full.height);
}

function publishSkinMask(prob: Float32Array, width: number, height: number): void {
  segMask.canvas.width = width;
  segMask.canvas.height = height;
  const pixels = segMask.ctx.createImageData(width, height);
  probToAlpha(prob, pixels.data);
  segMask.ctx.putImageData(pixels, 0, 0);
  skinEffectMask.canvas.width = width;
  skinEffectMask.canvas.height = height;
  const faded = insetSkinMask(
    pixels.data,
    width,
    height,
    0,
    Math.max(3, Math.min(width, height) * 0.025),
  );
  skinEffectMask.ctx.putImageData(new ImageData(faded, width, height), 0, 0);
  state.skinMaskReady = true;
  markEffectsDirty();
}

export async function processCurrentSource(): Promise<void> {
  if (!state.modelReady || !models) return;
  if (processing) {
    processingPending = true;
    return;
  }
  processing = true;
  try {
    const { faceLandmarker, segmenter } = models;
    const camera = state.sourceMode === "camera";
    const live = camera ? (liveLandmarker ?? (await liveModel())) : null;
    const timestamp = performance.now();
    const { w, h } = getSourceDims();
    if (camera) snapshotCamera(w, h);
    sourceCanvas.width = w;
    sourceCanvas.height = h;
    sourceCtx.clearRect(0, 0, w, h);
    sourceCtx.drawImage(analysisSource(), 0, 0, w, h);

    const wantsMask =
      (state.sourceMode === "photo" || cameraNeedsEffect()) &&
      metaOf(state.module).usesSkinMask;
    // (Live camera frames never need the skin mask: effects run on the captured photo.)
    const faceRes = live
      ? tracked.sync("live face tracking", () => live.detectForVideo(sourceCanvas, timestamp))
      : tracked.sync("photo face detection", () => faceLandmarker.detect(sourceCanvas));
    if (wantsMask)
      tracked.sync("skin segmentation", () => segmentSkin(segmenter, sourceCanvas, faceRes.faceLandmarks?.[0] ?? null));
    if (faceRes.faceLandmarks?.length) {
      const landmarks = faceRes.faceLandmarks[0];
      state.facePoints = landmarks;
      markEffectsDirty();
      const matrix = faceRes.facialTransformationMatrixes?.[0]?.data;
      updateFaceGuide(landmarks, matrix ? headPose(matrix) : null);
      state.lipData = buildLipData(landmarks, w, h, camera);
      dom.faceBadge.textContent = "Face detected";
      dom.faceBadge.classList.add("detected");
    } else {
      clearFace();
      updateFaceGuide(null);
      dom.faceBadge.textContent = "No face — try a clearer front-facing photo";
      dom.faceBadge.classList.remove("detected");
    }
    perf.frames++;
  } catch (err) {
    console.warn(err);
    state.skinMaskReady = false;
    state.facePoints = null;
    state.lipData = null;
    setStatus(
      "Photo processing failed. Please retake or reload the photo.",
      "error",
    );
  } finally {
    processing = false;
    if (processingPending) {
      processingPending = false;
      await processCurrentSource();
      renderAll();
    }
  }
}

/** Release the native model resources (page unload). */
export function closeModels(): void {
  models?.faceLandmarker.close();
  models?.segmenter.close();
  liveLandmarker?.close();
}
