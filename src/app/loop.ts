// The live-camera frame loop: process each new video frame, redraw, and update the perf badge.
import { dom } from "../ui/dom";
import { ensureSizes, getSourceDims } from "./frames";
import { perf, clearFace, processCurrentSource } from "./pipeline";
import { cameraNeedsEffect, renderAll } from "./render";
import { state } from "./state";
import { cameraTuning } from "./cameraTuning";
import { sourceCanvas } from "./frames";

/**
 * Live analysis rate. The live view only drives the capture guide (and the exposure meter); effects
 * run on the captured photo. ~12 analyses a second is smooth for the guide and leaves the laptop
 * free to decode and show the camera at full frame rate, instead of running the face model on
 * every one of 30 frames.
 */
const LIVE_ANALYSIS_FPS = 12;

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
    now - lastAnalysisAt >= 1000 / LIVE_ANALYSIS_FPS
  ) {
    lastCameraTime = video.currentTime;
    lastAnalysisAt = now;
    if (state.module !== "home") {
      const t0 = performance.now();
      await processCurrentSource();
      const { w, h } = getSourceDims();
      cameraTuning.observe(sourceCanvas, w, h, state.facePoints);
      windowMs += performance.now() - t0;
      windowCount++;
    }
    if (!state.running || state.sourceMode !== "camera") return;
    renderAll();
  }
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

