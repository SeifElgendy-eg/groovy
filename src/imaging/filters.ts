// Pure image-processing primitives on single-channel Float32 planes.
// Every function that takes a `box` only computes inside it (plus the window margin).
import type { Box } from "../core/types";

export const BIG = 1e9;

// ------------------------------------------------------------ primitives
// Separable [1 4 6 4 1]/16 blur, edge-clamped.
export function blur5(src: Float32Array, w: number, h: number, passes = 1): Float32Array {
  let a = src;
  const k = [1 / 16, 4 / 16, 6 / 16, 4 / 16, 1 / 16];
  for (let n = 0; n < passes; n++) {
    const b = new Float32Array(src.length),
      c = new Float32Array(src.length);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let t = -2; t <= 2; t++)
          s += a[y * w + Math.min(w - 1, Math.max(0, x + t))] * k[t + 2];
        b[y * w + x] = s;
      }
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let t = -2; t <= 2; t++)
          s += b[Math.min(h - 1, Math.max(0, y + t)) * w + x] * k[t + 2];
        c[y * w + x] = s;
      }
    a = c;
  }
  return a;
}

// Separable max/min over a (2k+1)^2 window, only inside `box`.
export function windowFilter(
  src: Float32Array,
  w: number,
  h: number,
  box: Box,
  k: number,
  isMax: boolean,
): Float32Array {
  const tmp = new Float32Array(w * h),
    out = new Float32Array(w * h);
  const ya = Math.max(0, box.y0 - k),
    yb = Math.min(h - 1, box.y1 + k);
  for (let y = ya; y <= yb; y++) {
    const row = y * w;
    for (let x = box.x0; x <= box.x1; x++) {
      let best = isMax ? -BIG : BIG;
      const a = Math.max(0, x - k),
        b = Math.min(w - 1, x + k);
      if (isMax) {
        for (let t = a; t <= b; t++) {
          const v = src[row + t];
          if (v > best) best = v;
        }
      } else {
        for (let t = a; t <= b; t++) {
          const v = src[row + t];
          if (v < best) best = v;
        }
      }
      tmp[row + x] = best;
    }
  }
  for (let y = box.y0; y <= box.y1; y++) {
    const a = Math.max(0, y - k),
      b = Math.min(h - 1, y + k);
    for (let x = box.x0; x <= box.x1; x++) {
      let best = isMax ? -BIG : BIG;
      if (isMax) {
        for (let t = a; t <= b; t++) {
          const v = tmp[t * w + x];
          if (v > best) best = v;
        }
      } else {
        for (let t = a; t <= b; t++) {
          const v = tmp[t * w + x];
          if (v < best) best = v;
        }
      }
      out[y * w + x] = best;
    }
  }
  return out;
}

// Closing of one channel: valleys narrower than the window fill to the lower bank.
// NaN where no valid skin is in reach.
export function closeChannel(
  values: Float32Array,
  valid: Uint8Array,
  w: number,
  h: number,
  box: Box,
  k: number,
): Float32Array {
  const n = w * h,
    hi = new Float32Array(n),
    big = k + 1;
  const grown = {
    x0: Math.max(0, box.x0 - big),
    x1: Math.min(w - 1, box.x1 + big),
    y0: Math.max(0, box.y0 - big),
    y1: Math.min(h - 1, box.y1 + big),
  };
  for (let p = 0; p < n; p++) hi[p] = valid[p] ? values[p] : -BIG;
  const dilated = windowFilter(hi, w, h, grown, k, true);
  for (let p = 0; p < n; p++)
    if (!valid[p] || dilated[p] < -BIG / 2) dilated[p] = BIG;
  const eroded = windowFilter(dilated, w, h, box, k, false);
  for (let p = 0; p < n; p++) if (eroded[p] > BIG / 2) eroded[p] = NaN;
  return eroded;
}

// Opening of one channel: bright ridges narrower than the window are cut to the higher floor.
export function openChannel(
  values: Float32Array,
  valid: Uint8Array,
  w: number,
  h: number,
  box: Box,
  k: number,
): Float32Array {
  const n = w * h,
    lo = new Float32Array(n),
    big = k + 1;
  const grown = {
    x0: Math.max(0, box.x0 - big),
    x1: Math.min(w - 1, box.x1 + big),
    y0: Math.max(0, box.y0 - big),
    y1: Math.min(h - 1, box.y1 + big),
  };
  for (let p = 0; p < n; p++) lo[p] = valid[p] ? values[p] : BIG;
  const eroded = windowFilter(lo, w, h, grown, k, false);
  for (let p = 0; p < n; p++)
    if (!valid[p] || eroded[p] > BIG / 2) eroded[p] = -BIG;
  const dilated = windowFilter(eroded, w, h, box, k, true);
  for (let p = 0; p < n; p++) if (dilated[p] < -BIG / 2) dilated[p] = NaN;
  return dilated;
}

