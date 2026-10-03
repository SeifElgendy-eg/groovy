// The fast filters must give exactly what the plain versions they replaced give (the effects'
// output is compared byte for byte against main). The plain versions are kept here as references.
import { describe, expect, it } from "vitest";
import { blurLike, slide } from "../../src/effects/acne/texture";
import { binomial, hypot } from "../../src/effects/wrinkles/lines";

let seed = 7;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const field = (w: number, h: number) => Float32Array.from({ length: w * h }, () => rnd() * 255 - (rnd() < 0.05 ? 300 : 0));

function refBoxBlur(src: Float32Array, w: number, h: number, r: number, tmp: Float32Array) {
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
function refBlurLike(src: Float32Array, w: number, h: number, sigma: number) {
  const out = src.slice(),
    tmp = new Float32Array(src.length);
  const r = Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2));
  for (let pass = 0; pass < 3; pass++) refBoxBlur(out, w, h, r, tmp);
  return out;
}
function refSlide(src: Float32Array, w: number, h: number, k: number, isMax: boolean, vertical: boolean) {
  const out = new Float32Array(src.length);
  const len = vertical ? h : w,
    lines = vertical ? w : h,
    win = 2 * k + 1;
  const g = new Float32Array(len + win),
    hh = new Float32Array(len + win);
  const pad = isMax ? -Infinity : Infinity,
    pick = isMax ? Math.max : Math.min;
  const at = (line: number, i: number) => (vertical ? i * w + line : line * w + i);
  for (let line = 0; line < lines; line++) {
    const n = len + 2 * k;
    const v = (i: number) => (i - k < 0 || i - k >= len ? pad : src[at(line, i - k)]);
    for (let i = 0; i < n; i++) g[i] = i % win === 0 ? v(i) : pick(g[i - 1], v(i));
    for (let i = n - 1; i >= 0; i--) hh[i] = i === n - 1 || (i + 1) % win === 0 ? v(i) : pick(hh[i + 1], v(i));
    for (let i = 0; i < len; i++) out[at(line, i)] = pick(hh[i], g[i + 2 * k]);
  }
  return out;
}
function refBinomial(src: Float32Array, w: number, h: number, sigma: number) {
  const passes = Math.max(1, Math.round(2 * sigma * sigma));
  const a = src.slice(),
    b = new Float32Array(src.length);
  for (let k = 0; k < passes; k++) {
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        b[p] = (a[x > 0 ? p - 1 : p] + 2 * a[p] + a[x < w - 1 ? p + 1 : p]) / 4;
      }
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        a[p] = (b[y > 0 ? p - w : p] + 2 * b[p] + b[y < h - 1 ? p + w : p]) / 4;
      }
  }
  return a;
}

const sizes: [number, number][] = [
  [1, 1],
  [1, 9],
  [9, 1],
  [3, 2],
  [7, 13],
  [64, 37],
  [101, 80],
];

describe("fast filters match the plain versions exactly", () => {
  it("blur", () => {
    for (const [w, h] of sizes)
      for (const sigma of [0.5, 1, 2.7, 6, 40]) {
        const src = field(w, h);
        expect(blurLike(src, w, h, sigma)).toEqual(refBlurLike(src, w, h, sigma));
      }
  });
  it("running min and max, along rows and columns", () => {
    for (const [w, h] of sizes)
      for (const k of [0, 1, 2, 5, 60])
        for (const isMax of [true, false])
          for (const vertical of [false, true]) {
            const src = field(w, h);
            expect(slide(src, w, h, k, isMax, vertical)).toEqual(refSlide(src, w, h, k, isMax, vertical));
          }
  });
  it("binomial smoothing, several widths from one run", () => {
    for (const [w, h] of sizes) {
      const src = field(w, h);
      const sigmas = [0.7, 1.6, 2.2];
      const got = binomial(src, w, h, sigmas);
      sigmas.forEach((s, i) => expect(got[i]).toEqual(refBinomial(src, w, h, s)));
    }
  });
  it("hypot", () => {
    for (let i = 0; i < 200000; i++) {
      const s = rnd() < 0.5 ? 50 : 1e-4;
      const a = (rnd() - 0.5) * s,
        b = (rnd() - 0.5) * s * (rnd() < 0.1 ? 1e7 : 1);
      expect(hypot(a, b)).toBe(Math.hypot(a, b));
    }
    for (const [a, b] of [
      [0, 0],
      [-0, 3],
      [Infinity, NaN],
      [NaN, 1],
      [-Infinity, 2],
    ])
      expect(hypot(a, b)).toBe(Math.hypot(a, b));
  });
});
