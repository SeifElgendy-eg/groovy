// Botox: find expression lines and soften them (pure, runs in the skin worker).
//
// Botox relaxes the muscles behind dynamic lines, so the lines soften (typically by 70-80%) while
// the skin itself (pores, freckles, sun spots, texture) is untouched. So this does not blur an
// area: it finds the lines. A line is a dark valley that is long in one direction (a Hessian
// "ridge" measure at two widths, fine and deep), running the way lines run in each treated area:
// across the forehead, up and down between the brows, fanning out from the eye corner. Round dark
// spots (freckles) and pores are not lines and are left alone. Each area returns its own
// correction layers, so the caller can switch areas on and off and set the dose without a recompute.
import { blobWeight, blurLike, boxRadius, slide } from "../acne/texture";

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
export const RIDGE_CAP = 50;
/** Share of the mid band (crepey texture between lines) softened at full dose. */
export const TEXTURE_SOFTEN = 0.95;
/** Share of the line-shaped finest detail (faint leftover lines) removed at full dose. */
export const FINEST_LINES = 0.85;
/** Share of the fine detail replaced by fresh grain at full dose (main areas). */
export const GRAIN_REPLACE = 0.65;
/** How much of the photo's own fine detail is dropped where it is line-shaped (0..1). */
export const PORE_LINE_DROP = 0.8;
/** Share of the skin's mid-scale relief kept away from the lines. */
export const MID_KEEP = 0.4;
/** Largest lift of a line (levels). */
export const MAX_LIFT = 80;
/** Depth (levels below the skin around it) over which a dip goes from "grain" to "line". */
export const MIN_DEPTH: [number, number] = [3, 8];
/** A line within this angle of the area's expected direction is fully treated (degrees)... */
export const DIRECTION_TOLERANCE = 25;
/** ...falling to nothing at this angle. */
export const DIRECTION_LIMIT = 50;
/** Under the eyes, the most a fine bright ridge (crepe) is lowered (levels). */
export const UNDEREYE_LOWER = 6;
/** Darkness of a spot's centre below the skin around it (levels) from which it counts as a freckle or mole. */
export const SPOT_DARK: [number, number] = [3, 6];

