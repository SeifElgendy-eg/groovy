// The empty backdrop (a photo of the booth with nobody in it): when the slimmed body no longer covers
// part of where the body was, the backdrop shows there, instead of stretched background pixels.
// Pure functions on small arrays (unit-tested); the drawing is in warp.ts.
import { blur } from "./field";

/** A single-channel map (0..1) at its own resolution. */
export interface Map1 {
  data: Float32Array;
  w: number;
  h: number;
}

/** Per-pixel colour gain (r, g, b) that makes the backdrop match the photo's exposure. */
export interface Gain {
  data: Float32Array;
  w: number;
  h: number;
  /** Average colour difference (0..1) between the photo's background and the corrected backdrop. */
  mismatch: number;
}

/** Above this mismatch the backdrop is not the scene of the photo (camera moved, lights changed). */
export const MAX_MISMATCH = 0.06;

/** Separable max filter of radius r (square neighbourhood). */
function maxFilter(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) m = Math.max(m, src[y * w + k]);
      tmp[y * w + x] = m;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) m = Math.max(m, tmp[k * w + x]);
      out[y * w + x] = m;
    }
  return out;
}

/**
 * Where the person is, grown by `grow` pixels and softened over `soft` pixels: covers the soft
 * edge of the person (hair, the mask's own blur) so no outline of the old body is left behind.
 */
export function personCover(mask: Map1, grow: number, soft: number): Map1 {
  const hard = new Float32Array(mask.data.length);
  for (let i = 0; i < hard.length; i++) hard[i] = mask.data[i] > 0.3 ? 1 : 0;
  const grown = maxFilter(hard, mask.w, mask.h, Math.max(0, Math.round(grow)));
  const data = soft > 0 ? blur(grown, mask.w, mask.h, soft) : grown;
  for (let i = 0; i < data.length; i++) data[i] = Math.min(1, Math.max(0, (data[i] - 0.1) / 0.8));
  return { data, w: mask.w, h: mask.h };
}

/**
 * Colour gain from the backdrop to the photo, measured on the background (away from the person,
 * `cover` ~ 0) of both images (RGBA, w x h, small), smoothed over the frame; and how well they
 * match after it. Where there is no background nearby, the gain of the whole frame is used.
 */
export function backdropGain(photo: Uint8ClampedArray, plate: Uint8ClampedArray, w: number, h: number, cover: Float32Array): Gain {
  const n = w * h;
  const wt = new Float32Array(n);
  for (let i = 0; i < n; i++) wt[i] = cover[i] < 0.02 ? 1 : 0;
  const sigma = Math.max(2, w / 10);
  const wb = blur(wt, w, h, sigma);
  const data = new Float32Array(n * 3);
  const total = [0, 0, 0], totalP = [0, 0, 0];
  let wsum = 0;
  for (let i = 0; i < n; i++)
    if (wt[i]) {
      wsum++;
      for (let c = 0; c < 3; c++) {
        total[c] += photo[i * 4 + c];
        totalP[c] += plate[i * 4 + c];
      }
    }
  const clampG = (g: number) => Math.min(2, Math.max(0.5, g));
  const globalG = [0, 1, 2].map((c) => (wsum ? clampG((total[c] + 1) / (totalP[c] + 1)) : 1));
  for (let c = 0; c < 3; c++) {
    const a = new Float32Array(n), b = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      a[i] = wt[i] * photo[i * 4 + c];
      b[i] = wt[i] * plate[i * 4 + c];
    }
    const ab = blur(a, w, h, sigma), bb = blur(b, w, h, sigma);
    for (let i = 0; i < n; i++) {
      const local = clampG((ab[i] + 1) / (bb[i] + 1));
      const k = Math.min(1, wb[i] / 0.15); // how much nearby background there is
      data[i * 3 + c] = k * local + (1 - k) * globalG[c];
    }
  }
  let diff = 0;
  for (let i = 0; i < n; i++)
    if (wt[i])
      for (let c = 0; c < 3; c++) diff += Math.abs(photo[i * 4 + c] - plate[i * 4 + c] * data[i * 3 + c]) / 255;
  return { data, w, h, mismatch: wsum ? diff / (3 * wsum) : 1 };
}
