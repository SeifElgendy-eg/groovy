// Green screen (chroma key) for body shaping. Pure functions on RGBA pixels (no DOM), unit-tested.
//
// On a green backdrop "not green" is the person, at the photo's full resolution and exact to the
// pixel: a far better outline than any model's, whatever the light or the clothes. The app then
// puts the person on the clinic's branded background, and slimming can never bend the background
// (it is replaced; where the body moves away, the branded background shows).
//
// The screen is found on the photo's border (around the person), so nothing needs setting up.
// keyPerson does the whole keying, in steps:
//  - the screen's colour is mapped across the photo (it is never lit evenly: falloff, folds, the
//    person's shadow), and each pixel's alpha is how much of that local screen colour is in it
//    (linear, so soft edges come out right); a pixel with the screen's hue is screen whatever its
//    brightness (its shadows);
//  - inside the body (where the segmenter is sure), only the screen's exact colour is screen, so
//    green clothes stay;
//  - edge pixels get the person's own colour back (the screen's share taken out);
//  - a floor that is not green is background except where the segmenter is sure of the person, and
//    anything far from the person is background;
//  - green light the screen throws on the person's edges ("spill") is taken out.
// Tuned on synthetic green screen photos with known cut-outs (studio, booth with a grey floor, and a
// dim uneven screen).

import { personCover } from "./backdrop";
import { distanceTransform } from "./field";

/** The screen: how green it is (see greenness), and how much of the photo's border it covers. */
export interface Key {
  /** The screen's typical greenness (0..1). */
  green: number;
  /** Share (0..1) of the photo's border that is the screen. */
  share: number;
  /** The screen's typical colour (r, g, b), to unmix the edges. */
  rgb: [number, number, number];
}

/** Below this share of the border, there is no green screen in the photo (the app works as without). */
export const MIN_SHARE = 0.35;

/**
 * How green a pixel is, whatever its brightness: how far green rises above the larger of red and
 * blue, as a share of the green itself (a lit screen and its shadow score the same; skin, white,
 * grey and dark clothes score 0 or less).
 */
export const greenness = (r: number, g: number, b: number): number => (g - Math.max(r, b)) / Math.max(g, 1);

/** A clearly green pixel (as a screen is). */
const greenish = (r: number, g: number, b: number) => g > 30 && greenness(r, g, b) > 0.2;

/**
 * The green screen of a photo, from its border (an outer band `band` x the short side wide), or
 * null when the border is not mostly green.
 */
export function findKey(rgba: Uint8ClampedArray, w: number, h: number, band = 0.06): Key | null {
  const bw = Math.max(1, Math.round(band * Math.min(w, h)));
  const step = Math.max(1, Math.round(Math.min(w, h) / 400)); // a sample of the band is plenty
  const gs: number[] = [], rs: number[] = [], gg: number[] = [], bs: number[] = [];
  let n = 0;
  for (let y = 0; y < h; y += step) {
    const edgeRow = y < bw || y >= h - bw;
    for (let x = 0; x < w; x += step) {
      // inside the band only: jump over the middle of the row
      if (!edgeRow && x >= bw && x < w - bw) {
        x = (Math.ceil((w - bw) / step) - 1) * step;
        continue;
      }
      n++;
      const i = (y * w + x) * 4, r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      if (greenish(r, g, b)) {
        gs.push(greenness(r, g, b));
        rs.push(r);
        gg.push(g);
        bs.push(b);
      }
    }
  }
  const share = n ? gs.length / n : 0;
  if (share < MIN_SHARE) return null;
  const med = (v: number[]) => Float32Array.from(v).sort()[v.length >> 1];
  return { green: med(gs), share, rgb: [med(rs), med(gg), med(bs)] };
}

/** A floor that is not green (the screen stops above it): its colour, from the photo's border. */
export interface Floor {
  /** Colour without brightness: r / sum and g / sum. */
  cr: number;
  cg: number;
  /** Brightness (r + g + b) range of the floor, its shadows included. */
  lo: number;
  hi: number;
  /** Where it starts, as a share of the height. */
  top: number;
}