const smoothstep = (e0: number, e1: number, x: number) => {
  if (e1 === e0) return x < e0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * Math.hypot for two numbers, the same algorithm (scaled, Kahan-summed squares) and so the same
 * result, without the builtin's call overhead (it is several times slower in a hot loop).
 */
export function hypot(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  if (a === Infinity || b === Infinity) return Infinity;
  if (a !== a || b !== b) return NaN;
  const max = a > b ? a : b;
  if (max === 0) return 0;
  const n1 = a / max,
    n2 = b / max;
  let sum = 0,
    comp = 0;
  let s = n1 * n1 - comp,
    pre = sum + s;
  comp = pre - sum - s;
  sum = pre;
  s = n2 * n2 - comp;
  pre = sum + s;
  comp = pre - sum - s;
  sum = pre;
  return Math.sqrt(sum) * max;
}

/**
 * Valley-line strength and direction at one width: from the Hessian of the lightness blurred at
 * `sigma`. A dark line curves up strongly across it and hardly along it.
 */
function lineness(blur: (sigma: number) => Float32Array, w: number, h: number, sigma: number) {
  const g = blur(sigma);
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
      // A dark spot curves up both ways (freckle, mole), and about as much one way as the other.
      // The deepest points of a wavy crease curve up both ways too, but far more across the crease
      // than along it: counting those as spots left dashes of the crease behind.
      if (along > 0) blob[p] = along * sigma * sigma * smoothstep(0.15, 0.35, along / across);
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

/**
 * A zone with what every pixel needs precomputed: its rotation, direction tolerance (as cosines)
 * and the box outside which its ellipse weight is 0 (so most pixels skip the maths).
 */
interface ZoneGeom {
  z: Zone;
  c: number;
  s: number;
  lo: number;
  hi: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

function zoneGeom(z: Zone, tolLo: number, tolHi: number): ZoneGeom {
  const c = Math.cos(z.angle),
    s = Math.sin(z.angle);
  // Half extents of the rotated ellipse, plus a pixel of margin.
  const ex = Math.sqrt(z.rx * z.rx * c * c + z.ry * z.ry * s * s),
    ey = Math.sqrt(z.rx * z.rx * s * s + z.ry * z.ry * c * c);
  const [lo, hi] = z.tolerance ? [Math.cos((z.tolerance[1] * Math.PI) / 180), Math.cos((z.tolerance[0] * Math.PI) / 180)] : [tolLo, tolHi];
  return { z, c, s, lo, hi, x0: Math.floor(z.cx - ex) - 1, x1: Math.ceil(z.cx + ex) + 1, y0: Math.floor(z.cy - ey) - 1, y1: Math.ceil(z.cy + ey) + 1 };
}

/** ellipseWeight, with the zone's precomputed rotation and box (same result). */
function zoneWeight(g: ZoneGeom, x: number, y: number, feather = 0.35): number {
  if (x < g.x0 || x > g.x1 || y < g.y0 || y > g.y1) return 0;
  const z = g.z;
  const dx = x - z.cx,
    dy = y - z.cy;
  const u = (dx * g.c + dy * g.s) / z.rx,
    v = (-dx * g.s + dy * g.c) / z.ry;
  const r = Math.sqrt(u * u + v * v);
  return 1 - smoothstep(1 - feather, 1, r);
}

export function linesCompute(j: LinesJob): LinesResult {
  const { pixels, mask, width: w, height: h, faceWidth: fw } = j;
  const n = w * h;
  const tolLo = Math.cos((DIRECTION_LIMIT * Math.PI) / 180),
    tolHi = Math.cos((DIRECTION_TOLERANCE * Math.PI) / 180);
  const geoms = j.zones.map((z) => zoneGeom(z, tolLo, tolHi));
  const lum = new Float32Array(n);
  for (let p = 0; p < n; p++) lum[p] = 0.2126 * pixels[p * 4] + 0.7152 * pixels[p * 4 + 1] + 0.0722 * pixels[p * 4 + 2];

  // Blurred copies of the lightness, by blur radius: different sizes often round to the same
  // radius, and then the same copy serves them all (read-only).
  const lumBlurs = new Map<number, Float32Array>();
  const lumBlur = (sigma: number) => {
    const r = boxRadius(sigma);
    let b = lumBlurs.get(r);
    if (!b) lumBlurs.set(r, (b = blurLike(lum, w, h, sigma)));
    return b;
  };
  // Each stage is its own function, so its working arrays are freed when it returns (a 4K
  // photo's face crop needs a lot of them).
  const { strength, dir, fineDir, fineStrength, level, spots, edge, edgeDir, widthOf, smooth0, smooth2, fineRef } = lineMeasures(lum, lumBlur, mask, geoms, w, h, fw);
  // How deep each pixel sits in a valley: lighter skin on both sides of it, within the width of
  // the line found there (a morphological closing fills such a valley; it leaves a step alone).
  // A shadow's edge (under the brows, the eye sockets in top light) is dark on one side only: it is
  // no line, and lifting it left a bright, orange band along the shadow.
  const { valley, broad } = valleyDepth(smooth0, level, widthOf, w, h, fw);
  const { roundNear, spotNear, spotRef, spotSurround } = spotProtection(spots, strength, lum, lumBlur, mask, geoms, w, h, fw);
  // How far below its surroundings each pixel is (the depth a line would be filled by).
  // (The pixel's own lightness: even the smallest blur would make the line look shallower.)
  const around = lumBlur(Math.max(3, fw * 0.02));
  const skin = plainSkinColour(pixels, lum, around, w, h, fw);
  // Frequency separation: the mid band (lines and crepey texture) is what botox softens; the fine
  // band (pores, grain) and the low band (the face's shading) are kept.
  const fineTop = lumBlur(Math.max(0.8, fw * 0.0022));
  // For fine-line areas only the very finest grain is kept.
  const finestTop = lumBlur(Math.max(0.5, fw * 0.0009));
  // The faint lines left in the finest grain: line-shaped detail (pores and grain are round or
  // random, lines are long), with its direction for the strict zones.
  const lineShaped = blobWeight(lum, w, h, Math.max(1, fw * 0.003));
  for (let p = 0; p < n; p++) lineShaped[p] = 1 - lineShaped[p];
  const lowBand = lumBlur(Math.max(3, fw * 0.012));
  lumBlurs.clear(); // (the copies still in use stay; the rest can be freed)
  const fineBand = new Float32Array(n);
  for (let p = 0; p < n; p++) fineBand[p] = lum[p] - fineTop[p];
  // Fresh grain for the treated skin: the face's own fine texture grew along its creases and
  // keeps tracing them, so it is replaced by new, directionless grain of the same scale and
  // strength as this face's least-lined skin.
  const donorGrain = synthGrain(fineBand, lineShaped, mask, w, h, fw, lowBand);
  const spotFree = new Float32Array(n);
  // A spot must also be a real one: strong against this face's typical spot response. (On plain
  // skin the line strength is ~0, so the ratio alone called every speck of grain a freckle, and
  // the treatment kept every slightly dark pixel, crease remnants included, as dark dashes.)
  for (let p = 0; p < n; p++)
    spotFree[p] =
      1 -
      smoothstep(0.35, 0.7, spotNear[p] / Math.max(1e-6, strength[p] * fineRef + spotNear[p])) *
        smoothstep(0.3, 0.6, spotNear[p] / Math.max(1e-6, spotRef));

  // Stray hairs lying on the skin (wisps, a curl hanging over the forehead): left whole.
  const strayNear = strayHairs(lum, around, mask, j.zones, w, h, fw, (p) => widthOf[p] > 0 && strength[p] > 0.45);
  // Real skin for the lines (healing-brush style): the fine texture of clean skin elsewhere on
  // this face, copied over the lines in place of generated grain.
  const healed = healLines(strength, mask, lineShaped, spotNear, spotRef, strayNear, fineBand, lowBand, w, h, fw);
  // Areas overlap (forehead and frown lines between the brows; crow's feet and under-eyes). Each
  // area's correction is computed from the original photo and the layers are drawn on top of each
  // other, so an overlap would be treated twice (pale streaks). Each area's weight over the crop is
  // kept, and linesLayers shares each pixel out among the areas that are switched on.
  const areaWeight = {} as Record<AreaId, Float32Array>;
  for (const id of AREAS) {
    const e = new Float32Array(n);
    for (const g of geoms) {
      if (g.z.id !== id) continue;
      for (let y = Math.max(0, g.y0); y <= Math.min(h - 1, g.y1); y++)
        for (let x = Math.max(0, g.x0); x <= Math.min(w - 1, g.x1); x++) {
          const p = y * w + x;
          e[p] = Math.max(e[p], zoneWeight(g, x, y));
        }
    }
    for (let p = 0; p < n; p++) e[p] = e[p] * e[p];
    areaWeight[id] = e;
  }
  const rawFill = {} as Record<AreaId, Float32Array>,
    rawRecolour = {} as Record<AreaId, Float32Array>;
  // Sizes of the per-area steps (the line cover, ridge and edge reach, and the blurs).
  const r = Math.max(1, Math.round(fw * 0.0025)),
    rf = Math.max(2, Math.round(fw * 0.02)),
    r1 = Math.max(1, Math.round(fw * 0.002)),
    sb = Math.max(5, fw * 0.032),
    sig = Math.max(3, fw * 0.03),
    sSoft = Math.max(1, fw * 0.004),
    sNear = Math.max(1, fw * 0.006);
  // Each area is worked on in its own window of the crop: its zones, plus how far its lines'
  // cover, ridges and edges reach (where it can change pixels), plus how far the blurs read
  // around those. Nothing outside can change, so the result is the same as over the whole crop.
  const reach = Math.max(r, rf + 3 * boxRadius(sNear), r1) + 2;
  const margin = reach + 3 * Math.max(boxRadius(sb), boxRadius(sig), boxRadius(sSoft)) + 2;
  const windows = {} as Record<AreaId, Window>;
  for (const id of AREAS) {
    const zones = j.zones.filter((z) => z.id === id);
    const zg = geoms.filter((g) => g.z.id === id);
    windows[id] = { x: 0, y: 0, w: 0, h: 0 };
    rawFill[id] = rawRecolour[id] = new Float32Array(0);
    if (!zg.length) continue;
    // Pixels outside every zone's box get no weight.
    const bx0 = Math.max(0, Math.min(...zg.map((g) => g.x0))),
      bx1 = Math.min(w - 1, Math.max(...zg.map((g) => g.x1))),
      by0 = Math.max(0, Math.min(...zg.map((g) => g.y0))),
      by1 = Math.min(h - 1, Math.max(...zg.map((g) => g.y1)));
    if (bx0 > bx1 || by0 > by1) continue;
    // The area's window (ox, oy, sw x sh); q indexes it, p the crop.
    const ox = Math.max(0, bx0 - margin),
      oy = Math.max(0, by0 - margin),
      sw = Math.min(w, bx1 + margin + 1) - ox,
      sh = Math.min(h, by1 + margin + 1) - oy,
      sn = sw * sh;
    // The area's corrections, over its window only (nothing changes outside it).
    const fill = new Float32Array(sn),
      recolour = new Float32Array(sn);
    windows[id] = { x: ox, y: oy, w: sw, h: sh };
    rawFill[id] = fill;
    rawRecolour[id] = recolour;
    const weight = new Float32Array(sn),
      edgeWeight = new Float32Array(sn);
    const ref = 1; // strengths are already relative to their width's typical value
    for (let y = by0; y <= by1; y++)
      for (let x = bx0; x <= bx1; x++) {
        const p = y * w + x;
        const m = mask[p * 4 + 3] / 255;
        if (m <= 0 || strength[p] <= 0) continue;
        let zw = 0,
          dw = 0;
        for (const g of zg) {
          const e = zoneWeight(g, x, y);
          if (e <= 0) continue;
          const z = g.z,
            lo = g.lo,
            hi = g.hi;
          const expected = z.from ? Math.atan2(y - z.from.y, x - z.from.x) : (z.lineAngle ?? 0);
          let d = z.anyDirection ? 1 : smoothstep(lo, hi, Math.abs(Math.cos(dir[p] - expected)));
          // By the lid, the finest width must agree too: a row of lashes reads as one dark band
          // along the lid at the broad widths, but at the finest width each lash crosses it.
          if (z.strict) d *= smoothstep(lo, hi, Math.abs(Math.cos(fineDir[p] - expected))) * (fineStrength[p] > 0 ? 1 : 0);
          if (e * d > zw * dw) {
            zw = e;
            dw = d;
          }
        }
        if (zw <= 0 || dw <= 0) continue;
        // Not a line where anything round is (deliberately broader than spotFree, which decides
        // what keeps its own pixels): lash tips crossing the lid line and similar dots must never
        // count as line, or the lid's lashes get painted over (unit test).
        const notSpot = 1 - smoothstep(0.35, 0.7, roundNear[p] / Math.max(1e-6, strength[p] + roundNear[p]));
        const isLine = smoothstep(0.12, 0.45, strength[p] / Math.max(1e-6, ref)) * notSpot;
        weight[(y - oy) * sw + x - ox] = isLine * dw * zw * m;
      }
    // Thin bright crease edges running the area's way (relative threshold as for lines).
    const edgeRef = percentile(edge, mask, zg, w, h, 0.9);
    for (let y = by0; y <= by1; y++)
      for (let x = bx0; x <= bx1; x++) {
        const p = y * w + x;
        const m = mask[p * 4 + 3] / 255;
        if (m <= 0 || edge[p] <= 0) continue;
        let best = 0;
        for (const g of zg) {
          const e = zoneWeight(g, x, y);
          if (e <= 0) continue;
          const z = g.z,
            lo = g.lo,
            hi = g.hi;
          const expected = z.from ? Math.atan2(y - z.from.y, x - z.from.x) : (z.lineAngle ?? 0);
          best = Math.max(best, e * (z.anyDirection ? 1 : smoothstep(lo, hi, Math.abs(Math.cos(edgeDir[p] - expected)))));
        }
        edgeWeight[(y - oy) * sw + x - ox] = best * smoothstep(0.35, 0.8, edge[p] / Math.max(1e-6, edgeRef)) * m;
      }
    // The line mask, widened to cover the whole line (its centre is where the measure peaks).
    const cover = slide(slide(weight, sw, sh, r, true, false), sw, sh, r, true, true);
    // Main areas: the plain skin level, with lines (and bright ridges, clipped) left out of the
    // average. Each pixel there goes to this level plus fresh grain: one target, so nothing stacks.
    // The skin level around each line, leaving the lines (and the shine) out of the average
    // (normalised convolution): the depth is then right at the line's centre and zero beside it,
    // so the fill never leaves a light halo next to a line. (Same weights as the base, wider.)
    // Bright ridges and shine are clipped too, so the skin level is the plain skin's (else a
    // ridge measures less raised than it is).
    const keep = new Float32Array(sn),
      keepLum = new Float32Array(sn),
      baseW = new Float32Array(sn),
      baseL = new Float32Array(sn);
    for (let y = 0; y < sh; y++)
      for (let x = 0; x < sw; x++) {
        const q = y * sw + x,
          p = (y + oy) * w + x + ox;
        keep[q] = 1 - Math.min(1, cover[q]);
        keepLum[q] = Math.min(lum[p], around[p] + MIN_DEPTH[1]) * keep[q];
        // The plain skin level leaves out anything clearly darker than the skin around it too
        // (stray hair at the hairline, crease remnants), so it never pulls the skin down.
        // (Narrow dark only, in a valley: a broad shadow is the skin's own shading and stays in.)
        const plainHere = lum[p] >= around[p] - MIN_DEPTH[1] || valley[p] < MIN_DEPTH[1] ? keep[q] : 0;
        baseW[q] = plainHere;
        baseL[q] = Math.min(lum[p], around[p] + MIN_DEPTH[1]) * plainHere;
      }
    const baseNum = blurLike(baseL, sw, sh, sb),
      baseDen = blurLike(baseW, sw, sh, sb);
    const num = blurLike(keepLum, sw, sh, sig),
      den = blurLike(keep, sw, sh, sig);
    // Next to lines (within a fold's width), the raised ridges between them: lowering those is
    // the other half of flattening a fold. Elsewhere bright bumps are highlights and stay.
    const ridgeLevel = smooth2;
    const onEdge = slide(slide(edgeWeight, sw, sh, r1, true, false), sw, sh, r1, true, true);
    // The lines themselves (their full width, softened by a pixel or two).
    const onLineSoft = blurLike(cover, sw, sh, sSoft);
    const nearLine = blurLike(slide(slide(weight, sw, sh, rf, true, false), sw, sh, rf, true, true), sw, sh, sNear);
    for (let ly = 0; ly < sh; ly++)
      for (let lx = 0; lx < sw; lx++) {
        const q = ly * sw + lx,
          x = lx + ox,
          y = ly + oy,
          p = y * w + x;
        // Outside the area's zones, with no line, ridge or edge reaching here: nothing changes.
        if ((x < bx0 || x > bx1 || y < by0 || y > by1) && !(cover[q] > 0) && !(nearLine[q] > 0) && !(onEdge[q] > 0)) continue;
        const skinLevel = den[q] > 1e-3 ? num[q] / den[q] : around[p];
        // The softened mid band everywhere in the area: dark detail fully on lines, partly elsewhere
        // (crepey texture); bright detail only near lines (ridges), never shine beyond RIDGE_CAP.
        let zone = 0,
          fineZone = 0,
          loose = 0,
          looseSoft = 0,
          strictOk = 0;
        for (const g of zg) {
          const e = zoneWeight(g, x, y);
          if (e <= 0) continue;
          const z = g.z;
          if (z.strict) {
            const expected = z.lineAngle ?? 0,
              lo = g.lo,
              hi = g.hi;
            strictOk = Math.max(strictOk, e * smoothstep(lo, hi, Math.abs(Math.cos(fineDir[p] - expected))) * (fineStrength[p] > 0 ? 1 : 0));
          } else {
            loose = Math.max(loose, e);
            looseSoft = Math.max(looseSoft, zoneWeight(g, x, y, 0.7));
          }
          zone = Math.max(zone, e);
          if (z.fine) fineZone = Math.max(fineZone, e);
        }
        const m = mask[p * 4 + 3] / 255;
        let band = 0;
        if (zone > 0 && m > 0) {
          const top = fineTop[p] + (finestTop[p] - fineTop[p]) * fineZone;
          const mid = top - lowBand[p];
          const onLine = Math.min(1, cover[q]);
          // Texture is softened in loose zones only; strict zones (by the lid) soften only lines.
          band =
            mid < 0
              ? -mid * MAX_SOFTEN * Math.max(TEXTURE_SOFTEN * loose, onLine * zone) * spotFree[p]
              : -Math.min(RIDGE_CAP, mid) * MAX_SOFTEN * (TEXTURE_SOFTEN * loose + RIDGE_FLATTEN * Math.min(1, nearLine[q]) * zone);
          // The faint leftover lines in the finest grain (both dark and light ones).
          const finest = lum[p] - finestTop[p];
          band -= finest * FINEST_LINES * lineShaped[p] * strictOk * spotFree[p];
          // Main areas: swap the fine detail (with the lines' last traces) for fresh grain.
          // Freckles and moles keep their own detail.
          band += (donorGrain[p] - fineBand[p]) * GRAIN_REPLACE * loose * spotFree[p];
          band *= m;
        }
        let f = 0,
          rc = 0;
        if (cover[q] > 0) {
          const depth = Math.max(0, Math.min(skinLevel - level[p], valley[p] + MIN_DEPTH[0]));
          // Skin grain dips a few levels; a line is deeper than that.
          // Capped: a fold deeper than this is mostly shadow from an expression (raised brows);
          // lifting it fully turns the skin flat and orange.
          f = Math.fround(Math.min(MAX_LIFT, depth * smoothstep(MIN_DEPTH[0], MIN_DEPTH[1], depth) * Math.min(1, cover[q]) * MAX_SOFTEN));
        }
        const notLine = 1 - Math.min(1, cover[q]);
        let lower = 0;
        if (nearLine[q] > 0 && ridgeLevel[p] > skinLevel) {
          const ridge = Math.min(RIDGE_CAP, ridgeLevel[p] - skinLevel);
          lower = ridge * smoothstep(MIN_DEPTH[0], MIN_DEPTH[1], ridge) * Math.min(1, nearLine[q]);
        }
        const edgeHere = Math.min(1, onEdge[q]);
        if (edgeHere > 0 && smooth0[p] > skinLevel) {
          const rise = Math.min(RIDGE_CAP, smooth0[p] - skinLevel);
          lower = Math.max(lower, rise * smoothstep(MIN_DEPTH[0], MIN_DEPTH[1], rise) * edgeHere);
        }
        f = Math.fround(f - lower * notLine * RIDGE_FLATTEN);
        // Whichever change is larger (in its own direction) wins: line fill, ridge lowering, band.
        f = Math.fround(band > 0 ? Math.max(f, band) : Math.min(f, band));
        if (looseSoft > 0 && m > 0) {
          // Never below the area's own average: botox never darkens skin (dark circles stay as
          // they are rather than turning darker or blotchy).
          const avg = baseDen[q] > 0.05 ? baseNum[q] / baseDen[q] : lowBand[p];
          const base = id === "undereye" ? Math.max(lowBand[p], avg) : avg;
          // The skin's own pores and grain stay wherever they do not trace a line: off the lines
          // themselves, and where the fine detail is round or random rather than long. Only on the
          // lines is the detail replaced (it traces the creases there).
          const keepTex = (1 - Math.min(1, onLineSoft[q])) * (1 - PORE_LINE_DROP * lineShaped[p]);
          const fresh = Number.isNaN(healed[p]) ? donorGrain[p] * GRAIN_REPLACE : healed[p];
          const texture = keepTex * fineBand[p] + (1 - keepTex) * fresh;
          // The skin's gentle relief between pore and line size, kept where no line is near (the
          // plain base alone reads as flat, airbrushed skin).
          const relief = (fineTop[p] - base) * MID_KEEP * (1 - Math.min(1, nearLine[q]));
          // Lifted no further than a valley's sides (or the local shading) allow: a fold's trough
          // comes up to the skin either side of it, a shadow cast by the brows or the eye sockets
          // keeps its depth (lifting it to the area's average left a pale, orange band).
          const ceiling = Math.max(broad[p], lowBand[p] - lum[p], 0) + MIN_DEPTH[1];
          const toTarget = Math.max(-RIDGE_CAP, Math.min(MAX_LIFT, ceiling, base + relief + texture - lum[p]));
          // Wide, gentle hand-over at the area's edge.
          const edgeK = looseSoft * looseSoft * (3 - 2 * looseSoft) * m;
          // Freckles and moles keep their own look, but only their dark core: the skin around them
          // goes to the target like everywhere else (no pale halo).
          // (The spot itself: darker than the skin right around it. Darker than the base alone is
          // not enough: under the eyes the whole dark circle is, and keeping it showed as squares.)
          const core = smoothstep(3, 8, Math.min(base, spotSurround[p]) - lum[p]);
          const k = edgeK * (1 - (1 - spotFree[p]) * core);
          f = Math.fround(f * (1 - edgeK) + toTarget * k);
          rc = Math.fround(k);
        }
        // Stray hairs keep their own pixels (only their dark strand, not the skin beside it).
        const hair = strayNear[p];
        if (hair > 0) {
          f = Math.fround(f * (1 - hair));
          rc = Math.fround(rc * (1 - hair));
        }
        f = Math.max(-RIDGE_CAP, Math.min(MAX_LIFT, f));
        // Under the eyes mostly lift: the lower lid's lighter skin and the cheek's highlights are
        // not ridges to flatten (lowering them reads as a darker eye bag). Only the crepe's fine
        // bright ridges come down, to the skin's local level and by a few levels at most, so
        // nothing gets darker than the skin around it. That holds for any area reaching there
        // (the crow's feet's lower zone covers the same band).
        const lowest = -Math.min(UNDEREYE_LOWER, Math.max(1, lum[p] - lowBand[p]));
        if (id === "undereye") f = Math.max(lowest, f);
        else if (f < lowest) {
          const u = smoothstep(0, 0.3, areaWeight.undereye[p]);
          if (u > 0) f = f * (1 - u) + lowest * u;
        }
        fill[q] = f;
        recolour[q] = rc;
      }
  }
  cached = { pixels, lum, skin, areaWeight, rawFill, rawRecolour, windows, width: w };
  return linesLayers(AREAS) as LinesResult;
}

/** The line measures at three widths, combined: per pixel the width that dominates, its strength (relative to this face's typical one), direction and depth level; plus the round-spot and bright-edge measures. */
function lineMeasures(lum: Float32Array, lumBlur: (sigma: number) => Float32Array, mask: Pixels, geoms: ZoneGeom[], w: number, h: number, fw: number) {
  const n = w * h;
  // Three widths: fine lines, deeper lines, and broad folds (e.g. a raised-brow forehead).
  const fine = lineness(lumBlur, w, h, Math.max(0.8, fw * 0.0028));
  const deep = lineness(lumBlur, w, h, Math.max(1.5, fw * 0.0065));
  const fold = lineness(lumBlur, w, h, Math.max(2.5, fw * 0.013));
  const scales = [fine, deep, fold];
  // Lightness at each width's own scale: depth is measured on these, so the correction is smooth
  // and the skin's texture stays on top of it (inside a filled fold too).
  const smooth = [0.0014, 0.003, 0.0065].map((k) => lumBlur(Math.max(0.5, fw * k)));
  const strength = new Float32Array(n),
    dir = new Float32Array(n),
    spots = new Float32Array(n),
    level = new Float32Array(n),
    edge = new Float32Array(n),
    edgeDir = new Float32Array(n),
    widthOf = new Uint8Array(n);
  // Each width is judged against its own typical strength on this face (90th percentile over
  // the skin), so the broad width cannot drown the fine lines just by being broad.
  const scaleRef = scales.map((sc) => percentile(sc.strength, mask, geoms, w, h, 0.9));
  const rel = [0, 0, 0];
  for (let p = 0; p < n; p++) {
    let k = 0;
    rel[0] = fine.strength[p] / scaleRef[0];
    rel[1] = deep.strength[p] / scaleRef[1];
    rel[2] = fold.strength[p] / scaleRef[2];
    // A wider width wins only when it clearly dominates (a broad fold, not a fine line).
    for (let i = 1; i < 3; i++) if (rel[i] > rel[k] * 1.5) k = i;
    strength[p] = rel[k];
    widthOf[p] = k;
    dir[p] = scales[k].dir[p];
    // Depth on a copy one step finer than the line's width: fine lines stay deep enough to fill,
    // broad folds keep their skin texture on top.
    level[p] = k === 0 ? lum[p] : smooth[k - 1][p];
    spots[p] = Math.max(fine.blob[p], deep.blob[p]);
    const bk = deep.bright[p] > fine.bright[p] ? deep : fine;
    edge[p] = bk.bright[p];
    edgeDir[p] = bk.brightDir[p];
  }
  return {
    strength,
    dir,
    fineDir: fine.dir,
    fineStrength: fine.strength,
    level,
    spots,
    edge,
    edgeDir,
    widthOf,
    smooth0: smooth[0],
    smooth2: smooth[2],
    fineRef: scaleRef[0],
  };
}

/**
 * Round dark spots (freckles, moles) and how far each pixel is from one (`spotNear`), with this
 * face's typical spot response. Round dark spots light up the line measure on their rims; each spot
 * is found by its centre (which curves both ways) and protected over its whole extent.
 */
function spotProtection(
  spots: Float32Array,
  strength: Float32Array,
  lum: Float32Array,
  lumBlur: (sigma: number) => Float32Array,
  mask: Pixels,
  geoms: ZoneGeom[],
  w: number,
  h: number,
  fw: number,
) {
  const n = w * h;

  const spotR = Math.max(2, Math.round(fw * 0.008));
  // A freckle or mole stands alone; where several lines meet (crow's feet at the eye corner) the
  // junction is round and dark too, but has lines running out of it: those are not protected.
  // Line signal in a ring around each spot, ignoring the spot's own rim (which lights up the line
  // measure too): normalised blur of the line strength with the spot areas left out.
  const rawNear = slide(slide(spots, w, h, Math.round(spotR * 1.5), true, false), w, h, Math.round(spotR * 1.5), true, true);
  const spotRef = percentile(spots, mask, geoms, w, h, 0.9);
  const ringKeep = new Float32Array(n),
    ringLine = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    ringKeep[p] = 1 - smoothstep(0.15, 0.4, rawNear[p] / Math.max(1e-6, spotRef));
    ringLine[p] = strength[p] * ringKeep[p];
  }
  const ringNum = blurLike(ringLine, w, h, spotR * 3),
    ringDen = blurLike(ringKeep, w, h, spotR * 3);
  const surround = lumBlur(spotR * 2),
    core = lumBlur(Math.max(0.5, fw * 0.0014));
  // A freckle is a small dark patch on its own. On a deeply lined face the crevices' junctions are
  // round and dark too, but each is part of a long dark network: dark patches larger than a
  // freckle (connected, darker than the skin around them) are not protected.
  const small = smallDarkPatches(surround, core, w, h, spotR * 4);
  const isolated = new Float32Array(n),
    darkSpots = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    const around = ringDen[p] > 1e-3 ? ringNum[p] / ringDen[p] : 0;
    isolated[p] = spots[p] * (1 - smoothstep(0.25, 0.6, around));
    // A freckle or mole is also clearly darker than the skin around it; pores and grain are only
    // a little darker (counting them kept dark crease remnants and grain all over the forehead).
    darkSpots[p] =
      isolated[p] *
      smoothstep(SPOT_DARK[0], SPOT_DARK[1], surround[p] - core[p]) *
      small[p];
  }
  const near = (v: Float32Array) => slide(slide(v, w, h, spotR, true, false), w, h, spotR, true, true);
  // (The freckles' protection is softened at its edge: a square cut-off showed as square patches
  // where the skin around a freckle was lifted and the protected square was not.)
  return { roundNear: near(isolated), spotNear: blurLike(near(darkSpots), w, h, Math.max(1, spotR / 2)), spotRef, spotSurround: surround };
}

/**
 * Per pixel, how far a closing (max then min filter, a square window per line width: fine, deep,
 * fold) raises `base` above `level`: the depth of a valley narrower than the window.
 */
function valleyDepth(base: Float32Array, level: Float32Array, widthOf: Uint8Array, w: number, h: number, fw: number) {
  const n = w * h;
  const valley = new Float32Array(n),
    broad = new Float32Array(n);
  [0.006, 0.012, 0.03].forEach((k, i) => {
    const r = Math.max(1, Math.round(fw * k));
    const dil = slide(slide(base, w, h, r, true, false), w, h, r, true, true);
    const closed = slide(slide(dil, w, h, r, false, false), w, h, r, false, true);
    for (let p = 0; p < n; p++) if (widthOf[p] === i) valley[p] = Math.max(0, closed[p] - level[p]);
    // (The broadest window, for every pixel: how far a fold's trough sits below its sides.)
    if (i === 2) for (let p = 0; p < n; p++) broad[p] = Math.max(0, closed[p] - base[p]);
  });
  return { valley, broad };
}

/**
 * 1 on dark patches (darker than `surround` by most of SPOT_DARK[1]) that fit in a `size` square,
 * 0 elsewhere: connected patches (8-neighbours) found with a union-find over the picture.
 */
export function smallDarkPatches(surround: Float32Array, core: Float32Array, w: number, h: number, size: number): Float32Array {
  const n = w * h;
  const parent = new Int32Array(n).fill(-1);
  const find = (p: number): number => {
    let r = p;
    while (parent[r] !== r) r = parent[r];
    while (parent[p] !== r) {
      const next = parent[p];
      parent[p] = r;
      p = next;
    }
    return r;
  };
  const join = (a: number, b: number) => {
    const ra = find(a),
      rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (!(surround[p] - core[p] >= SPOT_DARK[1] * 0.75)) continue;
      parent[p] = p;
      if (x > 0 && parent[p - 1] >= 0) join(p, p - 1);
      if (y > 0) {
        if (parent[p - w] >= 0) join(p, p - w);
        if (x > 0 && parent[p - w - 1] >= 0) join(p, p - w - 1);
        if (x < w - 1 && parent[p - w + 1] >= 0) join(p, p - w + 1);
      }
    }
  const x0 = new Int32Array(n).fill(w),
    x1 = new Int32Array(n).fill(-1),
    y0 = new Int32Array(n).fill(h),
    y1 = new Int32Array(n).fill(-1);
  for (let p = 0; p < n; p++) {
    if (parent[p] < 0) continue;
    const r = find(p),
      x = p % w,
      y = (p / w) | 0;
    if (x < x0[r]) x0[r] = x;
    if (x > x1[r]) x1[r] = x;
    if (y < y0[r]) y0[r] = y;
    if (y > y1[r]) y1[r] = y;
  }
  const out = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    if (parent[p] < 0) continue;
    const r = parent[p];
    if (x1[r] - x0[r] < size && y1[r] - y0[r] < size) out[p] = 1;
  }
  return out;
}

