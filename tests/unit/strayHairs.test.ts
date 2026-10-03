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
