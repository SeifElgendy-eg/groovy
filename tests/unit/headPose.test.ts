import { describe, expect, it } from "vitest";
import { INITIAL_ALIGNMENT, POSE_LIMITS, evaluateAlignment, headPose } from "../../src/face/alignment";

/** Column-major 4x4 of a rotation about one axis (x: pitch, y: yaw, z: roll), in degrees. */
function rot(axis: "x" | "y" | "z", deg: number): number[] {
  const a = (deg * Math.PI) / 180,
    c = Math.cos(a),
    s = Math.sin(a);
  const R =
    axis === "x" ? [[1, 0, 0], [0, c, -s], [0, s, c]] : axis === "y" ? [[c, 0, s], [0, 1, 0], [-s, 0, c]] : [[c, -s, 0], [s, c, 0], [0, 0, 1]];
  const m = new Array(16).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[j * 4 + i] = R[i][j];
  m[15] = 1;
  return m;
}

function face() {
  const pts = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5 }));
  pts[234] = { x: 0.35, y: 0.48 };
  pts[454] = { x: 0.65, y: 0.48 };
  pts[10] = { x: 0.5, y: 0.2 };
  pts[152] = { x: 0.5, y: 0.76 };
  pts[1] = { x: 0.5, y: 0.5 };
  pts[33] = { x: 0.43, y: 0.45 };
  pts[263] = { x: 0.57, y: 0.45 };
  return pts;
}

describe("head pose", () => {
  it("reads yaw, pitch and roll from the transformation matrix", () => {
    expect(headPose(rot("y", 20)).yaw).toBeCloseTo(20, 5);
    expect(headPose(rot("x", -15)).pitch).toBeCloseTo(15, 5); // rotating about x by -15 tips the face's forward axis up
    expect(headPose(rot("z", 10)).roll).toBeCloseTo(10, 5);
    const p = headPose(rot("y", 0));
    expect(Math.abs(p.yaw) + Math.abs(p.pitch) + Math.abs(p.roll)).toBeLessThan(1e-9);
  });

  it("guides the head straight before allowing a capture", () => {
    const at = (pose: { yaw: number; pitch: number; roll: number }) => evaluateAlignment(face(), INITIAL_ALIGNMENT, pose).label;
    expect(at({ yaw: POSE_LIMITS.yaw + 3, pitch: -5, roll: 0 })).toBe("Turn your face to the camera");
    expect(at({ yaw: 0, pitch: POSE_LIMITS.pitchUp + 3, roll: 0 })).toBe("Lower your chin a little");
    expect(at({ yaw: 0, pitch: POSE_LIMITS.pitchDown - 3, roll: 0 })).toBe("Raise your chin a little");
    expect(at({ yaw: 0, pitch: -5, roll: POSE_LIMITS.roll + 3 })).toBe("Keep your head level");
    // A frontal photo reads slightly chin-down: that is fine.
    expect(evaluateAlignment(face(), INITIAL_ALIGNMENT, { yaw: 1, pitch: -9, roll: -1 }).valid).toBe(true);
  });
});
