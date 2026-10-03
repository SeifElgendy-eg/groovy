import { describe, expect, it } from "vitest";
import type { Point } from "../../src/core/types";
import { crossSection, FILLED_RATIO, transformOuterLip } from "../../src/effects/lips/geometry";

/** Mouth in landmark order (0 left corner, 1-9 upper, 10 right corner, 11-19 lower). */
function mouth(up: number, down: number, width = 300, cx = 400, cy = 300) {
  const ring = (u: number, d: number): Point[] =>
    Array.from({ length: 20 }, (_, i) => {
      const t = (i % 10) / 10;
      const upper = i < 10;
      const x = upper ? cx - width / 2 + width * t : cx + width / 2 - width * t;
      const s = Math.sin(Math.PI * t);
      return { x, y: upper ? cy - u * s : cy + d * s };
    });
  return { outer: ring(up, down), inner: ring(3, 3) };
}
const heights = (pts: Point[], inner: Point[]) => ({ upper: inner[5].y - pts[5].y, lower: pts[15].y - inner[15].y });

describe("lip filler shape", () => {
  for (const [label, up, down] of [["balanced", 40, 64], ["thin upper", 25, 60], ["full upper", 50, 50]] as const) {
    it(`grows both lips and moves the ratio toward 1:${FILLED_RATIO} (${label})`, () => {
      const m = mouth(up, down);
      const before = heights(m.outer, m.inner);
      const after = heights(transformOuterLip(m.outer, m.inner, 0.4, 0.6), m.inner);
      expect(after.upper).toBeGreaterThan(before.upper + 3);
      expect(after.lower).toBeGreaterThan(before.lower + 3);
      const r0 = before.lower / before.upper,
        r1 = after.lower / after.upper;
      expect(Math.abs(r1 - FILLED_RATIO)).toBeLessThanOrEqual(Math.abs(r0 - FILLED_RATIO) + 1e-9);
    });
  }

  it("never droops a full lower lip: growth is capped by mouth width", () => {
    const m = mouth(40, 120);
    const before = heights(m.outer, m.inner);
    const after = heights(transformOuterLip(m.outer, m.inner, 0.55, 1), m.inner);
    expect(after.lower - before.lower).toBeLessThan(300 * 0.055 * (0.55 / 0.4) * 1.65 * 1.2 + 1e-6);
  });

  it("like the clinic ladder: on natural lips (1:1.6) the upper lip grows more than the lower", () => {
    const m = mouth(40, 64);
    const before = heights(m.outer, m.inner);
    const after = heights(transformOuterLip(m.outer, m.inner, 0.55, 0.6), m.inner);
    expect(after.upper / before.upper).toBeGreaterThan(after.lower / before.lower);
    expect(after.upper / before.upper).toBeGreaterThan(1.6); // "4 ml": clearly fuller
  });

  it("keeps the corners and the mouth opening", () => {
    const m = mouth(40, 64);
    const out = transformOuterLip(m.outer, m.inner, 0.55, 1);
    expect(out[0]).toEqual(m.outer[0]);
    expect(out[10]).toEqual(m.outer[10]);
  });

  it("keeps the lip line and the border at their original scale (crisp), growing the middle", () => {
    const rho = 0.5; // the lip doubled in height
    const eps = 1e-3;
    const stretchAt = (t: number) => ((crossSection(t + eps, rho) - crossSection(t, rho)) / eps) / rho;
    expect(stretchAt(0)).toBeCloseTo(1, 2); // at the lip line: no stretch
    expect(stretchAt(1 - eps)).toBeCloseTo(1, 2); // at the border: no stretch
    expect(stretchAt(0.5)).toBeGreaterThan(2); // the middle takes the growth
    expect(crossSection(0, rho)).toBe(0);
    expect(crossSection(1, rho)).toBeCloseTo(1, 9);
  });
});

import { fillerLevel, ML_MAX, mlToAmount } from "../../src/effects/lips/geometry";

describe("filler in ml", () => {
  it("each ml adds the same amount, and 4 ml is the full level", () => {
    const steps = [1, 2, 3, 4].map((ml) => mlToAmount(ml) - mlToAmount(ml - 1));
    steps.forEach((s) => expect(s).toBeCloseTo(steps[0], 9));
    expect(fillerLevel(mlToAmount(ML_MAX))).toBe(1);
    expect(fillerLevel(mlToAmount(0))).toBe(0);
    expect(mlToAmount(9)).toBe(mlToAmount(ML_MAX));
  });

  it("lips get fuller with every ml", () => {
    const m = mouth(40, 64);
    let last = 0;
    for (const ml of [1, 2, 3, 4]) {
      const h = heights(transformOuterLip(m.outer, m.inner, mlToAmount(ml), 0.6), m.inner);
      expect(h.upper + h.lower).toBeGreaterThan(last);
      last = h.upper + h.lower;
    }
  });
});
