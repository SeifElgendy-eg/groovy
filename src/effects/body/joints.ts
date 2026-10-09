// Body points from two detectors (BodyPix and MediaPipe Pose), checked against BodyPix's body parts.
//
// Each detector makes its own mistakes: BodyPix swaps the hips or loses legs it can't see well;
// MediaPipe now and then puts a whole arm or leg in the wrong place with a high visibility (and
// guesses points outside the picture). BodyPix's body-part map is a third opinion: an elbow has to
// lie on that side's arm, a knee on that side's leg. Per limb, the points that agree with the map win.

/** BodyPix part ids, per body point (OpenPose order) that should lie on them. */
const ON: Record<number, readonly number[]> = {
  3: [4, 5, 8, 9], // right elbow: right upper or lower arm
  4: [8, 9, 11], // right wrist: right lower arm or hand
  6: [2, 3, 6, 7],
  7: [6, 7, 10],
  9: [16, 17, 20, 21], // right knee: right upper or lower leg
  10: [20, 21, 23], // right ankle: right lower leg or foot
  12: [14, 15, 18, 19],
  13: [18, 19, 22],
};
/** Hips: a little way towards the knee is that side's thigh. */
const THIGH: Record<number, readonly number[]> = { 8: [16, 17], 11: [14, 15] };
/** Limbs decided together (one detector's points per limb, so a limb is never half of each). */
const LIMBS: readonly (readonly number[])[] = [[3, 4], [6, 7], [9, 10], [12, 13], [8, 11]];
const KNEE: Record<number, number> = { 8: 9, 11: 12 };

/** MediaPipe Pose landmark for each OpenPose body point (-1: the middle of the shoulders). */
export const FROM_MEDIAPIPE = [0, -1, 12, 14, 16, 11, 13, 15, 24, 26, 28, 23, 25, 27, 5, 2, 8, 7] as const;

/**
 * MediaPipe Pose landmarks ([x, y, visibility], x and y 0..1) as body points in OpenPose order at
 * w x h. Points outside the picture get a low score (MediaPipe guesses them with a high visibility).
 */
export function fromMediaPipe(lm: readonly (readonly number[])[], w: number, h: number): Float32Array {
  const J = new Float32Array(18 * 3);
  FROM_MEDIAPIPE.forEach((m, j) => {
    const p = m >= 0 ? lm[m] : [(lm[11][0] + lm[12][0]) / 2, (lm[11][1] + lm[12][1]) / 2, Math.min(lm[11][2], lm[12][2])];
    const inside = p[0] >= 0.01 && p[0] <= 0.99 && p[1] >= 0.01 && p[1] <= 0.98;
    J.set([p[0] * w, p[1] * h, inside ? p[2] : Math.min(p[2], 0.2)], j * 3);
  });
  return J;
}

export interface FuseInput {
  w: number;
  h: number;
  /** Person mask (>0.5) and BodyPix part ids at w x h. */
  person: ArrayLike<number>;
  labels: ArrayLike<number>;
  /** BodyPix's and MediaPipe's body points (OpenPose order, x, y, score) at w x h. */
  bodypix: Float32Array;
  mediapipe: Float32Array;
}

export interface Fused {
  joints: Float32Array;
  /** Per limb (LIMBS order): "mp", "bp" or "-" (kept BodyPix's, neither fits the parts). */
  chosen: string[];
}

/** Body points: per limb MediaPipe's when they lie on the right body parts, else BodyPix's if theirs do. */
export function fuseJoints({ w, h, person, labels, bodypix, mediapipe }: FuseInput): Fused {
  const J = bodypix.slice();
  const sw = Math.max(8, Math.hypot(bodypix[6] - bodypix[15], bodypix[7] - bodypix[16]));
  const r = Math.max(2, Math.round(0.08 * sw));
  const near = (x: number, y: number, ids: readonly number[]) => {
    const cx = Math.round(x), cy = Math.round(y);
    for (let yy = Math.max(0, cy - r); yy <= Math.min(h - 1, cy + r); yy++)
      for (let xx = Math.max(0, cx - r); xx <= Math.min(w - 1, cx + r); xx++) {
        const i = yy * w + xx;
        if (person[i] > 0.5 && ids.includes(labels[i])) return true;
      }
    return false;
  };
  const fits = (S: Float32Array, j: number) => {
    const x = S[j * 3], y = S[j * 3 + 1];
    if (S[j * 3 + 2] < 0.5 || !(x >= 0 && y >= 0 && x < w && y < h)) return false;
    if (ON[j]) return near(x, y, ON[j]);
    const k = KNEE[j];
    return near(x + 0.3 * (S[k * 3] - x), y + 0.3 * (S[k * 3 + 1] - y), THIGH[j]);
  };
  const chosen: string[] = [];
  for (const limb of LIMBS) {
    const mp = limb.every((j) => fits(mediapipe, j)), bp = limb.every((j) => fits(bodypix, j));
    const src = mp ? mediapipe : bp ? bodypix : null;
    chosen.push(mp ? "mp" : bp ? "bp" : "-");
    if (src === mediapipe) for (const j of limb) J.set(mediapipe.subarray(j * 3, j * 3 + 3), j * 3);
  }
  // the shoulders and the head: MediaPipe's when it found the arms of both sides on the right parts
  // (the whole pose is then right), else BodyPix's
  if (chosen[0] === "mp" && chosen[1] === "mp") for (const j of [0, 1, 2, 5, 14, 15, 16, 17]) J.set(mediapipe.subarray(j * 3, j * 3 + 3), j * 3);
  return { joints: J, chosen };
}
