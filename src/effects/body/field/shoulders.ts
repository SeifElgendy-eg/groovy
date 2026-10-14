// Shoulders: the arm field also shifts the shoulders and arms inward, fading out toward the chest.
import { FULL, type Frame, JOINT, TUNING, sstep } from "./common";

/**
 * Narrower shoulders (TUNING.shoulders), added to the arms' unit field `dx` inside the person `m`
 * (`armW`: how much each pixel is arm, 0..1, soft at the arm's edge):
 * each side's shoulder and arm move in toward the neck. (A backward map: the left side reads from
 * further left, dx < 0, so it shows what was further out.)
 */
export function shoulderShift(dx: Float32Array, m: Uint8Array, armW: Float32Array, F: Frame): void {
  const T = TUNING.shoulders, { w, h, sw } = F;
  const neckX = F.neck[0];
  // (unit field: at the full arms strength this is `shift` x sw)
  const amount = (T.shift * sw) / FULL.arms;
  for (const [S, W] of [[JOINT.rShoulder, JOINT.rWrist], [JOINT.lShoulder, JOINT.lWrist]] as const) {
    if (F.J[S * 3 + 2] < 0.3) continue;
    const sx = F.jx(S), sy = F.jy(S);
    const wy = F.J[W * 3 + 2] >= 0.3 ? Math.max(F.jy(W), sy + 0.5 * sw) : sy + 1.2 * sw;
    const out = Math.sign(sx - neckX) || 1; // the side's outward direction
    const top = sy - T.above * sw;
    const armpit = sy + T.armpit * sw, chestEnd = sy + T.chestEnd * sw;
    for (let y = Math.max(0, Math.floor(top)); y < Math.min(h, Math.ceil(wy)); y++) {
      const v = y < sy ? sstep(top, sy, y) : 1 - sstep(sy, wy, y);
      if (v <= 0) continue;
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!m[i] || Math.sign(x - neckX) !== out) continue;
        // The side of the chest comes in with the shoulder and arm, easing out down to the bottom of
        // the chest (the waist has its own slimming); a cut at the armpits would leave the chest
        // under the arm sticking out past the narrower shoulders, with a crease where the cut is.
        // (blended softly across the arm's edge by `armW`, the arm's weight: no seam where it meets the body)
        const side = armW[i] + (1 - armW[i]) * (1 - sstep(armpit, chestEnd, y));
        const g = sstep(T.from[0] * sw, T.from[1] * sw, Math.abs(x - neckX));
        if (g > 0 && side > 0) dx[i] += out * amount * g * v * side;
      }
    }
  }
}
