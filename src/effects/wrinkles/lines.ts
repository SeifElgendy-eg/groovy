// Botox: find expression lines and soften them (pure, runs in the skin worker).
//
// Botox relaxes the muscles behind dynamic lines, so the lines soften (typically by 70-80%) while
// the skin itself (pores, freckles, sun spots, texture) is untouched. So this does not blur an
// area: it finds the lines. A line is a dark valley that is long in one direction (a Hessian
// "ridge" measure at two widths, fine and deep), running the way lines run in each treated area:
// across the forehead, up and down between the brows, fanning out from the eye corner. Round dark
// spots (freckles) and pores are not lines and are left alone. Each area returns its own
// correction layers, so the caller can switch areas on and off and set the dose without a recompute.
import { blobWeight, blurLike, slide } from "../acne/texture";

type Pixels = Uint8ClampedArray<ArrayBuffer>;

export type AreaId = "forehead" | "frown" | "crows" | "undereye";
export const AREAS: AreaId[] = ["forehead", "frown", "crows", "undereye"];

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
  /** Lines here are very fine (crepe under the eyes, crow's feet): soften finer detail too. */
  fine?: boolean;
  /**
   * Only lines in this zone's direction are touched, no texture softening (next to the lid:
   * lashes are thin dark lines too, but they cross the lid; the under-lid line runs along it).
   */
  strict?: boolean;
  /** Lines here run every way (under the eyes): no direction preference. */
  anyDirection?: boolean;
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
export const MAX_SOFTEN = 1;
/** Share of the raised ridge between deep lines lowered at full dose (the fold's other half). */
export const RIDGE_FLATTEN = 0.95;
/** Ridges brighter than this above the skin are shine; only this much of them is lowered. */
export const RIDGE_CAP = 35;
/** Share of the mid band (crepey texture between lines) softened at full dose. */
export const TEXTURE_SOFTEN = 0.95;
/** Share of the line-shaped finest detail (faint leftover lines) removed at full dose. */
export const FINEST_LINES = 0.85;
/** Share of the fine detail replaced by fresh grain at full dose (main areas). */
export const GRAIN_REPLACE = 0.65;
/** Largest lift of a line (levels). */
export const MAX_LIFT = 45;
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
    blob = new Float32Array(n),
    bright = new Float32Array(n),
    brightDir = new Float32Array(n);
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
      // A thin bright line (the lit edge of a crease) curves down across it, hardly along it.
      const b = -along - Math.abs(across);
      if (b > 0) {
        bright[p] = b * sigma * sigma;
        brightDir[p] = 0.5 * Math.atan2(2 * hxy, hxx - hyy);
      }
      // Long, not round: strong curvature across, little along (freckles curve both ways).
      const s = across - Math.abs(along);
      if (s <= 0) continue;
      strength[p] = s * sigma * sigma; // scale-normalised, so both widths compare
      // Direction of strongest curvature; the line runs perpendicular to it.
      dir[p] = 0.5 * Math.atan2(2 * hxy, hxx - hyy) + Math.PI / 2;
    }
  return { strength, dir, blob, bright, brightDir };
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
  // Three widths: fine lines, deeper lines, and broad folds (e.g. a raised-brow forehead).
  const fine = lineness(lum, w, h, Math.max(0.8, fw * 0.0028));
  const deep = lineness(lum, w, h, Math.max(1.5, fw * 0.0065));
  const fold = lineness(lum, w, h, Math.max(2.5, fw * 0.013));
  const scales = [fine, deep, fold];
  // Lightness at each width's own scale: depth is measured on these, so the correction is smooth
  // and the skin's texture stays on top of it (inside a filled fold too).
  const smooth = [0.0014, 0.003, 0.0065].map((k) => blurLike(lum, w, h, Math.max(0.5, fw * k)));
  const strength = new Float32Array(n),
    dir = new Float32Array(n),
    spots = new Float32Array(n),
    level = new Float32Array(n),
    edge = new Float32Array(n),
    edgeDir = new Float32Array(n);
  // Each width is judged against its own typical strength on this face (90th percentile over
  // the skin), so the broad width cannot drown the fine lines just by being broad.
  const scaleRef = scales.map((sc) => percentile(sc.strength, mask, j.zones, w, h, 0.9));
  for (let p = 0; p < n; p++) {
    let k = 0;
    const rel = scales.map((sc, i) => sc.strength[p] / scaleRef[i]);
    // A wider width wins only when it clearly dominates (a broad fold, not a fine line).
    for (let i = 1; i < 3; i++) if (rel[i] > rel[k] * 1.5) k = i;
    strength[p] = rel[k];
    dir[p] = scales[k].dir[p];
    // Depth on a copy one step finer than the line's width: fine lines stay deep enough to fill,
    // broad folds keep their skin texture on top.
    level[p] = k === 0 ? lum[p] : smooth[k - 1][p];
    spots[p] = Math.max(fine.blob[p], deep.blob[p]);
    const bk = deep.bright[p] > fine.bright[p] ? deep : fine;
    edge[p] = bk.bright[p];
    edgeDir[p] = bk.brightDir[p];
  }
  // Round dark spots light up the line measure on their rims; find each spot (its centre curves
  // both ways) and switch the treatment off over its whole extent.
  const spotR = Math.max(2, Math.round(fw * 0.008));
  // A freckle or mole stands alone; where several lines meet (crow's feet at the eye corner) the
  // junction is round and dark too, but has lines running out of it: those are not protected.
  // Line signal in a ring around each spot, ignoring the spot's own rim (which lights up the line
  // measure too): normalised blur of the line strength with the spot areas left out.
  const rawNear = slide(slide(spots, w, h, Math.round(spotR * 1.5), true, false), w, h, Math.round(spotR * 1.5), true, true);
  const spotRef = percentile(spots, mask, j.zones, w, h, 0.9);
  const ringKeep = new Float32Array(n),
    ringLine = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    ringKeep[p] = 1 - smoothstep(0.15, 0.4, rawNear[p] / Math.max(1e-6, spotRef));
    ringLine[p] = strength[p] * ringKeep[p];
  }
  const ringNum = blurLike(ringLine, w, h, spotR * 3),
    ringDen = blurLike(ringKeep, w, h, spotR * 3);
  const isolated = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    const around = ringDen[p] > 1e-3 ? ringNum[p] / ringDen[p] : 0;
    isolated[p] = spots[p] * (1 - smoothstep(0.25, 0.6, around));
  }
  const spotNear = slide(slide(isolated, w, h, spotR, true, false), w, h, spotR, true, true);

  // How far below its surroundings each pixel is (the depth a line would be filled by).
  // (The pixel's own lightness: even the smallest blur would make the line look shallower.)
  const near = lum;
  const around = blurLike(lum, w, h, Math.max(3, fw * 0.02));
  // Surrounding skin colour, so a lifted crease takes the skin's colour (not its own darker,
  // more saturated one, which would leave orange-brown streaks).
  // (Shine and creases are left out: the reference is the plain skin's colour, so lowered shine
  // does not turn grey and lifted creases do not turn orange.)
  const plain = new Float32Array(n);
  for (let p = 0; p < n; p++) plain[p] = Math.abs(lum[p] - around[p]) <= MIN_DEPTH[1] ? 1 : 0; // no shine, no creases
  const plainW = blurLike(plain, w, h, Math.max(3, fw * 0.02));
  const skin = [0, 1, 2].map((c) => {
    const v = new Float32Array(n);
    for (let p = 0; p < n; p++) v[p] = pixels[p * 4 + c] * plain[p];
    const b = blurLike(v, w, h, Math.max(3, fw * 0.02));
    for (let p = 0; p < n; p++) b[p] = plainW[p] > 1e-3 ? b[p] / plainW[p] : pixels[p * 4 + c];
    return b;
  });
  // Frequency separation: the mid band (lines and crepey texture) is what botox softens; the fine
  // band (pores, grain) and the low band (the face's shading) are kept.
  const fineTop = blurLike(lum, w, h, Math.max(0.8, fw * 0.0022));
  // For fine-line areas only the very finest grain is kept.
  const finestTop = blurLike(lum, w, h, Math.max(0.5, fw * 0.0009));
  // The faint lines left in the finest grain: line-shaped detail (pores and grain are round or
  // random, lines are long), with its direction for the strict zones.
  const lineShaped = blobWeight(lum, w, h, Math.max(1, fw * 0.003));
  for (let p = 0; p < n; p++) lineShaped[p] = 1 - lineShaped[p];
  const lowBand = blurLike(lum, w, h, Math.max(3, fw * 0.012));
  const fineBand = new Float32Array(n);
  for (let p = 0; p < n; p++) fineBand[p] = lum[p] - fineTop[p];
  // Fresh grain for the treated skin: the face's own fine texture grew along its creases and
  // keeps tracing them, so it is replaced by new, directionless grain of the same scale and
  // strength as this face's least-lined skin.
  const donorGrain = synthGrain(fineBand, lineShaped, mask, w, h, fw);
  const spotFree = new Float32Array(n);
  for (let p = 0; p < n; p++) spotFree[p] = 1 - smoothstep(0.35, 0.7, spotNear[p] / Math.max(1e-6, strength[p] * scaleRef[0] + spotNear[p]));

  const tolLo = Math.cos((DIRECTION_LIMIT * Math.PI) / 180),
    tolHi = Math.cos((DIRECTION_TOLERANCE * Math.PI) / 180);
  const result = {} as LinesResult;
  // Areas overlap (forehead and frown lines between the brows; crow's feet and under-eyes). Each
  // area's layer is computed from the original photo and they are drawn on top of each other, so
  // in an overlap the correction would be applied twice (pale streaks). Each pixel's correction is
  // shared out instead: mostly to the area it is most central to, summing to one.
  const areaWeight = {} as Record<AreaId, Float32Array>;
  for (const id of AREAS) {
    const zs = j.zones.filter((z) => z.id === id);
    const e = new Float32Array(n);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let m = 0;
        for (const z of zs) m = Math.max(m, ellipseWeight(z, x, y));
        e[y * w + x] = m * m;
      }
    areaWeight[id] = e;
  }
  const shareOf = (id: AreaId, p: number) => {
    let sum = 0;
    for (const a of AREAS) sum += areaWeight[a][p];
    return sum > 1e-6 ? areaWeight[id][p] / Math.max(sum, areaWeight[id][p]) : 0;
  };
  for (const id of AREAS) {
    const zones = j.zones.filter((z) => z.id === id);
    const fill = new Float32Array(n),
      weight = new Float32Array(n),
      edgeWeight = new Float32Array(n);
    const ref = 1; // strengths are already relative to their width's typical value
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
          let d = z.anyDirection ? 1 : smoothstep(lo, hi, Math.abs(Math.cos(dir[p] - expected)));
          // By the lid, the finest width must agree too: a row of lashes reads as one dark band
          // along the lid at the broad widths, but at the finest width each lash crosses it.
          if (z.strict) d *= smoothstep(lo, hi, Math.abs(Math.cos(fine.dir[p] - expected))) * (fine.strength[p] > 0 ? 1 : 0);
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
    // Thin bright crease edges running the area's way (relative threshold as for lines).
    const edgeRef = percentile(edge, mask, zones, w, h, 0.9);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        const m = mask[p * 4 + 3] / 255;
        if (m <= 0 || edge[p] <= 0) continue;
        let best = 0;
        for (const z of zones) {
          const e = ellipseWeight(z, x, y);
          if (e <= 0) continue;
          const expected = z.from ? Math.atan2(y - z.from.y, x - z.from.x) : (z.lineAngle ?? 0);
          const [lo, hi] = z.tolerance ? [Math.cos((z.tolerance[1] * Math.PI) / 180), Math.cos((z.tolerance[0] * Math.PI) / 180)] : [tolLo, tolHi];
          best = Math.max(best, e * (z.anyDirection ? 1 : smoothstep(lo, hi, Math.abs(Math.cos(edgeDir[p] - expected)))));
        }
        edgeWeight[p] = best * smoothstep(0.35, 0.8, edge[p] / Math.max(1e-6, edgeRef)) * m;
      }
    // The line mask, widened to cover the whole line (its centre is where the measure peaks).
    const r = Math.max(1, Math.round(fw * 0.0025));
    const cover = slide(slide(weight, w, h, r, true, false), w, h, r, true, true);
    // Main areas: the plain skin level, with lines (and bright ridges, clipped) left out of the
    // average. Each pixel there goes to this level plus fresh grain: one target, so nothing stacks.
    const sb = Math.max(5, fw * 0.032);
    const exW = new Float32Array(n),
      exL = new Float32Array(n);
    for (let p = 0; p < n; p++) {
      exW[p] = 1 - Math.min(1, cover[p]);
      exL[p] = Math.min(lum[p], around[p] + MIN_DEPTH[1]) * exW[p];
    }
    const baseNum = blurLike(exL, w, h, sb),
      baseDen = blurLike(exW, w, h, sb);
    // The skin level around each line, leaving the lines (and the shine) out of the average
    // (normalised convolution): the depth is then right at the line's centre and zero beside it,
    // so the fill never leaves a light halo next to a line.
    const sig = Math.max(3, fw * 0.03);
    const keep = new Float32Array(n),
      keepLum = new Float32Array(n);
    for (let p = 0; p < n; p++) {
      keep[p] = 1 - Math.min(1, cover[p]);
      // Bright ridges and shine are clipped too, so the skin level is the plain skin's (else
      // a ridge measures less raised than it is).
      keepLum[p] = Math.min(lum[p], around[p] + MIN_DEPTH[1]) * keep[p];
    }
    const num = blurLike(keepLum, w, h, sig),
      den = blurLike(keep, w, h, sig);
    // Next to lines (within a fold's width), the raised ridges between them: lowering those is
    // the other half of flattening a fold. Elsewhere bright bumps are highlights and stay.
    const rf = Math.max(2, Math.round(fw * 0.02));
    const ridgeLevel = smooth[2];
    const r1 = Math.max(1, Math.round(fw * 0.002));
    const onEdge = slide(slide(edgeWeight, w, h, r1, true, false), w, h, r1, true, true);
    const nearLine = blurLike(slide(slide(weight, w, h, rf, true, false), w, h, rf, true, true), w, h, Math.max(1, fw * 0.006));
    for (let p = 0; p < n; p++) {
      const skinLevel = den[p] > 1e-3 ? num[p] / den[p] : around[p];
      // The softened mid band everywhere in the area: dark detail fully on lines, partly elsewhere
      // (crepey texture); bright detail only near lines (ridges), never shine beyond RIDGE_CAP.
      const x = p % w,
        y = (p / w) | 0;
      let zone = 0,
        fineZone = 0,
        loose = 0,
        looseSoft = 0,
        strictOk = 0;
      for (const z of zones) {
        const e = ellipseWeight(z, x, y);
        if (e <= 0) continue;
        if (z.strict) {
          const expected = z.lineAngle ?? 0;
          const [lo, hi] = z.tolerance ? [Math.cos((z.tolerance[1] * Math.PI) / 180), Math.cos((z.tolerance[0] * Math.PI) / 180)] : [tolLo, tolHi];
          strictOk = Math.max(strictOk, e * smoothstep(lo, hi, Math.abs(Math.cos(fine.dir[p] - expected))) * (fine.strength[p] > 0 ? 1 : 0));
        } else {
          loose = Math.max(loose, e);
          looseSoft = Math.max(looseSoft, ellipseWeight(z, x, y, 0.7));
        }
        zone = Math.max(zone, e);
        if (z.fine) fineZone = Math.max(fineZone, e);
      }
      const m = mask[p * 4 + 3] / 255;
      let band = 0;
      if (zone > 0 && m > 0) {
        const top = fineTop[p] + (finestTop[p] - fineTop[p]) * fineZone;
        const mid = top - lowBand[p];
        const onLine = Math.min(1, cover[p]);
        // Texture is softened in loose zones only; strict zones (by the lid) soften only lines.
        band =
          mid < 0
            ? -mid * MAX_SOFTEN * Math.max(TEXTURE_SOFTEN * loose, onLine * zone) * spotFree[p]
            : -Math.min(RIDGE_CAP, mid) * MAX_SOFTEN * (TEXTURE_SOFTEN * loose + RIDGE_FLATTEN * Math.min(1, nearLine[p]) * zone);
        // The faint leftover lines in the finest grain (both dark and light ones).
        const finest = lum[p] - finestTop[p];
        band -= finest * FINEST_LINES * lineShaped[p] * strictOk * spotFree[p];
        // Main areas: swap the fine detail (with the lines' last traces) for fresh grain.
        // Freckles and moles keep their own detail.
        band += (donorGrain[p] - fineBand[p]) * GRAIN_REPLACE * loose * spotFree[p];
        band *= m;
      }
      if (cover[p] > 0) {
        const depth = Math.max(0, skinLevel - level[p]);
        // Skin grain dips a few levels; a line is deeper than that.
        // Capped: a fold deeper than this is mostly shadow from an expression (raised brows);
        // lifting it fully turns the skin flat and orange.
        fill[p] = Math.min(MAX_LIFT, depth * smoothstep(MIN_DEPTH[0], MIN_DEPTH[1], depth) * Math.min(1, cover[p]) * MAX_SOFTEN);
      }
      const notLine = 1 - Math.min(1, cover[p]);
      let lower = 0;
      if (nearLine[p] > 0 && ridgeLevel[p] > skinLevel) {
        const ridge = Math.min(RIDGE_CAP, ridgeLevel[p] - skinLevel);
        lower = ridge * smoothstep(MIN_DEPTH[0], MIN_DEPTH[1], ridge) * Math.min(1, nearLine[p]);
      }
      const edgeHere = Math.min(1, onEdge[p]);
      if (edgeHere > 0 && smooth[0][p] > skinLevel) {
        const rise = Math.min(RIDGE_CAP, smooth[0][p] - skinLevel);
        lower = Math.max(lower, rise * smoothstep(MIN_DEPTH[0], MIN_DEPTH[1], rise) * edgeHere);
      }
      fill[p] -= lower * notLine * RIDGE_FLATTEN;
      // Whichever change is larger (in its own direction) wins: line fill, ridge lowering, band.
      fill[p] = band > 0 ? Math.max(fill[p], band) : Math.min(fill[p], band);
      if (looseSoft > 0 && m > 0) {
        const base = baseDen[p] > 0.05 ? baseNum[p] / baseDen[p] : lowBand[p];
        const toTarget = Math.max(-RIDGE_CAP, Math.min(MAX_LIFT, base + donorGrain[p] * GRAIN_REPLACE - lum[p]));
        // Wide, gentle hand-over at the area's edge.
        const edge = looseSoft * looseSoft * (3 - 2 * looseSoft) * m;
        // Freckles and moles keep their own look, but only their dark core: the skin around them
        // goes to the target like everywhere else (no pale halo).
        const core = smoothstep(2, 6, base - lum[p]);
        const k = edge * (1 - (1 - spotFree[p]) * core);
        fill[p] = fill[p] * (1 - edge) + toTarget * k;
      }
      fill[p] = Math.max(-RIDGE_CAP, Math.min(MAX_LIFT, fill[p]));
    }
    for (let p = 0; p < n; p++) if (fill[p] !== 0) fill[p] *= shareOf(id, p);
    result[id] = toLayers(pixels, lum, fill, skin);
  }
  return result;
}

