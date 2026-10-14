// Filler (lips): volume, colour and finish, drawn over the photo or camera frame each time.
import { needsWarp } from "../../effects/lips/renderer";
import { readLipParams } from "../../ui/controls";
import { dom } from "../../ui/dom";
import { noteWork } from "../activity";
import { lipRenderer } from "../effects";
import { drawForDisplay, sourceCanvas, sourceCtx } from "../frames";
import { state } from "../state";
import type { Service } from "./service";

export const lipsService: Service = {
  id: "lips",
  sections: [dom.lipsSection, dom.colorSection],
  active: () => Number(dom.lipSlider.value) > 0 || Number(dom.colorSlider.value) > 0 || dom.lipDebug.checked,
  invalidate: () => {}, // the lip shape comes with each face the pipeline finds
  busy: () => false,
  draw({ ctx, w, h }) {
    if (!state.lipData) return;
    // The lips repaint the whole frame (the warp moves pixels), then draw on it.
    drawForDisplay(ctx, w, h);
    const params = readLipParams();
    if (needsWarp(params)) {
      // The warp samples the display-oriented frame (mirrored for the camera).
      sourceCtx.clearRect(0, 0, w, h);
      drawForDisplay(sourceCtx, w, h);
    }
    const start = performance.now();
    lipRenderer.render(ctx, sourceCanvas, state.lipData, params, w, h);
    if (state.sourceMode === "photo") noteWork("lips", performance.now() - start);
  },
};
