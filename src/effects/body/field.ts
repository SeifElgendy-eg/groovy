// Body slimming: where each pixel of the photo moves. Pure functions (no DOM), run in the body worker.
//
// Inputs, at a working resolution (the photo scaled so the person is about 800 px tall; the movement
// is smooth, so it is computed small and applied to the full photo by the GPU, see warp.ts):
//   - person: soft person mask (0..1) from the app's segmenter (arms it missed filled in by BodyPix)
//   - labels: BodyPix part per pixel (0..23, 255 = none): arms, hands, torso, legs, feet, face
//   - joints: 18 body points in OpenPose order (see JOINT below), from BodyPix's keypoints
//   - rgb: the photo's colours (to find whole hands)
//
// How the body slims (worked out on test photos; scripts/body/ measures any change):
//   - Torso and legs (the body without the arms): each row narrows toward the body's centre line
//     (the torso: a little over the chest and bust, full from the natural waist down, so the
//     waist-to-hip ratio stays) or toward each leg's own middle (full on the thighs, easing into the
//     knee, less on the calves, none at the ankles). The outer edges move smoothly from row to row.
//     Legs far from upright (crouching, a knee raised) are left as they are.
//   - Arms: each part (upper arm, forearm) narrows across its own direction, but only for an arm
//     hanging down (armHanging); the side lying against the body stays against it. An arm resting
//     on the body's side turns in with it (shoulder and elbow, two rigid pieces); a free arm stays.
//   - Hands move as one piece, as their wrist does, or with the body they rest on.
//   - One smooth warp: every pixel follows the arm's motion or the body's, softly blended at the
//     arm's edge. The background beside the person follows the person's edge and fades out with
//     distance; nothing moves at the photo's edges, and the picture never folds over itself
//     (unfold), whatever the sliders' mix.
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

const isArmPart = (p: number) => p >= 2 && p <= 11;
const LEFT_ARM = [2, 3, 6, 7, 10];
const RIGHT_ARM = [4, 5, 8, 9, 11];
/** A 256-entry table: 1 for the given part ids (for per-pixel tests without searching an array). */
function partTable(ids: readonly number[]): Uint8Array {
  const t = new Uint8Array(256);
  for (const id of ids) t[id] = 1;
  return t;
}
const IS_LEFT_ARM = partTable(LEFT_ARM), IS_RIGHT_ARM = partTable(RIGHT_ARM);

/** Smallest local area scale of the warp at 100% that unfold() lets through (1 = unchanged). */
export const UNFOLD_MIN_SCALE = 0.1;
/** unfold() stops when at most this many pixels are left folding. */
const UNFOLD_LEFT_OK = 4;

/** Support (pixels) of blur() with this sigma: beyond it a blurred point mask is exactly 0. */
function blurReach(s: number): number {
  return 3 * Math.max(0, Math.round(Math.sqrt((12 * s * s) / 3 + 1) / 2 - 0.5)) + 1;
}

/** Bounding box [x0, y0, x1, y1] (inclusive) of the set pixels, or null. */
function bbox(m: ArrayLike<number>, w: number, h: number): [number, number, number, number] | null {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0, i = 0; y < h; y++)
    for (let x = 0; x < w; x++, i++)
      if (m[i]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  return x1 < 0 ? null : [x0, y0, x1, y1];
}

/** Strength at 100% of the overall slider, per area (fraction of the local half-width). */
export const FULL = { arms: 0.6, torso: 0.3, legs: 0.3 } as const;

/**
 * The numbers that shape the slimming, in one place. Lengths are fractions of the shoulder width
 * (sw), the torso's length (tl, shoulders to hip joints) or the thigh's; angles in degrees; [a, b]
 * is a smooth ramp from a to b. Change them only with scripts/body/ (metrics against a baseline and
 * before/after sheets): each was tuned on test photos, and they interact.
 */
