// BodyPix outputs -> what the slimming needs: body points (OpenPose order) and the body part of
// each pixel. Pure functions; the model itself runs in the body worker (worker.ts).
//
// BodyPix (MobileNetV1, output stride 8) takes an RGB image of size (16k + 1) x (16m + 1) in [-1, 1]
// and returns, on a grid with one node every 8 input pixels:
//   heatmaps (17 keypoints), short_offsets (17 y then 17 x), part_heatmaps (24 parts), ...
import { JOINT_COUNT } from "./field";

/** Input side for a photo side: the model wants 16k + 1. */
export const inputSide = (side: number) => Math.floor((side + 15) / 16) * 16 + 1;
export const STRIDE = 8;
/** Longest side of the image given to BodyPix. */
export const BODYPIX_LONG_SIDE = 640;

/**
 * Where the model's input sits in the working-resolution image (pixels of that image): BodyPix is
 * run on a crop around the person, so a small person in a wide frame still gets enough detail.
 * Without it, the input covers the whole image.
 */
export interface Crop {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Grid {
  /** Grid nodes. */
  gw: number;
  gh: number;
  /** Model input size (pixels). */
  W: number;
  H: number;
}

// COCO keypoints (BodyPix order) -> OpenPose joints: nose, neck (= mid-shoulders), right
// shoulder/elbow/wrist, left shoulder/elbow/wrist, right hip/knee/ankle, left hip/knee/ankle, eyes, ears.
const OPENPOSE_FROM_COCO = [0, -1, 6, 8, 10, 5, 7, 9, 12, 14, 16, 11, 13, 15, 2, 1, 4, 3];

/**
 * Body points at the working resolution (ww x wh): for each keypoint the most confident node,
 * refined by its offset. Returns JOINT_COUNT * 3 (x, y, score).
 */
export function decodeJoints(heat: Float32Array, offsets: Float32Array, g: Grid, ww: number, wh: number, crop?: Crop): Float32Array {
  const c0: Crop = crop ?? { x: 0, y: 0, w: ww, h: wh };
  const coco: [number, number, number][] = [];
  const n = g.gw * g.gh;
  for (let k = 0; k < 17; k++) {
    let best = -Infinity, bi = 0;
    for (let i = 0; i < n; i++) {
      const v = heat[i * 17 + k];
      if (v > best) {
        best = v;
        bi = i;
      }
    }
    const gy = Math.floor(bi / g.gw), gx = bi % g.gw;
    const py = gy * STRIDE + offsets[bi * 34 + k];
    const px = gx * STRIDE + offsets[bi * 34 + k + 17];
    coco.push([c0.x + (px * c0.w) / g.W, c0.y + (py * c0.h) / g.H, 1 / (1 + Math.exp(-best))]);
  }
  const out = new Float32Array(JOINT_COUNT * 3);
  OPENPOSE_FROM_COCO.forEach((c, j) => {
    const p: [number, number, number] =
      c >= 0
        ? coco[c]
        : [(coco[5][0] + coco[6][0]) / 2, (coco[5][1] + coco[6][1]) / 2, Math.min(coco[5][2], coco[6][2])];
    out.set(p, j * 3);
  });
  return out;
}

/**
 * The body part (0..23) of each working-resolution pixel inside the person (255 elsewhere): the
 * part with the highest score, scores interpolated between grid nodes.
 */
export function decodeParts(parts: Float32Array, g: Grid, ww: number, wh: number, person: Float32Array, crop?: Crop): Uint8Array {
  const out = new Uint8Array(ww * wh).fill(255);
  const c0: Crop = crop ?? { x: 0, y: 0, w: ww, h: wh };
  const sx = g.W / (c0.w * STRIDE), sy = g.H / (c0.h * STRIDE);
  const yA = Math.max(0, Math.floor(c0.y)), yB = Math.min(wh, Math.ceil(c0.y + c0.h));
  const xA = Math.max(0, Math.floor(c0.x)), xB = Math.min(ww, Math.ceil(c0.x + c0.w));
  for (let y = yA; y < yB; y++) {
    const fy = Math.min(Math.max((y - c0.y) * sy, 0), g.gh - 1);
    const y0 = Math.floor(fy), y1 = Math.min(y0 + 1, g.gh - 1), ty = fy - y0;
    for (let x = xA; x < xB; x++) {
      const i = y * ww + x;
      if (person[i] <= 0.3) continue;
      const fx = Math.min(Math.max((x - c0.x) * sx, 0), g.gw - 1);
      const x0 = Math.floor(fx), x1 = Math.min(x0 + 1, g.gw - 1), tx = fx - x0;
      const a = (y0 * g.gw + x0) * 24, b = (y0 * g.gw + x1) * 24, c = (y1 * g.gw + x0) * 24, d = (y1 * g.gw + x1) * 24;
      let best = -Infinity, bp = 255;
      for (let p = 0; p < 24; p++) {
        const top = parts[a + p] + (parts[b + p] - parts[a + p]) * tx;
        const bot = parts[c + p] + (parts[d + p] - parts[c + p]) * tx;
        const v = top + (bot - top) * ty;
        if (v > best) {
          best = v;
          bp = p;
        }
      }
      out[i] = bp;
    }
  }
  return out;
}

/**
 * The box around the person (mask above 0.3), grown by `margin` of its height on every side and
 * kept inside the image, in the mask's own pixels; null when there is nobody.
 */
export function personBox(mask: Float32Array, w: number, h: number, margin: number): Crop | null {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (mask[y * w + x] > 0.3) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) return null;
  const m = margin * (y1 - y0 + 1);
  const ax = Math.max(0, x0 - m), ay = Math.max(0, y0 - m);
  const bx = Math.min(w, x1 + 1 + m), by = Math.min(h, y1 + 1 + m);
  return { x: ax, y: ay, w: bx - ax, h: by - ay };
}

