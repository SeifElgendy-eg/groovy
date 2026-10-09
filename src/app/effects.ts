// The effect instances and the canvases they share with the pipeline.
import { AcneEffect } from "../effects/acne/effect";
import { BodyEffect, type PersonMask } from "../effects/body/effect";
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
export const body = new BodyEffect();
// Debug and regression tools (scripts/body/) read the body analysis from here with ?debug=body.
if (new URLSearchParams(location.search).get("debug") === "body") (globalThis as { groovyBody?: BodyEffect }).groovyBody = body;

/** Person mask of the current photo for body slimming (from the multiclass segmenter), or null. */
export const bodyPerson: { mask: PersonMask | null } = { mask: null };

/** Raw skin segmentation (alpha = skin), in the model's orientation. */
export const segMask = scratch();
/** Same mask, edge-faded, used by the skin-brightness effect and its debug overlay. */
export const skinEffectMask = scratch();

/** The face, mask or source changed: effects must re-analyse before their next draw. */
export function markEffectsDirty(): void {
  acne.dirty = true;
  wrinkles.dirty = true;
  body.dirty = true;
}
