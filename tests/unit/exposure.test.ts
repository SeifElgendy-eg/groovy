import { describe, expect, it } from "vitest";
import { meterFace, nextExposure, nextOffset } from "../../src/face/exposure";
import { LM } from "../../src/core/landmarks";

function face(): { x: number; y: number }[] {
  const pts = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5 }));
  pts[LM.faceLeft] = { x: 0.3, y: 0.5 };
  pts[LM.faceRight] = { x: 0.7, y: 0.5 };
  pts[LM.foreheadTop] = { x: 0.5, y: 0.2 };
  pts[LM.chin] = { x: 0.5, y: 0.8 };
  return pts;
}

function frame(w: number, h: number, value: number): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4).fill(value);
  for (let i = 3; i < d.length; i += 4) d[i] = 255;
  return d;
}

describe("meterFace", () => {
  it("reads the face luma and clipping", () => {
    const m = meterFace(frame(100, 100, 255), 100, 100, face(), false)!;
    expect(m.mean).toBeCloseTo(255, 0);
    expect(m.clipped).toBe(1);
    const dark = meterFace(frame(100, 100, 100), 100, 100, face(), false)!;
    expect(dark.mean).toBeCloseTo(100, 0);
    expect(dark.clipped).toBe(0);
  });
  it("only samples the face box, not the background", () => {
    const d = frame(100, 100, 250); // bright background
    for (let y = 20; y < 80; y++)
      for (let x = 30; x < 70; x++) d.fill(110, (y * 100 + x) * 4, (y * 100 + x) * 4 + 3);
    expect(meterFace(d, 100, 100, face(), false)!.mean).toBeCloseTo(110, 0);
  });
});

describe("nextExposure", () => {
  const range = { min: 1, max: 333 };
  it("steps down firmly when highlights clip", () => {
    expect(nextExposure(100, { mean: 200, clipped: 0.2, crushed: 0 }, range)).toBe(75);
  });
  it("brightens a dark face, damped and bounded", () => {
    const next = nextExposure(100, { mean: 40, clipped: 0, crushed: 0 }, range)!;
    expect(next).toBeGreaterThan(100);
    expect(next).toBeLessThanOrEqual(150);
  });
  it("holds inside the dead band", () => {
    expect(nextExposure(100, { mean: 118, clipped: 0, crushed: 0 }, range)).toBeNull();
  });
  it("respects the range", () => {
    expect(nextExposure(300, { mean: 30, clipped: 0, crushed: 0 }, range)).toBe(333);
    expect(nextExposure(333, { mean: 30, clipped: 0, crushed: 0 }, range)).toBeNull();
  });
});

describe("nextOffset", () => {
  const range = { min: -64, max: 64, step: 1 };
  it("lowers brightness on clipping and raises it when dark", () => {
    expect(nextOffset(0, { mean: 200, clipped: 0.5, crushed: 0 }, range)).toBeLessThan(0);
    expect(nextOffset(0, { mean: 50, clipped: 0, crushed: 0 }, range)).toBeGreaterThan(0);
    expect(nextOffset(0, { mean: 125, clipped: 0, crushed: 0 }, range)).toBeNull();
  });
});
