// Body slimming: the helpers it is built on, BodyPix output decoding, and the movement fields'
// basic behaviour on a drawn figure.
import { describe, expect, it } from "vitest";
import { armHanging, blur, bodyFields, distanceTransform, FULL, growHands, handShapes, JOINT_COUNT, jointsBySide, rigidHands, runsOf, sstep, unfold } from "../../src/effects/body/field";
import { addArms, decodeJoints, decodeParts, inputSide, STRIDE } from "../../src/effects/body/bodypix";

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
    // (within 10%: the arms 4 px from the torso squeeze the gap, and the fold smoothing there
    // differs a little between the sides of this drawn figure)
    expect(ratio).toBeGreaterThan(0.9);
    expect(ratio).toBeLessThan(1.1);
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

describe("a body cut off by the photo's edge", () => {
  it("keeps the side that runs off the photo where it is, and slims the other", () => {
    // a figure whose coat (torso) carries on past the right edge of the photo
    const w = 160, h = 300;
    const person = new Float32Array(w * h);
    const labels = new Uint8Array(w * h).fill(255);
    const fill = (x0: number, y0: number, x1: number, y1: number, part: number) => {
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          person[y * w + x] = 1;
          labels[y * w + x] = part;
        }
    };
    fill(85, 15, 115, 55, 0);
    fill(70, 60, w, 160, 12);
    fill(72, 160, 98, 290, 16);
    fill(102, 160, 128, 290, 14);
    fill(52, 62, 66, 170, 4);
    const joints = new Float32Array(JOINT_COUNT * 3);
    const set = (j: number, x: number, y: number) => joints.set([x, y, 1], j * 3);
    set(0, 100, 35); set(1, 100, 62);
    set(2, 75, 62); set(3, 59, 120); set(4, 59, 170);
    set(5, 125, 62); set(6, 141, 120); set(7, 141, 170);
    set(8, 85, 155); set(9, 85, 220); set(10, 85, 285);
    set(11, 115, 155); set(12, 115, 220); set(13, 115, 285);
    const f = bodyFields({ w, h, person, labels, joints });
    const dx = (x: number, y: number) => f.torso[(y * w + x) * 2];
    expect(dx(71, 130)).toBeLessThan(-1);
    // (without this, 21 here; the coat inside still narrows a little toward the body, and the
    // smoothing carries a trace of it to the border: under half a pixel at 100%)
    for (const x of [w - 1, w - 2]) expect(Math.abs(dx(x, 130) * FULL.torso)).toBeLessThan(0.5);
  });
});