/**
 * The floor in front of the screen when it is not green: the part of the border (sides and bottom)
 * that is not screen, below the screen. Null when the floor is green too (or not in the photo).
 */
export function findFloor(rgba: Uint8ClampedArray, w: number, h: number, band = 0.06): Floor | null {
  const bw = Math.max(1, Math.round(band * Math.min(w, h)));
  const step = Math.max(1, Math.round(Math.min(w, h) / 400));
  const cr: number[] = [], cg: number[] = [], lum: number[] = [];
  let n = 0, top = h;
  for (let y = Math.floor(h / 2); y < h; y += step)
    for (let x = 0; x < w; x += step) {
      if (x >= bw && x < w - bw && y < h - bw) continue;
      n++;
      const i = (y * w + x) * 4, r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      if (greenish(r, g, b)) continue;
      const sum = r + g + b + 1;
      cr.push(r / sum);
      cg.push(g / sum);
      lum.push(sum);
      if (x < bw || x >= w - bw) top = Math.min(top, y);
    }
  if (cr.length < 0.05 * n) return null;
  const q = (v: number[], f: number) => v.sort((a, b) => a - b)[Math.min(v.length - 1, Math.floor(f * v.length))];
  // the floor's shadow (under and around the feet) is darker than the border sees
  return { cr: q(cr, 0.5), cg: q(cg, 0.5), lo: 0.35 * q(lum, 0.05), hi: 1.15 * q(lum, 0.95), top: Math.min(top, h - bw) / h };
}

/** Whether a pixel has the floor's colour (any of its shades). */
function floorLike(f: Floor, r: number, g: number, b: number): boolean {
  const sum = r + g + b + 1;
  if (sum < f.lo || sum > f.hi) return false;
  return Math.hypot(r / sum - f.cr, g / sum - f.cg) < 0.035;
}

/**
 * Alpha (0 screen .. 255 person) of each pixel, from its greenness relative to the screen's: at or
 * above `inner` of it, screen; at or below `outer` of it, person; a soft ramp between (the edge:
 * hair, motion blur, a half-covered pixel). Shadows and folds on the screen stay screen.
 */
export function keyAlpha(rgba: Uint8ClampedArray, w: number, h: number, key: Key, inner = 0.7, outer = 0.3): Uint8Array {
  const out = new Uint8Array(w * h);
  const g0 = Math.max(0.05, key.green);
  for (let p = 0, i = 0; p < out.length; p++, i += 4) {
    const k = greenness(rgba[i], rgba[i + 1], rgba[i + 2]) / g0;
    const t = (inner - k) / (inner - outer); // 0 screen .. 1 person
    out[p] = t <= 0 ? 0 : t >= 1 ? 255 : Math.round(255 * t * t * (3 - 2 * t));
  }
  return out;
}

/** The screen's colour around each part of the photo (it is never lit evenly), on a coarse grid. */
export interface ScreenMap {
  /** RGB per cell, gw x gh cells of `cell` px. */
  rgb: Float32Array;
  gw: number;
  gh: number;
  cell: number;
}

/**
 * The screen's colour around every point: averaged over the pixels that are surely screen in each
 * cell, and carried in (smoothly, from coarser levels) where the person hides it. Within the person
 * (`person` > 0.5, when given) nothing is taken as screen: green clothes would pass for it.
 */
