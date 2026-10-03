// Skin segmentation at face resolution.
//
// The segmentation model sees a 256x256 picture. Given the whole frame, a face that fills a third
// of a 4K photo gets ~85 model pixels across, and the mask is then stretched back up to the
// photo. So once the face is found, the model is run again on a square crop around the face (the
// face then gets ~160 model pixels). Both runs see downscaled copies (the model works at 256 px
// anyway, and its outputs come back at the input's size: six float masks per run).
//
// A pixel is skin where the face-skin class beats every other class, exactly as with the model's
// hard label, but the decision is read from the soft per-class scores: the margin (skin score minus
// the strongest other class) is sampled smoothly up to the photo's size, so the edge lands between
// pixels where it really is, with a soft fringe just outside it. The whole-frame result is kept
// outside the crop (neck, a second person...) and the two cross-fade near the crop's border.
import type { NormalizedLandmark } from "../effects/skin/input";

export interface CropRect {
  x: number;
  y: number;
  /** Square: the model's input is square, so the crop is not stretched. */
  size: number;
}

/** A margin map: skin score minus the strongest other class, -1..1, at the map's own size. */
export interface MarginMap {
  margin: Float32Array;
  width: number;
  height: number;
}

/** Margins around the landmark box, as fractions of the face's size. */
export const CROP_PAD = { side: 0.3, top: 0.45, bottom: 0.3 };
/** Longest side the whole frame is segmented at. */
export const FRAME_MAX = 1024;
/** Side the face crop is segmented at. */
export const CROP_SIZE = 512;
/** Margin below zero over which the soft fringe fades out (0 = the hard label's edge). */
export const FRINGE = 0.1;

/**
 * The crop (in pixels of a `w` x `h` image) to segment the face in: the landmark box plus room
 * for the hairline above (the mesh stops around the brows' top) and the jaw's edge, made square.
 * It may reach past the image's edge (that part is drawn empty), so it stays square. Null when it
 * would not help (no face, or the face already fills the photo).
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
  if (!(fw >= 8 && fh >= 8)) return null;
  const x0 = minX - fw * CROP_PAD.side,
    x1 = maxX + fw * CROP_PAD.side,
    y0 = minY - fh * CROP_PAD.top,
    y1 = maxY + fh * CROP_PAD.bottom;
  const size = Math.ceil(Math.max(x1 - x0, y1 - y0));
  // No gain when the crop is (nearly) as large as the whole image.
  if (size * size > w * h * 0.8) return null;
  return { x: Math.round((x0 + x1 - size) / 2), y: Math.round((y0 + y1 - size) / 2), size };
}

/**
 * Margin map from the model's per-class scores (each `width` x `height`): the skin class's
 * score minus the best other class's.
 */
export function marginFromScores(scores: Float32Array[], skinClass: number, width: number, height: number): MarginMap {
  const n = width * height;
  const margin = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    let other = 0;
    for (let c = 0; c < scores.length; c++) if (c !== skinClass) other = Math.max(other, scores[c][p]);
    margin[p] = scores[skinClass][p] - other;
  }
  return { margin, width, height };
}

/** Bilinear sample of a map at (u, v) in its own pixel coordinates (pixel centres at +0.5). */
function sample(m: MarginMap, u: number, v: number): number {
  const x = Math.min(m.width - 1, Math.max(0, u - 0.5)),
    y = Math.min(m.height - 1, Math.max(0, v - 0.5));
  const x0 = Math.floor(x),
    y0 = Math.floor(y);
  const x1 = Math.min(m.width - 1, x0 + 1),
    y1 = Math.min(m.height - 1, y0 + 1);
  const fx = x - x0,
    fy = y - y0;
  const a = m.margin[y0 * m.width + x0],
    b = m.margin[y0 * m.width + x1],
    c = m.margin[y1 * m.width + x0],
    d = m.margin[y1 * m.width + x1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

/**
 * The skin mask's alpha at the photo's size (`w` x `h`, RGBA out): the whole frame's margin map
 * (covering the photo), with the face crop's map (covering `rect`) cross-faded in over `fade` of
 * its size from its inner border. Full alpha exactly where skin wins (the hard label's area), a
 * soft fringe just outside.
 */
export function skinAlpha(
  full: MarginMap,
  crop: { map: MarginMap; rect: CropRect } | null,
  w: number,
  h: number,
  out: Uint8ClampedArray,
  fade = 0.06,
): Uint8ClampedArray {
  const fsx = full.width / w,
    fsy = full.height / h;
  const r = crop?.rect;
  const band = r ? Math.max(1, r.size * fade) : 1;
  const cs = crop ? crop.map.width / crop.rect.size : 1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let m = sample(full, (x + 0.5) * fsx, (y + 0.5) * fsy);
      if (crop && r) {
        const lx = x + 0.5 - r.x,
          ly = y + 0.5 - r.y;
        if (lx > 0 && ly > 0 && lx < r.size && ly < r.size) {
          // Fade only along crop sides inside the photo (beyond the photo there is no context).
          let d = Infinity;
          if (r.x > 0) d = Math.min(d, lx);
          if (r.y > 0) d = Math.min(d, ly);
          if (r.x + r.size < w) d = Math.min(d, r.size - lx);
          if (r.y + r.size < h) d = Math.min(d, r.size - ly);
          const t = Math.min(1, d / band);
          const k = t * t * (3 - 2 * t);
          if (k > 0) m = m * (1 - k) + sample(crop.map, lx * cs, ly * cs) * k;
        }
      }
      const t = Math.max(0, Math.min(1, (m + FRINGE) / FRINGE));
      const p = (y * w + x) * 4;
      out[p] = out[p + 1] = out[p + 2] = 255;
      out[p + 3] = Math.round(255 * t * t * (3 - 2 * t));
    }
  return out;
}