/**
 * Surrounding skin colour (R, G, B), so a lifted crease takes the skin's colour (not its own
 * darker, more saturated one, which would leave orange-brown streaks). Shine and creases are left
 * out: the reference is the plain skin's colour, so lowered shine does not turn grey and lifted
 * creases do not turn orange.
 */
function plainSkinColour(pixels: Pixels, lum: Float32Array, around: Float32Array, w: number, h: number, fw: number): Float32Array[] {
  const n = w * h;
  const plain = new Float32Array(n);
  for (let p = 0; p < n; p++) plain[p] = Math.abs(lum[p] - around[p]) <= MIN_DEPTH[1] ? 1 : 0; // no shine, no creases
  const plainW = blurLike(plain, w, h, Math.max(3, fw * 0.02));
  return [0, 1, 2].map((c) => {
    const v = new Float32Array(n);
    for (let p = 0; p < n; p++) v[p] = pixels[p * 4 + c] * plain[p];
    const b = blurLike(v, w, h, Math.max(3, fw * 0.02));
    for (let p = 0; p < n; p++) b[p] = plainW[p] > 1e-3 ? b[p] / plainW[p] : pixels[p * 4 + c];
    return b;
  });
}

/**
 * Healing-brush texture for the lines (see healTexture), capped to this face's grain. Skin to
 * cover: anywhere the treatment may replace the texture (any line it would treat). Clean source
 * skin: no clear line nearby, no line-shaped detail, spot, hair or mask edge.
 */
