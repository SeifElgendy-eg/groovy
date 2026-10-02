// The live-camera frame loop: process each new video frame, redraw, and update the perf badge.
import { dom } from "../ui/dom";
import { ensureSizes, getSourceDims } from "./frames";
import { perf, clearFace, processCurrentSource } from "./pipeline";
import { cameraNeedsEffect, renderAll } from "./render";
import { state } from "./state";
import { cameraTuning } from "./cameraTuning";
import { sourceCtx } from "./frames";

let frameRequest = 0;
let lastCameraTime = -1;
let perfWindowStart = performance.now();

export function startCameraLoop(): void {
  cancelAnimationFrame(frameRequest);
  lastCameraTime = -1;
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
  if (video.readyState >= 2 && video.currentTime !== lastCameraTime) {
    lastCameraTime = video.currentTime;
    if (state.module !== "home") {
      await processCurrentSource();
      const { w, h } = getSourceDims();
      cameraTuning.observe(sourceCtx, w, h, state.facePoints);
    }
    if (!state.running || state.sourceMode !== "camera") return;
    renderAll();
  }
  if (now - perfWindowStart >= 1000) {
    perfBadge.textContent = cameraNeedsEffect()
      ? `PROC ${perf.frames} fps`
      : "LIVE — ORIGINAL";
    perf.frames = 0;
    perfWindowStart = now;
  }
  frameRequest = requestAnimationFrame(tick);
}

