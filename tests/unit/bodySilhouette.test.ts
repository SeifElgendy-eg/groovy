// The standing outline shown over the camera for body shaping: a closed, symmetric figure that
// fits its viewBox and stands on the feet ring.
import { describe, expect, it } from "vitest";
import { FEET_RING, GUIDE_CENTRE_X, GUIDE_VIEWBOX, silhouettePath } from "../../src/ui/bodySilhouette";

/** Every coordinate pair in the path (control points included). */
function points(d: string): [number, number][] {
  const n = d.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < n.length; i += 2) out.push([n[i], n[i + 1]]);
  return out;
}

describe("body guide silhouette", () => {
  const d = silhouettePath();
  const pts = points(d);

  it("is one closed path of plain numbers", () => {
    expect(d.startsWith("M")).toBe(true);
    expect(d.endsWith("Z")).toBe(true);
    expect(d).not.toMatch(/NaN|Infinity/);
    expect(pts.length).toBeGreaterThan(50);
  });

  it("fits inside the viewBox", () => {
    for (const [x, y] of pts) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(GUIDE_VIEWBOX.w);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(GUIDE_VIEWBOX.h);
    }
  });

  it("is symmetric about the centre line", () => {
    const xs = pts.map((p) => p[0]);
    expect(Math.min(...xs) + Math.max(...xs)).toBeCloseTo(2 * GUIDE_CENTRE_X, 0);
    // every point has a mirror image (within rounding)
    for (const [x, y] of pts) {
      const mirrored = pts.some(([mx, my]) => Math.abs(mx - (GUIDE_VIEWBOX.w - x)) < 0.05 && Math.abs(my - y) < 0.05);
      expect(mirrored).toBe(true);
    }
  });

  it("stands on the feet ring, with room for the ring below", () => {
    // (control points overshoot the drawn curve by a pixel or two, hence the margins)
    const ys = pts.map((p) => p[1]);
    expect(Math.max(...ys)).toBeLessThanOrEqual(FEET_RING.cy);
    expect(Math.max(...ys)).toBeGreaterThan(FEET_RING.cy - 10);
    expect(FEET_RING.cy + FEET_RING.ry).toBeLessThanOrEqual(GUIDE_VIEWBOX.h);
    expect(FEET_RING.cx - FEET_RING.rx).toBeGreaterThanOrEqual(0);
    expect(FEET_RING.cx + FEET_RING.rx).toBeLessThanOrEqual(GUIDE_VIEWBOX.w);
  });

  it("is a standing figure: much taller than wide, head at the top", () => {
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const width = Math.max(...xs) - Math.min(...xs);
    const height = Math.max(...ys) - Math.min(...ys);
    expect(height / width).toBeGreaterThan(1.8); // widened for a forgiving fit
    expect(Math.min(...ys)).toBeLessThan(10);
  });
});
