// Botox: find expression lines and soften them (pure, runs in the skin worker).
//
// Botox relaxes the muscles behind dynamic lines, so the lines soften (typically by 70-80%) while
// the skin itself (pores, freckles, sun spots, texture) is untouched. So this does not blur an
// area: it finds the lines. A line is a dark valley that is long in one direction (a Hessian
// "ridge" measure at two widths, fine and deep), running the way lines run in each treated area:
// across the forehead, up and down between the brows, fanning out from the eye corner. Round dark
// spots (freckles) and pores are not lines and are left alone. Each area returns its own
// correction layers, so the caller can switch areas on and off and set the dose without a recompute.
import { blurLike, slide } from "../acne/texture";

type Pixels = Uint8ClampedArray<ArrayBuffer>;

export type AreaId = "forehead" | "frown" | "crows";

/** A treated area: a soft ellipse, and the direction its lines run (fixed, or fanning out). */
export interface Zone {
  id: AreaId;
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  /** Ellipse rotation (radians). */
  angle: number;
  /** Lines run at this angle (radians)... */
  lineAngle?: number;
  /** ...or fan out from this point (crow's feet). */
  from?: { x: number; y: number };
  /** Direction tolerance (degrees): fully treated within the first, nothing past the second. */
  tolerance?: [number, number];
}

export interface LinesJob {
  /** Face crop at full resolution (RGBA) and its treatable-skin mask (alpha). */
  pixels: Pixels;
  mask: Pixels;
  width: number;
  height: number;
  faceWidth: number;
  zones: Zone[];
}

export interface Layers {
  mul: Pixels;
  add: Pixels;
}

export type LinesResult = Record<AreaId, Layers>;

/** Share of a line's depth removed at full dose (botox softens, it does not erase). */
export const MAX_SOFTEN = 0.78;
/** Depth (levels below the skin around it) over which a dip goes from "grain" to "line". */
export const MIN_DEPTH: [number, number] = [3, 8];
/** A line within this angle of the area's expected direction is fully treated (degrees)... */
export const DIRECTION_TOLERANCE = 25;
/** ...falling to nothing at this angle. */
export const DIRECTION_LIMIT = 50;

const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * Valley-line strength and direction at one width: from the Hessian of the lightness blurred at
 * `sigma`. A dark line curves up strongly across it and hardly along it.
 */
function lineness(lum: Float32Array, w: number, h: number, sigma: number) {
  const g = blurLike(lum, w, h, sigma);
  const n = w * h;
  const strength = new Float32Array(n),
    dir = new Float32Array(n),
    blob = new Float32Array(n);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      const hxx = g[p - 1] - 2 * g[p] + g[p + 1];
      const hyy = g[p - w] - 2 * g[p] + g[p + w];
      const hxy = (g[p + w + 1] - g[p + w - 1] - g[p - w + 1] + g[p - w - 1]) / 4;
      const mean = (hxx + hyy) / 2,
        diff = Math.sqrt(((hxx - hyy) / 2) ** 2 + hxy * hxy);
      const across = mean + diff, // curvature across the line (> 0 for a dark valley)
        along = mean - diff;
      // A dark spot curves up both ways (freckle, mole).
      if (along > 0) blob[p] = along * sigma * sigma;
      // Long, not round: strong curvature across, little along (freckles curve both ways).
      const s = across - Math.abs(along);
      if (s <= 0) continue;
      strength[p] = s * sigma * sigma; // scale-normalised, so both widths compare
      // Direction of strongest curvature; the line runs perpendicular to it.
      dir[p] = 0.5 * Math.atan2(2 * hxy, hxx - hyy) + Math.PI / 2;
    }
  return { strength, dir, blob };
}

/** Soft ellipse weight: 1 inside, fading to 0 over the outer `feather` of its radius. */
function ellipseWeight(z: Zone, x: number, y: number, feather = 0.35): number {
  const c = Math.cos(z.angle),
    s = Math.sin(z.angle);
  const dx = x - z.cx,
    dy = y - z.cy;
  const u = (dx * c + dy * s) / z.rx,
    v = (-dx * s + dy * c) / z.ry;
  const r = Math.sqrt(u * u + v * v);
  return 1 - smoothstep(1 - feather, 1, r);
}