export const TUNING = {
  build: {
    /** Waist width / body height of a slim and a heavy build (without the arms). */
    ratio: [0.21, 0.36],
    /** Strength factor for the slimmest build (1 for the heaviest). */
    slimmest: 0.3,
  },
  torso: {
    /** Strength over the chest and the bust (same over the whole bust: no pointed bust). */
    chest: 0.3,
    /** The chest strength is reached this far below the shoulders (tl). */
    chestFrom: 0.12,
    /** Full strength is reached from the bust down to the natural waist: starts this far above it (tl), */
    fullFrom: 0.2,
    /** and is reached this far above it (tl); not above these points below the shoulders (tl). */
    fullAt: 0.05,
    fullFromMin: 0.28,
    fullAtMin: 0.4,
    /** How much of the gap to an arm beside the waist its edge may take (folds beyond). */
    gapUse: 0.6 * 0.8,
    /** Smoothing of the outer edges' movement down the body (sw). */
    edgeSmooth: 0.15,
  },
  legs: {
    /** Strength at the knee, as a share taken off the thighs' (the thigh tapers into the knee). */
    kneeEase: 0.45,
    /** The taper starts this far below the hips (thigh lengths). */
    kneeEaseFrom: 0.35,
    /** Toward the body's centre line at the top of the thighs (so the outer hips come in). */
    hipsBlend: 0.7,
    /** Legs tilted this far from upright are slimmed less, and not at all (degrees). */
    tilt: [25, 45],
    /** The calves fade out over this much above the ankles (thigh lengths). */
    ankleFade: 0.35,
  },
  arms: {
    /** An arm is slimmed fully when hanging down: less as its parts tilt from vertical, */
    tilt: [35, 60],
    /** and as the elbow bends (degrees). */
    bend: [35, 70],
    /** Upper arm: half at the shoulder, full from this far down it; the forearm: this much. */
    upperFullFrom: 0.35,
    forearm: 0.5,
  },
  hands: {
    /** A hand rests on the body when this share of the ring around it is body, */
    touch: [0.1, 0.3],
    /** unless its arm moves more than this (sw): then the hand goes with its arm. */
    armMoves: [0.02, 0.05],
  },
} as const;

