import { describe, expect, it } from "vitest";
import { faceCropRect, mergeCrop, probToAlpha } from "../../src/face/segmentation";

const box = (x0: number, y0: number, x1: number, y1: number) =>
  [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x0, y: y1 }, { x: x1, y: y1 }];

describe("face-crop segmentation", () => {
  it("crops a square around the face with room for the hairline, inside the image", () => {
    const r = faceCropRect(box(0.45, 0.4, 0.55, 0.6), 3840, 2160)!;
    expect(Math.abs(r.w - r.h)).toBeLessThanOrEqual(1);
    // Face 384 x 432 px: the crop is well under the frame, so the model sees the face larger.
    expect(r.w).toBeLessThan(900);
    expect(r.y).toBeLessThan(0.4 * 2160 - 0.45 * 432 * 0.9); // hairline room above
    const edge = faceCropRect(box(0.0, 0.0, 0.3, 0.5), 1000, 1000)!;
    expect(edge.x).toBe(0);
    expect(edge.y).toBe(0);
  });

  it("skips the crop when the face fills the photo", () => {
    expect(faceCropRect(box(0.1, 0.1, 0.9, 0.9), 1000, 1000)).toBeNull();
  });

  it("uses the crop inside and fades to the whole-frame result at its border", () => {
    const w = 100, h = 100;
    const full = new Float32Array(w * h).fill(0);
    const rect = { x: 20, y: 20, w: 50, h: 50 };
    mergeCrop(full, w, h, new Float32Array(50 * 50).fill(1), rect);
    expect(full[45 * w + 45]).toBeCloseTo(1, 5); // centre: the crop
    expect(full[45 * w + 20]).toBeLessThan(0.1); // crop edge: still the whole frame
    expect(full[45 * w + 10]).toBe(0); // outside: untouched
  });

  it("turns probability into a soft edge around the old 'skin wins' boundary", () => {
    const a = probToAlpha(new Float32Array([0, 0.3, 0.5, 0.7, 1]), new Uint8ClampedArray(20));
    expect([a[3], a[7], a[11], a[15], a[19]]).toEqual([0, 0, 128, 255, 255]);
  });
});
