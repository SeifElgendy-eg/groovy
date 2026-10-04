// Body slimming: where each pixel of the photo moves. Pure functions (no DOM), run in the body worker.
//
// Inputs, at a working resolution (the photo scaled down; the movement is smooth, so it is computed
// small and applied to the full photo by the GPU):
//   - person: soft person mask (0..1) from the app's segmenter
//   - labels: BodyPix part per pixel (0..23, 255 = none): arms, hands, torso, legs, feet, face
//   - joints: 18 body points in OpenPose order (see JOINT below), from BodyPix's keypoints
//
// How the body slims (worked out on test photos, see the PR description):
//   - Torso and legs (the body without the arms): each row of the body narrows toward the body's
//     centre line (the torso: gently at the chest, fully at the waist and hips) or toward each
//     leg's own middle (full on the thighs, less on the calves, none at the ankles). The hips blend
//     smoothly into the thighs.
//   - Arms (BodyPix's upper-arm and forearm parts): each part narrows across its own direction
//     toward its centre line (from the part's shape, not the body points), limited to the arm's
//     thickness: full on the upper arm, half on the forearm, none at the hand. An arm resting on
//     the body's side swings in with it, hinged at the shoulder; an arm hanging free or in front of
//     the body stays where it is. An arm mostly hidden behind the body moves with the body.
//   - One smooth warp: every pixel follows the arm's motion or the body's, softly blended at the
//     arm's edge, so nothing tears or leaves ghosts. The rounded shoulder eases in (no corner).
//   - The background next to the person follows the person's edge movement smoothly and fades
//     out with distance (tall smoothing: straight lines bend gently instead of stepping).
//   - Slim builds get a smaller maximum than heavy ones (waist width relative to body height).
//
// The result is linear in the three strengths (arms, waist & hips, legs): the worker returns one
// unit field per area and the GPU adds them with the slider weights, so the sliders are instant.

/** Body points in OpenPose order (what the slimming rules were written against). */
export const JOINT = {
  nose: 0, neck: 1,
  rShoulder: 2, rElbow: 3, rWrist: 4,
  lShoulder: 5, lElbow: 6, lWrist: 7,
  rHip: 8, rKnee: 9, rAnkle: 10,
  lHip: 11, lKnee: 12, lAnkle: 13,
} as const;
export const JOINT_COUNT = 18;

/** BodyPix part ids. */
export const PART = {
  leftUpperArm: [2, 3], rightUpperArm: [4, 5],
  leftLowerArm: [6, 7], rightLowerArm: [8, 9],
  leftHand: 10, rightHand: 11,
  torso: [12, 13],
} as const;
const isArmPart = (p: number) => p >= 2 && p <= 11;
const LEFT_ARM = [2, 3, 6, 7, 10];
const RIGHT_ARM = [4, 5, 8, 9, 11];

/** Strength at 100% of the overall slider, per area (fraction of the local half-width). */
export const FULL = { arms: 0.6, torso: 0.3, legs: 0.25 } as const;

export interface BodyInput {
  w: number;
  h: number;
  person: Float32Array;
  labels: Uint8Array;
  /** x, y, score per joint (JOINT_COUNT * 3). */
  joints: Float32Array;
}

export interface BodyFields {
  w: number;
  h: number;
  /** Unit fields, interleaved (dx, dy) per pixel: the movement at strength 1 of that area. */
  arms: Float32Array;
  torso: Float32Array;
  legs: Float32Array;
  /** 0.3 (slim) .. 1 (heavy): scales the maximum. */
  build: number;
}

// ---------------------------------------------------------------- small helpers

export function sstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const lerp1 = (y: number, y0: number, y1: number, v0: number, v1: number) =>
  y <= y0 ? v0 : y >= y1 ? v1 : v0 + ((v1 - v0) * (y - y0)) / (y1 - y0);