function healLines(
  strength: Float32Array,
  mask: Pixels,
  lineShaped: Float32Array,
  spotNear: Float32Array,
  spotRef: number,
  strayNear: Float32Array,
  fineBand: Float32Array,
  lowBand: Float32Array,
  w: number,
  h: number,
  fw: number,
): Float32Array {
  const n = w * h;
  const strongLine = new Float32Array(n),
    anyLine = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    strongLine[p] = strength[p] > HEAL.cover ? 1 : 0;
    anyLine[p] = strength[p] > HEAL.line ? 1 : 0;
  }
  const lr = Math.max(1, Math.round(fw * 0.004));
  const need = slide(slide(strongLine, w, h, lr, true, false), w, h, lr, true, true);
  const nearAny = slide(slide(anyLine, w, h, lr, true, false), w, h, lr, true, true);
  const clean = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    const a = mask[p * 4 + 3];
    if (a < 8) {
      need[p] = 0;
      continue;
    }
    clean[p] = a > 230 && !nearAny[p] && lineShaped[p] < 0.6 && spotNear[p] < 0.3 * spotRef && strayNear[p] === 0 ? 1 : 0;
  }
  // The skin's typical grain amplitude; shine (bright specks) is not copied: sources with it are
  // skipped and what still comes through is capped.
  const amps: number[] = [];
  for (let p = 0; p < n; p += 2) if (clean[p]) amps.push(Math.abs(fineBand[p]));
  const sortedAmps = sorted(amps);
  const amp = Math.max(0.5, sortedAmps.length ? sortedAmps[sortedAmps.length >> 1] : 1);
  for (let p = 0; p < n; p++) if (clean[p] && fineBand[p] > HEAL.shine * amp) clean[p] = 0;
  const healed = healTexture(fineBand, lowBand, clean, need, w, h, fw);
  for (let p = 0; p < n; p++)
    if (!Number.isNaN(healed[p])) healed[p] = Math.max(-HEAL.darkCap * amp, Math.min(HEAL.brightCap * amp, healed[p]));
  return healed;
}

