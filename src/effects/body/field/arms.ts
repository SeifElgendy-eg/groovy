// Arms: which arm hangs, each part narrowing across its own direction, an arm resting on the body
// turning in with it (armSwing), and the part of an arm lying in front of the body.
import { type ArmRest, type BodyInput, type Frame, IS_LEFT_ARM, IS_RIGHT_ARM, TUNING, bbox, blur, blurReach, centreX, clamp, distanceTransform, isArmPart, partTable, percentile, sample, sstep } from "./common";

// ---------------------------------------------------------------- arms

export interface ArmPart {
  ids: number[];
  side: "L" | "R";
  upper: boolean;
}
export const ARM_PARTS: ArmPart[] = [
  { ids: [2, 3], side: "L", upper: true },
  { ids: [6, 7], side: "L", upper: false },
  { ids: [4, 5], side: "R", upper: true },
  { ids: [8, 9], side: "R", upper: false },
];

/**
 * How much an arm hangs down (1) rather than being raised, held out or sharply bent (0), from its
 * body points (side "R": joints 2-4, "L": 5-7). Arms are slimmed by narrowing each part across its
 * own direction, which is reliable on an arm hanging by the body; on a raised arm, an arm bent to
 * the face or hip, or crossed arms (often in baggy sleeves), the parts are mislabelled and
 * narrowing them twists the arm, so those arms are slimmed less, down to not at all.
 */
export function armHanging(J: ArrayLike<number>, side: "L" | "R"): number {
  const [S, E, W] = side === "R" ? [2, 3, 4] : [5, 6, 7];
  const x = (i: number) => J[i * 3], y = (i: number) => J[i * 3 + 1];
  if (J[E * 3 + 2] < 0.3 || J[W * 3 + 2] < 0.3) return 0.5;
  const fromDown = (a: number, b: number) => (Math.atan2(Math.abs(x(b) - x(a)), y(b) - y(a)) * 180) / Math.PI; // 0 = straight down, 180 = up
  const upper = fromDown(S, E), fore = fromDown(E, W);
  const ux = x(E) - x(S), uy = y(E) - y(S), fx = x(W) - x(E), fy = y(W) - y(E);
  const bend = (Math.acos(Math.max(-1, Math.min(1, (ux * fx + uy * fy) / (Math.hypot(ux, uy) * Math.hypot(fx, fy) || 1)))) * 180) / Math.PI;
  const A = TUNING.arms;
  return (1 - sstep(A.tilt[0], A.tilt[1], Math.max(upper, fore))) * (1 - sstep(A.bend[0], A.bend[1], bend));
}