function boxPass(src: Float32Array, dst: Float32Array, w: number, h: number, r: number, horizontal: boolean): void {
  if (r < 1) {
    dst.set(src);
    return;
  }
  const n = horizontal ? w : h;
  const lines = horizontal ? h : w;
  const step = horizontal ? 1 : w;
  const inv = 1 / (2 * r + 1);
  for (let l = 0; l < lines; l++) {
    const base = horizontal ? l * w : l;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[base + clamp(k, 0, n - 1) * step];
    for (let i = 0; i < n; i++) {
      dst[base + i * step] = acc * inv;
      acc += src[base + Math.min(i + r + 1, n - 1) * step] - src[base + Math.max(i - r, 0) * step];
    }
  }
}

/** Gaussian blur approximated by three box passes per axis (edges replicated). */
export function blur(src: Float32Array, w: number, h: number, sx: number, sy = sx): Float32Array {
  const radius = (s: number) => Math.max(0, Math.round(Math.sqrt((12 * s * s) / 3 + 1) / 2 - 0.5));
  const rx = radius(sx), ry = radius(sy);
  let a: Float32Array = Float32Array.from(src);
  let b: Float32Array = new Float32Array(src.length);
  for (let i = 0; i < 3; i++) {
    boxPass(a, b, w, h, rx, true);
    [a, b] = [b, a];
  }
  for (let i = 0; i < 3; i++) {
    boxPass(a, b, w, h, ry, false);
    [a, b] = [b, a];
  }
  return a;
}

/** Exact Euclidean distance from each set pixel to the nearest unset one (0 on unset pixels). */
export function distanceTransform(mask: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e20;
  const f = new Float64Array(Math.max(w, h));
  const d = new Float64Array(Math.max(w, h));
  const v = new Int32Array(Math.max(w, h));
  const z = new Float64Array(Math.max(w, h) + 1);
  const grid = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) grid[i] = mask[i] ? INF : 0;
  const pass = (n: number) => {
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
    }
  };
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
    pass(h);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = grid[y * w + x];
    pass(w);
    for (let x = 0; x < w; x++) out[y * w + x] = Math.sqrt(d[x]);
  }
  return out;
}

/** Bilinear sample of a single-channel image (edges clamped). */
function sample(img: Float32Array, w: number, h: number, x: number, y: number): number {
  x = clamp(x, 0, w - 1);
  y = clamp(y, 0, h - 1);
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
  const fx = x - x0, fy = y - y0;
  const a = img[y0 * w + x0] + (img[y0 * w + x1] - img[y0 * w + x0]) * fx;
  const b = img[y1 * w + x0] + (img[y1 * w + x1] - img[y1 * w + x0]) * fx;
  return a + (b - a) * fy;
}

/** Runs of set pixels in one row ([start, end) pairs), small gaps bridged, tiny runs dropped. */
export function runsOf(m: Uint8Array, w: number, y: number, gap: number): [number, number][] {
  const out: [number, number][] = [];
  let x = 0;
  const row = y * w;
  while (x < w) {
    while (x < w && !m[row + x]) x++;
    if (x >= w) break;
    const a = x;
    while (x < w && m[row + x]) x++;
    const last = out[out.length - 1];
    if (last && a - last[1] < gap) last[1] = x;
    else out.push([a, x]);
  }
  return out.filter((r) => r[1] - r[0] > 2);
}

function percentile(values: Float32Array, p: number): number {
  const s = Float32Array.from(values).sort();
  return s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))];
}

interface Frame {
  w: number;
  h: number;
  J: Float32Array;
  jx: (i: number) => number;
  jy: (i: number) => number;
  sw: number;
  neck: [number, number];
  hip: [number, number];
}

function frame(input: BodyInput): Frame {
  const J = input.joints;
  const jx = (i: number) => J[i * 3], jy = (i: number) => J[i * 3 + 1];
  const sw = Math.max(4, Math.hypot(jx(2) - jx(5), jy(2) - jy(5)));
  return {
    w: input.w,
    h: input.h,
    J,
    jx,
    jy,
    sw,
    neck: [(jx(2) + jx(5)) / 2, (jy(2) + jy(5)) / 2],
    hip: [(jx(8) + jx(11)) / 2, (jy(8) + jy(11)) / 2],
  };
}

