// The effect instances and the canvases they share with the pipeline.
import { AcneEffect } from "../effects/acne/effect";
import { LipRenderer } from "../effects/lips/renderer";
import { SkinBrightness } from "../effects/skin/brightness";
import { WrinklesEffect } from "../effects/wrinkles/effect";

function scratch(): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  return { canvas, ctx: canvas.getContext("2d")! };
}

export const acne = new AcneEffect();
export const wrinkles = new WrinklesEffect();
export const lipRenderer = new LipRenderer();
export const skinBrightness = new SkinBrightness();

/** Raw skin segmentation (alpha = skin), in the model's orientation. */
export const segMask = scratch();
/** Same mask, edge-faded, used by the skin-brightness effect and its debug overlay. */
export const skinEffectMask = scratch();

/** The face, mask or source changed: effects must re-analyse before their next draw. */
export function markEffectsDirty(): void {
  acne.dirty = true;
  wrinkles.dirty = true;
}