export function linesCompute(j: LinesJob): LinesResult {
  const { pixels, mask, width: w, height: h, faceWidth: fw } = j;
  const n = w * h;
  const lum = new Float32Array(n);
  for (let p = 0; p < n; p++) lum[p] = 0.2126 * pixels[p * 4] + 0.7152 * pixels[p * 4 + 1] + 0.0722 * pixels[p * 4 + 2];

  // Two line widths: fine lines and deeper folds.
  const fine = lineness(lum, w, h, Math.max(0.8, fw * 0.0028));
  const deep = lineness(lum, w, h, Math.max(1.5, fw * 0.0065));
  const strength = new Float32Array(n),
    dir = new Float32Array(n),
    spots = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    const useDeep = deep.strength[p] > fine.strength[p];
    strength[p] = useDeep ? deep.strength[p] : fine.strength[p];
    dir[p] = useDeep ? deep.dir[p] : fine.dir[p];
    spots[p] = Math.max(fine.blob[p], deep.blob[p]);
  }
  // Round dark spots light up the line measure on their rims; find each spot (its centre curves
  // both ways) and switch the treatment off over its whole extent.
  const spotR = Math.max(2, Math.round(fw * 0.008));
  const spotNear = slide(slide(spots, w, h, spotR, true, false), w, h, spotR, true, true);

  // How far below its surroundings each pixel is (the depth a line would be filled by).
  // (The pixel's own lightness: even the smallest blur would make the line look shallower.)
  const near = lum;
  const around = blurLike(lum, w, h, Math.max(3, fw * 0.02));
  // Surrounding skin colour, so a lifted crease takes the skin's colour (not its own darker,
  // more saturated one, which would leave orange-brown streaks).
  const skin = [0, 1, 2].map((c) => {
    const v = new Float32Array(n);
    for (let p = 0; p < n; p++) v[p] = pixels[p * 4 + c];
    return blurLike(v, w, h, Math.max(3, fw * 0.02));
  });

  const tolLo = Math.cos((DIRECTION_LIMIT * Math.PI) / 180),
    tolHi = Math.cos((DIRECTION_TOLERANCE * Math.PI) / 180);
  const result = {} as LinesResult;
  for (const id of ["forehead", "frown", "crows"] as AreaId[]) {
    const zones = j.zones.filter((z) => z.id === id);
    const fill = new Float32Array(n),
      weight = new Float32Array(n);
    // Relative threshold: this area's own line strengths decide what counts as a clear line,
    // so exposure and skin tone matter less.
    const inZone: number[] = [];
    for (let p = 0; p < n; p += 3) {
      const x = p % w,
        y = (p / w) | 0;
      if (strength[p] > 0 && mask[p * 4 + 3] > 128 && zones.some((z) => ellipseWeight(z, x, y, 0) > 0)) inZone.push(strength[p]);
    }
    inZone.sort((a, b) => a - b);
    const ref = inZone.length ? inZone[Math.floor(inZone.length * 0.9)] : 1;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        const m = mask[p * 4 + 3] / 255;
        if (m <= 0 || strength[p] <= 0) continue;
        let zw = 0,
          dw = 0;
        for (const z of zones) {
          const e = ellipseWeight(z, x, y);
          if (e <= 0) continue;
          const expected = z.from ? Math.atan2(y - z.from.y, x - z.from.x) : (z.lineAngle ?? 0);
          const [lo, hi] = z.tolerance ? [Math.cos((z.tolerance[1] * Math.PI) / 180), Math.cos((z.tolerance[0] * Math.PI) / 180)] : [tolLo, tolHi];
          const d = smoothstep(lo, hi, Math.abs(Math.cos(dir[p] - expected)));
          if (e * d > zw * dw) {
            zw = e;
            dw = d;
          }
        }
        if (zw <= 0 || dw <= 0) continue;
        const notSpot = 1 - smoothstep(0.35, 0.7, spotNear[p] / Math.max(1e-6, strength[p] + spotNear[p]));
        const isLine = smoothstep(0.12, 0.45, strength[p] / Math.max(1e-6, ref)) * notSpot;
        weight[p] = isLine * dw * zw * m;
      }
    // The line mask, widened to cover the whole line (its centre is where the measure peaks).
    const r = Math.max(1, Math.round(fw * 0.0025));
    const cover = slide(slide(weight, w, h, r, true, false), w, h, r, true, true);
    // The skin level around each line, leaving the lines themselves out of the average
    // (normalised convolution): the depth is then right at the line's centre and zero beside it,
    // so the fill never leaves a light halo next to a line.
    const sig = Math.max(3, fw * 0.02);
    const keep = new Float32Array(n),
      keepLum = new Float32Array(n);
    for (let p = 0; p < n; p++) {
      keep[p] = 1 - Math.min(1, cover[p]);
      keepLum[p] = lum[p] * keep[p];
    }
    const num = blurLike(keepLum, w, h, sig),
      den = blurLike(keep, w, h, sig);
    for (let p = 0; p < n; p++) {
      if (cover[p] <= 0) continue;
      const skinLevel = den[p] > 1e-3 ? num[p] / den[p] : around[p];
      const depth = Math.max(0, skinLevel - near[p]);
      // Skin grain dips a few levels; a line is deeper than that.
      fill[p] = depth * smoothstep(MIN_DEPTH[0], MIN_DEPTH[1], depth) * Math.min(1, cover[p]) * MAX_SOFTEN;
    }
    result[id] = toLayers(pixels, lum, fill, skin);
  }
  return result;
}

/** Lighten by `fill` per pixel; the more a pixel is lifted, the more it takes the skin's colour. */
function toLayers(pixels: Pixels, lum: Float32Array, fill: Float32Array, skin: Float32Array[]): Layers {
  const n = lum.length;
  const mul = new Uint8ClampedArray(n * 4).fill(255);
  const add = new Uint8ClampedArray(n * 4);
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    add[i + 3] = 255;
    const f = fill[p];
    if (f < 0.25 || lum[p] < 1) continue;
    const target = lum[p] + f;
    const sl = 0.2126 * skin[0][p] + 0.7152 * skin[1][p] + 0.0722 * skin[2][p];
    const a = Math.min(0.6, f / 12);
    for (let c = 0; c < 3; c++) {
      const v = pixels[i + c];
      const own = v / lum[p],
        ref = sl > 1 ? skin[c][p] / sl : own;
      const d = target * (own * (1 - a) + ref * a) - v;
      if (d < 0) mul[i + c] = Math.round((255 * (v + d)) / Math.max(1, v));
      else add[i + c] = d;
    }
  }
  return { mul, add };
}
