// Lip filler warp as one continuous displacement field (pure maths, no DOM).
//
// The old warp drew ~280 separately clipped Canvas2D triangles: hairline seams along their edges,
// visible kinks between its 6 coarse rings, a full-frame redraw per triangle, and a fixed rim
// (2.2x/2.8x the lip size) that could reach the nose. Here the same lip model is laid out as a fine
// mesh (smooth contours, many rings) and rasterised once into a grid of backward offsets: for every
// output pixel, where in the original frame to read it from. The grid is continuous by
// construction (shared mesh vertices), zero on its border, and is what both the WebGL2 renderer and
// the CPU fallback sample.
import type { Point } from "../../core/types";
import { rollProfile, type LipData, type LipParams } from "./geometry";

export interface Roi {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Backward map sampled on a grid over the ROI: source = p + (dx, dy). */
export interface WarpGrid {
  roi: Roi;
  /** Grid size; node (i, j) sits at roi.x + i * sx, roi.y + j * sy (corners on the ROI's corners). */
  cols: number;
  rows: number;
  sx: number;
  sy: number;
  /** Interleaved dx, dy per node, row-major. */
  data: Float32Array;
}

/** Closed uniform Catmull-Rom resample: `sub` points per original segment (originals kept). */
export function densify(pts: Point[], sub: number): Point[] {
  const n = pts.length;
  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n],
      p1 = pts[i],
      p2 = pts[(i + 1) % n],
      p3 = pts[(i + 2) % n];
    for (let s = 0; s < sub; s++) {
      const t = s / sub,
        t2 = t * t,
        t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push({ x: f(p0.x, p1.x, p2.x, p3.x), y: f(p0.y, p1.y, p2.y, p3.y) });
    }
  }
  return out;
}

const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const smoothstep = (t: number) => t * t * (3 - 2 * t);

/** Rings of corresponding points: ring r, point i is at dst[r][i] and reads from src[r][i]. */
export interface WarpMesh {
  dst: Point[][];
  src: Point[][];
}

/** Rings through the lips, and rings in the skin around them. */
const LIP_RINGS = 12,
  SKIN_RINGS = 8,
  SUBDIVIDE = 4;

/**
 * The lip model as a fine mesh, from the mouth opening (fixed) through the lips (grown, with the
 * "roll" cross-section) to an anchor ring (fixed) whose distance scales with how far the lips
 * moved, so the skin in between is squeezed but never folded.
 */
export function buildMesh(lip: LipData, targetOuter: Point[], p: LipParams): WarpMesh {
  const inner = densify(lip.innerPts, SUBDIVIDE),
    outer = densify(lip.outerPts, SUBDIVIDE),
    tOuter = densify(targetOuter, SUBDIVIDE);
  const pts = lip.outerPts;
  const width = Math.hypot(pts[10].x - pts[0].x, pts[10].y - pts[0].y);
  // Cross-section: a gentle outward roll (see rollProfile).
  const rolled = rollProfile(p.amount, p.roll);
  const dst: Point[][] = [],
    src: Point[][] = [];
  for (let r = 0; r <= LIP_RINGS; r++) {
    const t = r / LIP_RINGS;
    src.push(outer.map((q, i) => lerp(inner[i], q, t)));
    dst.push(tOuter.map((q, i) => lerp(inner[i], q, rolled(t))));
  }
  // Skin: the offset fades from the lip edge's to zero at the anchor along a smoothstep, whose
  // slope peaks at 1.5x. Each anchor's gap scales with how far its own edge point moved (so corners,
  // which barely move, stay tight): at 2x the move, skin is squeezed by at most 75%, never folded.
  const cx = (pts[0].x + pts[10].x) / 2,
    cy = lip.cy;
  const anchor = tOuter.map((q, i) => {
    const gap = width * 0.04 + Math.hypot(q.x - outer[i].x, q.y - outer[i].y) * 2;
    const dx = q.x - cx,
      dy = q.y - cy;
    const len = Math.hypot(dx, dy) || 1;
    return { x: q.x + (dx / len) * gap, y: q.y + (dy / len) * gap };
  });
  for (let r = 1; r <= SKIN_RINGS; r++) {
    const u = r / SKIN_RINGS,
      keep = 1 - smoothstep(u);
    const ring = tOuter.map((q, i) => lerp(q, anchor[i], u));
    dst.push(ring);
    src.push(ring.map((q, i) => ({ x: q.x + (outer[i].x - tOuter[i].x) * keep, y: q.y + (outer[i].y - tOuter[i].y) * keep })));
  }
  return { dst, src };
}

/** The area the warp touches: the anchor ring's bounds (plus a pixel), clamped to the image. */
export function warpRoi(mesh: WarpMesh, w: number, h: number): Roi {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const ring of mesh.dst)
    for (const q of ring) {
      minX = Math.min(minX, q.x);
      minY = Math.min(minY, q.y);
      maxX = Math.max(maxX, q.x);
      maxY = Math.max(maxY, q.y);
    }
  const x = Math.max(0, Math.floor(minX) - 1),
    y = Math.max(0, Math.floor(minY) - 1);
  return {
    x,
    y,
    w: Math.max(0, Math.min(w, Math.ceil(maxX) + 1) - x),
    h: Math.max(0, Math.min(h, Math.ceil(maxY) + 1) - y),
  };
}

