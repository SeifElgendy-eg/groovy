// Body slimming: the helpers it is built on, BodyPix output decoding, and the movement fields'
// basic behaviour on a drawn figure.
import { describe, expect, it } from "vitest";
import { blur, bodyFields, distanceTransform, JOINT_COUNT, jointsBySide, runsOf, sstep } from "../../src/effects/body/field";
import { decodeJoints, decodeParts, inputSide, STRIDE } from "../../src/effects/body/bodypix";

let seed = 11;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

describe("helpers", () => {
  it("distance transform matches brute force", () => {
    const w = 23, h = 17;
    const m = Uint8Array.from({ length: w * h }, () => (rnd() < 0.7 ? 1 : 0));
    const d = distanceTransform(m, w, h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let best = Infinity;
        for (let v = 0; v < h; v++) for (let u = 0; u < w; u++) if (!m[v * w + u]) best = Math.min(best, Math.hypot(u - x, v - y));
        const want = m[y * w + x] ? best : 0;
        expect(d[y * w + x]).toBeCloseTo(want === Infinity ? d[y * w + x] : want, 4);
      }
  });

  it("blur keeps a constant image and the total of an impulse", () => {
    const w = 41, h = 31;
    const c = blur(new Float32Array(w * h).fill(3), w, h, 4, 6);
    for (const v of c) expect(v).toBeCloseTo(3, 4);
    const imp = new Float32Array(w * h);
    imp[15 * w + 20] = 1;
    const b = blur(imp, w, h, 3);
    expect(b.reduce((a, v) => a + v, 0)).toBeCloseTo(1, 4);
    expect(b[15 * w + 20]).toBeGreaterThan(b[15 * w + 25]);
  });

  it("runs bridge small gaps and drop tiny runs", () => {
    const w = 30;
    const m = new Uint8Array(w);
    m.fill(1, 2, 10);
    m.fill(1, 11, 15); // 1-pixel gap: bridged
    m.fill(1, 20, 22); // 2 pixels: dropped
    expect(runsOf(m, w, 0, 2)).toEqual([[2, 15]]);
  });

  it("smoothstep", () => {
    expect(sstep(0, 1, -1)).toBe(0);
    expect(sstep(0, 1, 2)).toBe(1);
    expect(sstep(0, 1, 0.5)).toBeCloseTo(0.5);
  });
});

describe("BodyPix decoding", () => {
  it("input sides are 16k + 1", () => {
    expect(inputSide(640)).toBe(641);
    expect(inputSide(427)).toBe(433);
  });

  it("a keypoint is its most confident node plus the offset", () => {
    const gw = 5, gh = 7, W = 33, H = 49;
    const heat = new Float32Array(gw * gh * 17).fill(-5);
    const offs = new Float32Array(gw * gh * 34);
    for (let k = 0; k < 17; k++) heat[(2 * gw + 3) * 17 + k] = 4; // every keypoint at node (3, 2)
    offs[(2 * gw + 3) * 34 + 5] = 1.5; // left shoulder: y offset
    offs[(2 * gw + 3) * 34 + 5 + 17] = -2; // left shoulder: x offset
    const j = decodeJoints(heat, offs, { gw, gh, W, H }, W * 2, H * 2);
    expect(j.length).toBe(JOINT_COUNT * 3);
    // left shoulder is joint 5 in OpenPose order
    expect(j[5 * 3]).toBeCloseTo((3 * STRIDE - 2) * 2);
    expect(j[5 * 3 + 1]).toBeCloseTo((2 * STRIDE + 1.5) * 2);
    expect(j[5 * 3 + 2]).toBeGreaterThan(0.9);
  });

  it("each pixel gets the part with the highest score, only inside the person", () => {
    const gw = 4, gh = 4, W = 25, H = 25, ww = 10, wh = 10;
    const parts = new Float32Array(gw * gh * 24);
    for (let i = 0; i < gw * gh; i++) parts[i * 24 + (i % gw < 2 ? 12 : 3)] = 5; // left half torso, right half arm
    const person = new Float32Array(ww * wh).fill(1);
    person[0] = 0;
    const lab = decodeParts(parts, { gw, gh, W, H }, ww, wh, person);
    expect(lab[0]).toBe(255);
    expect(lab[5 * ww + 1]).toBe(12);
    expect(lab[5 * ww + 9]).toBe(3);
  });
});

