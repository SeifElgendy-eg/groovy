// Acne scars and pores: texture smoothing at the photo's full resolution (face area only).
//
// The skin's lightness is split by size (frequency separation):
//   fine  = L - blur(L, pore size)          -> pores and fine grain
// Pores: the fine band's dark parts are reduced much more than light parts (natural sheen) and
// some of it is always kept, so skin never turns plastic.
// Scars: pits are found as dips below the surrounding skin (morphological closing) and filled
// most of the way, on a pore-smoothed copy so the photo's own pore texture stays on top.
// Colour is kept: each pixel's RGB is scaled by its change in lightness.
//
// The result is returned as two composite layers per treatment, so the caller can apply any
// strength (0..1) with globalAlpha and no recompute:
//   mul: multiply layer (gain <= 1, darkens) - RGB = 255 * gain, white where unchanged
//   add: lighter layer (adds light)            - RGB = amount added, black where unchanged

import { closeChannel } from "../../imaging/filters";

type Pixels = Uint8ClampedArray<ArrayBuffer>;

export interface TextureJob {
  /** Face crop at full resolution (RGBA) and its treatable-skin mask (alpha). */
  pixels: Pixels;
  mask: Pixels;
  width: number;
  height: number;
  /** Face width in these pixels: sets the pore and scar sizes. */
  faceWidth: number;
}

export interface Layers {
  mul: Pixels;
  add: Pixels;
}

export interface TextureResult {
  pores: Layers;
  scars: Layers;
}

/** How strongly each band is reduced at full strength: [dark parts, light parts]. */
export const PORE_REDUCTION: [number, number] = [0.6, 0.15];

/** In-place horizontal + vertical box blur of radius r (clamped edges). */
function boxBlur(src: Float32Array, w: number, h: number, r: number, tmp: Float32Array): void {
  if (r < 1) return;
  const norm = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[row + Math.min(w - 1, Math.max(0, k))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc * norm;
      acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += tmp[Math.min(h - 1, Math.max(0, k)) * w + x];
    for (let y = 0; y < h; y++) {
      src[y * w + x] = acc * norm;
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
}

/** Gaussian-like blur (three box passes) of std. deviation ~sigma. Returns a new array. */
export function blurLike(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const out = src.slice();
  const tmp = new Float32Array(src.length);
  // Three boxes of radius r approximate a Gaussian with sigma^2 = r(r+1).
  const r = Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2));
  for (let pass = 0; pass < 3; pass++) boxBlur(out, w, h, r, tmp);
  return out;
}

function toLayers(pixels: Pixels, lum: Float32Array, delta: Float32Array, mask: Pixels): Layers {
  const n = lum.length;
  const mul = new Uint8ClampedArray(n * 4).fill(255);
  const add = new Uint8ClampedArray(n * 4);
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    add[i + 3] = 255;
    const cover = mask[i + 3] / 255;
    const d = delta[p] * cover;
    if (Math.abs(d) < 0.25 || lum[p] < 1) continue;
    const gain = (lum[p] + d) / lum[p];
    if (gain < 1) {
      const g = Math.round(255 * gain);
      mul[i] = mul[i + 1] = mul[i + 2] = g;
    } else {
      // Added light, per channel, proportional to the pixel's own colour (keeps its hue).
      add[i] = pixels[i] * (gain - 1);
      add[i + 1] = pixels[i + 1] * (gain - 1);
      add[i + 2] = pixels[i + 2] * (gain - 1);
    }
  }
  return { mul, add };
}

function reduceBand(
  band: Float32Array,
  [dark, light]: [number, number],
  w: number,
  h: number,
  sigma: number,
): Float32Array {
  // The change to apply: minus the reduced part of the band.
  const delta = new Float32Array(band.length);
  for (let p = 0; p < band.length; p++) delta[p] = -band[p] * (band[p] < 0 ? dark : light);
  // Lifting dark parts more than light ones would raise the overall tone (a hazy, washed-out
  // look). Remove the change's local average so only the texture changes, never the tone.
  const avg = blurLike(delta, w, h, sigma);
  for (let p = 0; p < delta.length; p++) delta[p] -= avg[p];
  return delta;
}

/**
 * Scar pits: how deep each spot sits below the skin around it. A morphological closing fills every
 * dip narrower than the window up to the level of its rim; the difference is the dip's depth.
 * Run on the pore-smoothed lightness (so pores are not "scars") at half resolution (fast; the depth
 * map is smooth anyway), then scaled back up. Wide shapes (cheekbones, folds) are wider than the
 * window and are left alone.
 */