/** Change lightness by `fill` per pixel (lift lines, lower ridges); the more a pixel changes, the more it takes the skin's colour. */
function toLayers(pixels: Pixels, lum: Float32Array, fill: Float32Array, skin: Float32Array[]): Layers {
  const n = lum.length;
  const mul = new Uint8ClampedArray(n * 4).fill(255);
  const add = new Uint8ClampedArray(n * 4);
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    add[i + 3] = 255;
    const f = fill[p];
    if (Math.abs(f) < 0.25 || lum[p] < 1) continue;
    const target = lum[p] + f;
    const sl = 0.2126 * skin[0][p] + 0.7152 * skin[1][p] + 0.0722 * skin[2][p];
    // Lifted creases take the skin's colour; lowered ridges (often shine) mostly keep their own.
    // Creases are redder than the skin around them: even small lifts take most of its colour.
    const a = f > 0 ? Math.min(0.8, f / 6) : Math.min(0.5, -f / 30);
    for (let c = 0; c < 3; c++) {
      const v = pixels[i + c];
      const own = v / lum[p],
        ref = sl > 1 ? skin[c][p] / sl : own;
      let d = target * (own * (1 - a) + ref * a) - v;
      // A lifted line may lose a little of a channel (its extra red), never much (that turns grey).
      if (f > 0) d = Math.max(d, -0.08 * v);
      if (d < 0) mul[i + c] = Math.round((255 * (v + d)) / Math.max(1, v));
      else add[i + c] = d;
    }
  }
  return { mul, add };
}

