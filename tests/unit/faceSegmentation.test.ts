import { describe, expect, it } from "vitest";
import { faceCropRect, marginFromScores, skinAlpha, type MarginMap } from "../../src/face/segmentation";

const box = (x0: number, y0: number, x1: number, y1: number) =>
  [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x0, y: y1 }, { x: x1, y: y1 }];

/** A uniform margin map. */
const flat = (v: number, size = 8): MarginMap => ({ margin: new Float32Array(size * size).fill(v), width: size, height: size });

describe("face-crop segmentation", () => {
  it("crops a square around the face with room for the hairline", () => {
    const r = faceCropRect(box(0.45, 0.4, 0.55, 0.6), 3840, 2160)!;
    // Face 384 x 432 px: the crop is well under the frame, so the model sees the face larger.
    expect(r.size).toBeLessThan(900);
    expect(r.y).toBeLessThan(0.4 * 2160 - 0.45 * 432 * 0.9); // hairline room above
  });

  it("stays square at the photo's edge (reaching past it) instead of being squashed", () => {
    const r = faceCropRect(box(0.0, 0.0, 0.3, 0.5), 1000, 1000)!;
    expect(r.x).toBeLessThan(0);
    expect(r.y).toBeLessThan(0);
    expect(r.size).toBeGreaterThan(500);
  });

  it("skips the crop when the face fills the photo", () => {
    expect(faceCropRect(box(0.1, 0.1, 0.9, 0.9), 1000, 1000)).toBeNull();
  });

  it("calls a pixel skin exactly where the skin class beats every other class", () => {
    // Skin 0.4 but every other class lower: skin wins (the hard label said skin) -> full alpha.
    const wins = [0.1, 0.2, 0.15, 0.4, 0.1, 0.05].map((v) => new Float32Array([v]));
    expect(marginFromScores(wins, 3, 1, 1).margin[0]).toBeGreaterThan(0);
    const out = skinAlpha({ ...marginFromScores(wins, 3, 1, 1) }, null, 1, 1, new Uint8ClampedArray(4));
    expect(out[3]).toBe(255);
    // Skin 0.45 but hair 0.5: not skin; only a faint fringe.
    const loses = [0.0, 0.5, 0.05, 0.45, 0.0, 0.0].map((v) => new Float32Array([v]));
    const o2 = skinAlpha(marginFromScores(loses, 3, 1, 1), null, 1, 1, new Uint8ClampedArray(4));
    expect(o2[3]).toBeGreaterThan(0);
    expect(o2[3]).toBeLessThan(200);
  });

  it("uses the crop inside, fades to the whole frame at its border, and nothing changes outside", () => {
    const w = 100,
      h = 100;
    const full = flat(-1); // the whole frame: no skin anywhere
    const crop = { map: flat(1), rect: { x: 20, y: 20, size: 50 } }; // the crop: all skin
    const out = skinAlpha(full, crop, w, h, new Uint8ClampedArray(w * h * 4));
    const a = (x: number, y: number) => out[(y * w + x) * 4 + 3];
    expect(a(45, 45)).toBe(255); // centre: the crop
    expect(a(20, 45)).toBeLessThan(30); // crop edge: still the whole frame
    expect(a(10, 45)).toBe(0); // outside
  });
});
