// Skin brightness (kept for staff; not on the home screen).
import { dom } from "../../ui/dom";
import { skinBrightness, skinEffectMask } from "../effects";
import { drawForDisplay } from "../frames";
import { state } from "../state";
import type { Service } from "./service";

const amount = () => Number(dom.brightnessSlider.value) / 100;

export const skinService: Service = {
  id: "skin",
  sections: [dom.skinSection],
  active: () => amount() > 0,
  invalidate: () => {},
  busy: () => false,
  draw({ ctx, w, h }) {
    if (amount() <= 0) return;
    skinBrightness.draw(ctx, w, h, amount(), state.sourceMode === "camera", drawForDisplay, skinEffectMask.canvas);
  },
  debugMask: () => skinEffectMask.canvas,
  debugMaskMirrored: true,
};
