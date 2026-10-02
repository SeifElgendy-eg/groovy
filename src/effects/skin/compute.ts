// The heavy, pure pixel work of the skin effects, split out so it can run in a Web Worker.
// Inputs and outputs are plain typed arrays: no DOM, no canvas.
import type { Point } from "../../core/types";
import { insetSkinMask } from "../../imaging/maskOps";
import { refineSkinMask } from "../../face/mask";
import { repairBlemishes } from "../acne/repair";
import { reduceWrinkles } from "../wrinkles/reduce";
import { wrinkleRegions } from "../wrinkles/regions";

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
  /** Landmarks in analysis pixels. */
  points: Point[];
  faceWidth: number;
}

export interface WrinklesResult {
  faded: Pixels;
  add: Pixels;
  mul: Pixels;
}

export function wrinklesCompute(j: WrinklesJob): WrinklesResult {
  const { aw, ah, faceWidth, original } = j;
  // Snap the soft 256px segmentation edge to the real hairline using the photo's own colours,
  // then fade inward. Small margin/feather = treatment runs close to the hair.
  const refined = refineSkinMask(j.mask, original, aw, ah, Math.max(3, Math.round(faceWidth * 0.02)));
  const faded = insetSkinMask(refined, aw, ah, 1, Math.max(3, faceWidth * 0.01));
  // reduceWrinkles returns a signed correction: `mul` (gain <= 1) and `add` (light). Only these
  // smooth maps are upscaled, never a downsampled copy of the skin, so the full-resolution photo
  // keeps its own texture inside and outside the treated areas.
  const { add, mul } = reduceWrinkles(
    original,
    faded,
    aw,
    ah,
    Math.max(2, Math.round(faceWidth * 0.012)),
    wrinkleRegions(j.points, faceWidth),
    // smoothing: how big a fold the filter flattens (default 1, max ~2.2). lines: removal of
    // faint thin lines (default 1). texture: pore detail kept (default 0.9; lower = smoother
    // but more "plastic").
    { smoothing: 1.25, lines: 1.3, texture: 0.82 },
  );
  return { faded, add, mul };
}
