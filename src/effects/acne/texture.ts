// Acne scars and pores: texture smoothing at the photo's full resolution (face area only).
//
// The skin's lightness is split by size (frequency separation):
//   fine  = L - blur(L, pore size)          -> pores and fine grain
// Pores: the fine band's dark dots are reduced (light parts, the skin's sheen, barely) and some
// of it is always kept, so skin never turns plastic. Line-like detail (hair, fine lines) is kept.
// Scars: pits are found as dips below the surrounding skin (morphology) and filled beyond the
// face's normal texture depth. Their raised rims are lowered only where there are pits, so
// highlights elsewhere stay. Lines (hair, creases) and the mask's edge are left alone.
// Colour is kept: each pixel's RGB is scaled by its change in lightness.
//
// The result is returned as two composite layers per treatment, so the caller can apply any
// strength (0..1) with globalAlpha and no recompute:
//   mul: multiply layer (gain <= 1, darkens) - RGB = 255 * gain, white where unchanged
//   add: lighter layer (adds light)            - RGB = amount added, black where unchanged

import { oklabToSrgb, srgbToOklab } from "../lips/color";

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
  redness: Layers;
}

/** How strongly each band is reduced at full strength: [dark parts, light parts]. */
export const PORE_REDUCTION: [number, number] = [0.5, 0.04];

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
 * Running min/max over a (2k+1)-wide window along rows or columns in O(n), whatever k is
 * (van Herk / Gil-Werman). Invalid pixels (valid=0) are ignored (treated as +/- infinity).
 */
export function slide(src: Float32Array, w: number, h: number, k: number, isMax: boolean, vertical: boolean): Float32Array {
  const out = new Float32Array(src.length);
  const len = vertical ? h : w,
    lines = vertical ? w : h;
  const win = 2 * k + 1;
  const g = new Float32Array(len + win),
    hh = new Float32Array(len + win);
  const pad = isMax ? -Infinity : Infinity;
  const pick = isMax ? Math.max : Math.min;
  const at = (line: number, i: number) => (vertical ? i * w + line : line * w + i);
  for (let line = 0; line < lines; line++) {
    const n = len + 2 * k;
    const v = (i: number) => {
      const j = i - k;
      return j < 0 || j >= len ? pad : src[at(line, j)];
    };
    for (let i = 0; i < n; i++) g[i] = i % win === 0 ? v(i) : pick(g[i - 1], v(i));
    for (let i = n - 1; i >= 0; i--) hh[i] = i === n - 1 || (i + 1) % win === 0 ? v(i) : pick(hh[i + 1], v(i));
    for (let i = 0; i < len; i++) out[at(line, i)] = pick(hh[i], g[i + 2 * k]);
  }
  return out;
}

function morph(src: Float32Array, valid: Uint8Array, w: number, h: number, k: number, isMax: boolean): Float32Array {
  const pad = isMax ? -Infinity : Infinity;
  const x = new Float32Array(src.length);
  for (let p = 0; p < x.length; p++) x[p] = valid[p] ? src[p] : pad;
  return slide(slide(x, w, h, k, isMax, false), w, h, k, isMax, true);
}

/** Closing (fill dips) and opening (cut ridges) narrower than the window, skin pixels only. */
const closing = (v: Float32Array, ok: Uint8Array, w: number, h: number, k: number) =>
  morph(morph(v, ok, w, h, k, true), ok, w, h, k, false);
const opening = (v: Float32Array, ok: Uint8Array, w: number, h: number, k: number) =>
  morph(morph(v, ok, w, h, k, false), ok, w, h, k, true);

/**
 * Scar depth: how far each spot sits below the skin around it (acne scars are pits), at full
 * resolution, on the pore-smoothed lightness (so pores are not "scars"). Bright bumps are lowered
 * only next to pits (scar rims); elsewhere they are highlights (nose, cheekbones) and are kept.
 * Open-close removes rims and dips narrower than the window; averaging it with close-open cancels
 * the slight darkening/lightening either order alone gives on textured skin. Wider shapes
 * (cheekbone, jaw) are wider than the window and left alone.
 */
