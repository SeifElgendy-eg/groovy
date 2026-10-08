// Posture check for body shaping: is the person standing so the slimming works best? Pure
// functions on BodyPix body points (OpenPose order, see field.ts JOINT), unit-tested.
//
// The best pose (measured on a set of full-body photos; the cleanest, strongest results all had
// it): facing the camera, arms hanging 17-20 degrees out (shoulder point to wrist point) with a gap
// of about half a shoulder width between the hands and the hips, feet hip-width apart (0.7-1x the
// hip joints' distance), the whole body filling most of the frame's height. The limits below keep
// people close to that while staying easy to meet. Arms at the sides, hands on the hips or in pockets hide
// the waist and make the arms and the body move into each other; feet together merge the legs.
//
// All the measures are relative to the body itself (its height and shoulder width), not to the
// frame, so they work in a landscape or a portrait camera alike.

import { jointsBySide } from "./field";

/** Body points used here (OpenPose order). */
const NOSE = 0, R_SH = 2, R_EL = 3, R_WR = 4, L_SH = 5, L_EL = 6, L_WR = 7;
const R_HIP = 8, R_KNEE = 9, R_ANK = 10, L_HIP = 11, L_KNEE = 12, L_ANK = 13;

export type PostureIssue =
  | "notVisible"
  | "stepBack"
  | "closer"
  | "centre"
  | "faceCamera"
  | "level"
  | "armsDown"
  | "armsOut"
  | "armsLower"
  | "armsIn"
  | "feetApart"
  | "feetCloser";

export interface PostureResult {
  /** No issue: a good pose for the slimming. */
  ok: boolean;
  /** The first thing to fix (most important first), or null. */
  issue: PostureIssue | null;
  /** What to tell the person. */
  message: string;
}

export const POSTURE_MESSAGES: Record<PostureIssue, string> = {
  notVisible: "Make sure your whole body is in view, from head to feet.",
  stepBack: "Step back: keep your head and feet inside the frame.",
  closer: "Come a little closer to the camera.",
  centre: "Move to the centre of the outline.",
  faceCamera: "Turn to face the camera straight on.",
  level: "Stand up straight with your shoulders level.",
  armsDown: "Let your arms hang down: hands off your hips and out of your pockets.",
  armsOut: "Move your arms a little away from your body: a hand's width between your hands and hips.",
  armsLower: "Lower your arms and let them hang by your sides.",
  armsIn: "Bring your arms a little closer to your body, like the outline.",
  feetApart: "Place your feet a little apart, about hip-width.",
  feetCloser: "Bring your feet a little closer, about hip-width apart.",
};

export const POSTURE_OK = "Great pose. Hold still…";

/** Limits of the pose, relative to the body (see the file comment). */
export const POSTURE = {
  minScore: 0.4,
  /** Shoulder width / body height (nose to ankles) below this: turned sideways. */
  minShoulderRatio: 0.16,
  /** Shoulder height difference / shoulder width above this: leaning. */
  maxTilt: 0.25,
  /** Body height (nose to ankles) / frame height below this: too far, the body would be small (camera only). */
  minHeightRatio: 0.6,
  /** Hip-centre offset from the frame centre / frame width above this (camera only). */
  maxOffCentre: 0.1,
  /** Gap between wrist and hip, sideways, in shoulder widths: at least this (best ~0.55-0.7). */
  minHandGap: 0.48,
  /** Arm angle from vertical (shoulder to wrist), degrees: at least / at most (best 17-20). */
  minArmAngle: 12,
  maxArmAngle: 30,
  /** Wrist height relative to the hips, in body heights: hands this far above the hips are on the hips or in pockets. */
  maxWristAboveHip: 0.06,
  /** Ankle distance / hip distance: at least / at most (best 0.7-1). */
  minFeet: 0.6,
  maxFeet: 1.6,
} as const;

const result = (issue: PostureIssue | null): PostureResult => ({
  ok: issue === null,
  issue,
  message: issue ? POSTURE_MESSAGES[issue] : POSTURE_OK,
});

/**
 * Check the pose from body points `J` (18 x [x, y, score], pixels of a w x h image). `live`: the
 * camera view (also checks the distance and that the person is centred).
 */
