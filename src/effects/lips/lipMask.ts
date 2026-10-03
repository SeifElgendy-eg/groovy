// Lip outline snapped to the photo's real lip border (pure, no DOM, no model).
//
// The landmark outline (20 points around the outer lip) is close to the vermilion border but not on
// it: colour bleeds onto skin at the Cupid's bow or leaves a pale gap. Lips differ from the skin
// next to them mostly in colour, so this learns both colours from the photo itself (lip: just inside
// the outline; skin: just outside it), finds the one direction in OKLab that best separates them
// (Fisher's linear discriminant), then moves each point of a smooth, densified outline along its
// normal to where lip turns into skin. The moves are smoothed along the contour and anchored at the
// mouth corners, so the result is still one clean outline (lipstick has a crisp edge), just in the
// right place. Where lip and skin are too alike to separate reliably, the landmark outline is kept.
import type { Point } from "../../core/types";
import { densify } from "./warpField";
import { srgbToOklab } from "./color";

export interface SnapInput {
  /** The photo (RGBA) over a region at (x0, y0) of size width x height. */
  pixels: Uint8ClampedArray;
  x0: number;
  y0: number;
  width: number;
  height: number;
  /** Landmark contours (display coordinates), 20 points each, in the landmark order. */
  outer: Point[];
  inner: Point[];
}

export interface SnapResult {
  /** The snapped outer outline (densified). */
  outer: Point[];
  /** How separable lip and skin colours were (Fisher's d'); below ~1.2 nothing moved. */
  separation: number;
}

/** How far a point may move, as a fraction of mouth width: inward, outward. */
export const SNAP_REACH: [number, number] = [0.035, 0.02];
/** Points added between landmarks. */
const SUB = 4;

const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

