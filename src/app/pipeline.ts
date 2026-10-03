// Model inference: runs face landmarks + skin segmentation on the current source and publishes
// the results into `state` and the shared masks.
import { buildLipData } from "../effects/lips/geometry";
import { metaOf } from "../effects/registry";
import { insetSkinMask } from "../imaging/maskOps";
import type { FaceLandmarker } from "@mediapipe/tasks-vision";
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
      m.segmenter.segment(warm).categoryMask?.close();
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

function publishSkinMask(mask: { width: number; height: number; getAsUint8Array(): Uint8Array; close(): void }): void {
  const { width, height } = mask;
  segMask.canvas.width = width;
  segMask.canvas.height = height;
  const pixels = segMask.ctx.createImageData(width, height);
  const labels = mask.getAsUint8Array();
  for (let i = 0; i < labels.length; i++) {
    pixels.data[i * 4] = pixels.data[i * 4 + 1] = pixels.data[i * 4 + 2] = 255;
    pixels.data[i * 4 + 3] = labels[i] === 3 ? 255 : 0;
  }
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
  mask.close();
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
    const segmentation = wantsMask ? tracked.sync("skin segmentation", () => segmenter.segment(sourceCanvas)) : null;
    if (segmentation?.categoryMask) publishSkinMask(segmentation.categoryMask);

    const faceRes = live
      ? tracked.sync("live face tracking", () => live.detectForVideo(sourceCanvas, timestamp))
      : tracked.sync("photo face detection", () => faceLandmarker.detect(sourceCanvas));
    if (faceRes.faceLandmarks?.length) {
      const landmarks = faceRes.faceLandmarks[0];
      state.facePoints = landmarks;
      markEffectsDirty();
      updateFaceGuide(landmarks);
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
