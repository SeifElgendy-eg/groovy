// Deformation guard: strength caps that keep the warp from shearing, magnifying or squeezing the
// body, and unfold(), which keeps the picture from folding over itself.
import { UNFOLD_LEFT_OK, UNFOLD_MIN_SCALE, blur, blurReach, distanceTransform, isArmPart } from "./common";

/**
 * Limits of the picture's distortion at 100% (strengthCaps). Measured on the regression photos:
 * the body's shear (98th percentile) is 13 degrees on a typical photo, 30-45 on the ones that looked
 * deformed; the background beside the body bends far more (it absorbs the change of outline).
 */
export const CAP = {
  /** At most this share of the body's pixels may go past a limit. */
  share: 0.02,
  /** Shear of the picture on the body, degrees. */
  shear: 25,
  /** Magnification (area) at most 1 / magnify, squeezing at most `squeeze`. */
  magnify: 0.55,
  squeeze: 1.6,
  /** The cap never goes below this (a little slimming rather than none). */
  min: 0.4,
  /** The arms' own movement is lowered to this at the least before the whole movement is. */
  minArms: 0.25,
} as const;

/**
 * How much of the 100% strength the picture can take before the body looks deformed. `all`: the
 * largest scale (1 = as is) of the whole movement (`k` x unit fields) at which no more than
 * CAP.share of the body's pixels are sheared or stretched past the CAP limits. `arms`: on top of
 * that, the scale of the arms' own movement at which the arms pass too (the arms are where it shows
 * first, and slimming them less keeps the waist and hips visibly slimmer than lowering everything);
 * only when even a quarter of the arms' movement fails is the whole movement lowered further. The
 * movement is linear in the strength, so the warp's local shape is I + G with G the sum of the
 * scaled fields' gradients. `m`: the person (1); `labels`: body parts.
 */
export function strengthCaps(
  f: { arms: Float32Array; torso: Float32Array; legs: Float32Array },
  k: [number, number, number],
  m: Uint8Array,
  labels: Uint8Array,
  w: number,
  h: number,
  sw: number,
): { all: number; arms: number } {
  const n = w * h;
  // the arms' movement and the rest's, apart
  const ax = new Float32Array(n), ay = new Float32Array(n), rx = new Float32Array(n), ry = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    ax[i] = k[0] * f.arms[2 * i];
    ay[i] = k[0] * f.arms[2 * i + 1];
    rx[i] = k[1] * f.torso[2 * i] + k[2] * f.legs[2 * i];
    ry[i] = k[1] * f.torso[2 * i + 1] + k[2] * f.legs[2 * i + 1];
  }
  // gradients on every other pixel of the body (the fields are smooth), away from the outline
  // (where the body meets the moving background the picture is meant to stretch); 8 per pixel: the
  // arms' movement's, then the rest's
  const inside = distanceTransform(m, w, h);
  const rim = Math.max(1.5, 0.04 * sw);
  const body: number[] = [], arms: number[] = [];
  const grad = (X: Float32Array, Y: Float32Array, i: number) => [(X[i + 1] - X[i - 1]) / 2, (X[i + w] - X[i - w]) / 2, (Y[i + 1] - Y[i - 1]) / 2, (Y[i + w] - Y[i - w]) / 2];
  for (let y = 1; y < h - 1; y += 2)
    for (let x = 1; x < w - 1; x += 2) {
      const i = y * w + x;
      if (!m[i] || inside[i] <= rim) continue;
      (isArmPart(labels[i]) ? arms : body).push(...grad(ax, ay, i), ...grad(rx, ry, i));
    }
  /** Share of the pixels past a limit with the whole movement at `s` and the arms' at `a` on top. */
  const bad = (G: number[], s: number, a: number) => {
    let c = 0;
    for (let j = 0; j < G.length; j += 8) {
      const g = (q: number) => s * (a * G[j + q] + G[j + 4 + q]);
      const A = 1 + g(0), B = g(1), C = g(2), E = 1 + g(3);
      const shear = (Math.abs(Math.atan2(C, A) - Math.atan2(-B, E)) * 180) / Math.PI;
      const det = A * E - B * C;
      if (shear > CAP.shear || det < CAP.magnify || det > CAP.squeeze) c++;
    }
    return c / Math.max(1, G.length / 8);
  };
  const largest = (ok: (v: number) => boolean, min: number, max = 1) => {
    if (ok(max)) return max;
    let lo = min, hi = max;
    for (let it = 0; it < 8; it++) {
      const mid = (lo + hi) / 2;
      if (ok(mid)) lo = mid;
      else hi = mid;
    }
    return lo;
  };
  let all = largest((v) => bad(body, v, 1) <= CAP.share, CAP.min);
  const ok = (s: number, a: number) => bad(arms, s, a) <= CAP.share;
  if (ok(all, 1)) return { all, arms: 1 };
  if (ok(all, CAP.minArms)) return { all, arms: largest((a) => ok(all, a), CAP.minArms) };
  all = largest((v) => ok(v, CAP.minArms), CAP.min, all);
  return { all, arms: CAP.minArms };
}