/** The last linesCompute's per-area corrections, before sharing (see linesLayers). */
let cached: {
  pixels: Pixels;
  lum: Float32Array;
  skin: Float32Array[];
  areaWeight: Record<AreaId, Float32Array>;
  /** Per area, over its window of the crop (see Window). */
  rawFill: Record<AreaId, Float32Array>;
  rawRecolour: Record<AreaId, Float32Array>;
  windows: Record<AreaId, Window>;
  width: number;
} | null = null;

/** Part of the crop an area can change (x, y, w, h); its corrections are kept for this part only. */
interface Window {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Correction layers for the areas that are switched on, from the last linesCompute. Areas overlap
 * (forehead and frown lines between the brows; crow's feet and under-eyes); each pixel's correction
 * is shared out among the areas that are on, mostly to the one it is most central to, summing to
 * one, so an overlap is treated once whichever areas are on. Null when nothing is cached (e.g. the
 * worker was restarted): the caller recomputes.
 */
export function linesLayers(enabled: readonly AreaId[]): Partial<LinesResult> | null {
  const c = cached;
  if (!c) return null;
  const out: Partial<LinesResult> = {};
  const W = c.width;
  const weights = enabled.map((a) => c.areaWeight[a]);
  for (const id of enabled) {
    const win = c.windows[id];
    const fill = new Float32Array(win.w * win.h),
      recolour = new Float32Array(win.w * win.h);
    const own = c.areaWeight[id],
      rawF = c.rawFill[id],
      rawR = c.rawRecolour[id];
    for (let y = 0; y < win.h; y++)
      for (let x = 0; x < win.w; x++) {
        const q = y * win.w + x,
          p = (y + win.y) * W + x + win.x;
        const f = rawF[q],
          r = rawR[q];
        if (f === 0 && r === 0) continue;
        let sum = 0;
        for (const a of weights) sum += a[p];
        const share = sum > 1e-6 ? own[p] / Math.max(sum, own[p]) : 0;
        fill[q] = f * share;
        recolour[q] = r * share;
      }
    out[id] = toLayers(c.pixels, c.lum, fill, c.skin, recolour, win, W);
  }
  return out;
}

/** Change lightness by `fill` per pixel (lift lines, lower ridges); the more a pixel changes, the more it takes the skin's colour. */
function toLayers(
  pixels: Pixels,
  lum: Float32Array,
  fill: Float32Array,
  skin: Float32Array[],
  recolour: Float32Array,
  win: Window,
  W: number,
): Layers {
  const n = lum.length;
  // Unchanged everywhere (white multiply, black add, both opaque), then the window's changes.
  const mul = new Uint8ClampedArray(n * 4).fill(255);
  const add = new Uint8ClampedArray(n * 4);
  new Uint32Array(add.buffer).fill(new Uint32Array(new Uint8Array([0, 0, 0, 255]).buffer)[0]);
  for (let q = 0; q < fill.length; q++) {
    const p = (((q / win.w) | 0) + win.y) * W + (q % win.w) + win.x;
    const i = p * 4;
    const f = fill[q];
    if ((Math.abs(f) < 0.25 && !(recolour[q] > 0.05)) || lum[p] < 1) continue;
    const target = lum[p] + f;
    const sl = 0.2126 * skin[0][p] + 0.7152 * skin[1][p] + 0.0722 * skin[2][p];
    // Lifted creases take the skin's colour; lowered ridges (often shine) mostly keep their own.
    // Creases are redder than the skin around them: even small lifts take most of its colour.
    // (A deep fold lifted far takes the skin's colour fully: its own, scaled up, turns orange.)
    let a = f > 0 ? Math.min(f / 8, 0.55 + 0.4 * smoothstep(20, 60, f)) : Math.min(0.5, -f / 30);
    // Main areas: the colour is the plain skin's too, so a removed fold leaves no tinted trace.
    a = Math.max(a, recolour[q] * 0.85);
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
function percentile(v: Float32Array, mask: Pixels, zones: ZoneGeom[], w: number, h: number, q: number): number {
  const xs: number[] = [];
  for (let p = 0; p < w * h; p += 3) {
    if (v[p] <= 0 || mask[p * 4 + 3] <= 128) continue;
    const x = p % w,
      y = (p / w) | 0;
    if (zones.some((g) => zoneWeight(g, x, y, 0) > 0)) xs.push(v[p]);
  }
  if (!xs.length) return 1;
  return sorted(xs)[Math.floor(xs.length * q)];
}

/** The numbers in ascending order (a typed array's numeric sort: much faster than Array sort). */
function sorted(xs: number[]): Float64Array {
  return Float64Array.from(xs).sort();
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
  shading?: Float32Array,
): Float32Array {
  const n = w * h;
  const ref: number[] = [];
  for (let p = 0; p < n; p += 3)
    if (mask[p * 4 + 3] > 200 && lineShaped[p] < 0.3) ref.push(Math.abs(fineBand[p]));
  const refSorted = sorted(ref);
  // Median |x| of zero-mean noise is ~0.674 sigma.
  const target = ref.length ? refSorted[Math.floor(ref.length / 2)] / 0.674 : 2;
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
  // For each grid cell, the points that can be among the three nearest to any pixel in it: of
  // the 5 x 5 points around, those no farther than the third-closest point's farthest distance
  // (same points, same order, so the same result with fewer to check per pixel).
  const candStart = new Int32Array(gw * gh + 1),
    cands = new Int32Array(gw * gh * 25),
    candMin = new Float64Array(gw * gh * 25);
  const near = new Float64Array(25),
    far = new Float64Array(25),
    ks = new Int32Array(25),
    idx = new Int32Array(25);
  let nc = 0;
  for (let cj = 0; cj < gh; cj++)
    for (let ci = 0; ci < gw; ci++) {
      candStart[cj * gw + ci] = nc;
      // The cell's pixels lie in this box.
      const bx0 = (ci - 1) * cell,
        bx1 = ci * cell,
        by0 = (cj - 1) * cell,
        by1 = cj * cell;
      let m = 0;
      for (let j = Math.max(0, cj - 2); j <= Math.min(gh - 1, cj + 2); j++)
        for (let i = Math.max(0, ci - 2); i <= Math.min(gw - 1, ci + 2); i++) {
          const k = j * gw + i;
          const nx = Math.max(0, bx0 - px[k], px[k] - bx1),
            ny = Math.max(0, by0 - py[k], py[k] - by1);
          const fx = Math.max(Math.abs(px[k] - bx0), Math.abs(px[k] - bx1)),
            fy = Math.max(Math.abs(py[k] - by0), Math.abs(py[k] - by1));
          near[m] = nx * nx + ny * ny;
          far[m] = fx * fx + fy * fy;
          ks[m] = k;
          m++;
        }
      // The third smallest farthest distance: no pixel in the cell is farther from three points.
      let f1 = Infinity,
        f2 = Infinity,
        f3 = Infinity;
      for (let t = 0; t < m; t++) {
        const f = far[t];
        if (f < f1) {
          f3 = f2;
          f2 = f1;
          f1 = f;
        } else if (f < f2) {
          f3 = f2;
          f2 = f;
        } else if (f < f3) f3 = f;
      }
      const limit = f3 * (1 + 1e-6) + 1e-6;
      // Nearest-possible first (insertion sort), so a pixel can stop once no remaining point can
      // be among its three.
      let q = 0;
      for (let t = 0; t < m; t++) {
        if (!(near[t] <= limit)) continue;
        let u = q++;
        while (u > 0 && near[idx[u - 1]] > near[t]) {
          idx[u] = idx[u - 1];
          u--;
        }
        idx[u] = t;
      }
      for (let u = 0; u < q; u++) {
        cands[nc] = ks[idx[u]];
        candMin[nc++] = near[idx[u]] * (1 - 1e-9) - 1e-9;
      }
    }
  candStart[gw * gh] = nc;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const ci = Math.floor(x / cell) + 1,
        cj = Math.floor(y / cell) + 1;
      // The three nearest points, ranked by squared distance (same order, no square roots).
      let d1 = Infinity,
        d2 = Infinity,
        d3 = Infinity,
        k1 = 0,
        k2 = 0,
        k3 = 0;
      const c = cj * gw + ci;
      for (let t = candStart[c], e = candStart[c + 1]; t < e; t++) {
          if (candMin[t] > d3) break; // this and every later point is farther than the third
          const k = cands[t];
          const ddx = x - px[k],
            ddy = y - py[k];
          const d = ddx * ddx + ddy * ddy;
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
      d1 = hypot(x - px[k1], y - py[k1]);
      d2 = hypot(x - px[k2], y - py[k2]);
      d3 = hypot(x - px[k3], y - py[k3]);
      const furrow = 1 - smoothstep(0, fw2, (d2 - d1) / 2);
      const junction = 1 - smoothstep(0, fw2 * 1.5, (d3 - d1) / 2);
      const a = Math.min(k1, k2),
        b = Math.max(k1, k2);
      const depth = 0.45 + 0.9 * hash(a * 7919 + b, 0x3a7d);
      // The three cells in index order.
      let s0 = k1,
        s1 = k2,
        s2 = k3,
        t: number;
      if (s0 > s1) { t = s0; s0 = s1; s1 = t; }
      if (s1 > s2) { t = s1; s1 = s2; s2 = t; }
      if (s0 > s1) { t = s0; s0 = s1; s1 = t; }
      const pore = junction * (hash(s0 * 104729 + s1 * 7919 + s2, 0x6b2f) < 0.15 ? 1 : 0);
      // Cell tops catch a little light; furrows and pores sit in shadow.
      relief[y * w + x] = 0.3 * (1 - furrow) - furrow * depth - 1.0 * pore;
    }
  const fine = blurLike(noise(0x9e37), w, h, Math.max(0.6, fw * 0.0006));
  let fs = 0;
  for (let p = 0; p < n; p++) fs += fine[p] * fine[p];
  const fsd = Math.sqrt(fs / n) || 1;
  // Soft edges (furrows are rounded, never a hard pixel line), then the fine grain.
  let soft = blurLike(relief, w, h, Math.max(0.5, cell * 0.06));
  // Light it like the photo: the relief is a height map, lit from the direction the face's own
  // shading says the light comes from (each furrow gets a lit and a shadowed edge), plus a little
  // ambient term (cell tops lighter than furrows whatever the direction).
  const light = shading ? lightDirection(shading, mask, w, h, fw) : null;
  if (light) {
    const lit = new Float32Array(n);
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        const p = y * w + x;
        const gx = (soft[p + 1] - soft[p - 1]) / 2,
          gy = (soft[p + w] - soft[p - w]) / 2;
        // Surface facing the light is brighter: slope towards the light raises it.
        lit[p] = (gx * light.x + gy * light.y) * cell * 0.9 * light.strength + 0.45 * soft[p];
      }
    soft = lit;
  }
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
  // Texture contrast follows the light: stronger where the skin is lit, fainter in shadow.
  if (shading) {
    let m = 0,
      c = 0;
    for (let p = 0; p < n; p += 3)
      if (mask[p * 4 + 3] > 200) {
        m += shading[p];
        c++;
      }
    m = c ? m / c : 1;
    for (let p = 0; p < n; p++) out[p] *= Math.max(0.45, Math.min(1.5, shading[p] / Math.max(1, m)));
  }
  return out;
}

/**
 * Where the light comes from, from the face's broad shading: the average direction in which the
 * skin gets brighter (over the skin mask), as a unit vector pointing towards the light, with a
 * strength 0..1 (0 = flat, frontal light: no directional shading of the texture).
 */
export function lightDirection(shading: Float32Array, mask: Pixels, w: number, h: number, fw: number) {
  const broad = blurLike(shading, w, h, Math.max(3, fw * 0.05));
  let sx = 0,
    sy = 0,
    mag = 0;
  for (let y = 2; y < h - 2; y += 2)
    for (let x = 2; x < w - 2; x += 2) {
      const p = y * w + x;
      if (mask[p * 4 + 3] <= 200) continue;
      const gx = (broad[p + 2] - broad[p - 2]) / 4,
        gy = (broad[p + 2 * w] - broad[p - 2 * w]) / 4;
      sx += gx;
      sy += gy;
      mag += Math.hypot(gx, gy);
    }
  const len = Math.hypot(sx, sy);
  if (len < 1e-6 || mag < 1e-6) return { x: 0, y: -1, strength: 0.4 };
  // How consistent the gradients are says how directional the light is. Weakly directional
  // (frontal) light is taken as coming from slightly above, the usual case, rather than trusting
  // a direction the face's own shape produced.
  const c = Math.min(1, (len / mag) * 3);
  const t = Math.max(0, Math.min(1, (c - 0.25) / 0.35));
  const x = (sx / len) * t,
    y = (sy / len) * t + -1 * (1 - t);
  const l = Math.hypot(x, y) || 1;
  return { x: x / l, y: y / l, strength: Math.max(0.4, c) };
}

/**
 * Hair thresholds: thin dark line strength relative to the median fine-line response on this
 * face's skin (a steady reference: it does not move with how deep the face's folds are), and
 * darkness below the surrounding skin, in levels and in multiples of the local skin grain (so
 * growth never spreads through grainy skin, e.g. a noisy camera frame).
 */
export const HAIR = { seed: 1.6, grow: 0.25, seedDark: 3, growDark: 0.8, seedGrain: 3, growGrain: 0.6, bridge: 2, turn: 50 };

/**
 * Stray hairs over the skin, 0..1. A loose hair, a wisp or a curl lying on the forehead is a thin
 * dark line like a crease, and may bend any way (a curl's loop runs across the forehead too), so
 * neither shape nor direction tells it apart. What does: it is connected to the hair. Starting
 * from strong thin lines touching the hairline (the skin mask's edge in the forehead's upper half),
 * the region grows along fainter thin dark lines (bridging one-pixel gaps); creases, which start
 * and end on the skin, are never reached. The strand is widened by a pixel for its soft edge.
 */
export function strayHairs(
  lum: Float32Array,
  around: Float32Array,
  mask: Uint8ClampedArray,
  zones: Zone[],
  w: number,
  h: number,
  fw: number,
  /** Pixels of a broader line (a crease): growth never passes through them. */
  crease: (p: number) => boolean = () => false,
): Float32Array {
  const n = w * h;
  const out = new Float32Array(n);
  const forehead = zones.filter((z) => z.id === "forehead" && !z.strict);
  if (!forehead.length) return out;
  // Any skin, the mask's faded edge included: strands cross that fade on their way from the hair.
  const inside = (p: number) => mask[p * 4 + 3] > 8;
  // Its own sharp line measure: a strand is one or two pixels wide on a 1k photo, finer than the
  // creases' finest width (whose box blur is wider than its nominal size).
  const sigma = Math.max(0.7, fw * 0.0028);
  const [g1] = binomial(lum, w, h, [sigma]);
  const thin = thinLine(g1, w, h, sigma);
  const fineStrength = thin.strength,
    lineDir = thin.dir;
  // The next width's strength is only needed for thin dark pixels near the hairline and along
  // strands: worked out there only, a tile at a time (its smoothing is many passes).
  const deepStrength = lazyThinLine(lum, w, h, sigma * 2.3);
  // Local grain: mean absolute fine detail around each pixel.
  const detail = new Float32Array(n);
  for (let p = 0; p < n; p++) detail[p] = Math.abs(lum[p] - g1[p]);
  const grain = blurLike(detail, w, h, Math.max(3, fw * 0.02));
  const sample: number[] = [];
  for (let p = 0; p < n; p += 3) if (inside(p) && fineStrength[p] > 0) sample.push(fineStrength[p]);
  if (sample.length < 50) return out;
  const fineRef = sorted(sample)[sample.length >> 1];
  // Thin (the finest width at least as strong as the next: hair, not a fold's edge) and darker
  // than the skin around, by more than the skin's own grain.
  // (Strength and darkness first: the width test is only needed where they pass.)
  const strong = (p: number) => {
    const rel = fineStrength[p] / fineRef,
      dark = around[p] - lum[p];
    const g = Math.max(0.5, grain[p]);
    return rel > HAIR.seed && dark > Math.max(HAIR.seedDark, HAIR.seedGrain * g)
      ? 2
      : rel > HAIR.grow && dark > Math.max(HAIR.growDark, HAIR.growGrain * g)
        ? 1
        : 0;
  };
  // Each pixel's level (0 none, 1 grow, 2 seed), worked out when first asked for (kept + 1).
  const lvKept = new Uint8Array(n);
  const lv = (p: number) => {
    let v = lvKept[p];
    if (!v) {
      let l = inside(p) && !crease(p) ? strong(p) : 0;
      if (l && fineStrength[p] < deepStrength(p) * 0.8) l = 0;
      lvKept[p] = v = l + 1;
    }
    return v - 1;
  };
  // Seeds: strong pixels within 3 px of the outside (hair), in the forehead's upper half.
  const seen = new Uint8Array(n);
  const queue = new Int32Array(n);
  let qh = 0,
    qt = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (!inside(p) || strong(p) !== 2) continue;
      let upper = false;
      for (const z of forehead) if (ellipseWeight(z, x, y) > 0 && y < z.cy) upper = true;
      if (!upper) continue;
      let edge = false;
      for (let dy = -3; dy <= 3 && !edge; dy++)
        for (let dx = -3; dx <= 3; dx++) {
          const xx = x + dx,
            yy = y + dy;
          // The hair is the mask's outside within the photo; the crop's or photo's own edge is
          // not (a forehead cut off by the top of the photo has no hairline there).
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          if (!inside(yy * w + xx)) {
            edge = true;
            break;
          }
        }
      if (edge && lv(p) === 2) {
        seen[p] = 1;
        queue[qt++] = p;
      }
    }
  // Follow the strand: to candidates within a short gap (a strand fades where it catches light)
  // whose direction agrees with this pixel's, stepping along the line rather than across it.
  // Grain has no steady direction, so growth cannot spread through it.
  const br = HAIR.bridge;
  const turn = Math.cos((HAIR.turn * Math.PI) / 180);
  while (qh < qt) {
    const p = queue[qh++];
    const x = p % w,
      y = (p / w) | 0;
    const dx0 = Math.cos(lineDir[p]),
      dy0 = Math.sin(lineDir[p]);
    for (let dy = -br; dy <= br; dy++)
      for (let dx = -br; dx <= br; dx++) {
        if (!dx && !dy) continue;
        const xx = x + dx,
          yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const q = yy * w + xx;
        if (seen[q] || !lv(q)) continue;
        if (Math.abs(Math.cos(lineDir[q] - lineDir[p])) < turn) continue;
        const len = Math.hypot(dx, dy);
        if (len > 1.5 && Math.abs(dx * dx0 + dy * dy0) / len < 0.7) continue;
        seen[q] = 1;
        queue[qt++] = q;
      }
  }
  // The strand itself, plus a softer pixel around it.
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (!seen[p] || !lv(p)) continue;
      out[p] = 1;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx,
            yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < w && yy < h) out[yy * w + xx] = Math.max(out[yy * w + xx], 0.6);
        }
    }
  return out;
}

