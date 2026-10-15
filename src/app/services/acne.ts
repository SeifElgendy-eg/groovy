// Acne treatment: spots, scars, pores and redness, analysed once per face in a worker.
import { dom } from "../../ui/dom";
import { acne } from "../effects";
import { warmUpWorkers } from "../../effects/skin/client";
import { drawForDisplay } from "../frames";
import { state } from "../state";
import { acneStatus } from "../statusMessages";
import { ensurePrepared, type Service } from "./service";

const levels = () => ({
  amount: Number(dom.acneSlider.value) / 100,
  scars: Number(dom.scarsSlider.value) / 100,
  pores: Number(dom.poresSlider.value) / 100,
  redness: Number(dom.rednessSlider.value) / 100,
});

export const acneService: Service = {
  id: "acne",
  sections: [dom.acneSection],
  active: () => Object.values(levels()).some((v) => v > 0),
  invalidate: () => void (acne.dirty = true),
  busy: () => acne.busy,
  draw({ ctx, w, h }) {
    if (!state.skinMaskReady) return;
    dom.acneStatus.textContent = acneStatus({ modelReady: state.modelReady, faceFound: !!state.facePoints });
    if (!state.facePoints) return;
    const { amount, scars, pores, redness } = levels();
    if (amount <= 0 && scars <= 0 && pores <= 0 && redness <= 0 && !dom.skinDebug.checked) return;
    const ready = ensurePrepared(acne, w, h, "Processing acne treatment…");
    // Scars and pores are multiply/add layers: they need the photo itself on the stage underneath
    // (spot repairs alone are opaque patches and can sit over the <img>).
    if (state.sourceMode === "photo" && (scars > 0 || pores > 0 || redness > 0)) drawForDisplay(ctx, w, h);
    if (ready) acne.draw(ctx, w, h, amount, scars, pores, redness);
  },
  debugMask: () => (acne.ready ? acne.maskCanvas : null),
  prepare: () => warmUpWorkers(), // its analysis worker starts with the app

};
