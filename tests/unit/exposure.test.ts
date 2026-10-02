import { describe, expect, it } from "vitest";
import { meterFace } from "../../src/face/exposure";
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



import { isUnusableFrame, meterFrame } from "../../src/face/exposure";

describe("frame safety net", () => {
  it("flags a black frame so exposure can recover when no face is visible", () => {
    const m = meterFrame(frame(64, 64, 2), 64, 64);
    expect(isUnusableFrame(m)).toBe(true);
  });
  it("leaves a normal frame alone", () => {
    expect(isUnusableFrame(meterFrame(frame(64, 64, 120), 64, 64))).toBe(false);
  });
});
