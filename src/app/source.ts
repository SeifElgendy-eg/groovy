// Where pictures come from: the live camera, an uploaded/captured photo, or a bundled test photo.
import { metaOf } from "../effects/registry";
import { describeCameraError, openUserCamera, stopStream } from "../io/camera";
import { applySourceMode, syncBefore } from "../ui/controls";
import { dom } from "../ui/dom";
import { capture, captureBtn, updateFaceGuide } from "../ui/faceGuide";
import { setStatus } from "../ui/status";
import { bodyPerson, markEffectsDirty } from "./effects";
import { ensureSizes, getSourceDims, setStill } from "./frames";
import { startCameraLoop } from "./loop";
import { clearFace, processCurrentSource } from "./pipeline";
import { renderAll } from "./render";
import { state } from "./state";
import { cameraTuning } from "./cameraTuning";
import { noteWork, tracked } from "./activity";
import { drawLifted } from "../io/softwareLift";

let stream: MediaStream | null = null;
let cameraStarting = false;

export function setSourceMode(mode: "camera" | "photo"): void {
  state.sourceMode = mode;
  applySourceMode();
}

function showStage(): void {
  dom.overlay.classList.add("hidden");
  state.running = true;
}

export async function startCamera(): Promise<void> {
  if (cameraStarting) return;
  cameraStarting = true;
  const { video } = dom;
  try {
    setStatus("Opening camera…");
    stopStream(stream);
    stream = await openUserCamera();
    const metadata = new Promise((r) => (video.onloadedmetadata = r));
    video.srcObject = stream;
    await metadata;
    await video.play();
    cameraTuning.attach(stream).catch((err) => console.error("camera settings could not be applied", err));

    const { w, h } = getSourceDims();
    ensureSizes(w, h);
    setSourceMode("camera");
    showStage();
    setStatus("Camera running", "ready");
    startCameraLoop();
    updateFaceGuide(null);
  } catch (err) {
    console.error(err);
    stopStream(stream);
    stream = null;
    cameraTuning.detach();
    setStatus(describeCameraError(err), "error");
  } finally {
    cameraStarting = false;
  }
}

export function useCameraAgain(): void {
  if (stream?.getVideoTracks().some((track) => track.readyState === "live")) {
    setSourceMode("camera");
    showStage();
    setStatus("Camera running", "ready");
    startCameraLoop();
    updateFaceGuide(null);
  } else {
    void startCamera();
  }
}

export function stopCamera(): void {
  stopStream(stream);
}

/** Shared tail of loading a photo: size the stage, run the models, draw. */
async function onPhotoReady(loadedStatus: string): Promise<void> {
  const start = performance.now();
  try {
    return await tracked("analysing the photo", () => photoReady(loadedStatus));
  } finally {
    noteWork("photo analysis", performance.now() - start);
  }
}

async function photoReady(loadedStatus: string): Promise<void> {
  setSourceMode("photo");
  updateFaceGuide(null);
  const { w, h } = getSourceDims();
  ensureSizes(w, h);
  showStage();
  setStatus(
    state.modelReady ? loadedStatus : "Loading models…",
    state.modelReady ? "ready" : "loading",
  );
  await processCurrentSource();
  renderAll();
  dom.perfBadge.textContent = "PHOTO READY";
}

function resetForNewPhoto(kind: typeof state.photoKind): void {
  state.skinMaskReady = false;
  bodyPerson.mask = null;
  state.photoKind = kind;
  clearFace();
  markEffectsDirty();
}

export async function handlePhoto(file: File | undefined | null): Promise<void> {
  if (!file) return;
  setStill(null);
  resetForNewPhoto("upload");
  const url = URL.createObjectURL(file);
  dom.photo.onload = async () => {
    await onPhotoReady("Photo loaded");
    URL.revokeObjectURL(url);
  };
  dom.photo.onerror = () => {
    URL.revokeObjectURL(url);
    setStatus("Unable to load photo", "error");
  };
  dom.photo.src = url;
}

const SAMPLE_PATHS = {
  sample: "./sample-face-test.png",
  "sample-acne": "./sample-acne-test.png",
  "sample-wrinkles": "./sample-wrinkles-test.png",
} as const;

export async function loadSamplePhoto(): Promise<void> {
  setStill(null);
  const kind = metaOf(state.module).sampleKind;
  resetForNewPhoto(kind);
  dom.photo.onload = () => onPhotoReady("Test photo loaded");
  dom.photo.onerror = () => setStatus("Unable to load test photo", "error");
  // Re-read replaceable test assets on every click, including same-name updates.
  const sampleUrl = new URL(SAMPLE_PATHS[kind], document.baseURI);
  sampleUrl.searchParams.set(
    "reload",
    `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  dom.photo.src = sampleUrl.href;
}

/** "Take photo": freeze the current camera frame (mirrored, as the user saw it) and use it. */
export function mountCaptureButton(): void {
  captureBtn.addEventListener("click", async () => {
    const { video } = dom;
    if (capture.busy || state.sourceMode !== "camera" || video.readyState < 2)
      return;
    capture.busy = true;
    captureBtn.disabled = true;
    try {
      const still = tracked.sync("taking the photo", () => {
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const c = canvas.getContext("2d")!;
        c.translate(canvas.width, 0);
        c.scale(-1, 1);
        // Software lift for a face the camera could not make bright enough (1 = untouched).
        drawLifted(c, video, canvas.width, canvas.height, cameraTuning.lift);
        return canvas;
      });
      state.showBefore = false;
      syncBefore();
      state.capturedPhoto = true;
      // Use the captured canvas directly as the photo: no PNG encode/decode round trip.
      resetForNewPhoto("upload");
      setStill(still);
      await onPhotoReady("Photo taken");
    } catch (error) {
      setStatus((error as Error).message, "error");
    } finally {
      capture.busy = false;
      captureBtn.disabled = false;
    }
  });
}