/** Centre line of the torso at row y (neck to mid-hip, straight beyond). */
const centreX = (F: Frame, y: number) => lerp1(y, F.neck[1], F.hip[1], F.neck[0], F.hip[0]);

function mainRun(rs: [number, number][], xc: number): [number, number] {
  let best = rs[0], bd = Infinity;
  for (const r of rs) {
    const d = r[0] <= xc && xc <= r[1] ? 0 : Math.min(Math.abs(r[0] - xc), Math.abs(r[1] - xc));
    if (d < bd) {
      bd = d;
      best = r;
    }
  }
  return best;
}

// ---------------------------------------------------------------- build

/** Waist width relative to body height: ~0.25 slim, ~0.35 average, 0.45+ heavy. */
export function waistRatio(m: Uint8Array, F: Frame): number {
  const tl = F.hip[1] - F.neck[1];
  const ws: number[] = [];
  for (let i = 0; i < 12; i++) {
    const y = Math.round(F.neck[1] + 0.55 * tl + ((0.1 * tl + 0.45 * tl) * i) / 11);
    if (y < 0 || y >= F.h) continue;
    const rs = runsOf(m, F.w, y, 0.01 * F.w);
    if (!rs.length) continue;
    const r = mainRun(rs, centreX(F, y));
    ws.push(r[1] - r[0]);
  }
  const H = Math.max(F.jy(10), F.jy(13)) - F.jy(0);
  if (!ws.length || H <= 0) return 0.35;
  ws.sort((a, b) => a - b);
  const mid = ws.length >> 1;
  const median = ws.length % 2 ? ws[mid] : (ws[mid - 1] + ws[mid]) / 2;
  return median / H;
}

// ---------------------------------------------------------------- torso and legs

/**
 * Horizontal movement of the body without the arms, at strength 1 of the torso (`legs` false) or
 * of the legs (`legs` true). Background fall-off widths are those of 100% (fixed, so the field is
 * linear in the strength).
 */
