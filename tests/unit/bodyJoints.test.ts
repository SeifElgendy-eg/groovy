import { describe, expect, it } from "vitest";
import { fromMediaPipe, fuseJoints } from "../../src/effects/body/joints";

// a 100 x 100 picture: the right arm (parts 4/8/11) on the left half, the left arm (2/6/10) on the right
const w = 100, h = 100;
const person = new Float32Array(w * h).fill(1);
const labels = new Uint8Array(w * h).fill(12);
for (let y = 40; y < 70; y++)
  for (let x = 0; x < w; x++) labels[y * w + x] = x < 50 ? (y < 55 ? 4 : 11) : y < 55 ? 2 : 10;
const pts = (p: Record<number, [number, number]>) => {
  const J = new Float32Array(18 * 3);
  for (const [j, [x, y]] of Object.entries(p)) J.set([x, y, 0.9], +j * 3);
  return J;
};
const shoulders = { 2: [40, 30], 5: [60, 30] } as Record<number, [number, number]>;

describe("fuseJoints", () => {
  it("takes MediaPipe's arm when it lies on that side's arm, BodyPix's when only BodyPix's does", () => {
    const bodypix = pts({ ...shoulders, 3: [20, 45], 4: [20, 62], 6: [52, 45], 7: [52, 20] });
    const mediapipe = pts({ ...shoulders, 3: [25, 46], 4: [25, 63], 6: [80, 20], 7: [80, 25] });
    const f = fuseJoints({ w, h, person, labels, bodypix, mediapipe });
    expect(f.chosen.slice(0, 2)).toEqual(["mp", "-"]);
    expect(Array.from(f.joints.subarray(9, 11))).toEqual([25, 46]);
    expect(Array.from(f.joints.subarray(18, 20))).toEqual([52, 45]); // kept BodyPix's
  });
  it("gives MediaPipe's points outside the picture a low score", () => {
    const lm = Array.from({ length: 33 }, () => [0.5, 0.5, 0.95]);
    lm[28] = [0.5, 1.1, 0.95];
    const J = fromMediaPipe(lm, w, h);
    expect(J[10 * 3 + 2]).toBeLessThan(0.3);
    expect(J[9 * 3 + 2]).toBeCloseTo(0.95);
  });
});
