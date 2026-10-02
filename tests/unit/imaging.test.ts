import { describe, expect, it } from "vitest";
import { distanceToOutside, insetSkinMask } from "../../src/imaging/maskOps";
import { transformOuterLip } from "../../src/effects/lips/geometry";
import { metaOf, SERVICES } from "../../src/effects/registry";

function squareMask(n: number, from: number, to: number) {
  const m = new Uint8ClampedArray(n * n * 4);
  for (let y = from; y < to; y++)
    for (let x = from; x < to; x++) m[(y * n + x) * 4 + 3] = 255;
  return m;
}

describe("distanceToOutside", () => {
  it("is 0 outside and grows by 1 per pixel inward", () => {
    const n = 11;
    const d = distanceToOutside(squareMask(n, 2, 9), n, n, 128);
    expect(d[0]).toBe(0);
    expect(d[2 * n + 2]).toBe(1); // first inside pixel touches the outside
    expect(d[5 * n + 5]).toBe(4); // centre of a 7x7 square
  });

  it("treats the image border as outside", () => {
    const n = 5;
    const full = new Uint8ClampedArray(n * n * 4).fill(255);
    expect(distanceToOutside(full, n, n, 128)[0]).toBe(0);
    expect(distanceToOutside(full, n, n, 128)[2 * n + 2]).toBe(2); // centre of 5x5
  });
});

describe("insetSkinMask", () => {
  it("shrinks and feathers the mask without growing it", () => {
    const n = 40;
    const m = squareMask(n, 5, 35);
    const out = insetSkinMask(m, n, n, 3);
    expect(out[(20 * n + 20) * 4 + 3]).toBe(255); // deep inside stays solid
    expect(out[(5 * n + 20) * 4 + 3]).toBe(0); // edge pixel removed
    expect(out[(2 * n + 2) * 4 + 3]).toBe(0); // outside stays outside
  });
});

describe("transformOuterLip", () => {
  // A flat mouth in landmark order: 0 = left corner, 10 = right corner, 1..9 upper lip going
  // right, 11..19 lower lip coming back left.
  const outer = Array.from({ length: 20 }, (_, i) => {
    if (i <= 10) return { x: 100 + i * 10, y: 100 - 8 * Math.sin((Math.PI * i) / 10) };
    const k = i - 10;
    return { x: 200 - k * 10, y: 100 + 8 * Math.sin((Math.PI * k) / 10) };
  });
  const inner = outer.map((p) => ({ x: p.x, y: 100 + (p.y - 100) * 0.4 }));

  it("keeps the mouth corners fixed and enlarges the lips", () => {
    const out = transformOuterLip(outer, inner, 0.4, 0.8);
    expect(out[0]).toEqual(outer[0]);
    expect(out[10]).toEqual(outer[10]);
    const gap = (pts: typeof outer) => Math.abs(pts[5].y - pts[15].y);
    expect(gap(out)).toBeGreaterThan(gap(outer));
  });

  it("is a no-op shape-wise at zero amount", () => {
    const out = transformOuterLip(outer, inner, 0, 0.8);
    out.forEach((p, i) => {
      expect(p.x).toBeCloseTo(outer[i].x, 6);
      expect(p.y).toBeCloseTo(outer[i].y, 6);
    });
  });
});

describe("service registry", () => {
  it("has a record for every service and the home screen", () => {
    expect(Object.keys(SERVICES).sort()).toEqual(["acne", "lips", "skin", "wrinkles"]);
    expect(metaOf("home").id).toBe("home");
    for (const [id, meta] of Object.entries(SERVICES)) expect(meta.id).toBe(id);
  });
});
