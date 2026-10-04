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
export function decodeJoints(heat: Float32Array, offsets: Float32Array, g: Grid, ww: number, wh: number): Float32Array {
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
    coco.push([(px * ww) / g.W, (py * wh) / g.H, 1 / (1 + Math.exp(-best))]);
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
export function decodeParts(parts: Float32Array, g: Grid, ww: number, wh: number, person: Float32Array): Uint8Array {
  const out = new Uint8Array(ww * wh).fill(255);
  const sx = g.W / (ww * STRIDE), sy = g.H / (wh * STRIDE);
  for (let y = 0; y < wh; y++) {
    const fy = Math.min(Math.max(y * sy, 0), g.gh - 1);
    const y0 = Math.floor(fy), y1 = Math.min(y0 + 1, g.gh - 1), ty = fy - y0;
    for (let x = 0; x < ww; x++) {
      const i = y * ww + x;
      if (person[i] <= 0.3) continue;
      const fx = Math.min(Math.max(x * sx, 0), g.gw - 1);
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