export function screenMap(rgba: Uint8ClampedArray, w: number, h: number, key: Key, cell = 12, person: Allowed | null = null): ScreenMap {
  const gw = Math.ceil(w / cell), gh = Math.ceil(h / cell);
  const sum = new Float32Array(gw * gh * 3), n = new Float32Array(gw * gh);
  const g0 = Math.max(0.05, key.green);
  for (let y = 0; y < h; y++) {
    const cy = Math.floor(y / cell) * gw;
    const py = person ? Math.min(person.h - 1, Math.floor(((y + 0.5) * person.h) / h)) * person.w : 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4, r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      if (g < 20 || greenness(r, g, b) < 0.85 * g0) continue;
      if (person && person.data[py + Math.min(person.w - 1, Math.floor(((x + 0.5) * person.w) / w))] > 0.5) continue;
      const c = cy + Math.floor(x / cell);
      sum[c * 3] += r;
      sum[c * 3 + 1] += g;
      sum[c * 3 + 2] += b;
      n[c]++;
    }
  }
  // push-pull: average the known cells into ever coarser levels, then fill the unknown from them
  const levels: { s: Float32Array; n: Float32Array; w: number; h: number }[] = [{ s: sum, n, w: gw, h: gh }];
  while (levels[levels.length - 1].w > 1 || levels[levels.length - 1].h > 1) {
    const f = levels[levels.length - 1], lw = Math.ceil(f.w / 2), lh = Math.ceil(f.h / 2);
    const s2 = new Float32Array(lw * lh * 3), n2 = new Float32Array(lw * lh);
    for (let y = 0; y < f.h; y++)
      for (let x = 0; x < f.w; x++) {
        const a = y * f.w + x, c = (y >> 1) * lw + (x >> 1);
        n2[c] += f.n[a];
        for (let k = 0; k < 3; k++) s2[c * 3 + k] += f.s[a * 3 + k];
      }
    levels.push({ s: s2, n: n2, w: lw, h: lh });
  }
  const top = levels[levels.length - 1];
  if (!top.n[0]) for (let k = 0; k < 3; k++) (top.s[k] = key.rgb[k]), (top.n[0] = 1);
  for (let l = levels.length - 2; l >= 0; l--) {
    const f = levels[l], c = levels[l + 1];
    for (let y = 0; y < f.h; y++)
      for (let x = 0; x < f.w; x++) {
        const a = y * f.w + x;
        // a cell with few screen pixels leans on the coarser level
        const m = Math.min(1, f.n[a] / 8);
        if (m >= 1) continue;
        const p = (y >> 1) * c.w + (x >> 1), cn = c.n[p] || 1;
        for (let k = 0; k < 3; k++) {
          const own = f.n[a] ? f.s[a * 3 + k] / f.n[a] : 0;
          f.s[a * 3 + k] = (m * own + (1 - m) * (c.s[p * 3 + k] / cn)) * Math.max(f.n[a], 1);
        }
        f.n[a] = Math.max(f.n[a], 1);
      }
  }
  const rgb = new Float32Array(gw * gh * 3);
  for (let c = 0; c < gw * gh; c++) for (let k = 0; k < 3; k++) rgb[c * 3 + k] = sum[c * 3 + k] / n[c];
  return { rgb, gw, gh, cell };
}

/** The screen's colour at pixel (x, y), from the map (bilinear), into `out`. */
function screenAt(m: ScreenMap, x: number, y: number, out: Float32Array): void {
  const fx = Math.min(m.gw - 1, Math.max(0, (x + 0.5) / m.cell - 0.5)), fy = Math.min(m.gh - 1, Math.max(0, (y + 0.5) / m.cell - 0.5));
  const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(m.gw - 1, x0 + 1), y1 = Math.min(m.gh - 1, y0 + 1);
  const tx = fx - x0, ty = fy - y0;
  for (let k = 0; k < 3; k++) {
    const a = m.rgb[(y0 * m.gw + x0) * 3 + k], b = m.rgb[(y0 * m.gw + x1) * 3 + k];
    const c = m.rgb[(y1 * m.gw + x0) * 3 + k], d = m.rgb[(y1 * m.gw + x1) * 3 + k];
    out[k] = (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
  }
}

/**
 * Alpha against the local screen colour (linear in how much of the pixel is screen): the green
 * excess (g - max(r, b)) of a pixel against the screen's own there. `lo`, `hi`: below/above this
 * share of screen the pixel is all person / all screen (camera noise).
 */
export function keyAlphaLocal(rgba: Uint8ClampedArray, w: number, h: number, map: ScreenMap, lo = 0.12, hi = 0.88): Uint8Array {
  const out = new Uint8Array(w * h);
  // the screen's green excess (g - max(r, b)) per cell
  const ex = new Float32Array(map.gw * map.gh);
  for (let c = 0; c < ex.length; c++) ex[c] = Math.max(8, map.rgb[c * 3 + 1] - Math.max(map.rgb[c * 3], map.rgb[c * 3 + 2]));
  const row = new Float32Array(map.gw), full = new Float32Array(w);
  for (let y = 0; y < h; y++) {
    // this row of the map (between cell centres), then out to every pixel of it
    const fy = Math.min(map.gh - 1, Math.max(0, (y + 0.5) / map.cell - 0.5)), y0 = Math.floor(fy), y1 = Math.min(map.gh - 1, y0 + 1), ty = fy - y0;
    for (let c = 0; c < map.gw; c++) row[c] = ex[y0 * map.gw + c] * (1 - ty) + ex[y1 * map.gw + c] * ty;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(map.gw - 1, Math.max(0, (x + 0.5) / map.cell - 0.5)), x0 = Math.floor(fx), x1 = Math.min(map.gw - 1, x0 + 1);
      full[x] = row[x0] + (row[x1] - row[x0]) * (fx - x0);
    }
    for (let x = 0; x < w; x++) {
      const p = y * w + x, i = p * 4;
      const d = rgba[i + 1] - Math.max(rgba[i], rgba[i + 2]);
      if (d <= 0) {
        out[p] = 255;
        continue;
      }
      const t = Math.min(1, d / full[x]); // share of screen
      const v = 1 - (t - lo) / (hi - lo);
      out[p] = v >= 1 ? 255 : v <= 0 ? 0 : Math.round(255 * v);
    }
  }
  return out;
}

