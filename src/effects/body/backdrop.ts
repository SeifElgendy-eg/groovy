// The empty backdrop (a photo of the booth with nobody in it): when the slimmed body no longer covers
// part of where the body was, the backdrop shows there, instead of stretched background pixels.
// Pure functions on small arrays (unit-tested); the drawing is in warp.ts.
import { blur, distanceTransform } from "./field";

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

/**
 * Where the person is, grown by `grow` pixels and softened over `soft` pixels: covers the soft
 * edge of the person (hair, the mask's own blur) so no outline of the old body is left behind.
 */
export function personCover(mask: Map1, grow: number, soft: number): Map1 {
  // grown by `grow` pixels in every direction (round, from the distance to the person: fast at
  // any size, unlike a max filter)
  const n = mask.data.length;
  const outside = new Uint8Array(n);
  for (let i = 0; i < n; i++) outside[i] = mask.data[i] > 0.3 ? 0 : 1;
  const dist = distanceTransform(outside, mask.w, mask.h);
  const grown = new Float32Array(n);
  for (let i = 0; i < n; i++) grown[i] = dist[i] <= grow ? 1 : 0;
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

/** How the backdrop sits in the photo: zoomed by `scale` about the frame's centre, then moved by (dx, dy) (fractions of the width / height). */
export interface Placement {
  scale: number;
  dx: number;
  dy: number;
  /** Mean edge difference over the background after the placement (lower is better; 0 = same edges). */
  cost: number;
}

/** Edges of a small RGBA image (gradient magnitude of its brightness), scaled to a mean of 1 over `use`. */
function edges(rgba: Uint8ClampedArray, w: number, h: number, use: Float32Array): Float32Array {
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
  const s = blur(g, w, h, 0.8);
  const e = new Float32Array(w * h);
  let sum = 0, c = 0;
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      e[i] = Math.hypot(s[i + 1] - s[i - 1], s[i + w] - s[i - w]);
      if (use[i]) (sum += e[i]), c++;
    }
  const k = c && sum ? c / sum : 1;
  for (let i = 0; i < e.length; i++) e[i] *= k;
  return e;
}

/**
 * Where the empty backdrop sits in the photo (small RGBA images, w x h, same size): a laptop or
 * webcam that reframes itself (auto-framing, a nudge) zooms and shifts the view between the two
 * shots, and the backdrop would no longer match. Searched over zoom 0.85-1.18 and shifts up to 15%
 * of the frame, on the edges of the background (`away` > 0: away from the person), which do not
 * change with the exposure. Coarse to fine.
 */
export function placeBackdrop(photo: Uint8ClampedArray, plate: Uint8ClampedArray, w: number, h: number, away: Float32Array): Placement {
  const use = new Float32Array(w * h);
  for (let i = 0; i < use.length; i++) use[i] = away[i] > 0.5 ? 1 : 0;
  const A = edges(photo, w, h, use), B = edges(plate, w, h, use);
  let useN = 0;
  for (let i = 0; i < use.length; i++) useN += use[i];
  const cx = (w - 1) / 2, cy = (h - 1) / 2;
  const cost = (scale: number, dx: number, dy: number, step: number) => {
    let sum = 0, c = 0;
    const tx = dx * w, ty = dy * h;
    for (let y = 1; y < h - 1; y += step)
      for (let x = 1; x < w - 1; x += step) {
        const i = y * w + x;
        if (!use[i]) continue;
        // the backdrop pixel that lands here
        const px = (x - cx - tx) / scale + cx, py = (y - cy - ty) / scale + cy;
        const xi = Math.round(px), yi = Math.round(py);
        if (xi < 1 || yi < 1 || xi >= w - 1 || yi >= h - 1) continue;
        sum += Math.abs(A[i] - B[yi * w + xi]);
        c++;
      }
    // (a placement that leaves too little of the background to compare is no match)
    return c > (0.5 * useN) / (step * step) ? sum / c : Infinity;
  };
  let best: Placement = { scale: 1, dx: 0, dy: 0, cost: cost(1, 0, 0, 1) };
  // coarse: every other pixel, zoom in ~2% steps, shifts by 2 pixels
  for (let scale = 0.85; scale <= 1.18; scale *= 1.02)
    for (let sy = -0.15; sy <= 0.15; sy += 2 / h)
      for (let sx = -0.15; sx <= 0.15; sx += 2 / w) {
        const c = cost(scale, sx, sy, 2);
        if (c < best.cost) best = { scale, dx: sx, dy: sy, cost: c };
      }
  // fine: around the best, every pixel
  const b0 = best;
  best = { ...b0, cost: cost(b0.scale, b0.dx, b0.dy, 1) };
  for (let ds = -2; ds <= 2; ds++)
    for (let iy = -2; iy <= 2; iy++)
      for (let ix = -2; ix <= 2; ix++) {
        const scale = b0.scale * (1 + 0.005 * ds), dx = b0.dx + (0.5 * ix) / w, dy = b0.dy + (0.5 * iy) / h;
        const c = cost(scale, dx, dy, 1);
        if (c < best.cost) best = { scale, dx, dy, cost: c };
      }
  return best;
}