/** Arm slimming at strength 1: each part narrows across its own direction toward its centre line. */
export function armField(input: BodyInput, labels: Uint8Array, F: Frame, body: Uint8Array): { dx: Float32Array; dy: Float32Array } {
  const { w, h, sw } = F;
  const n = w * h;
  // the body beside the arm, softened: an arm's side lying against the body is not narrowed (it
  // stays against it; narrowing it would open a gap there with nothing behind it to show)
  const bodyF = new Float32Array(n);
  for (let i = 0; i < n; i++) bodyF[i] = body[i];
  const near = blur(bodyF, w, h, 0.03 * sw + 1);
  const P = input.person;
  const armMask = new Uint8Array(n);
  for (let i = 0; i < n; i++) armMask[i] = P[i] > 0.5 && isArmPart(labels[i]) ? 1 : 0;
  const dtm = distanceTransform(armMask, w, h);
  const numX = new Float32Array(n), numY = new Float32Array(n), den = new Float32Array(n);
  // torso centre and hand centres (to tell which end of a part is which)
  const centroid = (test: (l: number) => boolean): [number, number] | null => {
    let sx = 0, sy = 0, c = 0;
    for (let i = 0; i < n; i++)
      if (P[i] > 0.5 && test(labels[i])) {
        sx += i % w;
        sy += (i / w) | 0;
        c++;
      }
    return c ? [sx / c, sy / c] : null;
  };
  const minArea = Math.max(30, 0.003 * sw * sw);
  for (const part of ARM_PARTS) {
    const hang = armHanging(F.J, part.side);
    if (hang <= 0) continue;
    const inPart = partTable(part.ids);
    const pm = new Float32Array(n);
    let cnt = 0, mx = 0, my = 0;
    for (let i = 0; i < n; i++)
      if (P[i] > 0.5 && inPart[labels[i]]) {
        pm[i] = 1;
        cnt++;
        mx += i % w;
        my += (i / w) | 0;
      }
    if (cnt < minArea) continue;
    mx /= cnt;
    my /= cnt;
    // principal direction of the part's pixels
    let sxx = 0, syy = 0, sxy = 0;
    for (let i = 0; i < n; i++)
      if (pm[i]) {
        const x = (i % w) - mx, y = ((i / w) | 0) - my;
        sxx += x * x;
        syy += y * y;
        sxy += x * y;
      }
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const ux = Math.cos(ang), uy = Math.sin(ang), nx = -uy, ny = ux;
    const tp = new Float32Array(cnt);
    for (let i = 0, k = 0; i < n; i++) if (pm[i]) tp[k++] = ((i % w) - mx) * ux + (((i / w) | 0) - my) * uy;
    const t0 = percentile(tp, 2), t1 = percentile(tp, 98);
    const len = Math.max(t1 - t0, 1);
    const e0: [number, number] = [mx + t0 * ux, my + t0 * uy], e1: [number, number] = [mx + t1 * ux, my + t1 * uy];
    const dist2 = (p: [number, number], q: [number, number]) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2;
    let flip: boolean; // true: measure "along" from the e1 end
    if (part.upper) {
      const S: [number, number] = part.side === "R" ? [F.jx(2), F.jy(2)] : [F.jx(5), F.jy(5)];
      flip = dist2(e1, S) < dist2(e0, S); // the shoulder end is "along = 0"
    } else {
      const hc = centroid((l) => l === (part.side === "L" ? 10 : 11));
      flip = hc ? dist2(e0, hc) < dist2(e1, hc) : false; // the hand end is "along = 1"
    }
    const sigma = 0.06 * sw + 1;
    const wgt = blur(pm, w, h, sigma);
    // (the blurred part is exactly 0 beyond the blur's reach around the part)
    const box = bbox(pm, w, h)!, reach = blurReach(sigma);
    for (let y = Math.max(0, box[1] - reach); y <= Math.min(h - 1, box[3] + reach); y++)
      for (let x = Math.max(0, box[0] - reach); x <= Math.min(w - 1, box[2] + reach); x++) {
        const i = y * w + x;
        if (wgt[i] < 1e-4) continue;
        const t = (x - mx) * ux + (y - my) * uy;
        if (t < t0 - 0.3 * len || t > t1 + 0.3 * len) continue;
        const v = (x - mx) * nx + (y - my) * ny;
        const tc = clamp(t, t0, t1);
        const r = clamp(sample(dtm, w, h, mx + tc * ux, my + tc * uy), 2, 0.3 * sw);
        let a = (tc - t0) / len;
        if (flip) a = 1 - a;
        const g = part.upper
          ? (0.5 + 0.5 * sstep(0, TUNING.arms.upperFullFrom, a)) * (1 - 0.3 * sstep(0.7, 1, a)) // shoulder cap at half strength
          : TUNING.arms.forearm * (1 - sstep(0.4, 0.95, a)); // forearm, none at the hand
        const av = Math.abs(v);
        const across = av <= r ? v : Math.sign(v) * r * clamp(1 - (av - r) / (0.6 * r), 0, 1);
        const ex = mx + tc * ux + Math.sign(v) * (r + 0.04 * sw) * nx, ey = my + tc * uy + Math.sign(v) * (r + 0.04 * sw) * ny;
        const against = clamp(1.6 * sample(near, w, h, ex, ey) - 0.2, 0, 1);
        const disp = hang * g * across * wgt[i] * (1 - against);
        numX[i] += disp * nx;
        numY[i] += disp * ny;
        den[i] += wgt[i];
      }
  }
  const dx = new Float32Array(n), dy = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (den[i] <= 1e-6) continue;
    const k = Math.min(1, den[i] / 0.2);
    dx[i] = (numX[i] / den[i]) * k;
    dy[i] = (numY[i] / den[i]) * k;
  }
  const sg = 0.01 * sw + 1;
  return { dx: blur(dx, w, h, sg), dy: blur(dy, w, h, sg) };
}

/**
 * An arm resting on the body's side turns in with it, as a rigid arm would: about the shoulder,
 * and a little more about the elbow (two rigid pieces), following the movement that `bodyDx` gives
 * the body's edge where they touch (only where this field moves the body: the torso above the
 * thighs, or the legs below the crotch; a hand by the thigh does not count as resting). Also returns
 * where the arms rest (`rest`, for bodyField).
 */
