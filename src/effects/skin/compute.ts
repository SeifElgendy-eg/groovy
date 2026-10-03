// The heavy, pure pixel work of the skin effects, split out so it can run in a Web Worker.
// Inputs and outputs are plain typed arrays: no DOM, no canvas.
import type { Point } from "../../core/types";
import { insetSkinMask } from "../../imaging/maskOps";
import { refineSkinMask } from "../../face/mask";
import { repairBlemishes } from "../acne/repair";

type Pixels = Uint8ClampedArray<ArrayBuffer>;

export interface AcneJob {
  /** Analysis frame, its blurred copy, and the carved skin mask (RGBA, alpha = skin). */
  work: Pixels;
  blur: Pixels;
  mask: Pixels;
  aw: number;
  ah: number;
  faceWidth: number;
  radius: number;
}

export interface AcneResult {
  /** RGBA correction layer (alpha already faded at protected edges). */
  corrected: Pixels;
  /** The feathered mask, for the debug overlay. */
  faded: Pixels;
}

export function acneCompute(j: AcneJob): AcneResult {
  const { aw, ah, faceWidth } = j;
  const inset = insetSkinMask(j.mask, aw, ah, Math.max(2, Math.ceil(faceWidth * 0.007)));
  const corrected = repairBlemishes(j.work, j.blur, inset, aw, ah, j.radius);
  // Fade the correction inward from every protected boundary, without expanding the correction
  // into hair, eyes or lips.
  const faded = insetSkinMask(inset, aw, ah, 0, Math.max(4, faceWidth * 0.035));
  for (let i = 3; i < corrected.length; i += 4) corrected[i] = (corrected[i] * faded[i]) / 255;
  return { corrected, faded };
}

export interface WrinklesJob {
  /** Analysis frame and the carved face mask (RGBA, alpha = treatable skin). */
  original: Pixels;
  mask: Pixels;
  aw: number;
  ah: number;
  faceWidth: number;
}

export interface WrinklesResult {
  /** The treatable-skin mask, snapped to the real hairline and faded inward. */
  faded: Pixels;
}

/** Botox mask: snap the soft segmentation edge to the hairline with the photo's own colours, then fade inward. */
export function wrinklesCompute(j: WrinklesJob): WrinklesResult {
  const { aw, ah, faceWidth, original } = j;
  const refined = refineSkinMask(j.mask, original, aw, ah, Math.max(3, Math.round(faceWidth * 0.02)));
  return { faded: insetSkinMask(refined, aw, ah, 1, Math.max(3, faceWidth * 0.01)) };
}