/**
 * Repeated [1 2 1]/4 passes (each adds variance 1/2): a close Gaussian for small sigmas. One copy
 * per sigma (ascending), each the same run of passes stopped at its own count.
 */
export function binomial(src: Float32Array, w: number, h: number, sigmas: number[]): Float32Array[] {
  const counts = sigmas.map((sigma) => Math.max(1, Math.round(2 * sigma * sigma)));
  const outs: Float32Array[] = [];
  const passes = Math.max(...counts);
  const a = src.slice();
  // Each pass: along the row, then down the columns. Done a row at a time: the row pass of the
  // row below goes into a ring of three rows, and the column pass of this row reads from there
  // (so the picture is read once per pass, not twice).
  const ring = new Float32Array(3 * w);
  const rowPass = (y: number) => {
    const row = y * w,
      o = (y % 3) * w;
    if (w === 1) {
      ring[o] = (a[row] + 2 * a[row] + a[row]) / 4;
      return;
    }
    ring[o] = (a[row] + 2 * a[row] + a[row + 1]) / 4;
    for (let x = 1; x < w - 1; x++) ring[o + x] = (a[row + x - 1] + 2 * a[row + x] + a[row + x + 1]) / 4;
    ring[o + w - 1] = (a[row + w - 2] + 2 * a[row + w - 1] + a[row + w - 1]) / 4;
  };
  for (let k = 0; k < passes; k++) {
    rowPass(0);
    if (h > 1) rowPass(1);
    for (let y = 0; y < h; y++) {
      const row = y * w,
        up = ((y > 0 ? y - 1 : y) % 3) * w,
        mid = (y % 3) * w,
        down = ((y < h - 1 ? y + 1 : y) % 3) * w;
      for (let x = 0; x < w; x++) a[row + x] = (ring[up + x] + 2 * ring[mid + x] + ring[down + x]) / 4;
      // The row two below is needed next; its row pass reads rows this one has not written.
      if (y + 2 < h) rowPass(y + 2);
    }
    counts.forEach((c, i) => {
      if (c === k + 1) outs[i] = a.slice();
    });
  }
  return outs;
}

