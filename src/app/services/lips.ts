// Filler (lips): volume, colour and finish, drawn over the photo or camera frame each time.
import { needsWarp } from "../../effects/lips/renderer";
import { readLipParams } from "../../ui/controls";
import { dom } from "../../ui/dom";
import { noteWork } from "../activity";
import { classicLipRenderer, lipRenderer } from "../effects";
import { ML_MAX } from "../../effects/lips/geometry";
import { lipStyle } from "../../ui/lipTuning";

import { drawForDisplay, sourceCanvas, sourceCtx } from "../frames";
import { state } from "../state";
import type { Service } from "./service";

/** The classic look's full volume (its old slider's maximum, 55%). */
const CLASSIC_FULL = 0.55;

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
    const classic = lipStyle() === "classic";
    const params = readLipParams();
    // The classic look's volume ran from 0 to 0.55 on its old slider: 4 ml is its full volume.
    if (classic) params.amount = (Number(dom.lipSlider.value) / ML_MAX) * CLASSIC_FULL;
    if (needsWarp(params)) {
      // The warp samples the display-oriented frame (mirrored for the camera).
      sourceCtx.clearRect(0, 0, w, h);
      drawForDisplay(sourceCtx, w, h);
    }
    const start = performance.now();
    (classic ? classicLipRenderer : lipRenderer).render(ctx, sourceCanvas, state.lipData, params, w, h);
    if (state.sourceMode === "photo") noteWork("lips", performance.now() - start);
  },
};
