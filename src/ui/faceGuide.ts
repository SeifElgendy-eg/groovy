// The oval capture guide and the "Take photo" button shown over the live camera (body shaping
// swaps the oval for its own standing outline, see bodyGuide.ts).
import { captureLabel } from "../core/countdown";
import { metaOf } from "../effects/registry";
import { evaluateAlignment, type HeadPose } from "../face/alignment";
import { getSourceDims } from "../app/frames";
import { state } from "../app/state";
import type { NormalizedLandmark } from "../effects/skin/input";
import { mountBodyGuide, updateBodyGuide } from "./bodyGuide";
import { mountCountdown } from "./countdown";
import { dom } from "./dom";

export const captureBtn = document.createElement("button");
captureBtn.className = "primary capture-photo";
captureBtn.textContent = "Take photo";
captureBtn.hidden = true;

const photoProcessingCue = document.createElement("div");
photoProcessingCue.className = "photo-processing-cue";
photoProcessingCue.hidden = true;
photoProcessingCue.setAttribute("role", "status");
photoProcessingCue.setAttribute("aria-live", "polite");
photoProcessingCue.setAttribute("aria-atomic", "true");
const photoProcessingSpinner = document.createElement("span");
photoProcessingSpinner.className = "photo-processing-spinner";
const photoProcessingCopy = document.createElement("div");
const photoProcessingTitle = document.createElement("strong");
const photoProcessingDetail = document.createElement("span");
photoProcessingCopy.append(photoProcessingTitle, photoProcessingDetail);
photoProcessingCue.append(photoProcessingSpinner, photoProcessingCopy);

const faceGuide = document.createElement("div");
faceGuide.className = "face-guide";
const faceGuideLabel = document.createElement("div");
faceGuideLabel.className = "face-guide-label";
faceGuideLabel.textContent = "Position your face inside the oval";

/** Set while a photo is being taken, so the button can't be double-clicked. */
export const capture = { busy: false };

export function mountFaceGuide(): void {
  dom.stageWrap.append(captureBtn);
  dom.stageWrap.append(faceGuide, faceGuideLabel);
  mountBodyGuide();
  mountCountdown();
  dom.stageWrap.append(photoProcessingCue);
  window.addEventListener("resize", () => updateFaceGuide(state.facePoints));
}

/** Last head pose seen (re-used when the guide is only re-laid out, e.g. on resize). */
let lastPose: HeadPose | null = null;

export function updateFaceGuide(points: NormalizedLandmark[] | null, pose?: HeadPose | null): void {
  if (pose !== undefined) lastPose = pose;
  if (!points) lastPose = null;
  const { stageWrap, video } = dom;
  const camera = state.sourceMode === "camera" && state.module !== "home";
  // Body shaping needs the whole body in view, not a face: it has its own guide (bodyGuide.ts).
  const bodyGuide = camera && state.module === "body";
  faceGuide.hidden = faceGuideLabel.hidden = !camera || bodyGuide;
  updateBodyGuide(bodyGuide);
  captureBtn.hidden = !camera || !state.running;
  captureBtn.disabled = capture.busy || video.readyState < 2;
  // A service shot from a distance has a timer (registry): the button starts it, then cancels it.
  const label = captureLabel(camera ? metaOf(state.module).captureDelaySeconds : 0, state.countdown);
  if (captureBtn.textContent !== label) captureBtn.textContent = label;
  captureBtn.classList.toggle("counting", state.countdown !== null);
  if (!camera || bodyGuide) return;
  const { w, h } = getSourceDims();
  const scale = Math.min(stageWrap.clientWidth / w, stageWrap.clientHeight / h);
  const dw = w * scale,
    dh = h * scale;
  faceGuide.style.width = `${dw * 0.44}px`;
  faceGuide.style.height = `${dh * 0.82}px`;
  faceGuide.style.left = `${(stageWrap.clientWidth - dw) / 2 + dw * 0.28}px`;
  faceGuide.style.top = `${(stageWrap.clientHeight - dh) / 2 + dh * 0.07}px`;
  const result = evaluateAlignment(points, state.alignment, lastPose);
  state.alignment = result.state;
  state.faceAligned = result.aligned;
  faceGuide.classList.toggle("aligned", state.faceAligned);
  faceGuideLabel.textContent = result.label;
}


export function showPhotoProcessingCue(detail: string): void {
  photoProcessingTitle.textContent = "Photo taken";
  photoProcessingDetail.textContent = detail;
  photoProcessingCue.hidden = false;
}

export function hidePhotoProcessingCue(): void {
  photoProcessingCue.hidden = true;
}