/** The q-quantile of `v` over masked pixels inside the zones (every 3rd pixel), or 1. */
function percentile(v: Float32Array, mask: Pixels, zones: Zone[], w: number, h: number, q: number): number {
  const xs: number[] = [];
  for (let p = 0; p < w * h; p += 3) {
    if (v[p] <= 0 || mask[p * 4 + 3] <= 128) continue;
    const x = p % w,
      y = (p / w) | 0;
    if (zones.some((z) => ellipseWeight(z, x, y, 0) > 0)) xs.push(v[p]);
  }
  if (!xs.length) return 1;
  xs.sort((a, b) => a - b);
  return xs[Math.floor(xs.length * q)];
}

/**
 * New skin grain: random noise band-limited to the fine band's scale (two octaves: grain and
 * pores), with the amplitude of this face's least line-like fine detail (robust median of its
 * magnitude where the texture is not line-shaped). Seeded per pixel position, so the same photo
 * always gets the same grain. No direction, so it cannot carry a line.
 */
export function synthGrain(
  fineBand: Float32Array,
  lineShaped: Float32Array,
  mask: Pixels,
  w: number,
  h: number,
  fw: number,
): Float32Array {
  const n = w * h;
  const ref: number[] = [];
  for (let p = 0; p < n; p += 3)
    if (mask[p * 4 + 3] > 200 && lineShaped[p] < 0.3) ref.push(Math.abs(fineBand[p]));
  ref.sort((a, b) => a - b);
  // Median |x| of zero-mean noise is ~0.674 sigma.
  const target = ref.length ? ref[Math.floor(ref.length / 2)] / 0.674 : 2;
  const noise = (salt: number) => {
    const v = new Float32Array(n);
    for (let p = 0; p < n; p++) {
      let x = Math.imul(p ^ salt, 2654435761) >>> 0;
      x = Math.imul(x ^ (x >>> 15), 2246822519) >>> 0;
      x ^= x >>> 13;
      v[p] = (x & 0xffff) / 65535 - 0.5;
    }
    return v;
  };
  // Skin micro-relief: a network of small polygonal cells separated by thin, shallow furrows
  // (the skin's surface lines), with pores where furrows meet, over a very fine smooth grain.
  // Cells: jittered points on a grid (Worley noise); a pixel's distance to its nearest point vs
  // its second nearest tells how close it is to a cell border.
  const cell = Math.max(4.5, fw * 0.011);
  const gw = Math.ceil(w / cell) + 2,
    gh = Math.ceil(h / cell) + 2;
  const hash = (i: number, salt: number) => {
    let x = Math.imul(i ^ salt, 2654435761) >>> 0;
    x = Math.imul(x ^ (x >>> 15), 2246822519) >>> 0;
    x ^= x >>> 13;
    return (x & 0xffff) / 65535;
  };
  const px = new Float32Array(gw * gh),
    py = new Float32Array(gw * gh);
  for (let j = 0; j < gh; j++)
    for (let i = 0; i < gw; i++) {
      const k = j * gw + i;
      // Full jitter: no trace of the grid.
      px[k] = (i - 1 + hash(k, 0x51ed)) * cell;
      py[k] = (j - 1 + hash(k, 0x2c1b)) * cell;
    }
  // Per pixel: how close to a cell border (furrow) and to a point where three cells meet
  // (junction). Each border gets its own depth and only some junctions a pore (hashed from the
  // cells involved), so the network is uneven like real skin without any large-scale blotches.
  const relief = new Float32Array(n);
  const fw2 = cell * 0.11; // furrow half-width
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const ci = Math.floor(x / cell) + 1,
        cj = Math.floor(y / cell) + 1;
      let d1 = Infinity,
        d2 = Infinity,
        d3 = Infinity,
        k1 = 0,
        k2 = 0,
        k3 = 0;
      for (let j = cj - 2; j <= cj + 2; j++)
        for (let i = ci - 2; i <= ci + 2; i++) {
          if (i < 0 || j < 0 || i >= gw || j >= gh) continue;
          const k = j * gw + i;
          const d = Math.hypot(x - px[k], y - py[k]);
          if (d < d1) {
            d3 = d2; k3 = k2;
            d2 = d1; k2 = k1;
            d1 = d; k1 = k;
          } else if (d < d2) {
            d3 = d2; k3 = k2;
            d2 = d; k2 = k;
          } else if (d < d3) {
            d3 = d; k3 = k;
          }
        }
      const furrow = 1 - smoothstep(0, fw2, (d2 - d1) / 2);
      const junction = 1 - smoothstep(0, fw2 * 1.5, (d3 - d1) / 2);
      const a = Math.min(k1, k2),
        b = Math.max(k1, k2);
      const depth = 0.45 + 0.9 * hash(a * 7919 + b, 0x3a7d);
      const ids = [k1, k2, k3].sort((u, v) => u - v);
      const pore = junction * (hash(ids[0] * 104729 + ids[1] * 7919 + ids[2], 0x6b2f) < 0.15 ? 1 : 0);
      // Cell tops catch a little light; furrows and pores sit in shadow.
      relief[y * w + x] = 0.3 * (1 - furrow) - furrow * depth - 1.0 * pore;
    }
  const fine = blurLike(noise(0x9e37), w, h, Math.max(0.6, fw * 0.0006));
  let fs = 0;
  for (let p = 0; p < n; p++) fs += fine[p] * fine[p];
  const fsd = Math.sqrt(fs / n) || 1;
  // Soft edges (furrows are rounded, never a hard pixel line), then the fine grain.
  const soft = blurLike(relief, w, h, Math.max(0.5, cell * 0.06));
  let rm = 0;
  for (let p = 0; p < n; p++) rm += soft[p];
  rm /= n;
  let rs = 0;
  for (let p = 0; p < n; p++) rs += (soft[p] - rm) ** 2;
  const rsd = Math.sqrt(rs / n) || 1;
  const out = new Float32Array(n);
  for (let p = 0; p < n; p++) out[p] = (soft[p] - rm) / rsd + 0.3 * (fine[p] / fsd);
  let sum = 0;
  for (let p = 0; p < n; p++) sum += out[p] * out[p];
  const sd = Math.sqrt(sum / n) || 1;
  for (let p = 0; p < n; p++) out[p] *= target / sd;
  return out;
}
