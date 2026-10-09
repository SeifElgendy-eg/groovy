// Empty backdrop for body shaping: the person cover and the backdrop's colour match.
import { describe, expect, it } from "vitest";
import { backdropGain, MAX_MISMATCH, personCover } from "../../src/effects/body/backdrop";

let seed = 7;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

describe("person cover", () => {
  it("grows the person a little and stays 0..1", () => {
    const w = 40, h = 30;
    const data = new Float32Array(w * h);
    for (let y = 10; y < 20; y++) for (let x = 15; x < 25; x++) data[y * w + x] = 1;
    const c = personCover({ data, w, h }, 3, 1);
    expect(c.data[15 * w + 20]).toBeCloseTo(1, 3); // inside
    expect(c.data[15 * w + 13]).toBeGreaterThan(0.9); // 2 px outside: covered
    expect(c.data[15 * w + 5]).toBe(0); // far away
    for (const v of c.data) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe("backdrop gain", () => {
  const w = 48, h = 32;
  const scene = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    scene[i * 4] = 60 + 120 * rnd();
    scene[i * 4 + 1] = 40 + 100 * rnd();
    scene[i * 4 + 2] = 30 + 90 * rnd();
    scene[i * 4 + 3] = 255;
  }
  const cover = new Float32Array(w * h);
  for (let y = 4; y < 28; y++) for (let x = 18; x < 30; x++) cover[y * w + x] = 1; // the person

  it("finds the exposure difference and matches the same scene", () => {
    const plate = new Uint8ClampedArray(scene.length);
    for (let i = 0; i < scene.length; i += 4) {
      plate[i] = scene[i] / 1.1;
      plate[i + 1] = scene[i + 1] / 1.1;
      plate[i + 2] = scene[i + 2] / 1.1;
      plate[i + 3] = 255;
    }
    const g = backdropGain(scene, plate, w, h, cover);
    expect(g.data[(5 * w + 5) * 3]).toBeCloseTo(1.1, 1);
    expect(g.mismatch).toBeLessThan(MAX_MISMATCH);
  });

  it("rejects a different scene (camera moved)", () => {
    const plate = new Uint8ClampedArray(scene.length);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        for (let c = 0; c < 4; c++) plate[(y * w + x) * 4 + c] = scene[(y * w + Math.min(w - 1, x + 3)) * 4 + c];
    expect(backdropGain(scene, plate, w, h, cover).mismatch).toBeGreaterThan(MAX_MISMATCH);
  });
});
