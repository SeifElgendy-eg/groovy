// Left and right: arm joints and arm part labels put on the side of their own shoulder.
import { type Frame, IS_LEFT_ARM, centreX, isArmPart } from "./common";

/** Arm joints (elbows, wrists) on the side of their own shoulder: a joint on the wrong side is mirrored across the body. */
export function jointsBySide(J: Float32Array): Float32Array {
  const out = Float32Array.from(J);
  const cx = (J[2 * 3] + J[5 * 3]) / 2;
  for (const [S, joints] of [
    [2, [3, 4]],
    [5, [6, 7]],
  ] as const) {
    const side = Math.sign(J[S * 3] - cx);
    for (const j of joints) if (Math.sign(J[j * 3] - cx) !== side) out[j * 3] = 2 * cx - J[j * 3];
  }
  return out;
}

export const OTHER_SIDE: Record<number, number> = { 2: 4, 3: 5, 6: 8, 7: 9, 10: 11, 4: 2, 5: 3, 8: 6, 9: 7, 11: 10 };

/**
 * Give every arm pixel the arm parts of the side it is on (left or right of the body's centre
 * line): the side's majority decides which BodyPix arm (left or right) that is.
 */
export function armsBySide(labels: Uint8Array, m: Uint8Array, w: number, h: number, F: Frame): void {
  const votes = [0, 0]; // image-left side: pixels labelled as BodyPix's left arm, as its right arm
  for (let y = 0; y < h; y++) {
    const xc = centreX(F, y);
    for (let x = 0; x < w; x++) {
      const i = y * w + x, l = labels[i];
      if (!m[i] || !isArmPart(l) || x >= xc) continue;
      votes[IS_LEFT_ARM[l] ? 0 : 1]++;
    }
  }
  const leftIsLeftArm = votes[0] >= votes[1];
  for (let y = 0; y < h; y++) {
    const xc = centreX(F, y);
    for (let x = 0; x < w; x++) {
      const i = y * w + x, l = labels[i];
      if (!m[i] || !isArmPart(l)) continue;
      const wantLeftArm = x < xc === leftIsLeftArm;
      if (!!IS_LEFT_ARM[l] !== wantLeftArm) labels[i] = OTHER_SIDE[l];
    }
  }
}
