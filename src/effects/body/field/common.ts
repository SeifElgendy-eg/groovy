// Shared pieces of the body slimming: body point ids, the tuning, the input/output types, image
// helpers (blur, distance transform, row runs) and the body's frame (centre line, shoulders, hips).

/** Body points in OpenPose order (what the slimming rules were written against). */
export const JOINT = {
  nose: 0, neck: 1,
  rShoulder: 2, rElbow: 3, rWrist: 4,
  lShoulder: 5, lElbow: 6, lWrist: 7,
  rHip: 8, rKnee: 9, rAnkle: 10,
  lHip: 11, lKnee: 12, lAnkle: 13,
} as const;
export const JOINT_COUNT = 18;

export const isArmPart = (p: number) => p >= 2 && p <= 11;
export const LEFT_ARM = [2, 3, 6, 7, 10];
export const RIGHT_ARM = [4, 5, 8, 9, 11];
/** A 256-entry table: 1 for the given part ids (for per-pixel tests without searching an array). */
export function partTable(ids: readonly number[]): Uint8Array {
  const t = new Uint8Array(256);
  for (const id of ids) t[id] = 1;
  return t;
}
export const IS_LEFT_ARM = partTable(LEFT_ARM), IS_RIGHT_ARM = partTable(RIGHT_ARM);

/** Smallest local area scale of the warp at 100% that unfold() lets through (1 = unchanged). */
export const UNFOLD_MIN_SCALE = 0.1;
/** unfold() stops when at most this many pixels are left folding. */
export const UNFOLD_LEFT_OK = 4;

/** Support (pixels) of blur() with this sigma: beyond it a blurred point mask is exactly 0. */
export function blurReach(s: number): number {
  return 3 * Math.max(0, Math.round(Math.sqrt((12 * s * s) / 3 + 1) / 2 - 0.5)) + 1;
}

/** Bounding box [x0, y0, x1, y1] (inclusive) of the set pixels, or null. */
export function bbox(m: ArrayLike<number>, w: number, h: number): [number, number, number, number] | null {
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
  /**
   * What 100% aims for: a waist of sensible proportions for this body (front view, without the
   * arms, widths relative to the nose-to-ankles height H). Measured on the test photos: a slim
   * build's waist is ~0.16-0.21 H, an average one (the booth photos) ~0.24-0.28 H, a heavy one
   * 0.29+ H. 100% brings the
   * waist to `waist` H, and no narrower than `shoulders` x the shoulder points' distance (broad
   * shoulders go with a broader waist: a fit man's waist is ~0.8-0.85 of it, the booth photos'
   * 0.96-1.04), and the hips to `hips` H, whichever needs more, never by more than `maxCut`; a body
   * already there is still visibly toned (`minCut`). The
   * waist, hips and thighs come in by the same fraction (the body keeps its shape), the arms and
   * legs by the same share of their own maximum.
   */
  proportion: {
    waist: 0.19,
    shoulders: 0.8,
    /** The hips (the widest part around the hip points, without the arms): ~0.22-0.28 H on a slim build, 0.31-0.34 on the booth photos. */
    hips: 0.28,
    /** A measured waist under this (x H, x the shoulder points' distance) is not a waist: arms in front of it. */
    measurable: [0.13, 0.6],
    maxCut: 0.22,
    minCut: 0.08,
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
  /**
   * Narrower shoulders (with the Arms area): each shoulder, and the arm hanging from it, moves in
   * toward the neck by `shift` x the shoulder points' distance at the full arms strength. Nothing
   * moves near the neck (`from`); it is full from the shoulder point outward, from just above the
   * shoulder line down, easing out down the arm to nothing at the wrist (the hand stays put), and
 * down the side of the chest to nothing at the bottom of the chest.
   */
  shoulders: {
    shift: 0.045,
    from: [0.12, 0.45],
    above: 0.3,
    /** The side of the chest moves with the shoulder down to `armpit` (sw below the shoulder points), easing out to none at `chestEnd`. */
    armpit: 0.25,
    chestEnd: 1.0,
  },
  hands: {
    /** A hand rests on the body when this share of the ring around it is body, */
    touch: [0.1, 0.3],
    /** unless its arm moves more than this (sw): then the hand goes with its arm. */
    armMoves: [0.02, 0.05],
  },
} as const;

export interface BodyInput {
  /** Filled with the 100% strength's measurements (regression tools). */
  debug?: Record<string, number>;
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
  /** How much of the 100% strength this photo can take before the body looks deformed (strengthCaps): all of the movement, and the arms' on top. */
  cap: { all: number; arms: number };
}

// ---------------------------------------------------------------- small helpers

export function sstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const lerp1 = (y: number, y0: number, y1: number, v0: number, v1: number) =>
  y <= y0 ? v0 : y >= y1 ? v1 : v0 + ((v1 - v0) * (y - y0)) / (y1 - y0);

export function boxPass(src: Float32Array, dst: Float32Array, w: number, h: number, r: number, horizontal: boolean): void {
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
export function sample(img: Float32Array, w: number, h: number, x: number, y: number): number {
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
export const runGap = (sw: number) => Math.max(1, 0.03 * sw);

export function percentile(values: Float32Array, p: number): number {
  const s = Float32Array.from(values).sort();
  return s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))];
}

export interface Frame {
  w: number;
  h: number;
  J: Float32Array;
  jx: (i: number) => number;
  jy: (i: number) => number;
  sw: number;
  neck: [number, number];
  hip: [number, number];
}

export function frame(input: BodyInput): Frame {
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
export const centreX = (F: Frame, y: number) => lerp1(y, F.neck[1], F.hip[1], F.neck[0], F.hip[0]);

export function mainRun(rs: [number, number][], xc: number): [number, number] {
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

/**
 * Where an arm rests on the body's side (from armSwing): per row, for the body's image-left side
 * (index y) and image-right side (index h + y), how much the arm resting there moves (`v`, unit
 * field) and how much it rests (`c`, 0..1).
 */
export interface ArmRest {
  v: Float32Array;
  c: Float32Array;
  /** How the arm on that side moves at each row (its turn; 0 where it does not turn). */
  arm: Float32Array;
}