export function scarDepth(b1: Float32Array, mask: Pixels, w: number, h: number, faceWidth: number): Float32Array {
  const n = w * h;
  const valid = new Uint8Array(n);
  for (let p = 0; p < n; p++) valid[p] = mask[p * 4 + 3] > 64 ? 1 : 0;
  // Largest scar treated: ~6% of the face width across (ice-pick and boxcar scars are 1-4%,
  // rolling scars wider).
  const k = Math.max(2, Math.round(faceWidth * 0.03));
  const finite = (a: Float32Array) => {
    for (let p = 0; p < n; p++) if (!Number.isFinite(a[p])) a[p] = b1[p];
    return a;
  };
  const oc = finite(closing(finite(opening(b1, valid, w, h, k)), valid, w, h, k));
  const co = finite(opening(finite(closing(b1, valid, w, h, k)), valid, w, h, k));
  let depth: Float32Array = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    const d = (oc[p] + co[p]) / 2 - b1[p];
    depth[p] = valid[p] ? Math.min(45, Math.max(-45, d)) : 0;
  }
  // Only soften the square window's edges; a wide blur would wash out small pits.
  depth = blurLike(depth, w, h, Math.max(1, faceWidth * 0.003));
  // Ordinary skin has relief too; flattening it all is what looks plastic. Take the typical
  // relief of this face (median |depth| over skin) as normal and remove only what goes beyond it,
  // so a filled scar ends up as textured as the skin around it.
  const floor = medianAbs(depth, valid) * SCAR_TEXTURE_KEPT;
  const pits = new Float32Array(n);
  for (let p = 0; p < n; p++) pits[p] = Math.max(0, depth[p] - floor);
  // Scar rims (the raised, lighter edge of a pit) are lowered too, but only where there are pits
  // around: elsewhere a bright bump is a highlight (nose, cheekbone, oily shine) and is kept.
  const scarred = blurLike(pits, w, h, k);
  for (let p = 0; p < n; p++) {
    const rim = Math.min(0, depth[p] + floor);
    const near = Math.min(1, scarred[p] / SCAR_RIM_NEIGHBOURHOOD);
    // A rim stands a few levels proud of the skin; shine stands far higher. Leave the latter.
    const t = Math.min(1, Math.max(0, (-rim - SCAR_RIM_MAX[0]) / (SCAR_RIM_MAX[1] - SCAR_RIM_MAX[0])));
    const isRim = 1 - t * t * (3 - 2 * t);
    depth[p] = pits[p] + rim * near * near * isRim;
  }
  return depth;
}

/**
 * 1 where the local structure is blob-like or random (pits, pores, skin grain), falling to 0 where
 * it is line-like (hair strands, creases, edges): the structure tensor's coherence over ~sigma.
 */
export function blobWeight(lum: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const n = w * h;
  const xx = new Float32Array(n),
    xy = new Float32Array(n),
    yy = new Float32Array(n);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const gx = (lum[y * w + Math.min(w - 1, x + 1)] - lum[y * w + Math.max(0, x - 1)]) / 2;
      const gy = (lum[Math.min(h - 1, y + 1) * w + x] - lum[Math.max(0, y - 1) * w + x]) / 2;
      xx[p] = gx * gx;
      xy[p] = gx * gy;
      yy[p] = gy * gy;
    }
  const a = blurLike(xx, w, h, sigma),
    b = blurLike(xy, w, h, sigma),
    c = blurLike(yy, w, h, sigma);
  const out = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    const tr = a[p] + c[p];
    const diff = Math.sqrt((a[p] - c[p]) ** 2 + 4 * b[p] * b[p]);
    // Coherence 0 (isotropic) .. 1 (a single direction). +1 keeps flat, noisy areas isotropic.
    const coh = diff / (tr + 1);
    const t = Math.min(1, Math.max(0, (coh - LINE_COHERENCE[0]) / (LINE_COHERENCE[1] - LINE_COHERENCE[0])));
    out[p] = 1 - t * t * (3 - 2 * t);
  }
  return out;
}

