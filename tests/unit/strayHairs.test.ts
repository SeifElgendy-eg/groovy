import { describe, expect, it } from "vitest";
import { strayHairs, type Zone } from "../../src/effects/wrinkles/lines";

// A forehead: hair (outside the mask) along the top, skin below. A strand hangs from the hair
// and curls on the skin; a crease of the same darkness runs across the middle, on its own.
function scene() {
  const w = 200,
    h = 140,
    n = w * h;
  const lum = new Float32Array(n).fill(170);
  const mask = new Uint8ClampedArray(n * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      mask[p * 4 + 3] = y < 20 ? 0 : 255;
      if (y < 20) lum[p] = 60; // hair
      else lum[p] = 170 + ((((x * 73856093) ^ (y * 19349663)) >>> 0) % 7) - 3; // skin grain
    }
  const dot = (x: number, y: number, v: number) => {
    const xi = Math.round(x),
      yi = Math.round(y);
    lum[yi * w + xi] = Math.min(lum[yi * w + xi], v);
  };
  // Strand: from the hairline down and around (one pixel wide, 30 levels darker).
  for (let t = 0; t <= 1; t += 0.002) {
    const a = t * Math.PI * 1.3;
    dot(60 + 25 * Math.sin(a), 20 + 30 * (1 - Math.cos(a)) + t * 10, 140);
  }
  // Crease: across the forehead, not touching the hair.
  for (let x = 30; x < 180; x++) dot(x, 100 + 3 * Math.sin(x / 15), 140);
  const zones: Zone[] = [{ id: "forehead", cx: 100, cy: 80, rx: 110, ry: 90, angle: 0, lineAngle: 0 }];
  // Skin level around each pixel (the caller passes its blurred lightness).
  const around = new Float32Array(n).fill(170);
  return { w, h, lum, mask, zones, around };
}

describe("stray hairs", () => {
  const { w, h, lum, mask, zones, around } = scene();
  const hair = strayHairs(lum, around, mask, zones, w, h, 200);

  it("keeps a strand that hangs from the hairline, all the way along its curl", () => {
    let found = 0,
      total = 0;
    for (let t = 0.05; t <= 1; t += 0.05) {
      const a = t * Math.PI * 1.3;
      const x = Math.round(60 + 25 * Math.sin(a)),
        y = Math.round(20 + 30 * (1 - Math.cos(a)) + t * 10);
      total++;
      if (hair[y * w + x] > 0.5) found++;
    }
    expect(found / total).toBeGreaterThan(0.85);
  });

  it("leaves a crease that does not reach the hair to the treatment", () => {
    let max = 0;
    for (let x = 100; x < 180; x++) max = Math.max(max, hair[Math.round(100 + 3 * Math.sin(x / 15)) * w + x]);
    expect(max).toBe(0);
  });
});

// A brow (carved out of the mask, as the landmarks' outline) with stray hairs sticking up past
// it onto the skin, and a crease above it (a raised brow) that does not touch it.
describe("stray brow hairs", () => {
  const w = 200,
    h = 140,
    n = w * h;
  const lum = new Float32Array(n),
    mask = new Uint8ClampedArray(n * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const brow = y >= 90 && y < 102 && x > 40 && x < 160;
      mask[p * 4 + 3] = brow ? 0 : 255;
      lum[p] = brow ? 70 : 170 + ((((x * 73856093) ^ (y * 19349663)) >>> 0) % 7) - 3;
    }
  const dot = (x: number, y: number, v: number) => {
    const p = Math.round(y) * w + Math.round(x);
    lum[p] = Math.min(lum[p], v);
  };
  // Hairs: from the brow's top edge up and slightly sideways, 6-9 px long (3-4.5% of the face's
  // width, which is 200 here).
  const hairs = [55, 75, 95, 115, 135].map((x0, i) => ({ x0, dx: (i % 2 ? 1 : -1) * 0.35, len: 6 + (i % 3) * 1.5 }));
  for (const { x0, dx, len } of hairs) for (let t = 0; t <= len; t += 0.25) dot(x0 + dx * t, 89 - t, 125);
  // Crease above the brow, across, not touching it.
  for (let x = 45; x < 155; x++) dot(x, 60 + 2 * Math.sin(x / 12), 140);
  // A frown line running up from the brow's inner end: as thin and dark as a hair, but long.
  for (let t = 0; t <= 40; t += 0.25) dot(150 + t * 0.15, 89 - t, 125);
  const zones: Zone[] = [
    { id: "forehead", cx: 100, cy: 40, rx: 110, ry: 60, angle: 0, lineAngle: 0 },
    ...[60, 100, 140].map((cx): Zone => ({ id: "forehead", cx, cy: 80, rx: 22, ry: 18, angle: 0, lineAngle: 0, tolerance: [35, 65] })),
  ];
  const around = new Float32Array(n).fill(170);
  const hair = strayHairs(lum, around, mask, zones, w, h, 200);

  it("keeps the brow's stray hairs", () => {
    let found = 0,
      total = 0;
    for (const { x0, dx, len } of hairs)
      for (let t = 1; t <= len - 1; t += 1.5) {
        total++;
        if (hair[Math.round(89 - t) * w + Math.round(x0 + dx * t)] > 0.5) found++;
      }
    expect(found / total).toBeGreaterThan(0.85);
  });

  it("still treats a long line running up from the brow", () => {
    let kept = 0;
    for (let t = 4; t <= 36; t += 2) if (hair[Math.round(89 - t) * w + Math.round(150 + t * 0.15)] > 0.5) kept++;
    expect(kept).toBe(0);
  });

  it("still treats the crease above the brow", () => {
    let max = 0;
    for (let x = 50; x < 150; x++) max = Math.max(max, hair[Math.round(60 + 2 * Math.sin(x / 12)) * w + x]);
    expect(max).toBe(0);
  });
});
