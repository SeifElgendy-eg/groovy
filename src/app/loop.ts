// The live-camera frame loop: process each new video frame, redraw, and update the perf badge.
import { dom } from "../ui/dom";
import { ensureSizes, getSourceDims } from "./frames";
import { perf, clearFace, forgetAnalysis, liveFaceWanted, processCurrentSource } from "./pipeline";
import { cameraNeedsEffect, renderAll } from "./render";
import { state } from "./state";
import { cameraTuning } from "./cameraTuning";
import { sourceCanvas } from "./frames";
import { bodyCoachTick } from "./bodyCoach";
import { metaOf } from "../effects/registry";
import { updateFaceGuide } from "../ui/faceGuide";

/**
 * Live analysis rate. The live view only drives the capture guide (and the exposure meter); effects
 * run on the captured photo. ~12 analyses a second is smooth for the guide and leaves the laptop
 * free to decode and show the camera at full frame rate, instead of running the face model on
 * every one of 30 frames.
 */
const LIVE_ANALYSIS_FPS = 12;
/**
 * A service that tracks the face only for the camera's exposure (body shaping: the posture coach
 * runs its own body check) analyses it this often, leaving the computer to the coach.
 */
const EXPOSURE_ANALYSIS_FPS = 3;

/** Live analyses a second for the chosen service. */
function liveRate(): number {
  const tracking = metaOf(state.module).needs.live === "track" || cameraTuning.calibrating;
  return tracking ? LIVE_ANALYSIS_FPS : EXPOSURE_ANALYSIS_FPS;
}

let frameRequest = 0;
let lastCameraTime = -1;
let lastAnalysisAt = -Infinity;
let perfWindowStart = performance.now();
let windowMs = 0,
  windowCount = 0;

export function startCameraLoop(): void {
  cancelAnimationFrame(frameRequest);
  lastCameraTime = -1;
  lastAnalysisAt = -Infinity;
  clearFace();
  forgetAnalysis();
  const { w, h } = getSourceDims();
  ensureSizes(w, h);
  frameRequest = requestAnimationFrame(tick);
}

export function stopCameraLoop(): void {
  cancelAnimationFrame(frameRequest);
}

async function tick(now: number): Promise<void> {
  frameRequest = 0;
  if (!state.running || state.sourceMode !== "camera") return;
  const { video, perfBadge } = dom;
  if (
    video.readyState >= 2 &&
    video.currentTime !== lastCameraTime &&
    now - lastAnalysisAt >= 1000 / liveRate()
  ) {
    lastCameraTime = video.currentTime;
    lastAnalysisAt = now;
    if (state.module !== "home" && liveFaceWanted()) {
      const t0 = performance.now();
      await processCurrentSource();
      const { w, h } = getSourceDims();
      cameraTuning.observe(sourceCanvas, w, h, state.facePoints);
      windowMs += performance.now() - t0;
      windowCount++;
    } else if (state.module !== "home") {
      // No face analysis wanted (body shaping): keep the capture guide and button up to date.
      updateFaceGuide(null);
    }
    if (!state.running || state.sourceMode !== "camera") return;
    renderAll();
  }
  bodyCoachTick(now);
  if (now - perfWindowStart >= 1000) {
    perfBadge.textContent = cameraNeedsEffect()
      ? `PROC ${perf.frames} fps`
      : "LIVE — ORIGINAL";
    perf.fps = perf.frames;
    perf.avgMs = windowCount ? windowMs / windowCount : 0;
    perf.frames = 0;
    windowMs = windowCount = 0;
    perfWindowStart = now;
  }
  frameRequest = requestAnimationFrame(tick);
}