/**
 * thinLine's strength at `sigma` (from the lightness binomial-smoothed at it), as a function of the
 * pixel, worked out a tile at a time when first asked for. Each tile smooths a window reaching as
 * many pixels past it as there are passes (each pass reaches one pixel further), so its values are
 * exactly those of smoothing the whole picture.
 */
function lazyThinLine(lum: Float32Array, w: number, h: number, sigma: number): (p: number) => number {
  const passes = Math.max(1, Math.round(2 * sigma * sigma));
  const T = 128,
    M = passes + 2;
  const tw = Math.ceil(w / T);
  const tiles = new Map<number, Float32Array>();
  const tile = (tx: number, ty: number) => {
    const x0 = tx * T,
      y0 = ty * T,
      x1 = Math.min(w, x0 + T),
      y1 = Math.min(h, y0 + T);
    const wx0 = Math.max(0, x0 - M),
      wy0 = Math.max(0, y0 - M),
      ww = Math.min(w, x1 + M) - wx0,
      wh = Math.min(h, y1 + M) - wy0;
    const win = new Float32Array(ww * wh);
    for (let y = 0; y < wh; y++) win.set(lum.subarray((y + wy0) * w + wx0, (y + wy0) * w + wx0 + ww), y * ww);
    const g = binomial(win, ww, wh, [sigma])[0];
    const out = new Float32Array(T * T);
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue; // as thinLine: no border pixels
        const q = (y - wy0) * ww + x - wx0;
        const hxx = g[q - 1] - 2 * g[q] + g[q + 1];
        const hyy = g[q - ww] - 2 * g[q] + g[q + ww];
        const hxy = (g[q + ww + 1] - g[q + ww - 1] - g[q - ww + 1] + g[q - ww - 1]) / 4;
        const mean = (hxx + hyy) / 2,
          diff = Math.sqrt(((hxx - hyy) / 2) ** 2 + hxy * hxy);
        const s = mean + diff - Math.abs(mean - diff);
        if (s > 0) out[(y - y0) * T + x - x0] = s * sigma * sigma;
      }
    return out;
  };
  return (p) => {
    const x = p % w,
      y = (p / w) | 0;
    const tx = (x / T) | 0,
      ty = (y / T) | 0,
      k = ty * tw + tx;
    let t = tiles.get(k);
    if (!t) tiles.set(k, (t = tile(tx, ty)));
    return t[(y - ty * T) * T + x - tx * T];
  };
}

