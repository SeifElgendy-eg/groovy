import { describe, expect, it } from "vitest";
import type { Point } from "../../src/core/types";
import { computeLipTargets, type LipData, type LipParams } from "../../src/effects/lips/geometry";
import {
  buildMesh,
  densify,
  gridOffset,
  sampleGrid,
  warpPixelsCpu,
  warpRoi,
  type WarpGrid,
} from "../../src/effects/lips/warpField";

/** A synthetic mouth in the landmark order: 0 left corner, 1-9 upper, 10 right corner, 11-19 lower. */
function mouth(width = 300, cx = 400, cy = 300): LipData {
  const ring = (up: number, down: number): Point[] =>
    Array.from({ length: 20 }, (_, i) => {
      const t = (i % 10) / 10;
      const upper = i < 10;
      const x = upper ? cx - width / 2 + width * t : cx + width / 2 - width * t;
      const s = Math.sin(Math.PI * t);
      return { x, y: upper ? cy - up * s : cy + down * s };
    });
  const outerPts = ring(42, 55),
    innerPts = ring(4, 4);
  const b = (pts: Point[]) => {
    const xs = pts.map((p) => p.x),
      ys = pts.map((p) => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
  };
  return { outerPts, innerPts, outer: b(outerPts), inner: b(innerPts), cy } as LipData;
}

const params = (amount: number, roll = 0.6): LipParams => ({
  amount, roll, blend: 0.3, colorIntensity: 0, shadeHex: "", finish: "natural", showOutline: false,
});

describe("lip warp field", () => {
  const lip = mouth();
  const p = params(0.55, 1);
  const { targetOuter } = computeLipTargets(lip, p);
  const mesh = buildMesh(lip, targetOuter, p);
  const roi = warpRoi(mesh, 2000, 2000);
  const g = sampleGrid(mesh, roi);
  const at = (q: Point) => gridOffset(g, q.x - roi.x, q.y - roi.y);

  it("densify keeps the original points and adds smooth ones between", () => {
    const d = densify(lip.outerPts, 3);
    expect(d.length).toBe(60);
    expect(d[3].x).toBeCloseTo(lip.outerPts[1].x, 6);
    expect(d[3].y).toBeCloseTo(lip.outerPts[1].y, 6);
  });

  it("reads every mesh point from where the lip model says", () => {
    let worst = 0;
    mesh.dst.forEach((ring, r) =>
      ring.forEach((d, i) => {
        const [ox, oy] = at(d);
        worst = Math.max(worst, Math.hypot(d.x + ox - mesh.src[r][i].x, d.y + oy - mesh.src[r][i].y));
      }),
    );
    expect(worst).toBeLessThan(1.5);
  });

  it("keeps the mouth opening in place", () => {
    for (const q of lip.innerPts) {
      const [ox, oy] = at(q);
      expect(Math.hypot(ox, oy)).toBeLessThan(0.5);
    }
  });

  it("actually grows the lips (the new, higher edge reads from lower down)", () => {
    const [, oy] = at(targetOuter[5]);
    expect(oy).toBeGreaterThan(15);
  });

  it("never folds, even at full volume and roll", () => {
    expect(minJacobian(g)).toBeGreaterThan(0.25);
  });

  it("is zero on the patch border (no seam with the untouched image)", () => {
    for (const [x, y] of [[0, 0], [roi.w, 0], [0, roi.h / 2], [roi.w / 2, roi.h], [roi.w, roi.h]]) {
      const [ox, oy] = gridOffset(g, x, y);
      expect(Math.hypot(ox, oy)).toBeLessThan(1e-6);
    }
  });

  it("stays local: the skin it moves scales with the volume, smaller than the old rim when moderate", () => {
    const oldRim = lip.outer.height * 2.8;
    // Anchors sit at most 2x the largest move + 4% of mouth width beyond the grown lips.
    let maxMove = 0;
    lip.outerPts.forEach((q, i) => (maxMove = Math.max(maxMove, Math.hypot(targetOuter[i].x - q.x, targetOuter[i].y - q.y))));
    const width = lip.outerPts[10].x - lip.outerPts[0].x;
    expect(roi.h).toBeLessThan(lip.outer.height + 2 * (maxMove * 3 + width * 0.04) + 4);
    const m = params(0.2, 0.5);
    const m2 = buildMesh(lip, computeLipTargets(lip, m).targetOuter, m);
    expect(warpRoi(m2, 2000, 2000).h).toBeLessThan(oldRim);
  });
});

/** Smallest local area ratio of the backward map over the grid (<= 0 means it folds). */
function minJacobian(g: WarpGrid): number {
  let min = Infinity;
  for (let y = 2; y < g.roi.h - 2; y += 2)
    for (let x = 2; x < g.roi.w - 2; x += 2) {
      const [ax, ay] = gridOffset(g, x + 1, y),
        [bx, by] = gridOffset(g, x - 1, y),
        [cx, cy] = gridOffset(g, x, y + 1),
        [dx, dy] = gridOffset(g, x, y - 1);
      const jxx = 1 + (ax - bx) / 2, jyx = (ay - by) / 2, jxy = (cx - dx) / 2, jyy = 1 + (cy - dy) / 2;
      min = Math.min(min, jxx * jyy - jxy * jyx);
    }
  return min;
}

describe("CPU warp fallback", () => {
  it("is the identity when nothing moves", () => {
    const lip = mouth(60, 40, 40);
    const p = params(0);
    const mesh = buildMesh(lip, lip.outerPts, p);
    const roi = warpRoi(mesh, 80, 80);
    const g = sampleGrid(mesh, roi);
    const src = new Uint8ClampedArray(roi.w * roi.h * 4).map((_, i) => (i * 37) % 251);
    const out = warpPixelsCpu(src, g);
    let diff = 0;
    for (let i = 0; i < src.length; i++) diff = Math.max(diff, Math.abs(out[i] - src[i]));
    expect(diff).toBeLessThanOrEqual(1);
  });
});