/**
 * The person's own colour on the soft edge (hair, the edge of an arm), in place: an edge pixel is
 * the person's colour and the screen's (there) mixed by alpha, so the screen's share is taken back
 * out (F = (C - (1 - a) K) / a). Without this the edge keeps a light green or grey fringe on any
 * background.
 */
export function unmix(rgba: Uint8ClampedArray, alpha: Uint8Array, w: number, map: ScreenMap): void {
  const K = new Float32Array(3);
  for (let p = 0, i = 0; p < alpha.length; p++, i += 4) {
    const a8 = alpha[p];
    if (a8 === 0 || a8 === 255) continue;
    screenAt(map, p % w, Math.floor(p / w), K);
    // (very faint edge pixels are nearly all screen: their own colour cannot be told apart, so the
    // division is limited; their small alpha hides them anyway)
    const a = Math.max(a8 / 255, 0.15);
    for (let c = 0; c < 3; c++) rgba[i + c] = (rgba[i + c] - (1 - a) * K[c]) / a;
  }
}

/**
 * Keep the alpha only where the person can be (`allowed`, 0..1 at any size, e.g. the person mask
 * grown generously): what is not green but is far from the person (a floor that is not green, a
 * stand, a bag on the floor) is background too. In place.
 */
export function boundAlpha(alpha: Uint8Array, w: number, h: number, allowed: Allowed): void {
  for (let y = 0; y < h; y++) {
    const ay = Math.min(allowed.h - 1, Math.floor(((y + 0.5) * allowed.h) / h)) * allowed.w;
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (!alpha[p]) continue;
      const k = allowed.data[ay + Math.min(allowed.w - 1, Math.floor(((x + 0.5) * allowed.w) / w))];
      if (k < 1) alpha[p] = Math.round(alpha[p] * k);
    }
  }
}

/** The person (despilled) over the background: `out` = bg x (1 - a) + photo x a. All the same size. */
export function composite(photo: Uint8ClampedArray, alpha: Uint8Array, bg: Uint8ClampedArray, out: Uint8ClampedArray): void {
  for (let p = 0, i = 0; p < alpha.length; p++, i += 4) {
    const a = alpha[p] / 255;
    out[i] = bg[i] + (photo[i] - bg[i]) * a;
    out[i + 1] = bg[i + 1] + (photo[i + 1] - bg[i + 1]) * a;
    out[i + 2] = bg[i + 2] + (photo[i + 2] - bg[i + 2]) * a;
    out[i + 3] = 255;
  }
}

