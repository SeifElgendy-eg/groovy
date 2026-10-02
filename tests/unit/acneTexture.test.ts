import { describe, expect, it } from "vitest";
import { textureCompute, type Layers } from "../../src/effects/acne/texture";

/** Apply a mul/add layer pair at strength a, the way the canvas compositing does. */
function apply(px: Uint8ClampedArray, l: Layers, a: number): Float32Array {
  const out = new Float32Array(px.length);
  for (let i = 0; i < px.length; i += 4)
    for (let c = 0; c < 3; c++) {
      const m = px[i + c] * (1 - a + (a * l.mul[i + c]) / 255);
      out[i + c] = m + l.add[i + c] * a;
    }
  return out;
}
const lum = (p: ArrayLike<number>, i: number) => 0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2];

/** Flat skin with small dark "pores" on a grid and one larger shallow "pit". */
function skin(size = 120) {
  const px = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      let v = 0;
      if (x % 10 === 5 && y % 10 === 5) v -= 30; // pore
      const d = Math.hypot(x - 60, y - 60);
      if (d < 7) v -= 18 * (1 - d / 7); // shallow pit (scar)
      px.set([200 + v, 160 + v, 140 + v, 255], i);
    }
  const mask = new Uint8ClampedArray(px.length).fill(255);
  return { px, mask, size };
}

describe("acne texture: pores and scars", () => {
  const { px, mask, size } = skin();
  const r = textureCompute({ pixels: px, mask, width: size, height: size, faceWidth: 400 });
  const pore = (25 * size + 25) * 4, flat = (20 * size + 21) * 4, pit = (60 * size + 60) * 4;

  it("pores slider lightens pore dots but leaves flat skin alone", () => {
    const out = apply(px, r.pores, 1);
    expect(lum(out, pore) - lum(px, pore)).toBeGreaterThan(10);
    expect(Math.abs(lum(out, flat) - lum(px, flat))).toBeLessThan(2);
  });

  it("keeps some pore texture (never fully flat)", () => {
    const out = apply(px, r.pores, 1);
    expect(lum(out, pore)).toBeLessThan(lum(px, flat) - 3);
  });

  it("scars slider lifts the shallow pit", () => {
    const out = apply(px, r.scars, 1);
    expect(lum(out, pit) - lum(px, pit)).toBeGreaterThan(3);
  });

  it("strength scales the change smoothly", () => {
    const half = apply(px, r.pores, 0.5), full = apply(px, r.pores, 1);
    const dHalf = lum(half, pore) - lum(px, pore), dFull = lum(full, pore) - lum(px, pore);
    expect(dHalf).toBeGreaterThan(dFull * 0.35);
    expect(dHalf).toBeLessThan(dFull * 0.65);
  });

  it("keeps the skin's colour (hue) while lightening", () => {
    const out = apply(px, r.pores, 1);
    const ratio = (p: ArrayLike<number>, i: number) => p[i] / p[i + 2];
    expect(Math.abs(ratio(out, pore) - ratio(px, pore))).toBeLessThan(0.03);
  });

  it("does nothing outside the skin mask", () => {
    const none = textureCompute({ pixels: px, mask: new Uint8ClampedArray(px.length), width: size, height: size, faceWidth: 400 });
    const out = apply(px, none.pores, 1);
    expect(lum(out, pore)).toBeCloseTo(lum(px, pore), 5);
  });
});

describe("acne texture keeps the overall tone", () => {
  it("does not lighten the skin on average (no haze)", () => {
    const { px, mask, size } = skin();
    const r = textureCompute({ pixels: px, mask, width: size, height: size, faceWidth: 400 });
    for (const layers of [r.pores, r.scars]) {
      const out = apply(px, layers, 1);
      let before = 0, after = 0;
      for (let i = 0; i < px.length; i += 4) { before += lum(px, i); after += lum(out, i); }
      expect(Math.abs(after - before) / (size * size)).toBeLessThan(0.6);
    }
  });
});

import { blurLike } from "../../src/effects/acne/texture";

describe("scar relief helpers", () => {
  it("blurLike keeps a flat image flat", () => {
    const v = new Float32Array(100).fill(7);
    for (const x of blurLike(v, 10, 10, 2)) expect(x).toBeCloseTo(7, 5);
  });
});

import { slide } from "../../src/effects/acne/texture";

describe("fast sliding min/max", () => {
  it("matches a brute-force window min/max in both directions, any window", () => {
    const w = 13, h = 9;
    const v = new Float32Array(w * h).map((_, i) => ((i * 7919) % 101) - 50);
    for (const k of [1, 2, 3, 6, 15]) for (const isMax of [true, false]) for (const vertical of [false, true]) {
      const got = slide(v, w, h, k, isMax, vertical);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let best = isMax ? -Infinity : Infinity;
        for (let d = -k; d <= k; d++) {
          const xx = vertical ? x : x + d, yy = vertical ? y + d : y;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const val = v[yy * w + xx];
          best = isMax ? Math.max(best, val) : Math.min(best, val);
        }
        expect(got[y * w + x]).toBe(best);
      }
    }
  });
});

import { srgbToOklab } from "../../src/effects/lips/color";

describe("redness", () => {
  // Normal skin with a red, inflamed patch in the middle.
  const size = 80;
  const px = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const red = Math.hypot(x - 40, y - 40) < 14;
      px.set(red ? [214, 140, 132, 255] : [210, 160, 140, 255], (y * size + x) * 4);
    }
  const mask = new Uint8ClampedArray(px.length).fill(255);
  const r = textureCompute({ pixels: px, mask, width: size, height: size, faceWidth: 400 });
  const centre = (40 * size + 40) * 4, normal = (5 * size + 5) * 4;

  it("moves a red patch toward the face's normal tone", () => {
    const out = apply(px, r.redness, 1);
    const before = srgbToOklab(px[centre], px[centre + 1], px[centre + 2]).a;
    const after = srgbToOklab(Math.round(out[centre]), Math.round(out[centre + 1]), Math.round(out[centre + 2])).a;
    const skin = srgbToOklab(px[normal], px[normal + 1], px[normal + 2]).a;
    expect(after).toBeLessThan(before);
    expect(after - skin).toBeLessThan((before - skin) * 0.35);
  });

  it("keeps brightness (texture) unchanged", () => {
    const out = apply(px, r.redness, 1);
    const Lb = srgbToOklab(px[centre], px[centre + 1], px[centre + 2]).L;
    const La = srgbToOklab(Math.round(out[centre]), Math.round(out[centre + 1]), Math.round(out[centre + 2])).L;
    expect(Math.abs(La - Lb)).toBeLessThan(0.01);
  });

  it("leaves normal skin alone", () => {
    const out = apply(px, r.redness, 1);
    for (let c = 0; c < 3; c++) expect(Math.abs(out[normal + c] - px[normal + c])).toBeLessThan(1.5);
  });
});
