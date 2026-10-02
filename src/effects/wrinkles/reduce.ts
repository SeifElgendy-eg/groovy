// Wrinkle ("botox") smoothing.
//
// reduceWrinkles() returns a SIGNED correction as two RGBA images:
//   mul : per-channel gain <= 1 (255 = no change)   -> composite with "multiply"
//   add : per-channel light to add (0 = no change)  -> composite with "lighter"
// The caller draws the native photo, then mul, then add, so the full-resolution photo
// keeps its own colour and pore texture; only the smooth correction is ever upscaled.
//
// Pipeline (all inside the treated regions and the skin mask):
//   1. Crease fill   - per-channel morphological closing fills narrow dark valleys up to
//                      the colour of their banks (deep lines, hair-thin lines alike).
//   2. Smoothing     - masked, edge-preserving (guided) filter flattens the remaining
//                      folds, ridges and blotches while strong edges stay put.
//   3. Texture       - pore-level detail (high-pass) is put back so skin does not turn
//                      plastic; sharp crease edges are not (they would leave hairlines).
import type { Box } from "../../core/types";
import { clamp, smooth } from "../../imaging/math";
import {
  BIG,
  blur5,
  closeChannel,
  guidedFilter,
  openChannel,
  windowFilter,
} from "../../imaging/filters";
import type { Region } from "./regions";

function buildFocus(regions: Region[], width: number, height: number) {
  const target = new Float32Array(width * height),
    support = new Float32Array(width * height),
    protect = new Float32Array(width * height);
  for (const r of regions) {
    const c = Math.cos(r.angle || 0),
      s = Math.sin(r.angle || 0),
      reach = Math.ceil(Math.max(r.rx, r.ry)) + 1;
    const field = r.protect ? protect : r.support ? support : target,
      strength = r.strength ?? 0.9,
      feather = r.feather ?? 0.45;
    for (
      let y = Math.max(0, Math.floor(r.y - reach));
      y <= Math.min(height - 1, Math.ceil(r.y + reach));
      y++
    ) {
      for (
        let x = Math.max(0, Math.floor(r.x - reach));
        x <= Math.min(width - 1, Math.ceil(r.x + reach));
        x++
      ) {
        const xx = x - r.x,
          yy = y - r.y,
          d = Math.hypot((xx * c + yy * s) / r.rx, (-xx * s + yy * c) / r.ry),
          p = y * width + x;
        field[p] = Math.max(
          field[p],
          smooth(clamp((1 - d) / feather)) * strength,
        );
      }
    }
  }
  return { target, support, protect };
}

// ------------------------------------------------------------------ main
// options: smoothing 0..1.5 (edge tolerance of the smoother), texture 0..1 (pore detail kept)
export interface WrinkleOptions {
  /** Edge tolerance of the smoother (default 1, max ~2.2). */
  smoothing?: number;
  /** Pore detail kept, 0..1 (default 0.9). */
  texture?: number;
  denoise?: number;
  clampDetail?: number;
  /** Removal of faint thin lines (default 1). */
  lines?: number;
}

export interface WrinkleCorrection {
  /** Per-channel gain <= 1 (255 = no change). */
  mul: Uint8ClampedArray<ArrayBuffer>;
  /** Per-channel light to add (0 = no change). */
  add: Uint8ClampedArray<ArrayBuffer>;
}