/** Coherence range over which a feature goes from "blob" (treated) to "line" (left alone). */
export const LINE_COHERENCE: [number, number] = [0.35, 0.7];

/** 1 well inside the mask, 0 at and beyond its edge (a blurred, re-thresholded core). */
function coreWeight(mask: Pixels, w: number, h: number, sigma: number): Float32Array {
  const n = w * h;
  const inside = new Float32Array(n);
  for (let p = 0; p < n; p++) inside[p] = mask[p * 4 + 3] > 200 ? 1 : 0;
  const v = blurLike(inside, w, h, sigma);
  for (let p = 0; p < n; p++) {
    const t = Math.min(1, Math.max(0, (v[p] - 0.6) / 0.35));
    v[p] = t * t * (3 - 2 * t);
  }
  return v;
}

/** How much of a scar's relief (beyond normal texture) is removed at full strength. */
export const SCAR_FILL = 1;

/** Average pit depth (levels) around a bright bump above which it counts as a scar rim. */
export const SCAR_RIM_NEIGHBOURHOOD = 2.5;

/** Height (levels above the skin) over which a bright bump goes from "scar rim" to "shine". */
export const SCAR_RIM_MAX: [number, number] = [6, 12];

/** Relief up to this multiple of the face's median relief counts as normal texture and is kept. */
export const SCAR_TEXTURE_KEPT = 1.5;

/** Median of |v| over valid pixels (histogram, 0.05-level bins). */
function medianAbs(v: Float32Array, valid: Uint8Array): number {
  const bins = new Uint32Array(1000);
  let count = 0;
  for (let p = 0; p < v.length; p++) {
    if (!valid[p]) continue;
    bins[Math.min(999, Math.floor(Math.abs(v[p]) * 20))]++;
    count++;
  }
  let seen = 0;
  for (let b = 0; b < 1000; b++) if ((seen += bins[b]) * 2 >= count) return b / 20;
  return 0;
}

/**
 * Fill scar pits with the colour of the skin around them (not by brightening the pit's own,
 * more saturated shadow colour, which turns filled pits into orange dots).
 */
function scarLayers(pixels: Pixels, lum: Float32Array, b1: Float32Array, mask: Pixels, w: number, h: number, faceWidth: number): Layers {
  const n = w * h;
  const depth = scarDepth(b1, mask, w, h, faceWidth);
  // Pits are round; hair strands, creases and the face's own outline are lines: leave those.
  const blob = blobWeight(b1, w, h, Math.max(1.5, faceWidth * 0.012));
  // Dark hair and shadow just inside the mask's edge look like dips too: fade out near the edge.
  const core = coreWeight(mask, w, h, Math.max(2, faceWidth * 0.015));
  // The colour of the normal skin around each pixel, as a ratio to lightness (r/L, g/L, b/L).
  // Shine (white) and deep shadow are left out of that average, so the reference is real skin
  // tone: lifted pit shadows do not go orange and lowered shiny rims do not go grey.
  const sigma = Math.max(2, faceWidth * 0.02);
  const around = blurLike(lum, w, h, sigma);
  const weight = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    const z = (lum[p] - around[p]) / 15;
    weight[p] = Math.exp(-z * z);
  }
  const wl = new Float32Array(n);
  for (let p = 0; p < n; p++) wl[p] = lum[p] * weight[p];
  const denom = blurLike(wl, w, h, sigma);
  const ratio = [0, 1, 2].map((c) => {
    const v = new Float32Array(n);
    for (let p = 0; p < n; p++) v[p] = pixels[p * 4 + c] * weight[p];
    const num = blurLike(v, w, h, sigma);
    for (let p = 0; p < n; p++) num[p] = denom[p] > 1e-3 ? num[p] / denom[p] : 1;
    return num;
  });
  const mul = new Uint8ClampedArray(n * 4).fill(255);
  const add = new Uint8ClampedArray(n * 4);
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    add[i + 3] = 255;
    const fill = depth[p] * SCAR_FILL * (mask[i + 3] / 255) * blob[p] * core[p];
    if (Math.abs(fill) < 0.25 || lum[p] < 1) continue;
    // The brightness change is exactly the fill (texture kept). The more a pixel is changed, the
    // more of its colour comes from the surrounding skin tone.
    const targetL = Math.max(1, lum[p] + fill);
    const a = Math.min(0.6, Math.abs(fill) / 10);
    for (let c = 0; c < 3; c++) {
      const v = pixels[i + c];
      const own = v / lum[p];
      const d = targetL * (own * (1 - a) + ratio[c][p] * a) - v;
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
  // Pores are dots; hair strands and fine lines are lines and keep their full detail.
  const poreBlob = blobWeight(lum, w, h, poreSigma * 2.5);
  const poreBand = new Float32Array(n);
  for (let p = 0; p < n; p++) poreBand[p] = fine[p] * poreBlob[p];
  return {
    pores: toLayers(pixels, lum, reduceBand(poreBand, PORE_REDUCTION, w, h, poreSigma * 2), j.mask),
    scars: scarLayers(pixels, lum, b1, j.mask, w, h, j.faceWidth),
    redness: rednessLayers(pixels, j.mask, w, h, j.faceWidth),
  };
}