/**
 * Where the movement at 100% would fold the picture over itself (the moved image's neighbouring
 * pixels swap places: a loop or a smear, e.g. in the background just outside an arm that turns in
 * with the waist), smooth the movement there until it no longer folds. The same smoothing is applied
 * to every area's field, so their weighted sum (the sliders) stays consistent. The sliders mix the
 * areas freely (and the legs are off when the knees are not in the photo), so every on/off mix of
 * the three areas at 100% is checked, not only all three together. Fields are interleaved (dx, dy);
 * `k`: the 100% strength of each. Only the neighbourhood of the folds is smoothed (and computed).
 * Returns how many pixels folded at first.
 */
export function unfold(
  f: { arms: Float32Array; torso: Float32Array; legs: Float32Array },
  k: [number, number, number],
  w: number,
  h: number,
  sw: number,
  minScale = UNFOLD_MIN_SCALE,
): number {
  const n = w * h;
  const keys = ["arms", "torso", "legs"] as const;
  const sW = 0.04 * sw + 1, sS = 0.05 * sw + 1; // spread of the smoothing weight, the smoothing itself
  const margin = blurReach(sW) + blurReach(sS) + 2;
  const bad = new Uint8Array(n);
  // the on/off mixes of the three areas (bit j: area j on)
  const mixes = [7, 1, 2, 4, 3, 5, 6].filter((mix) => [0, 1, 2].some((j) => mix & (1 << j) && k[j] > 0));
  const A = f.arms, T = f.torso, G = f.legs;
  const d = new Float64Array(12); // per area: d(dx)/dx, d(dx)/dy, d(dy)/dx, d(dy)/dy at 100%
  let worst = 0;
  // where to look: everywhere at first, then only where the last round changed the fields (all
  // the folds were inside that window, and the fields changed nowhere else)
  let rx0 = 1, ry0 = 1, rx1 = w - 2, ry1 = h - 2;
  for (let it = 0; it < 16; it++) {
    bad.fill(0);
    let count = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = ry0; y <= ry1; y++)
      for (let x = rx0; x <= rx1; x++) {
        const i = y * w + x, r = 2 * (i + 1), l = 2 * (i - 1), u = 2 * (i - w), o = 2 * (i + w);
        for (let j = 0; j < 3; j++) {
          const a = j === 0 ? A : j === 1 ? T : G, kk = k[j] / 2;
          d[4 * j] = kk * (a[r] - a[l]);
          d[4 * j + 1] = kk * (a[o] - a[u]);
          d[4 * j + 2] = kk * (a[r + 1] - a[l + 1]);
          d[4 * j + 3] = kk * (a[o + 1] - a[u + 1]);
        }
        for (const mix of mixes) {
          let ax = 1, ay = 0, bx = 0, by = 1;
          for (let j = 0; j < 3; j++)
            if (mix & (1 << j)) {
              ax += d[4 * j];
              ay += d[4 * j + 1];
              bx += d[4 * j + 2];
              by += d[4 * j + 3];
            }
          if (ax * by - ay * bx < minScale) {
            bad[i] = 1;
            count++;
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
            break;
          }
        }
      }
    if (it === 0) worst = count;
    // (a few single pixels left: a sub-pixel overlap nobody can see; not worth another round)
    if (count <= UNFOLD_LEFT_OK) break;
    // a window around the folds, wide enough that blurring inside it equals blurring the whole
    // field wherever the smoothing applies
    const wx0 = Math.max(0, x0 - margin), wy0 = Math.max(0, y0 - margin);
    const wx1 = Math.min(w - 1, x1 + margin), wy1 = Math.min(h - 1, y1 + margin);
    const ww = wx1 - wx0 + 1, wh = wy1 - wy0 + 1, wn = ww * wh;
    rx0 = Math.max(1, wx0 - 1);
    ry0 = Math.max(1, wy0 - 1);
    rx1 = Math.min(w - 2, wx1 + 1);
    ry1 = Math.min(h - 2, wy1 + 1);
    const cut = (get: (i: number) => number) => {
      const out = new Float32Array(wn);
      for (let y = 0; y < wh; y++) for (let x = 0; x < ww; x++) out[y * ww + x] = get((wy0 + y) * w + wx0 + x);
      return out;
    };
    // (at the window's border the blur sees replicated edges instead of the field beyond: the
    // margin keeps that away from where the weight is not 0)
    const wgt = blur(cut((i) => bad[i]), ww, wh, sW);
    for (let i = 0; i < wn; i++) wgt[i] = Math.min(1, wgt[i] * 4);
    for (const key of keys) {
      const a = f[key];
      const fx = cut((i) => a[2 * i]), fy = cut((i) => a[2 * i + 1]);
      const bx = blur(fx, ww, wh, sS), by = blur(fy, ww, wh, sS);
      for (let y = 0; y < wh; y++)
        for (let x = 0; x < ww; x++) {
          const j = y * ww + x;
          if (!wgt[j]) continue;
          const i = (wy0 + y) * w + wx0 + x;
          a[2 * i] = fx[j] + (bx[j] - fx[j]) * wgt[j];
          a[2 * i + 1] = fy[j] + (by[j] - fy[j]) * wgt[j];
        }
    }
  }
  return worst;
}