export function reduceWrinkles(
  source: Uint8ClampedArray,
  mask: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
  regions: Region[] = [],
  options: WrinkleOptions = {},
): WrinkleCorrection {
  const {
    smoothing = 1,
    texture = 0.9,
    denoise = 2,
    clampDetail = 3,
    lines = 1,
  } = options;
  const count = width * height;
  const add = new Uint8ClampedArray(source.length),
    mul = new Uint8ClampedArray(source.length);
  for (let i = 0; i < mul.length; i += 4) {
    mul[i] = mul[i + 1] = mul[i + 2] = 255;
    mul[i + 3] = 255;
    add[i + 3] = 255;
  }

  const { target, support, protect } = buildFocus(regions, width, height);
  const focus = new Float32Array(count),
    valid = new Uint8Array(count),
    wt = new Float32Array(count);
  const box: Box = { x0: width, x1: -1, y0: height, y1: -1 };
  for (let p = 0; p < count; p++) {
    focus[p] = (target[p] + support[p] * (1 - target[p])) * (1 - protect[p]);
    const a = mask[p * 4 + 3];
    valid[p] = a >= 180 ? 1 : 0;
    wt[p] = valid[p];
    if (focus[p] > 0.01 && a >= 20) {
      const x = p % width,
        y = (p - x) / width;
      if (x < box.x0) box.x0 = x;
      if (x > box.x1) box.x1 = x;
      if (y < box.y0) box.y0 = y;
      if (y > box.y1) box.y1 = y;
    }
  }
  if (box.x1 < 0) return { add, mul };

  // Thin dark structures (lashes, brow and stray hair) are found on the RAW luminance. On the
  // denoised image a 1-2 px lash is already too light to recognise, which is how lashes used to
  // slip through and get smoothed away.
  const k = Math.max(3, Math.round(radius * 1.5));
  const rawLum = new Float32Array(count);
  for (let p = 0; p < count; p++)
    rawLum[p] =
      source[p * 4] * 0.2126 +
      source[p * 4 + 1] * 0.7152 +
      source[p * 4 + 2] * 0.0722;
  const rawClosed = closeChannel(rawLum, valid, width, height, box, k);
  const hair = new Float32Array(count);
  {
    // Creases are only mildly darker than the skin around them; lashes, brow and stray hair are
    // far darker. So the detector is strict ONLY around the eyes (where lashes are
    // anti-aliased to faint pixels) and lenient everywhere else. Using the strict threshold on
    // the forehead classifies the creases themselves as hair and leaves them untouched.
    const hk = new Float32Array(count),
      hkEye = new Float32Array(count);
    for (let p = 0; p < count; p++) {
      if (Number.isNaN(rawClosed[p])) continue;
      const ratio = rawLum[p] / Math.max(rawClosed[p], 1);
      hk[p] = clamp((0.62 - ratio) / 0.1); // full below 52%, none above 62%
      if (protect[p] > 0.01) hkEye[p] = clamp((0.76 - ratio) / 0.12);
    }
    const near = windowFilter(hk, width, height, box, 1, true), // 1px margin
      eye = windowFilter(hkEye, width, height, box, 3, true); // 3px margin at the eyes
    for (let p = 0; p < count; p++) hair[p] = Math.max(0, near[p], eye[p]);
  }
  // Hair never contributes colour to anything below.
  for (let p = 0; p < count; p++) wt[p] = valid[p] ? 1 - hair[p] : 0;

  // Denoised colour: detection helper and base of the smooth layer. Masked blur, so lash/hair
  // and non-skin pixels cannot bleed a dark halo into the skin beside them.
  const wBlur = blur5(wt, width, height, denoise);
  const ch = [0, 1, 2].map((c) => {
    const a = new Float32Array(count);
    for (let p = 0; p < count; p++) a[p] = source[p * 4 + c] * wt[p];
    const b = blur5(a, width, height, denoise);
    for (let p = 0; p < count; p++)
      b[p] = wBlur[p] > 0.05 ? b[p] / wBlur[p] : source[p * 4 + c];
    return b;
  });
  const lum = new Float32Array(count);
  for (let p = 0; p < count; p++)
    lum[p] = ch[0][p] * 0.2126 + ch[1][p] * 0.7152 + ch[2][p] * 0.0722;

  // 1. Crease fill.
  const closed = ch.map((v) => closeChannel(v, valid, width, height, box, k));
  const filled = ch.map((v) => Float32Array.from(v));
  for (let p = 0; p < count; p++) {
    if (focus[p] < 0.01 || !valid[p] || Number.isNaN(closed[0][p])) continue;
    const depth =
      closed[0][p] * 0.2126 +
      closed[1][p] * 0.7152 +
      closed[2][p] * 0.0722 -
      lum[p];
    if (depth <= 0.5) continue;
    const notEdge = clamp((95 - depth) / 30); // very deep = hair, brow, accessory
    const notDark = clamp((lum[p] - 38) / 22); // near-black = hair/shadow, not skin
    const f =
      clamp(
        (Math.max(0, depth - 1.2) *
          notEdge *
          notDark *
          (1 - hair[p]) *
          (0.35 + 0.65 * target[p])) /
          depth,
      ) * Math.min(1, focus[p] * 1.5);
    for (let c = 0; c < 3; c++)
      filled[c][p] = ch[c][p] + (closed[c][p] - ch[c][p]) * f;
  }

  // 2. Edge-preserving smoothing of what is left (folds, ridges, blotches).
  const flum = new Float32Array(count);
  for (let p = 0; p < count; p++)
    flum[p] =
      filled[0][p] * 0.2126 + filled[1][p] * 0.7152 + filled[2][p] * 0.0722;
  const r = Math.max(4, Math.round(radius * 2.6)),
    eps = Math.pow(11 + 13 * smoothing, 2);
  const smoothed = guidedFilter(flum, filled, wt, width, height, r, eps, box);

  // 2b. Faint thin lines survive an edge-preserving filter because they are low contrast but
  // sharp. Alternating closing (dark lines) and opening (bright ridges) removes them.
  const slum = new Float32Array(count),
    lineDelta = new Float32Array(count);
  for (let p = 0; p < count; p++)
    slum[p] =
      smoothed[0][p] * 0.2126 +
      smoothed[1][p] * 0.7152 +
      smoothed[2][p] * 0.0722;
  if (lines > 0) {
    const k2 = Math.max(2, Math.round(radius * 0.9));
    const cl = closeChannel(slum, valid, width, height, box, k2),
      op = openChannel(slum, valid, width, height, box, k2);
    for (let p = 0; p < count; p++) {
      if (
        focus[p] < 0.01 ||
        !valid[p] ||
        Number.isNaN(cl[p]) ||
        Number.isNaN(op[p])
      )
        continue;
      const dd = Math.max(-14, Math.min(14, (cl[p] + op[p]) * 0.5 - slum[p]));
      lineDelta[p] = dd * lines;
    }
  }

  // 3. Compose the correction, put pore texture back, and encode as mul / add.
  for (let y = box.y0; y <= box.y1; y++)
    for (let x = box.x0; x <= box.x1; x++) {
      const p = y * width + x,
        i = p * 4,
        a = mask[i + 3],
        f = focus[p];
      if (a < 20 || f < 0.01) continue;
      const edge = a >= 180 ? 1 : a / 180;
      const sm = smooth(clamp(f * 1.15)) * edge * (1 - hair[p]);
      // Pore texture stays, but not where a line was just removed (it would redraw the line).
      const removed =
        clamp(Math.abs(lineDelta[p]) / 3) * 0.55 +
        clamp(Math.abs(slum[p] - lum[p]) / 18) * 0.35;
      const texKeep =
        1 - sm * (1 - texture) - Math.min(1, removed) * sm * texture;
      for (let c = 0; c < 3; c++) {
        const o = source[i + c],
          detail = o - ch[c][p],
          keep = clamp(detail, -clampDetail, clampDetail),
          excess = detail - keep;
        const base =
          filled[c][p] + (smoothed[c][p] + lineDelta[p] - filled[c][p]) * sm;
        const out = base + keep * texKeep + excess * (1 - sm);
        const d = Math.max(-o, Math.min(255 - o, out - o));
        if (d >= 0) add[i + c] = Math.round(d);
        else
          mul[i + c] = Math.round(255 * Math.max(0, (o + d) / Math.max(o, 8)));
      }
    }
  return { add, mul };
}
