// Face-metered exposure. Webcam auto-exposure meters the whole frame, so a bright background or a
// strong key light leaves the face blown out (or a backlit face too dark). This measures the
// face skin itself and steers the camera's exposure towards a target. Pure logic: the caller
// owns the camera and the frame.
import { LM } from "../core/landmarks";
import type { NormalizedLandmark } from "../effects/skin/input";

export interface FaceMeter {
  /** Mean Rec.709 luma of the sampled face skin, 0..255. */
  mean: number;
  /** Fraction of sampled pixels with any channel >= 250 (blown highlights). */
  clipped: number;
  /** Fraction of sampled pixels with luma <= 12 (crushed shadows). */
  crushed: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The central face (inner 60% x 70% of the face box: cheeks, nose, forehead centre), which is
 * mostly skin and avoids hair and background. In pixels of a w x h frame.
 */
export function faceMeterBox(
  landmarks: NormalizedLandmark[],
  w: number,
  h: number,
  mirrored: boolean,
): Box | null {
  const xs = [LM.faceLeft, LM.faceRight].map((i) =>
    mirrored ? (1 - landmarks[i].x) * w : landmarks[i].x * w,
  );
  const top = landmarks[LM.foreheadTop].y * h,
    chin = landmarks[LM.chin].y * h;
  const fx0 = Math.min(...xs),
    fx1 = Math.max(...xs);
  const fw = fx1 - fx0,
    fh = chin - top;
  if (fw < 8 || fh < 8) return null;
  const x0 = Math.max(0, Math.floor(fx0 + fw * 0.2)),
    x1 = Math.min(w, Math.ceil(fx1 - fw * 0.2)),
    y0 = Math.max(0, Math.floor(top + fh * 0.15)),
    y1 = Math.min(h, Math.ceil(chin - fh * 0.15));
  if (x1 - x0 < 2 || y1 - y0 < 2) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Meter every `step`-th pixel of an RGBA buffer (rows of width w). */
export function meterPixels(
  data: Uint8ClampedArray,
  w: number,
  box: Box = { x: 0, y: 0, w, h: data.length / 4 / w },
  step = 1,
): FaceMeter | null {
  let n = 0,
    sum = 0,
    clipped = 0,
    crushed = 0;
  for (let y = box.y; y < box.y + box.h; y += step)
    for (let x = box.x; x < box.x + box.w; x += step) {
      const i = (y * w + x) * 4;
      const r = data[i],
        g = data[i + 1],
        b = data[i + 2];
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sum += l;
      if (r >= 250 || g >= 250 || b >= 250) clipped++;
      if (l <= 12) crushed++;
      n++;
    }
  return n ? { mean: sum / n, clipped: clipped / n, crushed: crushed / n } : null;
}

/** Meter the central face of a full w x h RGBA frame. */
export function meterFace(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  landmarks: NormalizedLandmark[],
  mirrored: boolean,
): FaceMeter | null {
  const box = faceMeterBox(landmarks, w, h, mirrored);
  return box ? meterPixels(data, w, box, 2) : null;
}

/**
 * Whole-frame reading, used only as a safety net when no face can be found. Without it a frame
 * that went black (or white) hides the face from the detector, so nothing could ever correct it.
 */
export function meterFrame(data: Uint8ClampedArray, w: number, h: number): FaceMeter {
  return meterPixels(data, w, { x: 0, y: 0, w, h }, 8) ?? { mean: 128, clipped: 0, crushed: 0 };
}

/** A frame so dark or so bright that no face can be read from it. */
export const isUnusableFrame = (m: FaceMeter): boolean =>
  m.mean < 30 || m.mean > 225 || m.clipped > 0.4;

export interface ExposureTarget {
  /** Desired face luma (0..255). ~120 keeps detail in light and dark skin alike. */
  mean: number;
  /** Highlights allowed to clip before exposure is forced down. */
  maxClipped: number;
}

// Skin always has some specular shine (forehead, nose tip, glasses), so a few blown pixels are
// normal: only a clearly blown face (>5% of the sampled skin) counts as over-exposed.
export const DEFAULT_TARGET: ExposureTarget = { mean: 120, maxClipped: 0.05 };
