// Botox (wrinkles): a dose per area, softening analysed once per face in a worker.
import { readBotoxDoses, syncWrinklesPreset } from "../../ui/controls";
import { dom } from "../../ui/dom";
import { wrinkles } from "../effects";
import { warmUpWorkers } from "../../effects/skin/client";
import { warmUpHelpers } from "../../effects/skin/pool";
import { drawForDisplay } from "../frames";
import { state } from "../state";
import { wrinklesStatus } from "../statusMessages";
import { ensurePrepared, settled, type Service } from "./service";

// Layers for a newly chosen set of botox areas arrive asynchronously: redraw then.
wrinkles.onChange = settled;

export const wrinklesService: Service = {
  id: "wrinkles",
  sections: [dom.wrinklesSection],
  active: () => Object.values(readBotoxDoses()).some((d) => d > 0),
  invalidate: () => void (wrinkles.dirty = true),
  busy: () => wrinkles.busy || wrinkles.layersPending,
  // opens on the full dose, so the effect shows straight away
  chosen() {
    dom.wrinklesSlider.value = "100";
    syncWrinklesPreset();
  },
  draw({ ctx, w, h }) {
    if (!state.skinMaskReady) return;
    dom.wrinklesStatus.textContent = wrinklesStatus({ modelReady: state.modelReady, faceFound: !!state.facePoints });
    if (!state.facePoints) return;
    const doses = readBotoxDoses();
    if (!Object.values(doses).some((d) => d > 0) && !dom.skinDebug.checked) return;
    const ready = ensurePrepared(wrinkles, w, h, "Processing Botox effect…");
    // Photos: draw the native photo first. Camera frames are already on the stage.
    if (state.sourceMode === "photo") {
      ctx.save();
      ctx.globalAlpha = 1;
      drawForDisplay(ctx, w, h);
      ctx.restore();
    }
    if (ready) wrinkles.draw(ctx, doses);
  },
  debugMask: () => (wrinkles.ready ? wrinkles.maskCanvas : null),
  // its workers (the analysis lane and the helpers that share it) start with the app
  prepare: async () => {
    warmUpHelpers();
    await warmUpWorkers();
  },
};
