// Lip colour in OKLab. OKLab separates lightness from colour the way the eye does, so a shade can
// be applied without the grey/washed-out look of shifting RGB channels, and the lip's own texture
// (creases, highlights) survives as lightness *differences* around the shade's lightness.
// Pure functions: pixels in, pixels out.

export type LipFinish = "natural" | "matte" | "gloss";

export interface Lab {
  L: number;
  a: number;
  b: number;
}

// sRGB <-> linear lookup (8-bit in, float out) and its inverse.
const TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
const toSrgb = (c: number): number =>
  c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;

export function srgbToOklab(r: number, g: number, b: number): Lab {
  const lr = TO_LINEAR[r],
    lg = TO_LINEAR[g],
    lb = TO_LINEAR[b];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

/** OKLab -> linear sRGB (may be out of gamut). */
function oklabToLinear(L: number, a: number, b: number): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const inGamut = (c: [number, number, number]) => c.every((v) => v >= -1e-4 && v <= 1 + 1e-4);

/** OKLab -> 8-bit sRGB, keeping lightness and hue and reducing chroma until it fits. */
export function oklabToSrgb(L: number, a: number, b: number): [number, number, number] {
  let lin = oklabToLinear(L, a, b);
  if (!inGamut(lin)) {
    let lo = 0,
      hi = 1;
    for (let i = 0; i < 12; i++) {
      const k = (lo + hi) / 2;
      if (inGamut(oklabToLinear(L, a * k, b * k))) lo = k;
      else hi = k;
    }
    lin = oklabToLinear(L, a * lo, b * lo);
  }
  return lin.map((v) => Math.round(255 * toSrgb(Math.min(1, Math.max(0, v))))) as [number, number, number];
}

export function hexToRgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

/** How each finish reshapes the lip's own highlights (lightness above the lip's average). */
const FINISH: Record<LipFinish, { highlight: number; sheen: number; chroma: number }> = {
  // natural: texture as photographed
  natural: { highlight: 1, sheen: 0, chroma: 1 },
  // matte: highlights flattened, slightly richer colour
  matte: { highlight: 0.4, sheen: 0, chroma: 1.08 },
  // gloss: highlights brightened and a little extra sheen on the brightest areas
  gloss: { highlight: 1.6, sheen: 0.06, chroma: 0.95 },
};

/**
 * Colour the lip pixels of `pixels` (RGBA, modified in place) with `shadeHex`.
 * `mask` is the feathered lip mask (RGBA, alpha = coverage) of the same size.
 * `intensity` 0..1 is the user's strength.
 */
export function colorLips(
  pixels: Uint8ClampedArray,
  mask: Uint8ClampedArray,
  shadeHex: string,
  intensity: number,
  finish: LipFinish = "natural",
): void {
  const shade = srgbToOklab(...hexToRgb(shadeHex));
  const f = FINISH[finish];

  // The lip's average lightness: texture is kept as each pixel's offset from it.
  let sumL = 0,
    sumW = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const w = mask[i + 3];
    if (w < 128) continue;
    sumL += srgbToOklab(pixels[i], pixels[i + 1], pixels[i + 2]).L * w;
    sumW += w;
  }
  if (!sumW) return;
  const meanL = sumL / sumW;
  // Move the lip's average most of the way to the shade's lightness (not all: a pale lipstick on
  // a dark lip still looks applied, not painted).
  const baseL = meanL + (shade.L - meanL) * 0.75;
  const shadeChroma = Math.hypot(shade.a, shade.b);

  for (let i = 0; i < pixels.length; i += 4) {
    const cover = mask[i + 3] / 255;
    if (cover <= 0.004) continue;
    const r = pixels[i],
      g = pixels[i + 1],
      b = pixels[i + 2];
    const px = srgbToOklab(r, g, b);
    const d = px.L - meanL;
    // Texture: creases (d < 0) kept as photographed; highlights (d > 0) reshaped by the finish.
    let L = baseL + (d > 0 ? d * f.highlight : d);
    if (f.sheen && d > 0.04) L += f.sheen * Math.min(1, (d - 0.04) / 0.08);
    L = Math.min(0.98, Math.max(0.02, L));
    // Colour: the shade's hue; chroma follows lightness so dark creases are not neon.
    const chroma = shadeChroma * f.chroma * Math.min(1.1, Math.max(0.5, L / Math.max(shade.L, 0.05)));
    const scale = shadeChroma > 1e-6 ? chroma / shadeChroma : 0;
    const [nr, ng, nb] = oklabToSrgb(L, shade.a * scale, shade.b * scale);
    // Very dark pixels (mouth corners, the lip line) take less colour.
    const alpha = Math.pow(cover, 1.5) * intensity * 0.85 * Math.min(1, px.L / 0.3);
    pixels[i] = r + (nr - r) * alpha;
    pixels[i + 1] = g + (ng - g) * alpha;
    pixels[i + 2] = b + (nb - b) * alpha;
  }
}