describe("waist and hips", () => {
  it("slims the waist by at least the fraction of the hips (the hourglass stays)", () => {
    const w = 200, h = 320;
    const person = new Float32Array(w * h);
    const labels = new Uint8Array(w * h).fill(255);
    const row = (y: number, x0: number, x1: number, part: number) => {
      for (let x = Math.round(x0); x < Math.round(x1); x++) {
        person[y * w + x] = 1;
        labels[y * w + x] = part;
      }
    };
    for (let y = 15; y < 55; y++) row(y, 85, 115, 0); // head
    // torso: chest 30 half-width, waist 20 at y=110, hips 32 at y=160
    const half = (y: number) => (y < 110 ? 30 - (10 * (y - 60)) / 50 : 20 + (12 * (y - 110)) / 50);
    for (let y = 60; y < 170; y++) row(y, 100 - half(y), 100 + half(y), 12);
    for (let y = 170; y < 300; y++) {
      row(y, 70, 98, 16);
      row(y, 102, 130, 14);
    }
    const joints = new Float32Array(JOINT_COUNT * 3);
    const set = (j: number, x: number, y: number) => joints.set([x, y, 1], j * 3);
    set(0, 100, 35); set(1, 100, 62);
    set(2, 72, 62); set(3, 50, 120); set(4, 45, 170);
    set(5, 128, 62); set(6, 150, 120); set(7, 155, 170);
    set(8, 85, 165); set(9, 85, 230); set(10, 85, 295);
    set(11, 115, 165); set(12, 115, 230); set(13, 115, 295);
    const f = bodyFields({ w, h, person, labels, joints });
    const frac = (y: number) => f.torso[(y * w + Math.round(100 + half(y)) - 1) * 2] / half(y);
    expect(frac(110)).toBeGreaterThan(0.05);
    expect(frac(110)).toBeGreaterThanOrEqual(0.9 * frac(160));
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

describe("whole hands", () => {
  it("gives fingers lying on the thigh the hand's part, not the leggings around them", () => {
    const w = 60, h = 80, sw = 40;
    const m = new Uint8Array(w * h).fill(1);
    const labels = new Uint8Array(w * h).fill(16); // a thigh
    const rgb = new Uint8ClampedArray(w * h * 3).fill(20); // dark leggings
    const skin = (x: number, y: number) => rgb.set([200, 150, 120], (y * w + x) * 3);
    for (let y = 20; y < 30; y++) for (let x = 25; x < 35; x++) { labels[y * w + x] = 11; skin(x, y); } // the palm
    for (let y = 30; y < 40; y++) for (let x = 27; x < 33; x++) skin(x, y); // the fingers, labelled thigh
    const J = new Float32Array(JOINT_COUNT * 3);
    J.set([30, 2, 0.9], 3 * 3); // elbow above
    J.set([30, 18, 0.9], 4 * 3); // wrist
    J.set([-100, -100, 0.9], 7 * 3); // the other wrist, far away
    growHands(labels, m, rgb, w, h, J, sw);
    expect(labels[35 * w + 30]).toBe(11); // a finger
    expect(labels[35 * w + 24]).toBe(16); // leggings beside the fingers
    expect(labels[10 * w + 30]).toBe(16); // above the wrist: not the hand
    expect(labels[60 * w + 30]).toBe(16); // far below: not the hand
  });
});

describe("arms the segmenter missed", () => {
  it("takes BodyPix's person value for sure arm and hand pixels only", () => {
    const person = Float32Array.from([0.1, 0.1, 0.1, 0.9, 0.1]);
    const bp = Float32Array.from([0.9, 0.9, 0.5, 0.9, 0.9]);
    const parts = Uint8Array.from([6, 12, 8, 6, 11]); // forearm, torso, forearm (unsure), forearm (already in), hand
    expect(addArms(person, bp, parts)).toBe(2);
    expect(Array.from(person).map((v) => +v.toFixed(2))).toEqual([0.9, 0.1, 0.1, 0.9, 0.9]);
  });
});

describe("fold removal", () => {
  const w = 60, h = 40, n = w * h;
  const field = (fn: (x: number) => number) => {
    const f = new Float32Array(2 * n);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) f[2 * (y * w + x)] = fn(x);
    return f;
  };
  const zero = () => new Float32Array(2 * n);

  it("smooths a movement that would fold the picture until (almost) nothing folds", () => {
    const f = { arms: zero(), torso: field((x) => (x >= 30 && x < 34 ? 6 : 0)), legs: zero() }; // a sharp jump: folds
    expect(unfold(f, [1, 1, 1], w, h, 40)).toBeGreaterThan(0);
    expect(unfold(f, [1, 1, 1], w, h, 40)).toBeLessThanOrEqual(4);
  });

  it("leaves a strong stretch that does not fold alone", () => {
    // the picture magnified 4x over 16 pixels (slope -0.75): strong, but no fold
    const torso = field((x) => (x < 20 ? 0 : x < 36 ? -0.75 * (x - 20) : -12));
    const before = torso.slice();
    expect(unfold({ arms: zero(), torso, legs: zero() }, [1, 1, 1], w, h, 40)).toBe(0);
    expect(torso).toEqual(before);
  });

  it("finds a fold that shows only with some areas switched off", () => {
    // the waist alone folds; the legs undo it when all three are on (the app turns the legs off
    // when the knees are not in the photo, and the sliders mix the areas freely)
    const torso = field((x) => (x >= 30 && x < 34 ? 6 : 0));
    const legs = field((x) => (x >= 30 && x < 34 ? -6 : 0));
    expect(unfold({ arms: zero(), torso, legs }, [1, 1, 1], w, h, 40)).toBeGreaterThan(0);
  });
});

describe("hands move as one piece", () => {
  // a forearm (rows 10-24) ending in a hand (rows 25-32) at x 17-23; wrist point at (20, 24)
  const w = 40, h = 40, n = w * h, sw = 40;
  const setup = (bodyAround: boolean) => {
    const m = new Uint8Array(n), labels = new Uint8Array(n).fill(255), body = new Uint8Array(n);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (x >= 17 && x <= 23 && y >= 10 && y <= 32) {
          m[i] = 1;
          labels[i] = y <= 24 ? 8 : 11;
        } else if (bodyAround && y >= 22) {
          m[i] = body[i] = 1;
          labels[i] = 16;
        }
      }
    const J = new Float32Array(JOINT_COUNT * 3);
    J.set([20, 2, 1], 3 * 3);
    J.set([20, 24, 1], 4 * 3);
    J.set([-200, -200, 1], 7 * 3);
    return { m, labels, body, J };
  };
  const at = (f: Float32Array, x: number, y: number) => f[y * w + x];

  it("goes where its wrist goes", () => {
    const { m, labels, J } = setup(false);
    const f = { dx: new Float32Array(n), dy: new Float32Array(n) };
    for (let i = 0; i < n; i++) f.dx[i] = labels[i] === 8 ? 2 : labels[i] === 11 ? 5 : 0;
    rigidHands(f, handShapes(labels, m, w, h, sw, J, null), w, h, sw, 1, null);
    expect(at(f.dx, 20, 29)).toBeCloseTo(2, 3);
    expect(at(f.dx, 18, 31)).toBeCloseTo(2, 3);
  });

  it("rests on the body and goes with it while its arm stays", () => {
    const { m, labels, body, J } = setup(true);
    const f = { dx: new Float32Array(n), dy: new Float32Array(n) };
    const bodyDx = new Float32Array(n);
    for (let i = 0; i < n; i++) bodyDx[i] = body[i] ? -3 : 0;
    f.dx.set(bodyDx);
    rigidHands(f, handShapes(labels, m, w, h, sw, J, body), w, h, sw, 1, bodyDx);
    expect(at(f.dx, 20, 29)).toBeCloseTo(-3, 1);
  });

  it("goes with its arm when the arm moves, even on the body", () => {
    const { m, labels, body, J } = setup(true);
    const f = { dx: new Float32Array(n), dy: new Float32Array(n) };
    const bodyDx = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      bodyDx[i] = body[i] ? -3 : 0;
      f.dx[i] = labels[i] === 8 ? 4 : bodyDx[i];
    }
    rigidHands(f, handShapes(labels, m, w, h, sw, J, body), w, h, sw, 1, bodyDx);
    expect(at(f.dx, 20, 29)).toBeCloseTo(4, 1);
  });
});

describe("arms that rest on the body", () => {
  const figure = (gap: number) => {
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
    fill(85, 15, 115, 55, 0);
    fill(70, 60, 130, 160, 12);
    fill(72, 160, 98, 290, 16);
    fill(102, 160, 128, 290, 14);
    // arms hanging straight down beside the torso, `gap` pixels from it
    fill(56 - gap, 62, 70 - gap, 120, 4);
    fill(56 - gap, 120, 70 - gap, 170, 8);
    fill(130 + gap, 62, 144 + gap, 120, 2);
    fill(130 + gap, 120, 144 + gap, 170, 6);
    const joints = new Float32Array(JOINT_COUNT * 3);
    const set = (j: number, x: number, y: number) => joints.set([x, y, 1], j * 3);
    set(0, 100, 35); set(1, 100, 62);
    set(2, 72, 62); set(3, 63 - gap, 120); set(4, 63 - gap, 170);
    set(5, 128, 62); set(6, 137 + gap, 120); set(7, 137 + gap, 170);
    set(8, 85, 155); set(9, 85, 220); set(10, 85, 285);
    set(11, 115, 155); set(12, 115, 220); set(13, 115, 285);
    return { w, f: bodyFields({ w, h, person, labels, joints }) };
  };

  it("an arm against the waist turns in with it; a free arm stays", () => {
    const touching = figure(0), free = figure(10);
    const dxAt = (r: { w: number; f: { torso: Float32Array } }, x: number, y: number) => r.f.torso[(y * r.w + x) * 2];
    // image-left forearm: the waist's edge next to it moves in (dx < 0 there), and so does the arm
    expect(dxAt(touching, 63, 150)).toBeLessThan(-1);
    expect(Math.abs(dxAt(free, 53, 150))).toBeLessThan(0.3);
  });

  it("only arms hanging down count as hanging", () => {
    const J = new Float32Array(JOINT_COUNT * 3);
    J.set([72, 62, 1], 2 * 3);
    J.set([63, 120, 1], 3 * 3);
    J.set([63, 170, 1], 4 * 3);
    expect(armHanging(J, "R")).toBeCloseTo(1, 3);
    J.set([110, 90, 1], 4 * 3); // forearm bent up across the body
    expect(armHanging(J, "R")).toBe(0);
  });
});
