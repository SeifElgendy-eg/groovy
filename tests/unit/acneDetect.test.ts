import { describe, expect, it } from "vitest";
import { detectSeeds, SEED_MARK, SEED_RED } from "../../src/effects/acne/detect";

const W = 80, H = 80;

/** Deterministic pseudo-random skin texture of a given base colour, with optional spots. */
function face(base: [number, number, number], spots: { x: number; y: number; r: number; color: [number, number, number] }[]) {
  const src = new Uint8ClampedArray(W * H * 4);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4, n = rnd() * 6;
      let c: number[] = base.map((v) => v + n);
      for (const s of spots) {
        const d = Math.hypot(x - s.x, y - s.y) / s.r;
        if (d < 1) { const t = 1 - d * d; c = c.map((v, k) => v + (s.color[k] - base[k]) * t); }
      }
      src.set([c[0], c[1], c[2], 255], i);
    }
  // Baseline: a wide box blur of the skin (what the effect passes in).
  const blur = new Uint8ClampedArray(src.length), k = 7;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const acc = [0, 0, 0]; let n = 0;
      for (let dy = -k; dy <= k; dy++) for (let dx = -k; dx <= k; dx++) {
        const xx = Math.min(W - 1, Math.max(0, x + dx)), yy = Math.min(H - 1, Math.max(0, y + dy)), j = (yy * W + xx) * 4;
        acc[0] += src[j]; acc[1] += src[j + 1]; acc[2] += src[j + 2]; n++;
      }
      blur.set([acc[0] / n, acc[1] / n, acc[2] / n, 255], (y * W + x) * 4);
    }
  const skin = new Uint8ClampedArray(src.length).fill(255);
  return { src, blur, skin };
}

const count = (seeds: Uint8Array, kind: number, cx: number, cy: number, r: number) => {
  let c = 0;
  for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) if (seeds[y * W + x] === kind) c++;
  return c;
};
const total = (seeds: Uint8Array) => seeds.reduce((a, v) => a + (v ? 1 : 0), 0);

// The previous fixed-threshold rule, for comparison.
function oldSeeds(src: Uint8ClampedArray, blur: Uint8ClampedArray) {
  const red = (r: number, g: number, b: number) => (r - (g + b) / 2) / Math.max(30, r + g + b);
  const out = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p++) {
    const i = p * 4;
    out[p] = red(src[i], src[i + 1], src[i + 2]) - red(blur[i], blur[i + 1], blur[i + 2]) > 0.006 && src[i] > src[i + 1] * 1.12 ? 1 : 0;
  }
  return out;
}

// The same blemish ("a bit redder, a bit darker") on three skins.
const cases: [string, [number, number, number], [number, number, number]][] = [
  ["light skin", [222, 176, 156], [214, 140, 130]],
  ["dark skin", [104, 70, 56], [104, 58, 48]],
  ["over-exposed photo", [246, 222, 210], [246, 196, 188]],
];

describe("acne detection adapts to the skin", () => {
  for (const [name, base, spot] of cases) {
    it(`finds a red spot on ${name}`, () => {
      const { src, blur, skin } = face(base, [{ x: 40, y: 40, r: 4, color: spot }]);
      const seeds = detectSeeds(src, blur, skin, W, H);
      expect(count(seeds, SEED_RED, 40, 40, 3)).toBeGreaterThanOrEqual(5);
    });
    it(`raises few false alarms on plain ${name}`, () => {
      const { src, blur, skin } = face(base, []);
      expect(total(detectSeeds(src, blur, skin, W, H))).toBeLessThan(W * H * 0.01);
    });
  }

  it("the old fixed rule raises false alarms on clean darker skin (why this changed)", () => {
    // Measured: the old rule flags hundreds to thousands of blemish-free pixels on darker skin
    // (each a potential repaint of healthy skin); the new detector flags almost none.
    const { src, blur, skin } = face(cases[1][1], []);
    expect(total(oldSeeds(src, blur))).toBeGreaterThan(300);
    expect(total(detectSeeds(src, blur, skin, W, H))).toBeLessThan(W * H * 0.01);
  });

  it("finds a brown mark as a MARK, not a red spot", () => {
    const { src, blur, skin } = face([210, 165, 145], [{ x: 40, y: 40, r: 5, color: [160, 112, 90] }]);
    const seeds = detectSeeds(src, blur, skin, W, H);
    expect(count(seeds, SEED_MARK, 40, 40, 4)).toBeGreaterThanOrEqual(5);
  });

  it("ignores pixels outside the skin mask", () => {
    const { src, blur, skin } = face([222, 176, 156], [{ x: 40, y: 40, r: 4, color: [214, 140, 130] }]);
    skin.fill(0);
    expect(total(detectSeeds(src, blur, skin, W, H))).toBe(0);
  });
});