/**
 * BodyPix's own person probability (its "segments" output, logits on the grid) at the working
 * resolution, 0 outside the crop.
 */
export function decodeSegments(seg: Float32Array, g: Grid, ww: number, wh: number, crop?: Crop): Float32Array {
  const out = new Float32Array(ww * wh);
  const c0: Crop = crop ?? { x: 0, y: 0, w: ww, h: wh };
  const sx = g.W / (c0.w * STRIDE), sy = g.H / (c0.h * STRIDE);
  const yA = Math.max(0, Math.floor(c0.y)), yB = Math.min(wh, Math.ceil(c0.y + c0.h));
  const xA = Math.max(0, Math.floor(c0.x)), xB = Math.min(ww, Math.ceil(c0.x + c0.w));
  for (let y = yA; y < yB; y++) {
    const fy = Math.min(Math.max((y - c0.y) * sy, 0), g.gh - 1);
    const y0 = Math.floor(fy), y1 = Math.min(y0 + 1, g.gh - 1), ty = fy - y0;
    for (let x = xA; x < xB; x++) {
      const fx = Math.min(Math.max((x - c0.x) * sx, 0), g.gw - 1);
      const x0 = Math.floor(fx), x1 = Math.min(x0 + 1, g.gw - 1), tx = fx - x0;
      const top = seg[y0 * g.gw + x0] + (seg[y0 * g.gw + x1] - seg[y0 * g.gw + x0]) * tx;
      const bot = seg[y1 * g.gw + x0] + (seg[y1 * g.gw + x1] - seg[y1 * g.gw + x0]) * tx;
      out[y * ww + x] = 1 / (1 + Math.exp(-(top + (bot - top) * ty)));
    }
  }
  return out;
}

/**
 * Fill in the arms and hands the person mask missed: the app's segmenter can lose a bare arm in
 * front of a wall of skin-like colour (brick, wood), and an arm missing from the mask is treated as
 * background (moved like it, painted over by the backdrop). Where BodyPix is sure of a person and
 * calls it an arm or a hand, the mask takes BodyPix's value. Changes `person` in place.
 */
export function addArms(person: Float32Array, bp: Float32Array, parts: Uint8Array): number {
  let added = 0;
  for (let i = 0; i < person.length; i++) {
    const p = parts[i];
    if (p < 2 || p > 11 || bp[i] <= 0.6 || person[i] >= bp[i]) continue;
    if (person[i] < 0.5) added++;
    person[i] = bp[i];
  }
  return added;
}

/** Bilinear resize of a single-channel float image. */
export function resizeMask(src: Float32Array, sw: number, sh: number, dw: number, dh: number): Float32Array {
  const out = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const fy = Math.min(Math.max(((y + 0.5) * sh) / dh - 0.5, 0), sh - 1);
    const y0 = Math.floor(fy), y1 = Math.min(y0 + 1, sh - 1), ty = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = Math.min(Math.max(((x + 0.5) * sw) / dw - 0.5, 0), sw - 1);
      const x0 = Math.floor(fx), x1 = Math.min(x0 + 1, sw - 1), tx = fx - x0;
      const top = src[y0 * sw + x0] + (src[y0 * sw + x1] - src[y0 * sw + x0]) * tx;
      const bot = src[y1 * sw + x0] + (src[y1 * sw + x1] - src[y1 * sw + x0]) * tx;
      out[y * dw + x] = top + (bot - top) * ty;
    }
  }
  return out;
}

/** RGBA pixels at W x H -> RGB (3 bytes per pixel) at w x h, bilinear. */
export function resizeRGB(rgba: Uint8ClampedArray, W: number, H: number, w: number, h: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 3);
  const ch = new Float32Array(W * H);
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < W * H; i++) ch[i] = rgba[i * 4 + c];
    const r = resizeMask(ch, W, H, w, h);
    for (let i = 0; i < w * h; i++) out[i * 3 + c] = r[i];
  }
  return out;
}

/** RGBA pixels (model input size) -> the model's input tensor data (NHWC, RGB in [-1, 1]). */
export function toInput(rgba: Uint8ClampedArray, W: number, H: number): Float32Array {
  const out = new Float32Array(W * H * 3);
  for (let i = 0, j = 0; i < W * H; i++, j += 3) {
    out[j] = (rgba[i * 4] / 255) * 2 - 1;
    out[j + 1] = (rgba[i * 4 + 1] / 255) * 2 - 1;
    out[j + 2] = (rgba[i * 4 + 2] / 255) * 2 - 1;
  }
  return out;
}
