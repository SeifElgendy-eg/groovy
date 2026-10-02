// Acne scars and pores: texture smoothing at the photo's full resolution (face area only).
//
// The skin's lightness is split by size (frequency separation):
//   fine  = L - blur(L, pore size)          -> pores and fine grain
//   mid   = blur(L, pore) - blur(L, scar)   -> shallow scar pits and uneven texture
//   base  = blur(L, scar size)              -> overall tone, untouched
// Dark parts of each band (pores, pits) are reduced much more than light parts (natural sheen),
// and some of every band is always kept, so skin never turns plastic. Colour is kept: each pixel's
// RGB is scaled by its change in lightness.
//
// The result is returned as two composite layers per treatment, so the caller can apply any
// strength (0..1) with globalAlpha and no recompute:
//   mul: multiply layer (gain <= 1, darkens) - RGB = 255 * gain, white where unchanged
//   add: lighter layer (adds light)            - RGB = amount added, black where unchanged

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
export const SCAR_REDUCTION: [number, number] = [0.6, 0.15];

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
  const scarSigma = Math.max(poreSigma * 2.5, j.faceWidth * 0.014);
  const b1 = blurLike(lum, w, h, poreSigma);
  const b2 = blurLike(lum, w, h, scarSigma);
  const fine = new Float32Array(n),
    mid = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    fine[p] = lum[p] - b1[p];
    mid[p] = b1[p] - b2[p];
  }
  return {
    pores: toLayers(pixels, lum, reduceBand(fine, PORE_REDUCTION, w, h, poreSigma * 2), j.mask),
    scars: toLayers(pixels, lum, reduceBand(mid, SCAR_REDUCTION, w, h, scarSigma), j.mask),
  };
}