function bodyField(m: Uint8Array, F: Frame, legs: boolean, buildK: number): Float32Array {
  const { w, h, sw, jx, jy } = F;
  const dx = new Float32Array(w * h);
  const tl = F.hip[1] - F.neck[1];
  const kneeY = (jy(9) + jy(12)) / 2, ankY = (jy(10) + jy(13)) / 2;
  const thigh = Math.max(kneeY - F.hip[1], 0.3 * tl);
  const crotch = F.hip[1] + 0.15 * thigh;
  const gt = (y: number) =>
    y >= F.neck[1] + 0.12 * tl
      ? 0.25 + 0.75 * sstep(F.neck[1] + 0.25 * tl, F.neck[1] + 0.75 * tl, y)
      : 0.25 * sstep(F.neck[1], F.neck[1] + 0.12 * tl, y);
  const gl = (y: number) => (1 - 0.5 * sstep(kneeY - 0.2 * thigh, kneeY + 0.3 * thigh, y)) * (1 - sstep(ankY - 0.35 * thigh, ankY, y));
  const nomT = FULL.torso * buildK, nomL = FULL.legs * buildK; // 100% strengths, for the fall-off widths
  const row = new Float32Array(w);
  const falloff = (edge: number, outward: 1 | -1, amt: number, B: number) => {
    for (let x = 0; x < w; x++) {
      const dist = (x - edge) * outward;
      if (dist > 0 && dist < B) row[x] += amt * (1 - dist / B);
    }
  };
  for (let y = Math.max(0, Math.floor(F.neck[1])); y < h; y++) {
    const rs = runsOf(m, w, y, 0.01 * w);
    if (!rs.length) continue;
    const xc = centreX(F, y);
    const main = mainRun(rs, xc);
    row.fill(0);
    const beta = sstep(crotch, crotch + 0.5 * thigh, y);
    if (!legs && y < crotch + 0.5 * thigh) {
      const g = gt(y);
      let a: number, b: number;
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
      for (let x = Math.max(0, Math.ceil(a)); x <= Math.min(w - 1, b); x++) row[x] = g * (x - xc);
      const eL = g * (a - xc), eR = g * (b - xc);
      // the background beside the body stretches into the gap, stopping short of an arm or hand there
      let gapL = 1e9, gapR = 1e9;
      for (const r of rs) {
        if (r[1] <= a) gapL = Math.min(gapL, a - r[1]);
        if (r[0] >= b) gapR = Math.min(gapR, r[0] - b);
      }
      const BL = Math.max(1, Math.min(2.5 * Math.abs(nomT * eL) + 0.08 * sw, 0.8 * gapL));
      const BR = Math.max(1, Math.min(2.5 * Math.abs(nomT * eR) + 0.08 * sw, 0.8 * gapR));
      falloff(a, -1, eL, BL);
      falloff(b, 1, eR, BR);
      // arms and hands beside the body hang from the shoulders: they stay where they are
      for (const r of rs) if (r[1] <= a || r[0] >= b) row.fill(0, r[0], r[1]);
      for (let x = 0; x < w; x++) row[x] *= 1 - beta;
    }
    if (legs && y >= crotch) {
      const g = gl(y);
      for (const r of rs) {
        const a = r[0], b = r[1], c = (a + b) / 2, hw = (b - a) / 2;
        if (hw < 0.04 * sw) continue;
        // a hand next to the thigh is not a leg
        const nearHand = [4, 7].some((k) => Math.abs(c - jx(k)) < 0.4 * sw && y < jy(k) + 0.45 * sw);
        if (nearHand && hw < 0.3 * sw) continue;
        for (let x = a; x < b; x++) row[x] += beta * g * (x - c);
        const B = 2.5 * nomL * g * hw + 0.06 * sw;
        falloff(a, -1, -beta * g * hw, B);
        falloff(b, 1, beta * g * hw, B);
      }
    }
    dx.set(row, y * w);
  }
  return blur(dx, w, h, 0.015 * sw + 1, 0.06 * sw);
}

// ---------------------------------------------------------------- arms

interface ArmPart {
  ids: number[];
  side: "L" | "R";
  upper: boolean;
}
const ARM_PARTS: ArmPart[] = [
  { ids: [2, 3], side: "L", upper: true },
  { ids: [6, 7], side: "L", upper: false },
  { ids: [4, 5], side: "R", upper: true },
  { ids: [8, 9], side: "R", upper: false },
];