describe("movement fields on a drawn figure", () => {
  // A standing figure: torso, two legs, arms hanging beside the torso with a gap.
  const w = 200, h = 300;
  const person = new Float32Array(w * h);
  const labels = new Uint8Array(w * h).fill(255);
  const fill = (x0: number, y0: number, x1: number, y1: number, part: number) => {
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        person[y * w + x] = 1;
        labels[y * w + x] = part;
      }
  };
  fill(85, 15, 115, 55, 0); // head
  fill(70, 60, 130, 160, 12); // torso
  fill(72, 160, 98, 290, 16); // right leg (image left)
  fill(102, 160, 128, 290, 14); // left leg
  fill(52, 62, 66, 120, 4); // right upper arm
  fill(52, 120, 66, 170, 8); // right forearm
  fill(134, 62, 148, 120, 2); // left upper arm
  fill(134, 120, 148, 170, 6); // left forearm
  const joints = new Float32Array(JOINT_COUNT * 3);
  const set = (j: number, x: number, y: number) => joints.set([x, y, 1], j * 3);
  set(0, 100, 35);
  set(2, 75, 62); set(3, 59, 120); set(4, 59, 170);
  set(5, 125, 62); set(6, 141, 120); set(7, 141, 170);
  set(8, 85, 155); set(9, 85, 220); set(10, 85, 285);
  set(11, 115, 155); set(12, 115, 220); set(13, 115, 285);
  set(1, 100, 62);
  const f = bodyFields({ w, h, person, labels, joints });
  const dx = (field: Float32Array, x: number, y: number) => field[(y * w + x) * 2];

  it("the waist narrows symmetrically toward the centre line", () => {
    // Backward map: an edge pixel samples from further out (dx < 0 on the left edge, > 0 on the right).
    expect(dx(f.torso, 72, 130)).toBeLessThan(-1);
    expect(dx(f.torso, 127, 130)).toBeGreaterThan(1);
    const ratio = -dx(f.torso, 72, 130) / dx(f.torso, 128, 130);
    expect(ratio).toBeGreaterThan(0.95);
    expect(ratio).toBeLessThan(1.05);
    expect(Math.abs(dx(f.torso, 100, 130))).toBeLessThan(0.5);
  });

  it("the legs narrow toward their own middles", () => {
    expect(dx(f.legs, 73, 220)).toBeLessThan(-0.5);
    expect(dx(f.legs, 97, 220)).toBeGreaterThan(0.5);
  });

  it("arms slim toward their middle and are not dragged by the waist (they hang free)", () => {
    expect(dx(f.arms, 53, 95)).toBeLessThan(-0.5);
    expect(dx(f.arms, 65, 95)).toBeGreaterThan(0.5);
    expect(Math.abs(dx(f.torso, 59, 140))).toBeLessThan(0.3);
  });

  it("nothing moves far from the person, the build factor is in range", () => {
    for (const field of [f.arms, f.torso, f.legs]) expect(Math.abs(dx(field, 5, 295))).toBeLessThan(1e-3);
    expect(f.build).toBeGreaterThanOrEqual(0.3);
    expect(f.build).toBeLessThanOrEqual(1);
  });
});

describe("arm joints by side", () => {
  it("mirrors an elbow or wrist BodyPix put on the other side of the body", () => {
    const J = new Float32Array(JOINT_COUNT * 3);
    const set = (i: number, x: number, y: number) => J.set([x, y, 0.9], i * 3);
    set(2, 80, 100); // right shoulder (image left)
    set(5, 120, 100);
    set(3, 70, 150);
    set(4, 130, 200); // right wrist found on the left side
    set(6, 130, 150);
    set(7, 135, 200);
    const out = jointsBySide(J);
    expect(out[4 * 3]).toBeCloseTo(70, 5); // mirrored across the centre (x = 100)
    expect(out[3 * 3]).toBe(70);
    expect(out[7 * 3]).toBe(135);
  });
});
