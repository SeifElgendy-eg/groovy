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

/**
 * Meter the central face (between the eyes' outer corners, brow to upper lip), which is mostly
 * skin and avoids hair and background.
 */
export function meterFace(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  landmarks: NormalizedLandmark[],
  mirrored: boolean,
): FaceMeter | null {
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
  // Inner 60% x 70% of the face box: cheeks, nose, forehead centre.
  const x0 = Math.max(0, Math.floor(fx0 + fw * 0.2)),
    x1 = Math.min(w, Math.ceil(fx1 - fw * 0.2)),
    y0 = Math.max(0, Math.floor(top + fh * 0.15)),
    y1 = Math.min(h, Math.ceil(chin - fh * 0.15));
  let n = 0,
    sum = 0,
    clipped = 0,
    crushed = 0;
  for (let y = y0; y < y1; y += 2)
    for (let x = x0; x < x1; x += 2) {
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
  if (!n) return null;
  return { mean: sum / n, clipped: clipped / n, crushed: crushed / n };
}

export interface ExposureTarget {
  /** Desired face luma (0..255). ~120 keeps detail in light and dark skin alike. */
  mean: number;
  /** Highlights allowed to clip before exposure is forced down. */
  maxClipped: number;
}

export const DEFAULT_TARGET: ExposureTarget = { mean: 120, maxClipped: 0.01 };

/**
 * Next value for a multiplicative exposure control (exposure time) given a meter reading.
 * Returns null when the current value is close enough (avoids hunting).
 */
export function nextExposure(
  current: number,
  meter: FaceMeter,
  range: { min: number; max: number },
  target: ExposureTarget = DEFAULT_TARGET,
): number | null {
  let ratio: number;
  if (meter.clipped > target.maxClipped) {
    // Blown highlights carry no information about how far over we are: step down firmly.
    ratio = 0.75;
  } else {
    const err = target.mean / Math.max(1, meter.mean);
    if (Math.abs(err - 1) < 0.08) return null; // dead band
    // Damped: move ~60% of the way in log space, at most x1.5 / x0.67 per step.
    ratio = Math.min(1.5, Math.max(0.67, Math.pow(err, 0.6)));
  }
  const next = Math.min(range.max, Math.max(range.min, current * ratio));
  return Math.abs(next - current) / Math.max(current, 1e-6) < 0.03 ? null : next;
}

/**
 * Next value for an additive control (UVC brightness offset), used when the camera has no
 * exposure-time control.
 */
export function nextOffset(
  current: number,
  meter: FaceMeter,
  range: { min: number; max: number; step: number },
  target: ExposureTarget = DEFAULT_TARGET,
): number | null {
  const span = range.max - range.min;
  let delta: number;
  if (meter.clipped > target.maxClipped) delta = -0.06 * span;
  else {
    const err = target.mean - meter.mean;
    if (Math.abs(err) < 10) return null;
    delta = Math.max(-0.08, Math.min(0.08, err / 255)) * span;
  }
  const step = range.step || 1;
  const next = Math.min(
    range.max,
    Math.max(range.min, Math.round((current + delta) / step) * step),
  );
  return next === current ? null : next;
}