/** Share of the excess redness removed at full strength (a little is kept: skin is never grey). */
export const REDNESS_REDUCTION = 0.75;

/**
 * Redness: inflamed patches and post-acne red marks are skin that is redder (OKLab a, the
 * red-green axis) than this face's normal tone. The excess over the face's typical value is
 * smoothed (so pores and fine texture are not recoloured one by one) and mostly removed, leaving
 * lightness and the yellow-blue axis untouched: brightness and texture stay exactly as they were.
 */
function rednessLayers(pixels: Pixels, mask: Pixels, w: number, h: number, faceWidth: number): Layers {
  const n = w * h;
  const L = new Float32Array(n),
    A = new Float32Array(n),
    B = new Float32Array(n);
  const skinA: number[] = [],
    skinB: number[] = [];
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    const lab = srgbToOklab(pixels[i], pixels[i + 1], pixels[i + 2]);
    L[p] = lab.L;
    A[p] = lab.a;
    B[p] = lab.b;
    if (mask[i + 3] > 200 && (p & 3) === 0) {
      skinA.push(lab.a);
      skinB.push(lab.b);
    }
  }
  const mul = new Uint8ClampedArray(n * 4).fill(255);
  const add = new Uint8ClampedArray(n * 4);
  for (let p = 0; p < n; p++) add[p * 4 + 3] = 255;
  if (!skinA.length) return { mul, add };
  // This face's normal tone: the median over its skin, on both colour axes.
  skinA.sort((x, y) => x - y);
  skinB.sort((x, y) => x - y);
  const normal = skinA[skinA.length >> 1];
  const normalB = skinB[skinB.length >> 1];
  // Excess redness, smoothed at about pore-to-small-spot scale.
  const excess = new Float32Array(n);
  for (let p = 0; p < n; p++) excess[p] = Math.max(0, A[p] - normal);
  const smooth = blurLike(excess, w, h, Math.max(1, faceWidth * 0.004));
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    const cut = Math.min(smooth[p], excess[p] + 0.004) * REDNESS_REDUCTION * (mask[i + 3] / 255);
    if (cut < 0.002) continue;
    // The share of this pixel's excess redness being removed; its yellow-blue tone moves toward
    // the normal skin by the same share (removing red alone turns red patches lilac).
    const share = Math.min(1, cut / Math.max(1e-4, A[p] - normal));
    const rgb = oklabToSrgb(L[p], A[p] - cut, B[p] + (normalB - B[p]) * share * 0.8);
    for (let c = 0; c < 3; c++) {
      const v = pixels[i + c];
      const d = rgb[c] - v;
      if (d < 0) mul[i + c] = Math.round((255 * (v + d)) / Math.max(1, v));
      else add[i + c] = d;
    }
  }
  return { mul, add };
}
