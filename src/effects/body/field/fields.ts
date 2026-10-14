// Everything together: the three unit fields (arms, waist & hips, legs) and the build factor.
import { type BodyFields, type BodyInput, FULL, IS_LEFT_ARM, IS_RIGHT_ARM, JOINT, TUNING, blur, clamp, distanceTransform, frame, isArmPart, noseToAnkles, pointsSeen, sstep } from "./common";
import { bodyField, waistRatio } from "./torso";
import { armField, armSwing, frontOfBody } from "./arms";
import { growHands, handShapes, rigidHands } from "./hands";
import { armsBySide, jointsBySide } from "./sides";
import { shoulderShift } from "./shoulders";
import { proportionStrength } from "./proportions";
import { strengthCaps, unfold } from "./guard";

// ---------------------------------------------------------------- everything together

/** The three unit fields (arms, torso = waist & hips, legs) and the build factor. */
export function bodyFields(input: BodyInput): BodyFields {
  const { w, h } = input;
  const n = w * h;
  // facing the camera: each arm is on its own side of the body (BodyPix sometimes calls one hand,
  // wrist or elbow by the other side's name; the arm would then be moved with the other arm)
  const J0 = input.joints;
  const tall = noseToAnkles(J0);
  const facing = tall > 0 && Math.hypot(J0[6] - J0[15], J0[7] - J0[16]) > 0.16 * tall;
  if (facing) input = { ...input, joints: jointsBySide(J0) };
  const F = frame(input);
  const sw = F.sw;
  const P = input.person;
  const m = new Uint8Array(n);
  for (let i = 0; i < n; i++) m[i] = P[i] > 0.5 ? 1 : 0;

  // an arm mostly hidden behind the body (a small visible slice) just moves with the body
  const labels = Uint8Array.from(input.labels);
  if (facing) armsBySide(labels, m, w, h, F);
  growHands(labels, m, input.rgb, w, h, F.J, sw);
  const area = (t: Uint8Array) => {
    let c = 0;
    for (let i = 0; i < n; i++) if (m[i] && t[labels[i]]) c++;
    return c;
  };
  const aL = area(IS_LEFT_ARM), aR = area(IS_RIGHT_ARM), big = Math.max(aL, aR, 1);
  for (const [a, t] of [[aL, IS_LEFT_ARM], [aR, IS_RIGHT_ARM]] as const)
    if (a < 0.3 * big) for (let i = 0; i < n; i++) if (t[labels[i]]) labels[i] = 12;

  const armHard = new Float32Array(n);
  const body = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    armHard[i] = m[i] && isArmPart(labels[i]) ? 1 : 0;
    body[i] = P[i] - armHard[i] > 0.5 ? 1 : 0;
  }
  // Arm pixels in front of the body (a hand in a pocket or on the hip, a forearm across the belly,
  // crossed arms) have body on both sides along their row: they move with the body, else the body
  // slides under them and smears them.
  const front = frontOfBody(armHard, body, w, h, 0.6 * sw, 0.15 * sw);
  for (let i = 0; i < n; i++) if (front[i]) {
    body[i] = 1;
    armHard[i] = 0;
  }
  // build: from the body without the arms (arms beside the waist are not waist)
  const B = TUNING.build;
  const buildK = B.slimmest + (1 - B.slimmest) * sstep(B.ratio[0], B.ratio[1], waistRatio(body, F));
  const torso0 = bodyField(body, F, false, buildK);
  const legs0 = bodyField(body, F, true, buildK);
  const arm = armField(input, labels, F, body);
  const swingT = armSwing(input, labels, body, F, torso0, false, FULL.torso * buildK);
  const torso = bodyField(body, F, false, buildK, swingT.rest);
  const swingL = armSwing(input, labels, body, F, legs0, true, FULL.legs * buildK);
  const legs = bodyField(body, F, true, buildK, swingL.rest);
  // each pixel follows the arm's motion or the body's, softly blended at the arm's edge
  const wa = blur(armHard, w, h, 0.03 * sw + 1);
  for (let i = 0; i < n; i++) wa[i] = Math.min(1, wa[i] * 1.6);

  // round shoulders: the movement eases in over the whole shoulder (none at the top of the shoulder
  // line, full halfway down the upper arm), away from the middle of the chest
  const ramp = new Float32Array(n).fill(1);
  const neckX = F.neck[0];
  for (const [S, E] of [[2, 3], [5, 6]] as const) {
    const tops: number[] = [];
    for (let x = Math.max(0, Math.floor(F.jx(S) - 0.35 * sw)); x < Math.min(w - 1, F.jx(S) + 0.35 * sw); x++)
      for (let y = 0; y < h; y++)
        if (m[y * w + x]) {
          tops.push(y);
          break;
        }
    tops.sort((a, b) => a - b);
    const top = tops.length ? tops[Math.round(0.2 * (tops.length - 1))] : F.jy(S) - 0.15 * sw;
    const y1 = F.jy(S) + 0.5 * Math.max(F.jy(E) - F.jy(S), 0.2 * sw);
    const leftSide = F.jx(S) < neckX;
    for (let y = 0; y < h; y++) {
      const r = sstep(top, y1, y);
      for (let x = 0; x < w; x++) {
        if (leftSide ? x >= neckX : x < neckX) continue;
        const away = sstep(0.15 * sw, 0.35 * sw, Math.abs(x - neckX));
        ramp[y * w + x] = 1 - away * (1 - r);
      }
    }
  }

  // per-area fields inside the person
  const unit = (
    ax: Float32Array | null,
    ay: Float32Array | null,
    bodyDx: Float32Array | null,
    swing: { dx: Float32Array; dy: Float32Array } | null,
  ) => {
    const dx = new Float32Array(n), dy = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const armX = (ax ? ax[i] : 0) + (swing ? swing.dx[i] : 0);
      const armY = (ay ? ay[i] : 0) + (swing ? swing.dy[i] : 0);
      dx[i] = (wa[i] * armX + (1 - wa[i]) * (bodyDx ? bodyDx[i] : 0)) * ramp[i];
      dy[i] = wa[i] * armY * ramp[i];
    }
    return { dx, dy };
  };
  const units = {
    arms: unit(arm.dx, arm.dy, null, null),
    torso: unit(null, null, torso, swingT),
    legs: unit(null, null, legs, swingL),
  };
  shoulderShift(units.arms.dx, m, wa, F);
  // Hands move as a whole (no part of a hand is narrowed, stretched or bent), blending into the wrist.
  const hands = handShapes(labels, m, w, h, sw, F.J, body);
  rigidHands(units.arms, hands, w, h, sw, FULL.arms * buildK, null);
  rigidHands(units.torso, hands, w, h, sw, FULL.torso * buildK, torso);
  rigidHands(units.legs, hands, w, h, sw, FULL.legs * buildK, legs);

  // The background beside the person follows the person's edge movement smoothly and fades out
  // with distance. The fade width is that of the full (100%) movement, so it is the same for every
  // strength (keeps the result linear).
  const M = new Float32Array(n);
  for (let i = 0; i < n; i++) M[i] = m[i];
  const sg = 0.04 * sw + 1, sgy = 0.2 * sw + 1;
  const den = blur(M, w, h, sg, sgy);
  const notM = new Uint8Array(n);
  for (let i = 0; i < n; i++) notM[i] = m[i] ? 0 : 1;
  const dist = distanceTransform(notM, w, h);
  const ext = (f: Float32Array) => {
    const g = new Float32Array(n);
    for (let i = 0; i < n; i++) g[i] = f[i] * M[i];
    const b = blur(g, w, h, sg, sgy);
    for (let i = 0; i < n; i++) b[i] /= den[i] + 1e-4;
    return b;
  };
  const exts = Object.fromEntries(
    Object.entries(units).map(([k, u]) => [k, { ex: ext(u.dx), ey: ext(u.dy) }]),
  ) as Record<keyof typeof units, { ex: Float32Array; ey: Float32Array }>;
  const fullMag = new Float32Array(n);
  const sA = FULL.arms * buildK, sT = FULL.torso * buildK, sL = FULL.legs * buildK;
  for (let i = 0; i < n; i++) {
    const ex = sA * exts.arms.ex[i] + sT * exts.torso.ex[i] + sL * exts.legs.ex[i];
    const ey = sA * exts.arms.ey[i] + sT * exts.torso.ey[i] + sL * exts.legs.ey[i];
    fullMag[i] = Math.hypot(ex, ey);
  }
  const Bmap = blur(fullMag, w, h, sg);
  const edgeBand = Math.max(2, 0.015 * sw);
  const finalBlur = Math.max(0.75, 0.006 * sw);
  const pack = (k: keyof typeof units) => {
    const { dx, dy } = units[k];
    const { ex, ey } = exts[k];
    for (let i = 0; i < n; i++) {
      if (m[i]) continue;
      const B = 2.5 * Bmap[i] + 0.08 * sw;
      let fall = clamp(1 - dist[i] / B, 0, 1);
      fall = fall * fall * (3 - 2 * fall);
      // from the person's own field to the smooth background field over a few pixels at the outline
      const t = clamp(dist[i] / edgeBand, 0, 1);
      dx[i] = (1 - t) * dx[i] + t * ex[i] * fall;
      dy[i] = (1 - t) * dy[i] + t * ey[i] * fall;
    }
    const bx = blur(dx, w, h, finalBlur), by = blur(dy, w, h, finalBlur);
    const out = new Float32Array(2 * n);
    // none at the photo's edges: a movement there would read from outside the photo (streaks)
    const edge = Math.max(2, 0.02 * Math.max(w, h));
    for (let i = 0; i < n; i++) {
      const x = i % w, y = (i / w) | 0;
      const e = sstep(0, edge, Math.min(x, w - 1 - x, y, h - 1 - y));
      out[2 * i] = bx[i] * e;
      out[2 * i + 1] = by[i] * e;
    }
    return out;
  };
  const out = { arms: pack("arms"), torso: pack("torso"), legs: pack("legs") };
  // 100%: the strength that brings the waist to sensible proportions (TUNING.proportion)
  const dbg: Record<string, number> = {};
  const k = proportionStrength(out.torso, body, F, dbg) ?? buildK;
  if (input.debug) Object.assign(input.debug, dbg);
  const kA = FULL.arms * k, kT = FULL.torso * k, kL = FULL.legs * k;
  unfold(out, [kA, kT, kL], w, h, sw);
  const cap = strengthCaps(out, [kA, kT, pointsSeen(F.J, w, h, [JOINT.rKnee, JOINT.lKnee]) ? kL : 0], m, labels, w, h, sw);
  return { w, h, ...out, build: k, labels, cap };
}