/**
 * Rasterise the mesh's backward offsets onto a grid over the ROI (barycentric interpolation per
 * triangle). Nodes outside the mesh (the mouth opening, beyond the anchors) stay zero, which is
 * also the mesh's own value on those boundaries, so the field is continuous everywhere.
 */
export function sampleGrid(mesh: WarpMesh, roi: Roi, maxNodes = 256): WarpGrid {
  const step = Math.max(1.5, Math.max(roi.w, roi.h) / maxNodes);
  const cols = Math.max(2, Math.ceil(roi.w / step) + 1),
    rows = Math.max(2, Math.ceil(roi.h / step) + 1);
  const sx = roi.w / (cols - 1) || 1,
    sy = roi.h / (rows - 1) || 1;
  const data = new Float32Array(cols * rows * 2);
  const tri = (a: Point, b: Point, c: Point, oa: Point, ob: Point, oc: Point) => {
    const det = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
    if (Math.abs(det) < 1e-9) return;
    const i0 = Math.max(0, Math.ceil((Math.min(a.x, b.x, c.x) - roi.x) / sx)),
      i1 = Math.min(cols - 1, Math.floor((Math.max(a.x, b.x, c.x) - roi.x) / sx));
    const j0 = Math.max(0, Math.ceil((Math.min(a.y, b.y, c.y) - roi.y) / sy)),
      j1 = Math.min(rows - 1, Math.floor((Math.max(a.y, b.y, c.y) - roi.y) / sy));
    for (let j = j0; j <= j1; j++) {
      const py = roi.y + j * sy;
      for (let i = i0; i <= i1; i++) {
        const px = roi.x + i * sx;
        const l1 = ((px - a.x) * (c.y - a.y) - (c.x - a.x) * (py - a.y)) / det;
        const l2 = ((b.x - a.x) * (py - a.y) - (px - a.x) * (b.y - a.y)) / det;
        const l0 = 1 - l1 - l2;
        if (l0 < -1e-6 || l1 < -1e-6 || l2 < -1e-6) continue;
        const k = (j * cols + i) * 2;
        data[k] = l0 * oa.x + l1 * ob.x + l2 * oc.x;
        data[k + 1] = l0 * oa.y + l1 * ob.y + l2 * oc.y;
      }
    }
  };
  const { dst, src } = mesh;
  const off = (r: number, i: number): Point => ({ x: src[r][i].x - dst[r][i].x, y: src[r][i].y - dst[r][i].y });
  for (let r = 0; r + 1 < dst.length; r++) {
    const n = dst[r].length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      tri(dst[r][i], dst[r + 1][i], dst[r + 1][j], off(r, i), off(r + 1, i), off(r + 1, j));
      tri(dst[r][i], dst[r + 1][j], dst[r][j], off(r, i), off(r + 1, j), off(r, j));
    }
  }
  return { roi, cols, rows, sx, sy, data };
}

/** Bilinear lookup of the grid at ROI-local position (px, py). */
export function gridOffset(g: WarpGrid, px: number, py: number): [number, number] {
  const fx = Math.max(0, Math.min(g.cols - 1, px / g.sx)),
    fy = Math.max(0, Math.min(g.rows - 1, py / g.sy));
  const i = Math.min(g.cols - 2, Math.floor(fx)),
    j = Math.min(g.rows - 2, Math.floor(fy));
  const tx = fx - i,
    ty = fy - j;
  const at = (a: number, b: number, c: number) => g.data[(b * g.cols + a) * 2 + c];
  const mix = (c: number) =>
    (at(i, j, c) * (1 - tx) + at(i + 1, j, c) * tx) * (1 - ty) +
    (at(i, j + 1, c) * (1 - tx) + at(i + 1, j + 1, c) * tx) * ty;
  return [mix(0), mix(1)];
}

/** In stretched lip areas: share of the magnified (streaky) detail removed at full effect... */
export const STRETCH_RELAX = 0.7;
/** ...which is reached at this much extra area (0.6 = 1.6x). */
export const STRETCH_FULL_AT = 0.6;
/** ...the detail's scale, as a mipmap level (1.7 ~ a 4 px low-pass)... */
export const STRETCH_LOD = 1.7;
/** ...and the fine grain added back there (0..1 units; ~4 levels of 255). */
export const STRETCH_GRAIN = 0.015;