/** The person mask at pixel (x, y) of a w x h photo (bilinear). */
function maskAt(m: Allowed, x: number, y: number, w: number, h: number): number {
  const fx = Math.min(m.w - 1, Math.max(0, ((x + 0.5) * m.w) / w - 0.5)), fy = Math.min(m.h - 1, Math.max(0, ((y + 0.5) * m.h) / h - 0.5));
  const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(m.w - 1, x0 + 1), y1 = Math.min(m.h - 1, y0 + 1);
  const tx = fx - x0, ty = fy - y0, d = m.data;
  return (d[y0 * m.w + x0] * (1 - tx) + d[y0 * m.w + x1] * tx) * (1 - ty) + (d[y1 * m.w + x0] * (1 - tx) + d[y1 * m.w + x1] * tx) * ty;
}

/**
 * Below where the floor starts: the floor's colour (and, along the line where the screen meets the
 * floor, anything: a blend of the two) is kept only where the segmenter is sure of the person.
 */
function floorBound(alpha: Uint8Array, rgba: Uint8ClampedArray, w: number, h: number, floor: Floor, person: Allowed): void {
  const top = Math.round(floor.top * h), seam = Math.round(0.012 * h);
  for (let y = Math.max(0, top - seam); y < h; y++) {
    const onSeam = y < top + seam;
    for (let x = 0; x < w; x++) {
      const p = y * w + x, i = p * 4;
      if (!alpha[p] || (!onSeam && !floorLike(floor, rgba[i], rgba[i + 1], rgba[i + 2]))) continue;
      const m = maskAt(person, x, y, w, h);
      const t = Math.min(1, Math.max(0, (m - KEYING.floorSure) / 0.3));
      alpha[p] = Math.round(alpha[p] * t * t * (3 - 2 * t));
    }
  }
}

/**
 * Inside the body (`person` > 0.5, at least `inset` x its long side in from its edge), a pixel is
 * screen only if it matches the screen's colour there (within `match` of its brightness): a gap
 * between an arm and the body shows the screen; green clothes are a different green.
 */
function keepCore(alpha: Uint8Array, rgba: Uint8ClampedArray, w: number, h: number, person: Allowed, map: ScreenMap, inset: number, match: number): void {
  const inside = new Uint8Array(person.w * person.h);
  for (let i = 0; i < inside.length; i++) inside[i] = person.data[i] > 0.5 ? 1 : 0;
  const dist = distanceTransform(inside, person.w, person.h); // in from the edge
  const d = inset * Math.max(person.w, person.h);
  const core: Allowed = { data: new Float32Array(dist.length), w: person.w, h: person.h };
  for (let i = 0; i < dist.length; i++) core.data[i] = Math.min(1, Math.max(0, (dist[i] - d) / d));
  const K = new Float32Array(3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (alpha[p] === 255) continue;
      // (most of the photo is far from the body: a quick nearest look first)
      if (person.data[Math.min(person.h - 1, Math.floor(((y + 0.5) * person.h) / h)) * person.w + Math.min(person.w - 1, Math.floor(((x + 0.5) * person.w) / w))] < 0.3) continue;
      const c = maskAt(core, x, y, w, h);
      if (c <= 0) continue;
      const i = p * 4;
      screenAt(map, x, y, K);
      const diff = Math.hypot(rgba[i] - K[0], rgba[i + 1] - K[1], rgba[i + 2] - K[2]) / (Math.hypot(K[0], K[1], K[2]) + 1);
      if (diff < match) continue;
      // fades in with the distance from the screen's colour
      const t = Math.min(1, (diff - match) / match) * c;
      alpha[p] = Math.max(alpha[p], Math.round(255 * t));
    }
}

/**
 * Take the screen's green light out of the person's edge (in place): no pixel keeps more green than
 * the larger of its red and blue, plus a little (skin and neutral colours lose only the green cast).
 * Along the edge only (within `band` px, fading out inward): the screen's light falls on the edges
 * that face it; further in, a green is the clothes' own.
 */