export function checkPosture(J0: ArrayLike<number>, w: number, h: number, live: boolean): PostureResult {
  if (J0.length < 54) return result("notVisible");
  let J: ArrayLike<number> = J0;
  const x = (i: number) => J[i * 3], y = (i: number) => J[i * 3 + 1], s = (i: number) => J[i * 3 + 2];
  const needed = [NOSE, R_SH, L_SH, R_HIP, L_HIP, R_KNEE, L_KNEE, R_ANK, L_ANK];
  if (needed.some((i) => !(s(i) >= POSTURE.minScore) || !Number.isFinite(x(i) + y(i)))) return result("notVisible");

  const ankY = (y(R_ANK) + y(L_ANK)) / 2;
  const H = ankY - y(NOSE); // nose to ankles: ~0.87 of the full height
  if (H <= 0) return result("notVisible");
  // the top of the head is ~0.12 H above the nose, the soles ~0.04 H below the ankles
  if (y(NOSE) - 0.12 * H < 0 || ankY + 0.04 * H > h) return result("stepBack");
  if (live && H < POSTURE.minHeightRatio * h) return result("closer");
  const hipX = (x(R_HIP) + x(L_HIP)) / 2, hipY = (y(R_HIP) + y(L_HIP)) / 2;
  if (live && Math.abs(hipX - w / 2) > POSTURE.maxOffCentre * w) return result("centre");

  const sw = Math.hypot(x(R_SH) - x(L_SH), y(R_SH) - y(L_SH));
  if (sw < POSTURE.minShoulderRatio * H) return result("faceCamera");
  if (Math.abs(y(R_SH) - y(L_SH)) > POSTURE.maxTilt * sw) return result("level");
  // facing the camera: an elbow or wrist BodyPix put on the other side belongs to this side
  J = jointsBySide(Float32Array.from(J0));

  // arms: hanging down (both checked first), then slightly out with a gap between hands and hips
  const armAngle = (S: number, W: number) => (Math.atan2(Math.abs(x(W) - x(S)), y(W) - y(S)) * 180) / Math.PI;
  const arms = [
    [R_SH, R_EL, R_WR, R_HIP],
    [L_SH, L_EL, L_WR, L_HIP],
  ] as const;
  for (const [S, E, W] of arms) {
    if (s(W) < POSTURE.minScore || s(E) < POSTURE.minScore) return result("notVisible");
    if (y(W) < y(S) || armAngle(S, W) > 60) return result("armsLower"); // raised
    if (armAngle(S, W) > POSTURE.maxArmAngle) return result("armsIn"); // held out wide
    if (y(W) < hipY - POSTURE.maxWristAboveHip * H) return result("armsDown");
  }
  for (const [S, , W, Hp] of arms) {
    const angle = armAngle(S, W);
    const gap = (Math.abs(x(W) - hipX) - Math.abs(x(Hp) - hipX)) / sw;
    if (angle < POSTURE.minArmAngle || gap < POSTURE.minHandGap) return result("armsOut");
  }

  const hipW = Math.max(1, Math.abs(x(R_HIP) - x(L_HIP)));
  const feet = Math.abs(x(R_ANK) - x(L_ANK)) / hipW;
  if (feet < POSTURE.minFeet) return result("feetApart");
  if (feet > POSTURE.maxFeet) return result("feetCloser");
  return result(null);
}

/** Body points watched for stillness: nose, shoulders, wrists, hips, ankles. */
const WATCH = [NOSE, R_SH, L_SH, R_WR, L_WR, R_HIP, L_HIP, R_ANK, L_ANK];

/**
 * How long the person has held still (the watched body points moved less than `tolerance` body
 * heights between checks). A gap of more than `maxGapMs` between checks starts over.
 */
export class Stillness {
  private since: number | null = null;
  private last: number[] | null = null;
  private lastT = 0;
  private readonly tolerance: number;
  private readonly maxGapMs: number;

  constructor(tolerance = 0.03, maxGapMs = 1500) {
    this.tolerance = tolerance;
    this.maxGapMs = maxGapMs;
  }

  reset(): void {
    this.since = null;
    this.last = null;
  }

  /** Feed the latest body points (taken at time `t`, ms); returns the milliseconds held still. */
  update(J: ArrayLike<number>, t: number): number {
    const H = (J[R_ANK * 3 + 1] + J[L_ANK * 3 + 1]) / 2 - J[NOSE * 3 + 1];
    const pts = WATCH.flatMap((i) => [J[i * 3], J[i * 3 + 1]]);
    const moved =
      !this.last ||
      t - this.lastT > this.maxGapMs ||
      !(H > 0) ||
      pts.some((v, k) => Math.abs(v - this.last![k]) > this.tolerance * H);
    this.last = pts;
    this.lastT = t;
    if (moved || this.since === null) this.since = t;
    return t - this.since;
  }
}

/** Legs are slimmed only when both knees and ankles are clearly in the picture. */
export function legsVisible(J: ArrayLike<number>, w: number, h: number): boolean {
  return [R_KNEE, R_ANK, L_KNEE, L_ANK].every((i) => {
    const px = J[i * 3], py = J[i * 3 + 1];
    return J[i * 3 + 2] >= 0.5 && px >= 0.01 * w && px <= 0.99 * w && py >= 0.01 * h && py <= 0.98 * h;
  });
}