/** Integer hash grain in -0.5..0.5, identical to the shader's (fixed to frame coordinates). */
export function grain(x: number, y: number): number {
  let h = (Math.imul(x >>> 0, 374761393) + Math.imul(y >>> 0, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return (h & 1023) / 1023 - 0.5;
}

/**
 * CPU version of the warp (used when WebGL2 is unavailable): `src` holds the ROI of the frame;
 * returns the warped ROI. Bilinear sampling, clamped at the ROI's edges. Stretched areas get the
 * same detail relaxing and grain as the shader (glWarp.ts).
 */
export function warpPixelsCpu(src: Uint8ClampedArray, g: WarpGrid): Uint8ClampedArray {
  const { w, h } = g.roi;
  const out = new Uint8ClampedArray(src.length);
  const px = [0, 0, 0];
  const at = (sx: number, sy: number, rgb: number[]) => {
    sx = Math.max(0, Math.min(w - 1, sx - 0.5));
    sy = Math.max(0, Math.min(h - 1, sy - 0.5));
    const x0 = Math.floor(sx),
      y0 = Math.floor(sy);
    const x1 = Math.min(w - 1, x0 + 1),
      y1 = Math.min(h - 1, y0 + 1);
    const tx = sx - x0,
      ty = sy - y0;
    for (let c = 0; c < 3; c++) {
      const a = src[(y0 * w + x0) * 4 + c] * (1 - tx) + src[(y0 * w + x1) * 4 + c] * tx;
      const b = src[(y1 * w + x0) * 4 + c] * (1 - tx) + src[(y1 * w + x1) * 4 + c] * tx;
      rgb[c] = a * (1 - ty) + b * ty;
    }
  };
  // Low-pass copy at the lip-line scale (two box passes of radius 2 ~ the shader's mip level).
  const low = boxBlurRgba(src, w, h, 2, 2);
  const at2 = (sx: number, sy: number, rgb: number[]) => {
    sx = Math.max(0, Math.min(w - 1, sx - 0.5));
    sy = Math.max(0, Math.min(h - 1, sy - 0.5));
    const x0 = Math.floor(sx),
      y0 = Math.floor(sy);
    const x1 = Math.min(w - 1, x0 + 1),
      y1 = Math.min(h - 1, y0 + 1);
    const tx = sx - x0,
      ty = sy - y0;
    for (let c = 0; c < 3; c++) {
      const a = low[(y0 * w + x0) * 4 + c] * (1 - tx) + low[(y0 * w + x1) * 4 + c] * tx;
      const b = low[(y1 * w + x0) * 4 + c] * (1 - tx) + low[(y1 * w + x1) * 4 + c] * tx;
      rgb[c] = a * (1 - ty) + b * ty;
    }
  };
  const t = [0, 0, 0];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const qx = x + 0.5,
        qy = y + 0.5;
      const [ox, oy] = gridOffset(g, qx, qy);
      const sx = qx + ox,
        sy = qy + oy;
      at(sx, sy, px);
      const [ax, ay] = gridOffset(g, qx + 1, qy),
        [bx, by] = gridOffset(g, qx - 1, qy),
        [cx, cy] = gridOffset(g, qx, qy + 1),
        [dx, dy] = gridOffset(g, qx, qy - 1);
      const det = (1 + (ax - bx) / 2) * (1 + (cy - dy) / 2) - ((ay - by) / 2) * ((cx - dx) / 2);
      const k = Math.max(0, Math.min(1, (1 / Math.max(det, 0.05) - 1) / STRETCH_FULL_AT));
      if (k > 0) {
        at2(sx, sy, t);
        const n = grain(x + g.roi.x, y + g.roi.y) * STRETCH_GRAIN * 255 * k;
        for (let c = 0; c < 3; c++) px[c] = t[c] + (px[c] - t[c]) * (1 - STRETCH_RELAX * k) + n;
      }
      const o = (y * w + x) * 4;
      out[o] = px[0];
      out[o + 1] = px[1];
      out[o + 2] = px[2];
      out[o + 3] = src[o + 3];
    }
  return out;
}

/** Separable box blur of an RGBA image (radius r, `passes` times), as floats. */
function boxBlurRgba(src: Uint8ClampedArray, w: number, h: number, r: number, passes: number): Float32Array {
  let cur = Float32Array.from(src);
  const tmp = new Float32Array(src.length);
  const norm = 1 / (2 * r + 1);
  for (let pass = 0; pass < passes; pass++) {
    for (let y = 0; y < h; y++)
      for (let c = 0; c < 3; c++) {
        let acc = 0;
        for (let k = -r; k <= r; k++) acc += cur[(y * w + Math.min(w - 1, Math.max(0, k))) * 4 + c];
        for (let x = 0; x < w; x++) {
          tmp[(y * w + x) * 4 + c] = acc * norm;
          acc += cur[(y * w + Math.min(w - 1, x + r + 1)) * 4 + c] - cur[(y * w + Math.max(0, x - r)) * 4 + c];
        }
      }
    const out = new Float32Array(src.length);
    for (let x = 0; x < w; x++)
      for (let c = 0; c < 3; c++) {
        let acc = 0;
        for (let k = -r; k <= r; k++) acc += tmp[(Math.min(h - 1, Math.max(0, k)) * w + x) * 4 + c];
        for (let y = 0; y < h; y++) {
          out[(y * w + x) * 4 + c] = acc * norm;
          acc += tmp[(Math.min(h - 1, y + r + 1) * w + x) * 4 + c] - tmp[(Math.max(0, y - r) * w + x) * 4 + c];
        }
      }
    cur = out;
  }
  return cur;
}