export function despill(rgba: Uint8ClampedArray, alpha: Uint8Array, w: number, h: number, band: number, slack = 6): void {
  // the distance in from the edge, on a grid of s x s px (the band is tens of px wide)
  const s = Math.max(1, Math.floor(band / 8)), sw = Math.ceil(w / s), sh = Math.ceil(h / s);
  const solid = new Uint8Array(sw * sh).fill(1);
  for (let y = 0; y < h; y++) {
    const r = Math.floor(y / s) * sw;
    for (let x = 0; x < w; x++) if (alpha[y * w + x] < 255) solid[r + Math.floor(x / s)] = 0;
  }
  const dist = distanceTransform(solid, sw, sh);
  const reach = band / s;
  for (let y = 0; y < h; y++) {
    const r = Math.floor(y / s) * sw;
    for (let x = 0; x < w; x++) {
      const p = y * w + x, i = p * 4;
      if (!alpha[p]) continue;
      const k = Math.min(1, Math.max(0, 1 - (dist[r + Math.floor(x / s)] - reach / 2) / (reach / 2))); // 1 on the edge .. 0 inside
      if (k <= 0) continue;
      const limit = Math.max(rgba[i], rgba[i + 2]) + slack;
      if (rgba[i + 1] > limit) rgba[i + 1] -= (rgba[i + 1] - limit) * k;
    }
  }
}

/** Keying settings (tuned on the benchmark; see the module's header). */
export const KEYING = {
  /** Share of the local screen colour in a pixel below which it is all person, above all screen. */
  lo: 0.12,
  hi: 0.88,
  /** The screen's hue: at `inner` x its greenness a pixel is screen, at `outer` person (keyAlpha). */
  inner: 0.7,
  outer: 0.3,
  /** Size (px) of the screen colour map's cells. */
  cell: 12,
  /** Inside the body, this far in from its edge (x its long side), only the screen's own colour (within `match`) is screen. */
  core: 0.01,
  match: 0.12,
  /** The segmenter's value from which a floor-coloured pixel starts being the person. */
  floorSure: 0.35,
  /** Spill is taken out within this share of the long side from the person's edge. */
  spillBand: 0.02,
};

/** A 0..1 map at any size (the person mask grown generously: where the person can be). */
export interface Allowed {
  data: Float32Array;
  w: number;
  h: number;
}

/**
 * The whole keying of a photo on its screen `key`: the person's alpha (0 screen .. 255 person),
 * kept to `allowed` when given, and the photo's own pixels (in place) cleaned on the person's edge
 * and of green spill, ready to composite. The app's and the benchmark's single entry point.
 */
export function keyPerson(rgba: Uint8ClampedArray, w: number, h: number, key: Key, person: Allowed | null): Uint8Array {
  const floor = person ? findFloor(rgba, w, h) : null;
  const map = screenMap(rgba, w, h, key, KEYING.cell, person);
  // how much of the local screen colour is in each pixel; but the screen's hue is screen, whatever
  // its brightness (a shadow on the screen is darker than the map there)
  const alpha = keyAlphaLocal(rgba, w, h, map, KEYING.lo, KEYING.hi);
  const hue = keyAlpha(rgba, w, h, key, KEYING.inner, KEYING.outer);
  for (let p = 0; p < alpha.length; p++) alpha[p] = hue[p] === 0 ? 0 : Math.max(alpha[p], hue[p]);
  // inside the body (where the segmenter is surely right), only the screen's own colour is screen:
  // green clothes, a green print, spill on olive cloth stay the person
  if (person) keepCore(alpha, rgba, w, h, person, map, KEYING.core, KEYING.match);
  // the person's own colour on the soft edge (before the floor: it is never mixed with the screen)
  unmix(rgba, alpha, w, map);
  if (person) {
    // a floor that is not green: its colour is kept only where the segmenter is sure of the person
    // (and anything at all along the line where the screen meets the floor)
    if (floor) floorBound(alpha, rgba, w, h, floor, person);
    // where the person can be, generously (arms out, hair): what is not green farther away (a stand,
    // a bag) is background
    const long = Math.max(person.w, person.h);
    boundAlpha(alpha, w, h, personCover(person, 0.06 * long, 0.01 * long));
  }
  despill(rgba, alpha, w, h, KEYING.spillBand * Math.max(w, h));
  return alpha;
}