export function armSwing(
  input: BodyInput,
  labels: Uint8Array,
  body: Uint8Array,
  F: Frame,
  bodyDx: Float32Array,
  legs: boolean,
  full: number,
): { dx: Float32Array; dy: Float32Array; rest: ArmRest } {
  const { w, h, sw } = F;
  // only where this field moves the body: the torso above the thighs, the legs below the crotch
  const tl = F.hip[1] - F.neck[1];
  const thigh = Math.max((F.jy(9) + F.jy(12)) / 2 - F.hip[1], 0.3 * tl);
  const crotch = F.hip[1] + 0.15 * thigh;
  const [yLo, yHi] = legs ? [crotch, h] : [F.neck[1] + 0.3 * tl, crotch + 0.5 * thigh];
  const n = w * h;
  const P = input.person;
  const out = { dx: new Float32Array(n), dy: new Float32Array(n), rest: { v: new Float32Array(2 * h), c: new Float32Array(2 * h), arm: new Float32Array(2 * h) } as ArmRest };
  for (const [side, inArm] of [["L", IS_LEFT_ARM], ["R", IS_RIGHT_ARM]] as const) {
    // only an arm hanging down rests on the body's side and turns in with it
    const hang = armHanging(F.J, side);
    if (hang <= 0) continue;
    const am = new Float32Array(n);
    let cnt = 0, sx = 0, sy = 0, ymin = h, ymax = -1;
    for (let i = 0; i < n; i++)
      if (P[i] > 0.5 && inArm[labels[i]]) {
        am[i] = 1;
        cnt++;
        const y = (i / w) | 0;
        sx += i % w;
        sy += y;
        ymin = Math.min(ymin, y);
        ymax = Math.max(ymax, y);
      }
    if (cnt < Math.max(30, 0.003 * sw * sw)) continue;
    const left = sx / cnt < centreX(F, sy / cnt);
    const rows: { y: number; c: number; edgeDx: number }[] = [];
    for (let y = ymin; y <= ymax; y++) {
      let armMin = w, armMax = -1, bodyMin = w, bodyMax = -1;
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        // the arm's extent without the hand: a hand near the thigh is not the arm resting on the body
        if (am[i] && labels[i] !== 10 && labels[i] !== 11) {
          armMin = Math.min(armMin, x);
          armMax = Math.max(armMax, x);
        }
        if (body[i]) {
          bodyMin = Math.min(bodyMin, x);
          bodyMax = Math.max(bodyMax, x);
        }
      }
      if (armMax < 0 || bodyMax < 0) continue;
      const [gap, edge] = left ? [bodyMin - armMax, bodyMin] : [armMin - bodyMax, bodyMax];
      // touching or just overlapping the body's side: the arm rests on it
      const c = sstep(-0.12 * sw, -0.04 * sw, gap) * (1 - sstep(0.03 * sw, 0.08 * sw, gap));
      if (c > 0.2 && y > yLo && y < yHi) rows.push({ y, c, edgeDx: bodyDx[y * w + edge] });
    }
    if (rows.length < 5) continue;
    // The arm turns about its shoulder by the small angle that best keeps it resting on the body's
    // moved edge (least squares over the contact rows): a rigid turn, so the upper arm, elbow,
    // forearm and hand keep their shape, and no gap opens at the waist that would have to be filled
    // with stretched skin. (A plain sideways shift fits the armpit or the waist, never both.)
    // The forearm may turn a little more about the elbow (two rigid pieces): one turn about the
    // shoulder cannot follow both the chest's small movement at the armpit and the waist's bigger
    // one at the forearm; the forearm would lag the waist, and the skin between would stretch.
    const S = side === "R" ? 2 : 5, E = S + 1;
    const sx0 = F.jx(S), sy0 = F.jy(S);
    const ey0 = Math.max(F.jy(E), sy0 + 0.3 * sw), ex0 = F.jx(E);
    let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0, below = 0;
    for (const r of rows) {
      const t = Math.max(0, r.y - sy0), u = Math.max(0, r.y - ey0);
      a11 += r.c * t * t;
      a12 += r.c * t * u;
      a22 += r.c * u * u;
      b1 += r.c * r.edgeDx * t;
      b2 += r.c * r.edgeDx * u;
      if (u > 0) below++;
    }
    if (a11 <= 0) continue;
    let theta = b1 / a11, theta2 = 0;
    if (below >= 4) {
      const reg = a22 + 0.05 * a11; // keeps the bend at the elbow small
      const det = a11 * reg - a12 * a12;
      if (det > 1e-9 * a11 * reg) {
        theta = (b1 * reg - a12 * b2) / det;
        theta2 = (a11 * b2 - a12 * b1) / det;
      }
    }
    // below the lowest contact the arm is not pushed any further: it moves on with that point
    // (an arm touching only near the armpit is not swung across by its whole length)
    theta *= hang;
    theta2 *= hang;
    const yLow = rows.reduce((m, r) => Math.max(m, r.y), sy0);
    for (const r of rows) {
      const k = (left ? 0 : h) + r.y;
      // only near the end of the contact (the waist above it keeps slimming fully: holding the
      // waist back wherever an arm touches it made the waist slim less than the hips)
      out.rest.c[k] = r.c * sstep(yLow - 0.25 * sw, yLow - 0.05 * sw, r.y);
      out.rest.v[k] = theta * Math.max(0, r.y - sy0) + theta2 * Math.max(0, r.y - ey0);
    }
    // and a little below the lowest contact, fading: the body's movement is smoothed down the body,
    // the waist's bigger movement below would otherwise reach up beside the arm's end of contact
    const last = rows.find((r) => r.y === yLow)!;
    for (let y = yLow + 1; y < Math.min(h, yLow + 0.12 * sw); y++) {
      const k = (left ? 0 : h) + y;
      out.rest.c[k] = Math.max(out.rest.c[k], last.c * (1 - sstep(0, 0.12 * sw, y - yLow)));
      out.rest.v[k] = out.rest.v[(left ? 0 : h) + yLow];
    }
    for (let y = 0; y < h; y++) {
      const yy = Math.min(y, yLow);
      out.rest.arm[(left ? 0 : h) + y] = theta * Math.max(0, yy - sy0) + theta2 * Math.max(0, yy - ey0);
    }
    const sigma = 0.05 * sw + 1;
    const wgt = blur(am, w, h, sigma);
    const at = (x: number, y: number) => Math.min(1, sample(wgt, w, h, x, y) * 3);
    // Only near the arm: the blurred arm is 0 beyond the blur's reach, and the arm moves by at
    // most `full` of its largest turn (at the photo's corners, the furthest from the shoulder).
    const box = bbox(am, w, h)!;
    let maxMove = 0;
    for (const [cx, cy] of [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]]) {
      const yy = Math.min(cy, yLow);
      const rx = Math.abs(theta * Math.max(0, yy - sy0)) + Math.abs(theta2 * Math.max(0, yy - ey0));
      const ry = Math.abs(theta * (cx - sx0)) + Math.abs(theta2 * (cx - ex0));
      maxMove = Math.max(maxMove, full * Math.hypot(rx, ry));
    }
    const reach = blurReach(sigma) + Math.ceil(maxMove) + 2;
    for (let y = Math.max(0, box[1] - reach); y <= Math.min(h - 1, box[3] + reach); y++)
      for (let x = Math.max(0, box[0] - reach); x <= Math.min(w - 1, box[2] + reach); x++) {
        const i = y * w + x;
        // (below it the arm moves as its lowest contact row does: no step where the contact ends)
        const yy = Math.min(y, yLow);
        const rx = theta * Math.max(0, yy - sy0) + theta2 * Math.max(0, yy - ey0);
        const ry =
          -theta * (x - sx0) * sstep(sy0 - 0.1 * sw, sy0 + 0.2 * sw, yy) -
          theta2 * (x - ex0) * sstep(ey0 - 0.1 * sw, ey0 + 0.1 * sw, yy);
        // the field is read where the picture ends up, and the arm moves by up to `full` of it: it
        // applies wherever the arm is on its way (else a hand moved further than the soft edge is
        // torn between moving and staying)
        const k = Math.max(at(x, y), at(x + 0.5 * full * rx, y + 0.5 * full * ry), at(x + full * rx, y + full * ry));
        if (!k) continue;
        out.dx[i] += rx * k;
        out.dy[i] += ry * k;
      }
  }
  return out;
}

/**
 * Arm pixels with body on both sides along their row, each within `reach` (the arm is in front of
 * the body there). Body counts only as a stretch of at least `minRun` pixels, so a few body-labelled
 * pixels along an arm's outer edge do not make a hanging arm "in front".
 */
export function frontOfBody(arm: Float32Array, body: Uint8Array, w: number, h: number, reach: number, minRun: number): Uint8Array {
  const out = new Uint8Array(w * h);
  const solid = new Uint8Array(w);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    solid.fill(0);
    for (let x = 0; x < w; ) {
      if (!body[o + x]) {
        x++;
        continue;
      }
      let e = x;
      while (e < w && body[o + e]) e++;
      if (e - x >= minRun) solid.fill(1, x, e);
      x = e;
    }
    let last = -Infinity; // last solid body pixel to the left
    const leftAt = new Float32Array(w);
    for (let x = 0; x < w; x++) {
      if (solid[x]) last = x;
      leftAt[x] = last;
    }
    let next = Infinity;
    for (let x = w - 1; x >= 0; x--) {
      if (solid[x]) next = x;
      if (arm[o + x] && x - leftAt[x] <= reach && next - x <= reach) out[o + x] = 1;
    }
  }
  return out;
}