export interface BodyInput {
  w: number;
  h: number;
  person: Float32Array;
  labels: Uint8Array;
  /** x, y, score per joint (JOINT_COUNT * 3). */
  joints: Float32Array;
  /** The photo's colours at w x h (RGB, 3 bytes per pixel), if available: tells fingers from what they lie on. */
  rgb?: Uint8ClampedArray;
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
  /** Body parts as the fields used them (arms by side, whole hands): for checks and the debug view. */
  labels: Uint8Array;
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

/**
 * Gaps narrower than this (pixels) are bridged when finding the body's runs in a row: a small
 * fraction of the shoulder width (a fraction of the frame would bridge the gap between an arm and
 * the body when the person is small in a wide frame).
 */
const runGap = (sw: number) => Math.max(1, 0.03 * sw);

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

/**
 * Nose to ankles in pixels; when the ankles are not seen (the photo ends at the knees or the shins),
 * estimated from nose to hips (nose to hips is about 0.48 of nose to ankles).
 */
export function noseToAnkles(J: ArrayLike<number>): number {
  const ok = J[10 * 3 + 2] >= 0.3 && J[13 * 3 + 2] >= 0.3;
  const ank = (J[10 * 3 + 1] + J[13 * 3 + 1]) / 2 - J[1];
  const hips = (J[8 * 3 + 1] + J[11 * 3 + 1]) / 2 - J[1];
  return ok && ank > hips ? ank : 2.1 * hips;
}

/** These body points (indices) are all found with confidence and inside the picture. */
export function pointsSeen(J: ArrayLike<number>, w: number, h: number, ids: readonly number[]): boolean {
  return ids.every((i) => {
    const px = J[i * 3], py = J[i * 3 + 1];
    return J[i * 3 + 2] >= 0.5 && px >= 0.01 * w && px <= 0.99 * w && py >= 0.01 * h && py <= 0.98 * h;
  });
}

/** Both ankles found with confidence and inside the picture (the calves can be slimmed). */
export const anklesSeen = (J: ArrayLike<number>, w: number, h: number): boolean => pointsSeen(J, w, h, [10, 13]);

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
 * Where an arm rests on the body's side (from armSwing): per row, for the body's image-left side
 * (index y) and image-right side (index h + y), how much the arm resting there moves (`v`, unit
 * field) and how much it rests (`c`, 0..1).
 */
interface ArmRest {
  v: Float32Array;
  c: Float32Array;
  /** How the arm on that side moves at each row (its turn; 0 where it does not turn). */
  arm: Float32Array;
}

/**
 * Horizontal movement of the body without the arms (`m`), at strength 1 of the torso (`legs` false)
 * or of the legs (`legs` true). `rest`: where arms rest on the body's sides (from armSwing). The
 * background fall-off widths are those of 100% (fixed, so the field is linear in the strength).
 */
function bodyField(m: Uint8Array, F: Frame, legs: boolean, buildK: number, rest?: ArmRest): Float32Array {
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
function armField(input: BodyInput, labels: Uint8Array, F: Frame, body: Uint8Array): { dx: Float32Array; dy: Float32Array } {
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
function armSwing(
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

/** A hand, measured once for rigidHands (its pixels, soft edge, the ring around it, its wrist). */
export interface HandShape {
  /** The hand's pixels (person pixels with that hand's part), ascending. */
  pixels: Int32Array;
  /** Soft hand mask (a little grown), and how far it reaches beyond the box. */
  soft: Float32Array;
  reach: number;
  box: [number, number, number, number];
  /** Pixels of the ring just around the hand, and those of them that are body (not hand). */
  ring: number;
  ringBody: Int32Array;
  /** Forearm pixels just above the wrist (empty when the wrist is not found). */
  wrist: Int32Array;
}

/** Measure both hands (BodyPix parts 10 and 11) for rigidHands. */
export function handShapes(labels: Uint8Array, m: Uint8Array, w: number, h: number, sw: number, J: Float32Array | null, body: Uint8Array | null): HandShape[] {
  const n = w * h;
  const out: HandShape[] = [];
  for (const id of [10, 11]) {
    const hand = new Float32Array(n);
    const px: number[] = [];
    let hx = 0, hy = 0;
    for (let i = 0; i < n; i++)
      if (m[i] && labels[i] === id) {
        hand[i] = 1;
        px.push(i);
        hx += i % w;
        hy += (i / w) | 0;
      }
    if (px.length < 10) continue;
    hx /= px.length;
    hy /= px.length;
    // the forearm just above this hand's wrist (the wrist nearest to the hand)
    const wrist: number[] = [];
    if (J) {
      const W = Math.hypot(J[12] - hx, J[13] - hy) <= Math.hypot(J[21] - hx, J[22] - hy) ? 4 : 7;
      const forearm = partTable(W === 4 ? [8, 9] : [6, 7]);
      const wx = J[W * 3], wy = J[W * 3 + 1], R = 0.15 * sw;
      for (let y = Math.max(0, Math.floor(wy - R)); y <= Math.min(h - 1, wy + R); y++)
        for (let x = Math.max(0, Math.floor(wx - R)); x <= Math.min(w - 1, wx + R); x++) {
          const i = y * w + x;
          if (m[i] && forearm[labels[i]] && Math.hypot(x - wx, y - wy) <= R) wrist.push(i);
        }
    }
    // the ring around the hand, and the body in it
    let ring = 0;
    const ringBody: number[] = [];
    if (body) {
      const rb = blur(hand, w, h, 0.03 * sw + 1);
      for (let i = 0; i < n; i++) {
        if (hand[i] || rb[i] < 0.03) continue;
        ring++;
        if (body[i] && !(labels[i] === 10 || labels[i] === 11)) ringBody.push(i);
      }
    }
    const sigma = 0.025 * sw + 1;
    out.push({
      pixels: Int32Array.from(px),
      soft: blur(hand, w, h, sigma),
      reach: blurReach(sigma),
      box: bbox(hand, w, h)!,
      ring,
      ringBody: Int32Array.from(ringBody),
      wrist: wrist.length >= 5 ? Int32Array.from(wrist) : new Int32Array(0),
    });
  }
  return out;
}

/**
 * Give each hand one movement in the field `f` (movement at strength 1; `full`: the strength at
 * 100%): the movement of the forearm just above its wrist (the hand goes where its wrist goes; the
 * hand's own average also picks up the movement around its edge, and a hand moved more than its
 * wrist bends at the wrist), or the hand's average when the wrist is not found. A hand against the
 * body (on the hip, the thigh, a coat's side) whose arm stays goes with the body around it instead
 * (`bodyDx`, the body's own field in `f`'s area; null: the body does not move in it): kept where the
 * arm puts it, the body slid away under the hand and left a notch below it. An arm turning in with
 * the waist takes its hand along. Applied wherever the hand is on its way at up to 100%.
 */
export function rigidHands(f: { dx: Float32Array; dy: Float32Array }, hands: HandShape[], w: number, h: number, sw: number, full: number, bodyDx: Float32Array | null): void {
  for (const hs of hands) {
    let vx = 0, vy = 0;
    for (const i of hs.pixels) {
      vx += f.dx[i];
      vy += f.dy[i];
    }
    vx /= hs.pixels.length;
    vy /= hs.pixels.length;
    const wristFound = hs.wrist.length > 0;
    if (wristFound) {
      let fx = 0, fy = 0;
      for (const i of hs.wrist) {
        fx += f.dx[i];
        fy += f.dy[i];
      }
      vx = fx / hs.wrist.length;
      vy = fy / hs.wrist.length;
    }
    if (hs.ring) {
      let bx = 0;
      for (const i of hs.ringBody) bx += bodyDx ? bodyDx[i] : 0;
      const bc = hs.ringBody.length;
      const H = TUNING.hands;
      const still = wristFound ? 1 - sstep(H.armMoves[0] * sw, H.armMoves[1] * sw, Math.abs(full * vx)) : 1;
      const touch = sstep(H.touch[0], H.touch[1], bc / hs.ring) * still;
      if (touch > 0) {
        vx += touch * (bx / bc - vx);
        vy *= 1 - touch;
      }
    }
    const at = (x: number, y: number) => Math.min(1, sample(hs.soft, w, h, x, y) * 2.5);
    // only near the hand: the soft mask is 0 beyond its reach, and the hand moves by full * v
    const reach = hs.reach + Math.ceil(full * Math.hypot(vx, vy)) + 2;
    const [bx0, by0, bx1, by1] = hs.box;
    for (let y = Math.max(0, by0 - reach); y <= Math.min(h - 1, by1 + reach); y++)
      for (let x = Math.max(0, bx0 - reach); x <= Math.min(w - 1, bx1 + reach); x++) {
        const i = y * w + x;
        const k = Math.max(at(x, y), at(x + 0.5 * full * vx, y + 0.5 * full * vy), at(x + full * vx, y + full * vy));
        if (!k) continue;
        f.dx[i] += (vx - f.dx[i]) * k;
        f.dy[i] += (vy - f.dy[i]) * k;
      }
  }
}

/**
 * Grow each hand (BodyPix parts 10 and 11) to the whole hand. BodyPix often labels only the palm and
 * gives the fingers the part they lie on (a thigh, the belly); those fingers would then be slimmed
 * with the leg while the palm moves with the arm, and the hand is torn or squashed. The hand is the
 * person's pixels from the wrist up to a hand's length past it, in the hand's direction and about a
 * hand wide, joined to the palm, and of the palm's colour (when the colours are known).
 */
export function growHands(labels: Uint8Array, m: Uint8Array, rgb: Uint8ClampedArray | undefined, w: number, h: number, J: Float32Array, sw: number): void {
  const n = w * h;
  for (const id of [10, 11]) {
    let c = 0, hx = 0, hy = 0;
    for (let i = 0; i < n; i++)
      if (m[i] && labels[i] === id) {
        c++;
        hx += i % w;
        hy += (i / w) | 0;
      }
    if (c < 6) continue;
    hx /= c;
    hy /= c;
    // the wrist and elbow of this hand: the wrist nearest to the palm
    const [W, E] = Math.hypot(J[12] - hx, J[13] - hy) <= Math.hypot(J[21] - hx, J[22] - hy) ? [4, 3] : [7, 6];
    const wx = J[W * 3], wy = J[W * 3 + 1];
    if (J[W * 3 + 2] < 0.3 || Math.hypot(wx - hx, wy - hy) > 0.5 * sw) continue;
    // the hand's direction: wrist to palm, or along the forearm when the palm is at the wrist
    let ux = hx - wx, uy = hy - wy;
    let len = Math.hypot(ux, uy);
    if (len < 0.05 * sw) {
      ux = wx - J[E * 3];
      uy = wy - J[E * 3 + 1];
      len = Math.hypot(ux, uy);
    }
    if (len < 1e-3) continue;
    ux /= len;
    uy /= len;
    const L = 0.5 * sw, R = 0.13 * sw;
    // the palm's colour
    let mr = 0, mg = 0, mb = 0, vr = 0;
    if (rgb) {
      for (let i = 0; i < n; i++)
        if (m[i] && labels[i] === id) {
          mr += rgb[i * 3];
          mg += rgb[i * 3 + 1];
          mb += rgb[i * 3 + 2];
        }
      mr /= c;
      mg /= c;
      mb /= c;
      for (let i = 0; i < n; i++)
        if (m[i] && labels[i] === id) vr += (rgb[i * 3] - mr) ** 2 + (rgb[i * 3 + 1] - mg) ** 2 + (rgb[i * 3 + 2] - mb) ** 2;
      vr /= c;
    }
    const maxD2 = Math.max(45 * 45, 6 * vr); // ~2.5 standard deviations of the palm's colour
    const cand = (x: number, y: number): boolean => {
      const i = y * w + x;
      if (!m[i] || labels[i] === 10 || labels[i] === 11 || labels[i] <= 1) return false; // not a hand already, not the face
      const t = (x - wx) * ux + (y - wy) * uy;
      if (t < 0 || t > L) return false;
      if (Math.abs((x - wx) * -uy + (y - wy) * ux) > R) return false;
      if (rgb && (rgb[i * 3] - mr) ** 2 + (rgb[i * 3 + 1] - mg) ** 2 + (rgb[i * 3 + 2] - mb) ** 2 > maxD2) return false;
      return true;
    };
    // flood from the palm through the candidates
    const stack: number[] = [];
    for (let i = 0; i < n; i++) if (m[i] && labels[i] === id) stack.push(i);
    const seen = new Uint8Array(n);
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % w, y = (i / w) | 0;
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const k = ny * w + nx;
        if (seen[k] || !cand(nx, ny)) continue;
        seen[k] = 1;
        labels[k] = id;
        stack.push(k);
      }
    }
  }
}

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

const OTHER_SIDE: Record<number, number> = { 2: 4, 3: 5, 6: 8, 7: 9, 10: 11, 4: 2, 5: 3, 8: 6, 9: 7, 11: 10 };

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
  unfold(out, [sA, sT, sL], w, h, sw);
  return { w, h, ...out, build: buildK, labels };
}

/**
 * Where the movement at 100% would fold the picture over itself (the moved image's neighbouring
 * pixels swap places: a loop or a smear, e.g. in the background just outside an arm that turns in
 * with the waist), smooth the movement there until it no longer folds. The same smoothing is applied
 * to every area's field, so their weighted sum (the sliders) stays consistent. The sliders mix the
 * areas freely (and the legs are off when the knees are not in the photo), so every on/off mix of
 * the three areas at 100% is checked, not only all three together. Fields are interleaved (dx, dy);
 * `k`: the 100% strength of each. Only the neighbourhood of the folds is smoothed (and computed).
 * Returns how many pixels folded at first.
 */
export function unfold(
  f: { arms: Float32Array; torso: Float32Array; legs: Float32Array },
  k: [number, number, number],
  w: number,
  h: number,
  sw: number,
  minScale = UNFOLD_MIN_SCALE,
): number {
  const n = w * h;
  const keys = ["arms", "torso", "legs"] as const;
  const sW = 0.04 * sw + 1, sS = 0.05 * sw + 1; // spread of the smoothing weight, the smoothing itself
  const margin = blurReach(sW) + blurReach(sS) + 2;
  const bad = new Uint8Array(n);
  // the on/off mixes of the three areas (bit j: area j on)
  const mixes = [7, 1, 2, 4, 3, 5, 6].filter((mix) => [0, 1, 2].some((j) => mix & (1 << j) && k[j] > 0));
  const A = f.arms, T = f.torso, G = f.legs;
  const d = new Float64Array(12); // per area: d(dx)/dx, d(dx)/dy, d(dy)/dx, d(dy)/dy at 100%
  let worst = 0;
  // where to look: everywhere at first, then only where the last round changed the fields (all
  // the folds were inside that window, and the fields changed nowhere else)
  let rx0 = 1, ry0 = 1, rx1 = w - 2, ry1 = h - 2;
  for (let it = 0; it < 16; it++) {
    bad.fill(0);
    let count = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = ry0; y <= ry1; y++)
      for (let x = rx0; x <= rx1; x++) {
        const i = y * w + x, r = 2 * (i + 1), l = 2 * (i - 1), u = 2 * (i - w), o = 2 * (i + w);
        for (let j = 0; j < 3; j++) {
          const a = j === 0 ? A : j === 1 ? T : G, kk = k[j] / 2;
          d[4 * j] = kk * (a[r] - a[l]);
          d[4 * j + 1] = kk * (a[o] - a[u]);
          d[4 * j + 2] = kk * (a[r + 1] - a[l + 1]);
          d[4 * j + 3] = kk * (a[o + 1] - a[u + 1]);
        }
        for (const mix of mixes) {
          let ax = 1, ay = 0, bx = 0, by = 1;
          for (let j = 0; j < 3; j++)
            if (mix & (1 << j)) {
              ax += d[4 * j];
              ay += d[4 * j + 1];
              bx += d[4 * j + 2];
              by += d[4 * j + 3];
            }
          if (ax * by - ay * bx < minScale) {
            bad[i] = 1;
            count++;
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
            break;
          }
        }
      }
    if (it === 0) worst = count;
    // (a few single pixels left: a sub-pixel overlap nobody can see; not worth another round)
    if (count <= UNFOLD_LEFT_OK) break;
    // a window around the folds, wide enough that blurring inside it equals blurring the whole
    // field wherever the smoothing applies
    const wx0 = Math.max(0, x0 - margin), wy0 = Math.max(0, y0 - margin);
    const wx1 = Math.min(w - 1, x1 + margin), wy1 = Math.min(h - 1, y1 + margin);
    const ww = wx1 - wx0 + 1, wh = wy1 - wy0 + 1, wn = ww * wh;
    rx0 = Math.max(1, wx0 - 1);
    ry0 = Math.max(1, wy0 - 1);
    rx1 = Math.min(w - 2, wx1 + 1);
    ry1 = Math.min(h - 2, wy1 + 1);
    const cut = (get: (i: number) => number) => {
      const out = new Float32Array(wn);
      for (let y = 0; y < wh; y++) for (let x = 0; x < ww; x++) out[y * ww + x] = get((wy0 + y) * w + wx0 + x);
      return out;
    };
    // (at the window's border the blur sees replicated edges instead of the field beyond: the
    // margin keeps that away from where the weight is not 0)
    const wgt = blur(cut((i) => bad[i]), ww, wh, sW);
    for (let i = 0; i < wn; i++) wgt[i] = Math.min(1, wgt[i] * 4);
    for (const key of keys) {
      const a = f[key];
      const fx = cut((i) => a[2 * i]), fy = cut((i) => a[2 * i + 1]);
      const bx = blur(fx, ww, wh, sS), by = blur(fy, ww, wh, sS);
      for (let y = 0; y < wh; y++)
        for (let x = 0; x < ww; x++) {
          const j = y * ww + x;
          if (!wgt[j]) continue;
          const i = (wy0 + y) * w + wx0 + x;
          a[2 * i] = fx[j] + (bx[j] - fx[j]) * wgt[j];
          a[2 * i + 1] = fy[j] + (by[j] - fy[j]) * wgt[j];
        }
    }
  }
  return worst;
}