function scarDepth(b1: Float32Array, mask: Pixels, w: number, h: number, faceWidth: number): Float32Array {
  const f = 2;
  const w2 = Math.max(1, Math.floor(w / f)),
    h2 = Math.max(1, Math.floor(h / f));
  const small = new Float32Array(w2 * h2);
  const valid = new Uint8Array(w2 * h2);
  for (let y = 0; y < h2; y++)
    for (let x = 0; x < w2; x++) {
      let acc = 0,
        a = 0;
      for (let dy = 0; dy < f; dy++)
        for (let dx = 0; dx < f; dx++) {
          const p = (y * f + dy) * w + (x * f + dx);
          acc += b1[p];
          a += mask[p * 4 + 3];
        }
      small[y * w2 + x] = acc / (f * f);
      valid[y * w2 + x] = a / (f * f) > 64 ? 1 : 0;
    }
  // Largest scar treated: ~5% of the face width across (typical acne scars are 1-4%).
  const k = Math.max(2, Math.round((faceWidth * 0.025) / f));
  const closed = closeChannel(small, valid, w2, h2, { x0: 0, y0: 0, x1: w2 - 1, y1: h2 - 1 }, k);
  let depth: Float32Array = new Float32Array(w2 * h2);
  for (let p = 0; p < depth.length; p++) {
    const d = closed[p] - small[p];
    depth[p] = valid[p] && Number.isFinite(d) ? Math.min(40, Math.max(0, d)) : 0;
  }
  // Soften the plateau edges of the closing.
  depth = blurLike(depth, w2, h2, Math.max(1, k * 0.35));
  // Back to full resolution (bilinear).
  const full = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(h2 - 1, Math.max(0, (y + 0.5) / f - 0.5));
    const y0 = Math.floor(sy),
      y1 = Math.min(h2 - 1, y0 + 1),
      ty = sy - y0;
    for (let x = 0; x < w; x++) {
      const sx = Math.min(w2 - 1, Math.max(0, (x + 0.5) / f - 0.5));
      const x0 = Math.floor(sx),
        x1 = Math.min(w2 - 1, x0 + 1),
        tx = sx - x0;
      const top = depth[y0 * w2 + x0] * (1 - tx) + depth[y0 * w2 + x1] * tx;
      const bot = depth[y1 * w2 + x0] * (1 - tx) + depth[y1 * w2 + x1] * tx;
      full[y * w + x] = top * (1 - ty) + bot * ty;
    }
  }
  return full;
}

/** How much of a scar's depth is filled at full strength (some shape is kept: natural, not erased). */
export const SCAR_FILL = 0.85;

/**
 * Fill scar pits with the colour of the skin around them (not by brightening the pit's own,
 * more saturated shadow colour, which turns filled pits into orange dots).
 */
function scarLayers(pixels: Pixels, lum: Float32Array, b1: Float32Array, mask: Pixels, w: number, h: number, faceWidth: number): Layers {
  const n = w * h;
  const depth = scarDepth(b1, mask, w, h, faceWidth);
  // The surrounding skin's colour: a blur somewhat wider than the largest scar.
  const sigma = Math.max(2, faceWidth * 0.02);
  const chan = [0, 1, 2].map((c) => {
    const v = new Float32Array(n);
    for (let p = 0; p < n; p++) v[p] = pixels[p * 4 + c];
    return blurLike(v, w, h, sigma);
  });
  const localLum = new Float32Array(n);
  for (let p = 0; p < n; p++) localLum[p] = 0.2126 * chan[0][p] + 0.7152 * chan[1][p] + 0.0722 * chan[2][p];
  const mul = new Uint8ClampedArray(n * 4).fill(255);
  const add = new Uint8ClampedArray(n * 4);
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    add[i + 3] = 255;
    const fill = depth[p] * SCAR_FILL * (mask[i + 3] / 255);
    if (fill < 0.25) continue;
    // The brightness change is exactly the fill (texture kept). Its tint comes partly from the
    // surrounding skin, more so for deeper fills, so lifted pit shadows do not turn orange.
    if (lum[p] < 1 || localLum[p] < 1) continue;
    const targetL = lum[p] + fill;
    const a = Math.min(0.7, fill / 12);
    for (let c = 0; c < 3; c++) {
      const v = pixels[i + c];
      const own = (v * targetL) / lum[p];
      const skin = (chan[c][p] * targetL) / localLum[p];
      const d = own * (1 - a) + skin * a - v;
      if (d < 0) mul[i + c] = Math.round((255 * (v + d)) / Math.max(1, v));
      else add[i + c] = d;
    }
  }
  return { mul, add };
}

export function textureCompute(j: TextureJob): TextureResult {
  const { pixels, width: w, height: h } = j;
  const n = w * h;
  const lum = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    lum[p] = 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2];
  }
  // Sizes relative to the face, so the result is the same at any photo resolution.
  const poreSigma = Math.max(1, j.faceWidth * 0.0035);
  const b1 = blurLike(lum, w, h, poreSigma);
  const fine = new Float32Array(n);
  for (let p = 0; p < n; p++) fine[p] = lum[p] - b1[p];
  return {
    pores: toLayers(pixels, lum, reduceBand(fine, PORE_REDUCTION, w, h, poreSigma * 2), j.mask),
    scars: scarLayers(pixels, lum, b1, j.mask, w, h, j.faceWidth),
  };
}
