import { describe, expect, it } from "vitest";
import type { Point } from "../../src/core/types";
import { FILLED_RATIO, rollProfile, transformOuterLip } from "../../src/effects/lips/geometry";

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

  it("the roll is gentle: stretch near the opening stays under 1.3x even at full volume and roll", () => {
    const f = rollProfile(0.55, 1);
    expect((f(0.01) - f(0)) / 0.01).toBeLessThan(1.3);
    expect(f(0)).toBe(0);
    expect(f(1)).toBeCloseTo(1, 9);
  });
});
