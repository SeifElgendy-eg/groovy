// Torso and legs: the build (waist width for the height), the natural waist, and the field that
// narrows each row toward the body's centre line or each leg's middle.
import { type ArmRest, FULL, type Frame, TUNING, anklesSeen, blur, centreX, clamp, mainRun, noseToAnkles, runGap, runsOf, sstep } from "./common";

// ---------------------------------------------------------------- build

/** Waist width (without the arms) relative to body height: ~0.2 slim, ~0.28 average, 0.36+ heavy. */
export function waistRatio(m: Uint8Array, F: Frame): number {
  const tl = F.hip[1] - F.neck[1];
  const ws: number[] = [];
  for (let i = 0; i < 12; i++) {
    const y = Math.round(F.neck[1] + 0.55 * tl + ((0.1 * tl + 0.45 * tl) * i) / 11);
    if (y < 0 || y >= F.h) continue;
    const rs = runsOf(m, F.w, y, runGap(F.sw));
    if (!rs.length) continue;
    // the body's extent near the centre line (a hand or forearm on the hip splits the row; the
    // pieces beside it are still waist)
    const xc = centreX(F, y);
    let a = Infinity, b = -Infinity;
    for (const r of rs)
      if (r[1] > xc - 0.9 * F.sw && r[0] < xc + 0.9 * F.sw) {
        a = Math.min(a, r[0]);
        b = Math.max(b, r[1]);
      }
    if (isFinite(a)) ws.push(b - a);
  }
  const H = noseToAnkles(F.J);
  if (!ws.length || H <= 0) return 0.35;
  ws.sort((a, b) => a - b);
  const mid = ws.length >> 1;
  const median = ws.length % 2 ? ws[mid] : (ws[mid - 1] + ws[mid]) / 2;
  return median / H;
}

// ---------------------------------------------------------------- torso and legs

/**
 * The natural waist: the narrowest row of the body (without the arms) between the bust and the hips
 * (0.3 to 0.75 of shoulders to hip joints; BodyPix's hip points sit low, so the waist is usually near
 * 0.45), widths smoothed over a few rows.
 */
export function waistY(m: Uint8Array, F: Frame): number {
  const tl = F.hip[1] - F.neck[1];
  const y0 = Math.max(0, Math.round(F.neck[1] + 0.3 * tl)), y1 = Math.min(F.h - 1, Math.round(F.neck[1] + 0.75 * tl));
  const ws: number[] = [];
  for (let y = y0; y <= y1; y++) {
    const rs = runsOf(m, F.w, y, runGap(F.sw));
    if (!rs.length) {
      ws.push(Infinity);
      continue;
    }
    const r = mainRun(rs, centreX(F, y));
    ws.push(r[1] - r[0]);
  }
  const k = Math.max(1, Math.round(0.03 * tl));
  let best = F.neck[1] + 0.45 * tl, bw = Infinity;
  for (let i = 0; i < ws.length; i++) {
    let sum = 0, c = 0;
    for (let j = Math.max(0, i - k); j <= Math.min(ws.length - 1, i + k); j++) if (isFinite(ws[j])) (sum += ws[j]), c++;
    // ties go to the lower row (a straight torso: the waist is lower, not under the bust)
    if (c && sum / c <= bw) {
      bw = sum / c;
      best = y0 + i;
    }
  }
  return best;
}

/**
 * Horizontal movement of the body without the arms (`m`), at strength 1 of the torso (`legs` false)
 * or of the legs (`legs` true). `rest`: where arms rest on the body's sides (from armSwing). The
 * background fall-off widths are those of 100% (fixed, so the field is linear in the strength).
 */
