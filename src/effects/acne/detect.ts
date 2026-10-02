// Blemish detection that adapts to the photo. Instead of fixed thresholds (which miss spots on
// darker skin and on over- or under-exposed photos), each pixel is compared with the blurred
// skin around it in OKLab, and the difference is measured against how much this particular face
// normally varies (a robust z-score). A spot is "unusual for this skin", whatever the skin tone.
//
// Two kinds of seed:
//   RED  - redder than its surroundings (active acne, inflamed spots)
//   MARK - clearly darker than its surroundings and not greener (brown post-acne marks)

export const SEED_NONE = 0;
export const SEED_RED = 1;
export const SEED_MARK = 2;

export interface DetectOptions {
  /** How unusual (in robust standard deviations) a pixel must be to start a spot. */
  redZ: number;
  markZ: number;
}

export const DEFAULT_DETECT: DetectOptions = { redZ: 2.2, markZ: 4 };

// sRGB -> linear lookup for the OKLab conversion.
const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** OKLab lightness L and red-green axis a for one sRGB pixel. */
function labLA(r: number, g: number, b: number): [number, number] {
  const lr = LIN[r],
    lg = LIN[g],
    lb = LIN[b];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s];
}

/** Median and robust spread (1.4826 x median absolute deviation) of `v[0..n)`. */
function robust(v: Float32Array, n: number, floor: number): { med: number; sigma: number } {
  if (!n) return { med: 0, sigma: floor };
  const sorted = v.slice(0, n).sort();
  const med = sorted[n >> 1];
  for (let i = 0; i < n; i++) sorted[i] = Math.abs(sorted[i] - med);
  sorted.sort();
  return { med, sigma: Math.max(floor, 1.4826 * sorted[n >> 1]) };
}

/**
 * Seed map (one byte per pixel: SEED_NONE / SEED_RED / SEED_MARK).
 * `source` and `baseline` (its blurred copy) are RGBA; `skin` alpha >= 250 marks treatable skin.
 */
export function detectSeeds(
  source: Uint8ClampedArray,
  baseline: Uint8ClampedArray,
  skin: Uint8ClampedArray,
  width: number,
  height: number,
  opts: DetectOptions = DEFAULT_DETECT,
): Uint8Array {
  const n = width * height;
  const dA = new Float32Array(n),
    dL = new Float32Array(n);
  const idx = new Int32Array(n);
  let count = 0;
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    if (skin[i + 3] < 250) continue;
    const [L, a] = labLA(source[i], source[i + 1], source[i + 2]);
    const [bL, bA] = labLA(baseline[i], baseline[i + 1], baseline[i + 2]);
    // Relative to the surroundings' lightness, so the same spot scores the same on light and
    // dark skin, and on bright and dim photos.
    const scale = Math.max(bL, 0.15);
    dA[count] = (a - bA) / scale;
    dL[count] = (bL - L) / scale;
    idx[count++] = p;
  }
  const ra = robust(dA, count, 0.004);
  const rl = robust(dL, count, 0.008);
  const seeds = new Uint8Array(n);
  for (let k = 0; k < count; k++) {
    const zA = (dA[k] - ra.med) / ra.sigma;
    const zL = (dL[k] - rl.med) / rl.sigma;
    if (zA > opts.redZ) seeds[idx[k]] = SEED_RED;
    // A mark is clearly darker AND not greener than its surroundings (that excludes shadows of
    // stubble and most hair), and at least a little red-brown.
    else if (zL > opts.markZ && zA > 0.5) seeds[idx[k]] = SEED_MARK;
  }
  return seeds;
}