export function snapLipOutline(j: SnapInput): SnapResult {
  const outer = densify(j.outer, SUB),
    inner = densify(j.inner, SUB);
  const n = outer.length;
  const width = Math.hypot(j.outer[10].x - j.outer[0].x, j.outer[10].y - j.outer[0].y);
  const reachIn = Math.max(1.5, width * SNAP_REACH[0]),
    reachOut = Math.max(1, width * SNAP_REACH[1]);

  // OKLab of the photo at a point (bilinear), or null outside the region.
  const sample = (x: number, y: number): [number, number, number] | null => {
    const fx = x - j.x0 - 0.5,
      fy = y - j.y0 - 0.5;
    if (fx < 0 || fy < 0 || fx > j.width - 1.001 || fy > j.height - 1.001) return null;
    const ix = Math.floor(fx),
      iy = Math.floor(fy),
      tx = fx - ix,
      ty = fy - iy;
    const c = [0, 1, 2].map((k) => {
      const at = (xx: number, yy: number) => j.pixels[(yy * j.width + xx) * 4 + k];
      return (at(ix, iy) * (1 - tx) + at(ix + 1, iy) * tx) * (1 - ty) + (at(ix, iy + 1) * (1 - tx) + at(ix + 1, iy + 1) * tx) * ty;
    });
    const o = srgbToOklab(Math.round(c[0]), Math.round(c[1]), Math.round(c[2]));
    return [o.L, o.a, o.b];
  };

  // Outward normal at each outline point (perpendicular to the contour, away from the mouth).
  const normals = outer.map((p, i) => {
    const a = outer[(i - 1 + n) % n],
      b = outer[(i + 1) % n];
    let nx = b.y - a.y,
      ny = -(b.x - a.x);
    const len = Math.hypot(nx, ny) || 1;
    nx /= len;
    ny /= len;
    if (nx * (p.x - inner[i].x) + ny * (p.y - inner[i].y) < 0) {
      nx = -nx;
      ny = -ny;
    }
    return { x: nx, y: ny };
  });
  const thickness = outer.map((p, i) => Math.hypot(p.x - inner[i].x, p.y - inner[i].y));
  // Corners: the landmark corners (densified indices 0 and 10*SUB) stay put; the dark corner crease
  // would otherwise pull the colour along it.
  const cornerWeight = outer.map((_, i) => {
    const k = Math.min(Math.abs(i - 0), Math.abs(i - n), Math.abs(i - 10 * SUB));
    return smoothstep(SUB * 0.5, SUB * 1.75, k);
  });

  // Class statistics from samples along the normals.
  const lip: number[][] = [],
    skin: number[][] = [];
  for (let i = 0; i < n; i++) {
    if (cornerWeight[i] < 0.5) continue;
    const p = outer[i],
      d = normals[i];
    // Inside: well into the lip but never near the mouth opening.
    const depthMax = Math.min(reachIn * 2.2, thickness[i] * 0.45);
    for (let s = reachIn * 0.7; s <= depthMax; s += 1) {
      const c = sample(p.x - d.x * s, p.y - d.y * s);
      if (c) lip.push(c);
    }
    for (let s = reachIn * 1.2; s <= reachIn * 3; s += 1) {
      const c = sample(p.x + d.x * s, p.y + d.y * s);
      if (c) skin.push(c);
    }
  }
  const keep = (separation: number): SnapResult => ({ outer, separation });
  if (lip.length < 30 || skin.length < 30) return keep(0);
  const L = moments(lip),
    S = moments(skin);
  const C = L.c.map((v, i) => (v + S.c[i]) / 2 + (i % 4 === 0 ? 1e-6 : 0));
  const inv = invert3(C);
  if (!inv) return keep(0);
  const dm = [0, 1, 2].map((i) => L.m[i] - S.m[i]);
  const wv = [0, 1, 2].map((i) => inv[i * 3] * dm[0] + inv[i * 3 + 1] * dm[1] + inv[i * 3 + 2] * dm[2]);
  const proj = (x: number[]) => wv[0] * x[0] + wv[1] * x[1] + wv[2] * x[2];
  const tLip = proj(L.m),
    tSkin = proj(S.m);
  let wcw = 0;
  for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) wcw += wv[i] * C[i * 3 + k] * wv[k];
  const separation = (tLip - tSkin) / Math.sqrt(Math.max(1e-12, wcw));
  const trust = smoothstep(1.2, 2.5, separation);
  if (trust <= 0) return keep(separation);
  const mid = (tLip + tSkin) / 2,
    steep = 6 / Math.max(1e-6, tLip - tSkin);
  // Outside the outline, only pixels about as light as the lips can be lip: shadows (the crease
  // under the lower lip, the corners) are dark, however red.
  const lipSdL = Math.sqrt(Math.max(1e-8, L.c[0]));
  const darkest = L.m[0] - 2 * lipSdL;

  // For each point, the offset along its normal that best splits lip (inside) from skin (outside):
  // maximise the running sum of (pLip - 0.5) from the inside out, with a small pull to stay put.
  const step = 0.5;
  const offsets = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (cornerWeight[i] <= 0) continue;
    const p = outer[i],
      d = normals[i];
    let run = 0,
      best = 0,
      bestScore = -Infinity;
    const inLimit = Math.min(reachIn, thickness[i] * 0.4);
    // Score at the very inside start (boundary at -inLimit means nothing inside counts).
    for (let s = -inLimit; s <= reachOut; s += step) {
      const c = sample(p.x + d.x * s, p.y + d.y * s);
      let pl = 0.5;
      if (c) {
        pl = 1 / (1 + Math.exp(-steep * (proj(c) - mid)));
        if (s > 0) pl *= smoothstep(darkest - lipSdL, darkest, c[0]);
      }
      run += pl - 0.5;
      const score = run - 0.02 * Math.abs(s) / step;
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    offsets[i] = best * trust * cornerWeight[i];
  }
  // Smooth the offsets along the contour (Gaussian, ~1 landmark spacing), so the edge stays crisp
  // and clean rather than following every pixel's noise.
  const sm = new Float32Array(n);
  const sig = SUB * 0.6,
    rad = Math.ceil(sig * 3);
  for (let i = 0; i < n; i++) {
    let acc = 0,
      wsum = 0;
    for (let k = -rad; k <= rad; k++) {
      const wgt = Math.exp(-(k * k) / (2 * sig * sig));
      acc += offsets[(i + k + n) % n] * wgt;
      wsum += wgt;
    }
    sm[i] = Math.max(-reachIn, Math.min(reachOut, (acc / wsum) * cornerWeight[i]));
  }
  return {
    outer: outer.map((p, i) => ({ x: p.x + normals[i].x * sm[i], y: p.y + normals[i].y * sm[i] })),
    separation,
  };
}

function moments(xs: number[][]) {
  const m = [0, 0, 0],
    c = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const x of xs) for (let i = 0; i < 3; i++) m[i] += x[i];
  for (let i = 0; i < 3; i++) m[i] /= xs.length;
  for (const x of xs)
    for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) c[i * 3 + k] += (x[i] - m[i]) * (x[k] - m[k]);
  return { m, c: c.map((v) => v / xs.length) };
}

/** Inverse of a 3x3 matrix (row-major), or null if singular. */
function invert3(m: number[]): number[] | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h,
    B = -(d * i - f * g),
    Cc = d * h - e * g;
  const det = a * A + b * B + c * Cc;
  if (Math.abs(det) < 1e-18) return null;
  const r = 1 / det;
  return [
    A * r, -(b * i - c * h) * r, (b * f - c * e) * r,
    B * r, (a * i - c * g) * r, -(a * f - c * d) * r,
    Cc * r, -(a * h - b * g) * r, (a * e - b * d) * r,
  ];
}
