// Proportion-based 100%: how strong the slimming is for a waist and hips that end in logical
// proportions.
import { FULL, type Frame, JOINT, TUNING, centreX, mainRun, noseToAnkles, runGap, runsOf } from "./common";

/**
 * The share of the full strength (FULL) that brings this waist to sensible proportions
 * (TUNING.proportion): the natural waist's width now, the cut that reaches the target, and how much
 * the torso field (unit, interleaved) narrows the waist at full strength.
 * Null when the waist cannot be measured.
 */
export function proportionStrength(torso: Float32Array, body: Uint8Array, F: Frame, debug?: Record<string, number>): number | null {
  const Pt = TUNING.proportion;
  const { w, h } = F;
  const H = noseToAnkles(F.J);
  const tl = F.hip[1] - F.neck[1];
  if (!(H > 0) || !(tl > 0)) return null;
  // the waist region (between the bust and the hip points), many rows: steady against a hand or a
  // fold of clothing on one row
  const widths: number[] = [], cuts: number[] = [];
  for (let i = 0; i < 12; i++) {
    const y = Math.round(F.neck[1] + 0.5 * tl + (0.4 * tl * i) / 11);
    if (y < 0 || y >= h) continue;
    const rs = runsOf(body, w, y, runGap(F.sw));
    if (!rs.length) continue;
    const [a, b] = mainRun(rs, centreX(F, y));
    if (b - a < 4) continue;
    widths.push(b - a);
    // (backward map: the left edge reads from further left, dx < 0; the right from further right)
    cuts.push((FULL.torso * (torso[2 * (y * w + b)] - torso[2 * (y * w + a)])) / (b - a));
  }
  if (widths.length < 3) return null;
  const median = (v: number[]) => {
    const s = [...v].sort((p, q) => p - q);
    return s[s.length >> 1];
  };
  // the waist: the narrower rows of the band (a quarter of the way up its widths), not the hips below
  const now = [...widths].sort((p, q) => p - q)[Math.floor(0.25 * (widths.length - 1))], atFull = median(cuts);
  if (!(atFull > 0.01)) return null;
  // A waist no real body has (hands or forearms across it hide most of it from the outline): not
  // measured; the build's strength is used instead.
  if (now < Pt.measurable[0] * H || now < Pt.measurable[1] * F.sw) return null;
  const target = Math.max(Pt.waist * H, Pt.shoulders * F.sw);
  // the hips: the widest rows from just above the hip points to the top of the thighs (a body with a
  // narrow waist and wide hips needs slimming too)
  let hips = 0;
  const kneeY = (F.jy(JOINT.rKnee) + F.jy(JOINT.lKnee)) / 2;
  const thigh = Math.max(kneeY - F.hip[1], 0.3 * tl);
  for (let y = Math.max(0, Math.round(F.hip[1] - 0.1 * tl)); y <= Math.min(h - 1, Math.round(F.hip[1] + 0.25 * thigh)); y++) {
    const rs = runsOf(body, w, y, runGap(F.sw));
    if (!rs.length) continue;
    // (both legs' runs near the hips: the hips' outer extent)
    let a = Infinity, b = -Infinity;
    for (const r of rs)
      if (r[1] > F.hip[0] - 1.2 * F.sw && r[0] < F.hip[0] + 1.2 * F.sw) {
        a = Math.min(a, r[0]);
        b = Math.max(b, r[1]);
      }
    if (isFinite(a)) hips = Math.max(hips, b - a);
  }
  const waistCut = 1 - target / now, hipCut = hips > 0 ? 1 - (Pt.hips * H) / hips : 0;
  const want = Math.min(Pt.maxCut, Math.max(Pt.minCut, waistCut, hipCut));
  if (debug) Object.assign(debug, { waistH: now / H, waistSw: now / F.sw, hipsH: hips / H, target: target / H, waistCut, hipCut, want, atFull });
  return Math.min(1, Math.max(0.1, want / atFull));
}
