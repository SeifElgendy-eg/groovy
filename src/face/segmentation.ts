// Skin segmentation at face resolution.
//
// The segmentation model sees a 256x256 picture. Given the whole frame, a face that fills a third
// of a 4K photo gets ~85 model pixels across, and the mask is then stretched back up to the
// photo: blocky at the hairline, brows and around loose hair. So once the face is found, the model
// is run again on a crop around the face (the face then gets ~160 model pixels), and its soft
// "how likely is this skin" output is used rather than the hard yes/no label, so the edge lands
// between pixels where it really is. The whole-frame result is kept outside the crop (neck, a
// second person...) and the two are cross-faded near the crop's border, so there is no seam.
import type { NormalizedLandmark } from "../effects/skin/input";

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Margins around the landmark box, as fractions of the face's size. */
export const CROP_PAD = { side: 0.3, top: 0.45, bottom: 0.3 };

/**
 * The crop (in pixels of a `w` x `h` image) to segment the face in: the landmark box plus room
 * for the hairline above (the mesh stops around the brows' top) and the jaw's edge, made square
 * (the model's input is square, so a square crop is not stretched) and clamped to the image.
 */
export function faceCropRect(points: NormalizedLandmark[], w: number, h: number): CropRect | null {
  if (!points.length) return null;
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x * w);
    maxX = Math.max(maxX, p.x * w);
    minY = Math.min(minY, p.y * h);
    maxY = Math.max(maxY, p.y * h);
  }
  const fw = maxX - minX,
    fh = maxY - minY;
  if (fw < 8 || fh < 8) return null;
  let x0 = minX - fw * CROP_PAD.side,
    x1 = maxX + fw * CROP_PAD.side,
    y0 = minY - fh * CROP_PAD.top,
    y1 = maxY + fh * CROP_PAD.bottom;
  // Square, around the same centre.
  const side = Math.max(x1 - x0, y1 - y0);
  const cx = (x0 + x1) / 2,
    cy = (y0 + y1) / 2;
  x0 = cx - side / 2;
  x1 = cx + side / 2;
  y0 = cy - side / 2;
  y1 = cy + side / 2;
  const rx = Math.max(0, Math.floor(x0)),
    ry = Math.max(0, Math.floor(y0));
  const rw = Math.min(w, Math.ceil(x1)) - rx,
    rh = Math.min(h, Math.ceil(y1)) - ry;
  if (rw < 16 || rh < 16) return null;
  // No gain when the crop is (nearly) the whole image.
  if (rw * rh > w * h * 0.8) return null;
  return { x: rx, y: ry, w: rw, h: rh };
}

/**
 * Put the crop's skin probability (`crop`, rect.w x rect.h) into the whole frame's (`full`,
 * w x h, changed in place), cross-fading over `fade` of the crop's size at its inner border (the
 * crop's edge pixels were seen with no context, so the whole-frame value is trusted there). A crop
 * side that touches the image border needs no fade.
 */
export function mergeCrop(
  full: Float32Array,
  w: number,
  h: number,
  crop: Float32Array,
  rect: CropRect,
  fade = 0.06,
): Float32Array {
  const band = Math.max(1, Math.min(rect.w, rect.h) * fade);
  const left = rect.x > 0,
    top = rect.y > 0,
    right = rect.x + rect.w < w,
    bottom = rect.y + rect.h < h;
  for (let y = 0; y < rect.h; y++) {
    let dy = Infinity;
    if (top) dy = Math.min(dy, y + 0.5);
    if (bottom) dy = Math.min(dy, rect.h - y - 0.5);
    for (let x = 0; x < rect.w; x++) {
      let d = dy;
      if (left) d = Math.min(d, x + 0.5);
      if (right) d = Math.min(d, rect.w - x - 0.5);
      const t = Math.min(1, d / band);
      const k = t * t * (3 - 2 * t);
      const p = (rect.y + y) * w + rect.x + x;
      full[p] = full[p] * (1 - k) + crop[y * rect.w + x] * k;
    }
  }
  return full;
}

/**
 * Skin probability to mask alpha. The hard label the app used before is "skin wins" (p > ~0.5);
 * this keeps that boundary but makes it a short ramp, so the edge is anti-aliased at its true
 * sub-pixel position instead of a stair-stepped copy of the model's grid.
 */
export function probToAlpha(prob: Float32Array, out: Uint8ClampedArray): Uint8ClampedArray {
  for (let p = 0; p < prob.length; p++) {
    const t = Math.max(0, Math.min(1, (prob[p] - 0.35) / 0.3));
    out[p * 4] = out[p * 4 + 1] = out[p * 4 + 2] = 255;
    out[p * 4 + 3] = Math.round(255 * t * t * (3 - 2 * t));
  }
  return out;
}