/** Arm slimming at strength 1: each part narrows across its own direction toward its centre line. */
function armField(input: BodyInput, labels: Uint8Array, F: Frame): { dx: Float32Array; dy: Float32Array } {
  const { w, h, sw } = F;
  const n = w * h;
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
    const pm = new Float32Array(n);
    let cnt = 0, mx = 0, my = 0;
    for (let i = 0; i < n; i++)
      if (P[i] > 0.5 && part.ids.includes(labels[i])) {
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
    const wgt = blur(pm, w, h, 0.06 * sw + 1);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
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
          ? (0.5 + 0.5 * sstep(0, 0.35, a)) * (1 - 0.3 * sstep(0.7, 1, a)) // shoulder cap at half strength
          : 0.5 * (1 - sstep(0.4, 0.95, a)); // forearm: half, none at the hand
        const av = Math.abs(v);
        const across = av <= r ? v : Math.sign(v) * r * clamp(1 - (av - r) / (0.6 * r), 0, 1);
        const disp = g * across * wgt[i];
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
 * An arm resting on the body's side swings in with it (hinged at the shoulder): the horizontal
 * movement that `bodyDx` gives the body's edge where the arm touches it, spread over the arm.
 */
function armSwing(input: BodyInput, labels: Uint8Array, body: Uint8Array, F: Frame, bodyDx: Float32Array): Float32Array {
  const { w, h, sw } = F;
  const n = w * h;
  const P = input.person;
  const out = new Float32Array(n);
  for (const [side, ids] of [["L", LEFT_ARM], ["R", RIGHT_ARM]] as const) {
    const am = new Float32Array(n);
    let cnt = 0, sx = 0, sy = 0, ymin = h, ymax = -1;
    for (let i = 0; i < n; i++)
      if (P[i] > 0.5 && ids.includes(labels[i])) {
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
    let tw = 0, tsum = 0, tcount = 0;
    for (let y = ymin; y <= ymax; y++) {
      let armMin = w, armMax = -1, bodyMin = w, bodyMax = -1;
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (am[i]) {
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
      if (c > 0.2 && y > F.neck[1] + 0.3 * (F.hip[1] - F.neck[1])) {
        tw += c;
        tsum += c * bodyDx[y * w + edge];
        tcount++;
      }
    }
    if (tcount < 5 || tw <= 0) continue;
    const Te = tsum / tw;
    const S = side === "R" ? 2 : 5, E = side === "R" ? 3 : 6;
    const wgt = blur(am, w, h, 0.05 * sw + 1);
    for (let y = 0; y < h; y++) {
      const ramp = 0.5 + 0.5 * sstep(F.jy(S), F.jy(E), y); // the shoulder cap comes in halfway
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        out[i] += Te * ramp * Math.min(1, wgt[i] * 3);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- everything together

/** The three unit fields (arms, torso = waist & hips, legs) and the build factor. */
export function bodyFields(input: BodyInput): BodyFields {
  const { w, h } = input;
  const n = w * h;
  const F = frame(input);
  const sw = F.sw;
  const P = input.person;
  const m = new Uint8Array(n);
  for (let i = 0; i < n; i++) m[i] = P[i] > 0.5 ? 1 : 0;
  const buildK = 0.3 + 0.7 * sstep(0.24, 0.42, waistRatio(m, F));

  // an arm mostly hidden behind the body (a small visible slice) just moves with the body
  const labels = Uint8Array.from(input.labels);
  const area = (ids: number[]) => {
    let c = 0;
    for (let i = 0; i < n; i++) if (m[i] && ids.includes(labels[i])) c++;
    return c;
  };
  const aL = area(LEFT_ARM), aR = area(RIGHT_ARM), big = Math.max(aL, aR, 1);
  for (const [a, ids] of [[aL, LEFT_ARM], [aR, RIGHT_ARM]] as const)
    if (a < 0.3 * big) for (let i = 0; i < n; i++) if (ids.includes(labels[i])) labels[i] = 12;

  const armHard = new Float32Array(n);
  const body = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    armHard[i] = m[i] && isArmPart(labels[i]) ? 1 : 0;
    body[i] = P[i] - armHard[i] > 0.5 ? 1 : 0;
  }
  const torso = bodyField(body, F, false, buildK);
  const legs = bodyField(body, F, true, buildK);
  const arm = armField(input, labels, F);
  const swingT = armSwing(input, labels, body, F, torso);
  const swingL = armSwing(input, labels, body, F, legs);
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
  const unit = (ax: Float32Array | null, ay: Float32Array | null, bodyDx: Float32Array | null, swing: Float32Array | null) => {
    const dx = new Float32Array(n), dy = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const armX = (ax ? ax[i] : 0) + (swing ? swing[i] : 0);
      dx[i] = (wa[i] * armX + (1 - wa[i]) * (bodyDx ? bodyDx[i] : 0)) * ramp[i];
      dy[i] = wa[i] * (ay ? ay[i] : 0) * ramp[i];
    }
    return { dx, dy };
  };
  const units = {
    arms: unit(arm.dx, arm.dy, null, null),
    torso: unit(null, null, torso, swingT),
    legs: unit(null, null, legs, swingL),
  };

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
    for (let i = 0; i < n; i++) {
      out[2 * i] = bx[i];
      out[2 * i + 1] = by[i];
    }
    return out;
  };
  return { w, h, arms: pack("arms"), torso: pack("torso"), legs: pack("legs"), build: buildK };
}