export function bodyField(m: Uint8Array, F: Frame, legs: boolean, buildK: number, rest?: ArmRest): Float32Array {
  const { w, h, sw, jy } = F;
  const T = TUNING.torso, Lg = TUNING.legs;
  const dx = new Float32Array(w * h);
  const tl = F.hip[1] - F.neck[1];
  const kneeY = (jy(9) + jy(12)) / 2;
  const thigh = Math.max(kneeY - F.hip[1], 0.3 * tl);
  const calves = anklesSeen(F.J, w, h);
  const ankY = calves ? (jy(10) + jy(13)) / 2 : kneeY + thigh;
  const crotch = F.hip[1] + 0.15 * thigh;
  // Strength down the torso: a little over the chest, the same over the whole bust (a strength
  // that grows down across the bust pulls its lower curve in more than its upper one and makes it
  // pointed), then growing below the bust to full at the waist. From the waist down it is full and
  // even: the waist, hips and thighs slim by the same fraction, so the waist-to-hip ratio stays (a
  // waist slimmed less than the hips below it turns an hourglass into a box).
  const waist = waistY(m, F);
  const gt = (y: number) =>
    y >= F.neck[1] + T.chestFrom * tl
      ? T.chest +
        (1 - T.chest) *
          sstep(Math.max(waist - T.fullFrom * tl, F.neck[1] + T.fullFromMin * tl), Math.max(waist - T.fullAt * tl, F.neck[1] + T.fullAtMin * tl), y)
      : T.chest * sstep(F.neck[1], F.neck[1] + T.chestFrom * tl, y);
  // Strength down the legs: full on the upper thighs, easing to 0.55 at the knee (the thigh tapers
  // into the knee as it does on a slimmer leg, and the knee keeps its shape: slimming the thigh
  // fully down to the knee would leave a wide, knobbly knee), 0.55 on the calves, none at the
  // ankles. Without the ankles in the picture, only the thighs and knees.
  // The rows are narrowed across, which suits legs that stand roughly upright: a thigh or shin
  // tilted far from vertical (crouching, a knee raised, a long stride) is slimmed less, and not at
  // all past 45 degrees (narrowing it across would smear it).
  const tilt = (a: number, b: number) =>
    (Math.atan2(Math.abs(F.jx(b) - F.jx(a)), Math.max(1e-3, F.jy(b) - F.jy(a))) * 180) / Math.PI;
  const legTilt = Math.max(tilt(8, 9), tilt(11, 12), calves ? Math.max(tilt(9, 10), tilt(12, 13)) : 0);
  const upright = 1 - sstep(Lg.tilt[0], Lg.tilt[1], legTilt);
  const gl = (y: number) =>
    upright *
    (1 - Lg.kneeEase * sstep(crotch + Lg.kneeEaseFrom * thigh, kneeY, y)) *
    (calves ? 1 - sstep(ankY - Lg.ankleFade * thigh, ankY, y) : 1 - sstep(kneeY, kneeY + Lg.ankleFade * thigh, y));
  const nomT = FULL.torso * buildK, nomL = FULL.legs * buildK; // 100% strengths, for the fall-off widths

  // Pass 1, per row: the runs this field narrows, each with its centre and strength, and the movement
  // of the body's two outer edges.
  interface Run {
    a: number;
    b: number;
    c: number;
    g: number;
  }
  const rowsOf: (Run[] | null)[] = new Array(h).fill(null);
  const eL = new Float32Array(h), eR = new Float32Array(h), has = new Uint8Array(h);
  // How far each outer edge may move in (unit field): the background between the body and an arm
  // or hand beside it stretches over the gap between them; squeezed into a narrow gap it would fold
  // over itself. At 100% the edge moves by at most 0.6 of the stretch's width (the stretch is at
  // most 0.8 of the gap, below).
  const capL = new Float32Array(h).fill(Infinity), capR = new Float32Array(h).fill(Infinity);
  // Where an arm's contact with the side ends (a forearm against the waist, at a shirt's hem), the
  // body's edge comes in no further than the arm does: a straight arm cannot follow the waist's
  // curve, and the gap that would open between them there has nothing behind it to show (it would
  // be filled with stretched skin ending in a notch). The arm hides that bit of the waist anyway.
  const keep = (e: number, k: number) => {
    const c = rest ? rest.c[k] : 0;
    if (!c || !e) return e;
    const v = rest!.v[k];
    const target = Math.sign(v) === Math.sign(e) && Math.abs(e) > Math.abs(v) ? v : e;
    return e + c * (target - e);
  };
  for (let y = Math.max(0, Math.floor(F.neck[1])); y < h; y++) {
    const rs = runsOf(m, w, y, runGap(sw));
    if (!rs.length) continue;
    const xc = centreX(F, y);
    const beta = sstep(crotch, crotch + 0.5 * thigh, y);
    const runs: Run[] = [];
    if (!legs && y < crotch + 0.5 * thigh) {
      let a: number, b: number;
      const main = mainRun(rs, xc);
      if (y < crotch) [a, b] = main;
      else {
        a = Infinity;
        b = -Infinity;
        for (const r of rs) {
          if (r[1] > F.hip[0] - 1.2 * sw) a = Math.min(a, r[0]);
          if (r[0] < F.hip[0] + 1.2 * sw) b = Math.max(b, r[1]);
        }
        if (!isFinite(a) || !isFinite(b)) [a, b] = main;
      }
      let gapL = Infinity, gapR = Infinity;
      for (const q of rs) {
        if (q[1] <= a) gapL = Math.min(gapL, a - q[1]);
        if (q[0] >= b) gapR = Math.min(gapR, q[0] - b);
      }
      capL[y] = (T.gapUse * gapL) / nomT;
      capR[y] = (T.gapUse * gapR) / nomT;
      // not standing upright (a knee raised, crouching): the hips and whatever is beside them (a
      // raised thigh) are left as they are, only the waist slims
      const hipsK = 1 - (1 - upright) * sstep(waist, F.hip[1], y);
      runs.push({ a, b, c: xc, g: gt(y) * (1 - beta) * hipsK });
    }
    if (legs && y >= crotch) {
      const g = beta * gl(y);
      // At the top of the thighs the legs narrow toward the body's centre line, as the hips above
      // do (so the outer hips come in as much as the waist; narrowing each thigh toward its own
      // middle there would leave the hips wide); lower down each leg narrows toward its own middle.
      // (A hand next to the thigh is not in this mask: hands are arm parts.)
      const own = sstep(crotch + 0.1 * thigh, crotch + 0.8 * thigh, y);
      for (const r of rs) {
        const c = (r[0] + r[1]) / 2;
        if (r[1] - r[0] < 0.08 * sw) continue;
        runs.push({ a: r[0], b: r[1], c: c + Lg.hipsBlend * (1 - own) * (F.hip[0] - c), g });
      }
    }
    if (!runs.length) continue;
    rowsOf[y] = runs;
    const first = runs[0], last = runs[runs.length - 1];
    // the body (or a coat, a shawl) carries on past the photo's edge: there is no edge to bring in
    // (pulling it in would show the mirrored picture past the border as a smeared strip). The mask
    // fades a few pixels short of the border.
    const border = Math.max(3, 0.03 * w);
    if (first.a <= border) capL[y] = 0;
    if (last.b >= w - 1 - border) capR[y] = 0;
    const capped = (e: number, cap: number) => Math.sign(e) * Math.min(Math.abs(e), cap);
    eL[y] = capped(keep(first.g * (first.a - first.c), y), capL[y]);
    eR[y] = capped(keep(last.g * (last.b - last.c), h + y), capR[y]);
    has[y] = 1;
  }
  // The outer edges' movement, smoothed down the body: where the edge seen in the photo jumps (a
  // cardigan's or a shirt's hem, a hand or forearm hiding part of a coat), the movement would jump
  // with it and leave a step or a notch in the outline. A body slims smoothly from row to row.
  const smoothEdge = (e: Float32Array) => {
    const out = Float32Array.from(e);
    const s = Math.max(1, T.edgeSmooth * sw), r = Math.ceil(2.5 * s);
    for (let y = 0; y < h; y++) {
      if (!has[y]) continue;
      let num = 0, den = 0;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) {
        if (!has[k]) continue;
        const wt = Math.exp(-0.5 * ((k - y) / s) ** 2);
        num += wt * e[k];
        den += wt;
      }
      out[y] = num / den;
    }
    return out;
  };
  // (and capped again: smoothing must not push an edge back into a narrow gap)
  const sL = smoothEdge(eL), sR = smoothEdge(eR);
  for (let y = 0; y < h; y++) {
    sL[y] = Math.sign(sL[y]) * Math.min(Math.abs(sL[y]), capL[y]);
    sR[y] = Math.sign(sR[y]) * Math.min(Math.abs(sR[y]), capR[y]);
  }

  // Pass 2: each run narrows toward its centre; the outer halves of the outermost runs are scaled
  // to give the smoothed edge movement.
  const row = new Float32Array(w);
  const falloff = (edge: number, outward: 1 | -1, amt: number, B: number) => {
    for (let x = 0; x < w; x++) {
      const dist = (x - edge) * outward;
      if (dist > 0 && dist < B) row[x] += amt * (1 - dist / B);
    }
  };
  for (let y = 0; y < h; y++) {
    const runs = rowsOf[y];
    if (!runs) continue;
    row.fill(0);
    const rs = runsOf(m, w, y, runGap(sw));
    const nom = legs ? nomL : nomT;
    runs.forEach((r, i) => {
      const e0L = r.g * (r.a - r.c), e0R = r.g * (r.b - r.c);
      const kL = i === 0 && e0L ? sL[y] / e0L : 1, kR = i === runs.length - 1 && e0R ? sR[y] / e0R : 1;
      for (let x = Math.max(0, Math.ceil(r.a)); x < Math.min(w, r.b + (legs ? 0 : 1)); x++) {
        const left = x < r.c, k = left ? kL : kR;
        const t = clamp(((x - r.c) / ((left ? r.a : r.b) - r.c || 1) - 0.5) / 0.5, 0, 1);
        row[x] += r.g * (x - r.c) * (1 + (k - 1) * t);
      }
      const EL = e0L * kL, ER = e0R * kR;
      if (legs) {
        falloff(r.a, -1, EL, 2.5 * nom * Math.abs(EL) + 0.06 * sw);
        falloff(r.b, 1, ER, 2.5 * nom * Math.abs(ER) + 0.06 * sw);
      } else {
        // the background beside the body stretches into the gap, stopping short of an arm or hand there
        let gapL = 1e9, gapR = 1e9;
        for (const q of rs) {
          if (q[1] <= r.a) gapL = Math.min(gapL, r.a - q[1]);
          if (q[0] >= r.b) gapR = Math.min(gapR, q[0] - r.b);
        }
        falloff(r.a, -1, EL, Math.max(1, Math.min(2.5 * Math.abs(nom * EL) + 0.08 * sw, 0.8 * gapL)));
        falloff(r.b, 1, ER, Math.max(1, Math.min(2.5 * Math.abs(nom * ER) + 0.08 * sw, 0.8 * gapR)));
        // arms and hands beside the body hang from the shoulders: they stay where they are
        for (const q of rs) if (q[1] <= r.a || q[0] >= r.b) row.fill(0, q[0], q[1]);
      }
    });
    dx.set(row, y * w);
  }
  return blur(dx, w, h, 0.015 * sw + 1, 0.06 * sw);
}
