// Closed-loop exposure calibration: set a value, wait for the camera to apply it, measure the face,
// repeat. Unlike stepping from what the camera *reports* (which many webcams report late, stale or
// not at all), this only trusts what it commanded and what it then sees in the picture, keeps a
// bracket so it cannot oscillate, and notices when the camera ignores the command altogether.
import { DEFAULT_TARGET, type ExposureTarget, type FaceMeter } from "./exposure";

export interface CalibrationIO {
  /** Command the control. */
  set(value: number): Promise<void>;
  /** A reading taken after the last set() has had time to apply; null when nothing is readable. */
  measure(): Promise<FaceMeter | null>;
}

export interface CalibrationRange {
  min: number;
  max: number;
  step: number;
}

export interface CalibrationResult {
  ok: boolean;
  value: number;
  meter: FaceMeter | null;
  steps: number;
  reason: "on-target" | "limit" | "ignored" | "unreadable" | "max-steps";
  log: string[];
}

/**
 * "multiplicative": exposure time (picture brightness ~ value^(1/2.2) through the sRGB curve).
 * "additive": a brightness offset.
 */
export type ControlKind = "multiplicative" | "additive";

const TOLERANCE = 0.1; // within ±10% of the target mean counts as done

function quantize(v: number, r: CalibrationRange): number {
  const step = r.step > 0 ? r.step : 1;
  const q = r.min + Math.round((v - r.min) / step) * step;
  return Math.min(r.max, Math.max(r.min, q));
}

function verdict(m: FaceMeter, t: ExposureTarget): "bright" | "dark" | "ok" {
  if (m.mean > t.mean * (1 + TOLERANCE)) return "bright";
  // Blown highlights only override a face that is not already dark overall.
  if (m.clipped > t.maxClipped && m.mean > t.mean * (1 - TOLERANCE)) return "bright";
  if (m.mean < t.mean * (1 - TOLERANCE)) return "dark";
  return "ok";
}

const score = (m: FaceMeter, t: ExposureTarget) => Math.abs(m.mean - t.mean) + m.clipped * 400;

export async function calibrate(
  io: CalibrationIO,
  start: number,
  range: CalibrationRange,
  kind: ControlKind,
  target: ExposureTarget = DEFAULT_TARGET,
  maxSteps = 8,
): Promise<CalibrationResult> {
  const log: string[] = [];
  const span = range.max - range.min;
  let lo = range.min,
    hi = range.max;
  // Range ends that have not been tried yet may be tried directly (e.g. "too dark even at max").
  let loTried = false,
    hiTried = false;
  let x = quantize(start, range);
  await io.set(x);
  let m = await io.measure();
  let steps = 0;
  let best: { x: number; m: FaceMeter } | null = m ? { x, m } : null;
  let ignoredChecks = 0;
  const done = (ok: boolean, reason: CalibrationResult["reason"]): CalibrationResult => ({
    ok,
    value: best?.x ?? x,
    meter: best?.m ?? m,
    steps,
    reason,
    log,
  });

  while (true) {
    if (!m) {
      log.push(`${x}: nothing readable`);
      return done(false, "unreadable");
    }
    log.push(`${x}: face ${m.mean.toFixed(0)}, blown ${(m.clipped * 100).toFixed(1)}%`);
    if (!best || score(m, target) < score(best.m, target)) best = { x, m };
    const v = verdict(m, target);
    if (v === "ok") return done(true, "on-target");
    if (steps >= maxSteps) break;

    if (v === "bright") {
      hi = x;
      hiTried = true;
    } else {
      lo = x;
      loTried = true;
    }
    const blown = m.clipped > target.maxClipped && m.mean > target.mean;

    let proposal: number;
    if (kind === "multiplicative") {
      // A blown face says nothing about how far over it is: cut hard (more blown -> harder).
      const ratio = blown ? (m.clipped > 0.5 ? 1 / 8 : 1 / 3) : Math.pow(target.mean / Math.max(m.mean, 1), 2.2);
      proposal = x * Math.min(8, Math.max(1 / 8, ratio));
      // Stay inside the bracket: try an untried range end, else the bracket's geometric middle.
      if (proposal >= hi) proposal = !hiTried && hi === range.max ? range.max : Math.sqrt(Math.max(lo, 1e-6) * hi);
      else if (proposal <= lo) proposal = !loTried && lo === range.min ? range.min : Math.sqrt(Math.max(lo, 1e-6) * hi);
    } else {
      proposal = blown ? x - 0.15 * span : x + ((target.mean - m.mean) / 255) * span;
      if (proposal >= hi) proposal = !hiTried && hi === range.max ? range.max : (lo + hi) / 2;
      else if (proposal <= lo) proposal = !loTried && lo === range.min ? range.min : (lo + hi) / 2;
    }
    const next = quantize(proposal, range);
    if (next === x) {
      log.push(`${x}: at the ${v === "dark" ? "maximum" : "minimum"} the camera allows`);
      return done(false, "limit");
    }

    const before = m;
    await io.set(next);
    const prevX = x;
    x = next;
    steps++;
    m = await io.measure();
    // Some cameras apply a new value a frame or two late: an unchanged first reading gets one
    // more look before it is believed.
    const unchanged = (r: FaceMeter | null) =>
      !!r && Math.abs(r.mean - before.mean) < 3 && Math.abs(r.clipped - before.clipped) < 0.01;
    if (unchanged(m)) m = await io.measure();

    // Did the picture respond at all? A big command with no visible change means the camera
    // (or this browser) accepts the value but does not apply it.
    const bigMove = kind === "multiplicative" ? Math.max(next / prevX, prevX / next) >= 1.6 : Math.abs(next - prevX) >= 0.15 * span;
    // (Not judged while the face is fully blown or fully black at both values: then no change is expected.)
    const saturated = (r: FaceMeter) => r.clipped > 0.3 || r.crushed > 0.3;
    if (m && bigMove && !(saturated(m) && saturated(before)) && unchanged(m)) {
      ignoredChecks++;
      if (ignoredChecks >= 2) {
        log.push("no visible change after two large steps: the camera is ignoring this control");
        return done(false, "ignored");
      }
    }
  }
  // Out of steps: settle on the best value seen.
  if (best && best.x !== x) await io.set(best.x);
  return done(false, "max-steps");
}