/** Scale-normalised dark-line strength (curvature across minus along) at `sigma` (from the lightness `g` smoothed at it), and the line's direction. */
function thinLine(g: Float32Array, w: number, h: number, sigma: number): { strength: Float32Array; dir: Float32Array } {
  const strength = new Float32Array(w * h),
    dir = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      const hxx = g[p - 1] - 2 * g[p] + g[p + 1];
      const hyy = g[p - w] - 2 * g[p] + g[p + w];
      const hxy = (g[p + w + 1] - g[p + w - 1] - g[p - w + 1] + g[p - w - 1]) / 4;
      const mean = (hxx + hyy) / 2,
        diff = Math.sqrt(((hxx - hyy) / 2) ** 2 + hxy * hxy);
      const s = mean + diff - Math.abs(mean - diff);
      if (s > 0) {
        strength[p] = s * sigma * sigma;
        dir[p] = 0.5 * Math.atan2(2 * hxy, hxx - hyy) + Math.PI / 2;
      }
    }
  return { strength, dir };
}

/**
 * Healing-brush texture: for each block of skin that needs new texture (`need`), the offset to the
 * cleanest skin nearby (`clean`: no lines, spots, hair or mask edge) of similar brightness, and the
 * fine texture (`fine`) read through it, scaled to the local brightness. Neighbouring blocks are
 * cross-faded (keeping the texture's contrast, not averaging it away). NaN where no clean skin was
 * found (the caller falls back to generated grain).
 */
export function healTexture(
  fine: Float32Array,
  low: Float32Array,
  clean: Float32Array,
  need: Float32Array,
  w: number,
  h: number,
  fw: number,
): Float32Array {
  const n = w * h;
  const out = new Float32Array(n).fill(NaN);
  const B = Math.max(6, Math.round(fw * HEAL.block));
  const bw = Math.ceil(w / B),
    bh = Math.ceil(h / B);
  // Blocks with need in or next to them (their neighbours are blended in too).
  const blockNeed = new Uint8Array(bw * bh);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (need[y * w + x] > 0) {
        const bx = Math.floor(x / B),
          by = Math.floor(y / B);
        for (let j = -1; j <= 1; j++)
          for (let i = -1; i <= 1; i++) {
            const X = bx + i,
              Y = by + j;
            if (X >= 0 && Y >= 0 && X < bw && Y < bh) blockNeed[Y * bw + X] = 1;
          }
      }
  // Candidate offsets: rings around the block, several radii and angles.
  const cands: [number, number][] = [];
  for (let r = 1; r <= HEAL.rings; r++) {
    const steps = 8 * r;
    for (let k = 0; k < steps; k++) {
      const a = (2 * Math.PI * (k + 0.5 * (r % 2))) / steps;
      cands.push([Math.round(Math.cos(a) * r * B * 0.75), Math.round(Math.sin(a) * r * B * 0.75)]);
    }
  }
  // The best few sources per block (a pixel whose first source is not clean uses the next).
  const K = 3;
  const offX = new Int32Array(bw * bh * K),
    offY = new Int32Array(bw * bh * K),
    nOk = new Uint8Array(bw * bh);
  const step = Math.max(1, Math.round(B / 6)); // sample the block sparsely when scoring
  const scores: number[] = [],
    order: number[] = [];
  for (let by = 0; by < bh; by++)
    for (let bx = 0; bx < bw; bx++) {
      const b = by * bw + bx;
      if (!blockNeed[b]) continue;
      const x0 = bx * B,
        y0 = by * B,
        x1 = Math.min(w, x0 + B),
        y1 = Math.min(h, y0 + B);
      let lowHere = 0,
        cnt = 0;
      for (let y = y0; y < y1; y += step)
        for (let x = x0; x < x1; x += step) {
          lowHere += low[y * w + x];
          cnt++;
        }
      lowHere /= Math.max(1, cnt);
      scores.length = 0;
      order.length = 0;
      cands.forEach(([dx, dy], ci) => {
        if (x0 + dx < 0 || y0 + dy < 0 || x1 + dx > w || y1 + dy > h) return;
        let c = 0,
          lw = 0,
          m = 0;
        for (let y = y0; y < y1; y += step)
          for (let x = x0; x < x1; x += step) {
            const q = (y + dy) * w + x + dx;
            c += clean[q];
            lw += low[q];
            m++;
          }
        const cleanFrac = c / m;
        if (cleanFrac < HEAL.minClean) return;
        const bright = Math.abs(lw / m - lowHere) / Math.max(10, lowHere);
        scores[ci] = cleanFrac - bright * 2 - Math.hypot(dx, dy) / (B * HEAL.rings * 8);
        order.push(ci);
      });
      order.sort((i, j) => scores[j] - scores[i]);
      const k = Math.min(K, order.length);
      for (let t = 0; t < k; t++) {
        offX[b * K + t] = cands[order[t]][0];
        offY[b * K + t] = cands[order[t]][1];
      }
      nOk[b] = k;
    }
  // Cross-fade between block centres; normalised by the root of the summed squared weights so
  // the blended texture keeps the contrast of a single source.
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (need[p] <= 0) continue;
      const fx = (x + 0.5) / B - 0.5,
        fy = (y + 0.5) / B - 0.5;
      const ix = Math.floor(fx),
        iy = Math.floor(fy);
      // Up to four sources; blocks sharing an offset are one source (their weights add).
      const ox: number[] = [],
        oy: number[] = [],
        ow: number[] = [];
      for (let j = 0; j <= 1; j++)
        for (let i = 0; i <= 1; i++) {
          const X = Math.min(bw - 1, Math.max(0, ix + i)),
            Y = Math.min(bh - 1, Math.max(0, iy + j));
          const b = Y * bw + X;
          if (!nOk[b]) continue;
          const wx = i ? fx - ix : 1 - (fx - ix),
            wy = j ? fy - iy : 1 - (fy - iy);
          const wt = Math.max(0, wx) * Math.max(0, wy);
          if (wt <= 0) continue;
          // This block's best source that lands on clean skin here.
          let t = 0;
          for (; t < nOk[b]; t++) {
            const qx = x + offX[b * K + t],
              qy = y + offY[b * K + t];
            if (qx >= 0 && qy >= 0 && qx < w && qy < h && clean[qy * w + qx]) break;
          }
          if (t === nOk[b]) continue;
          const dx = offX[b * K + t],
            dy = offY[b * K + t];
          const k = ox.findIndex((v, u) => v === dx && oy[u] === dy);
          if (k >= 0) ow[k] += wt;
          else {
            ox.push(dx);
            oy.push(dy);
            ow.push(wt);
          }
        }
      let sum = 0,
        w2 = 0;
      for (let k = 0; k < ox.length; k++) {
        const qx = x + ox[k],
          qy = y + oy[k];
        if (qx < 0 || qy < 0 || qx >= w || qy >= h) continue;
        const q = qy * w + qx;
        // Only clean skin is copied: a source pixel on a line or spot is skipped.
        if (!clean[q]) continue;
        // Pore contrast follows brightness: scale to this spot's level.
        const gain = Math.min(1.5, Math.max(0.6, low[p] / Math.max(1, low[q])));
        sum += ow[k] * fine[q] * gain;
        w2 += ow[k] * ow[k];
      }
      if (w2 > 0) out[p] = sum / Math.sqrt(w2);
    }
  return out;
}

/**
 * Healing: block size (of face width), search rings, least clean share of a source block, line
 * strength that rules a source out, line strength that asks for new texture, and (in multiples of
 * the typical grain) the brightest source detail allowed and the caps on copied detail.
 */
export const HEAL = { block: 0.035, rings: 8, minClean: 0.6, line: 0.56, cover: 0.12, shine: 3, brightCap: 2, darkCap: 4 };