// Window SUMS (not means) over (2r+1)^2, computed for pixels inside `box`.
export function boxSum(
  src: Float32Array,
  w: number,
  h: number,
  r: number,
  box: Box,
): Float32Array {
  const tmp = new Float32Array(w * h),
    out = new Float32Array(w * h);
  const ya = Math.max(0, box.y0 - r),
    yb = Math.min(h - 1, box.y1 + r);
  for (let y = ya; y <= yb; y++) {
    const row = y * w;
    let s = 0;
    for (let t = Math.max(0, box.x0 - r); t <= Math.min(w - 1, box.x0 + r); t++)
      s += src[row + t];
    tmp[row + box.x0] = s;
    for (let x = box.x0 + 1; x <= box.x1; x++) {
      if (x + r < w) s += src[row + x + r];
      if (x - r - 1 >= 0) s -= src[row + x - r - 1];
      tmp[row + x] = s;
    }
  }
  for (let x = box.x0; x <= box.x1; x++) {
    let s = 0;
    for (let t = Math.max(0, box.y0 - r); t <= Math.min(h - 1, box.y0 + r); t++)
      s += tmp[t * w + x];
    out[box.y0 * w + x] = s;
    for (let y = box.y0 + 1; y <= box.y1; y++) {
      if (y + r < h) s += tmp[(y + r) * w + x];
      if (y - r - 1 >= 0) s -= tmp[(y - r - 1) * w + x];
      out[y * w + x] = s;
    }
  }
  return out;
}

// Guided filter (He et al.) with a gray guide and per-pixel sample weights `wt`,
// so pixels outside the skin never contribute colour to the result.
export function guidedFilter(
  guide: Float32Array,
  channels: Float32Array[],
  wt: Float32Array,
  w: number,
  h: number,
  r: number,
  eps: number,
  box: Box,
): Float32Array[] {
  const n = w * h,
    big = {
      x0: Math.max(0, box.x0 - r),
      x1: Math.min(w - 1, box.x1 + r),
      y0: Math.max(0, box.y0 - r),
      y1: Math.min(h - 1, box.y1 + r),
    };
  const sW = boxSum(wt, w, h, r, big);
  const gw = new Float32Array(n),
    gg = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    gw[p] = guide[p] * wt[p];
    gg[p] = guide[p] * guide[p] * wt[p];
  }
  const sI = boxSum(gw, w, h, r, big),
    sII = boxSum(gg, w, h, r, big);
  const have = new Float32Array(n);
  for (let p = 0; p < n; p++) have[p] = sW[p] > 1e-3 ? 1 : 0;
  const sHave = boxSum(have, w, h, r, box);
  return channels.map((p0) => {
    const pw = new Float32Array(n),
      Ip = new Float32Array(n);
    for (let p = 0; p < n; p++) {
      pw[p] = p0[p] * wt[p];
      Ip[p] = guide[p] * p0[p] * wt[p];
    }
    const sP = boxSum(pw, w, h, r, big),
      sIP = boxSum(Ip, w, h, r, big);
    const A = new Float32Array(n),
      B = new Float32Array(n);
    for (let y = big.y0; y <= big.y1; y++)
      for (let x = big.x0; x <= big.x1; x++) {
        const p = y * w + x;
        if (!have[p]) continue;
        const m = sW[p],
          mI = sI[p] / m,
          mP = sP[p] / m;
        const a =
          (sIP[p] / m - mI * mP) / (Math.max(0, sII[p] / m - mI * mI) + eps);
        A[p] = a;
        B[p] = mP - a * mI;
      }
    const sA = boxSum(A, w, h, r, box),
      sB = boxSum(B, w, h, r, box),
      out = new Float32Array(n);
    for (let y = box.y0; y <= box.y1; y++)
      for (let x = box.x0; x <= box.x1; x++) {
        const p = y * w + x,
          c = sHave[p];
        out[p] = c > 0 ? (sA[p] / c) * guide[p] + sB[p] / c : p0[p];
      }
    return out;
  });
}
