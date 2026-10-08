// Body shaping posture check: the coaching rules on hand-made body points, in landscape and
// portrait frames, plus the stillness timer, the legs-visible test and arms in front of the body.
import { describe, expect, it } from "vitest";
import { checkPosture, legsVisible, Stillness } from "../../src/effects/body/posture";
import { frontOfBody } from "../../src/effects/body/field";

/** Body points (OpenPose order) of a person standing in the given pose, in a w x h frame. */
function person(
  w: number,
  h: number,
  opts: { height?: number; cx?: number; armDeg?: number; wristUp?: number; feet?: number; turn?: number } = {},
): number[] {
  const H = (opts.height ?? 0.8) * h; // nose to ankles
  const cx = opts.cx ?? w / 2;
  const top = (h - H) / 2 + 0.05 * H;
  const turn = opts.turn ?? 1; // 1 facing the camera, ~0.4 side-on
  const sw = 0.25 * H * turn, hw = 0.16 * H * turn;
  const shY = top + 0.12 * H, hipY = top + 0.47 * H, kneeY = top + 0.73 * H, ankY = top + H;
  const arm = 0.36 * H;
  const a = ((opts.armDeg ?? 18) * Math.PI) / 180;
  const feet = (opts.feet ?? 0.9) * hw;
  const J: number[][] = [];
  J[0] = [cx, top];
  J[1] = [cx, shY];
  const side = (sx: number, i: number) => {
    const s = [cx + sx * sw / 2, shY];
    const wr = [s[0] + sx * Math.sin(a) * arm, s[1] + Math.cos(a) * arm - (opts.wristUp ?? 0) * H];
    J[i] = s;
    J[i + 1] = [(s[0] + wr[0]) / 2, (s[1] + wr[1]) / 2];
    J[i + 2] = wr;
  };
  side(-1, 2); // right side of the body (image left)
  side(1, 5);
  for (const [sx, i] of [
    [-1, 8],
    [1, 11],
  ] as const) {
    J[i] = [cx + (sx * hw) / 2, hipY];
    J[i + 1] = [cx + (sx * (hw + feet)) / 4, kneeY];
    J[i + 2] = [cx + (sx * feet) / 2, ankY];
  }
  for (let i = 14; i < 18; i++) J[i] = [cx + (i % 2 ? 1 : -1) * 0.03 * H, top - 0.02 * H];
  return J.flatMap((p) => [p[0], p[1], 0.95]);
}

const L = [3840, 2160] as const, P = [2160, 3840] as const;

describe("posture check", () => {
  it("accepts the recommended pose in a landscape and a portrait frame", () => {
    for (const [w, h] of [L, P]) {
      const r = checkPosture(person(w, h), w, h, true);
      expect(r.issue).toBeNull();
      expect(r.ok).toBe(true);
    }
  });

  it("asks for a gap when the arms hang against the body", () => {
    expect(checkPosture(person(...L, { armDeg: 2 }), ...L, true).issue).toBe("armsOut");
  });

  it("asks to bring arms held out wide closer, and to lower raised arms", () => {
    expect(checkPosture(person(...L, { armDeg: 40 }), ...L, true).issue).toBe("armsIn");
    expect(checkPosture(person(...L, { armDeg: 75 }), ...L, true).issue).toBe("armsLower");
  });

  it("catches hands on the hips or in pockets", () => {
    expect(checkPosture(person(...L, { armDeg: 20, wristUp: 0.12 }), ...L, true).issue).toBe("armsDown");
  });

  it("asks to face the camera when turned sideways", () => {
    expect(checkPosture(person(...L, { turn: 0.45 }), ...L, true).issue).toBe("faceCamera");
  });

  it("checks the feet", () => {
    expect(checkPosture(person(...L, { feet: 0.2 }), ...L, true).issue).toBe("feetApart");
    expect(checkPosture(person(...L, { feet: 2 }), ...L, true).issue).toBe("feetCloser");
  });

  it("asks to step back when the head or feet are cut off", () => {
    expect(checkPosture(person(...L, { height: 1.0 }), ...L, true).issue).toBe("stepBack");
  });

  it("checks distance and centring only on the live camera", () => {
    const far = person(...L, { height: 0.5 });
    expect(checkPosture(far, ...L, true).issue).toBe("closer");
    expect(checkPosture(far, ...L, false).ok).toBe(true);
    const aside = person(...L, { cx: 0.65 * L[0] });
    expect(checkPosture(aside, ...L, true).issue).toBe("centre");
    expect(checkPosture(aside, ...L, false).ok).toBe(true);
  });

  it("needs the body points to be seen", () => {
    const J = person(...L);
    J[13 * 3 + 2] = 0.1; // an ankle unsure
    expect(checkPosture(J, ...L, true).issue).toBe("notVisible");
    expect(checkPosture([], ...L, true).issue).toBe("notVisible");
  });
});

describe("stillness", () => {
  it("counts the time held still and restarts on movement or a long gap", () => {
    const s = new Stillness(0.03, 1500);
    const J = person(...L);
    expect(s.update(J, 0)).toBe(0);
    expect(s.update(J, 300)).toBe(300);
    expect(s.update(J, 600)).toBe(600);
    const moved = J.slice();
    moved[7 * 3] += 0.1 * L[1]; // a wrist moved a lot
    expect(s.update(moved, 900)).toBe(0);
    expect(s.update(moved, 1200)).toBe(300);
    expect(s.update(moved, 5000)).toBe(0); // long gap
  });
});

describe("legs visible", () => {
  it("needs both knees and ankles inside the picture", () => {
    const J = person(...L);
    expect(legsVisible(J, ...L)).toBe(true);
    const cut = J.slice();
    cut[10 * 3 + 1] = 0.995 * L[1];
    expect(legsVisible(cut, ...L)).toBe(false);
    const unsure = J.slice();
    unsure[12 * 3 + 2] = 0.3;
    expect(legsVisible(unsure, ...L)).toBe(false);
  });
});

describe("arms in front of the body", () => {
  it("marks arm pixels with solid body on both sides, not an arm beside the body", () => {
    const w = 40, h = 1;
    const body = new Uint8Array(w), arm = new Float32Array(w);
    body.fill(1, 10, 30); // the body
    arm.fill(1, 18, 22); // a hand in front of it
    body.fill(0, 18, 22);
    arm.fill(1, 3, 8); // an arm hanging beside it
    body[2] = 1; // a stray body pixel at that arm's outer edge
    const f = frontOfBody(arm, body, w, h, 12, 3);
    expect([...f.slice(18, 22)]).toEqual([1, 1, 1, 1]);
    expect([...f.slice(3, 8)]).toEqual([0, 0, 0, 0, 0]);
  });
});
