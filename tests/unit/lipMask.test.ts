import { describe, expect, it } from "vitest";
import type { Point } from "../../src/core/types";
import { snapLipOutline } from "../../src/effects/lips/lipMask";
import { densify } from "../../src/effects/lips/warpField";

const W = 240,
  H = 160,
  CX = 120,
  CY = 80,
  RX = 80,
  RY = 36;
const inEllipse = (x: number, y: number, rx: number, ry: number) => ((x - CX) / rx) ** 2 + ((y - CY) / ry) ** 2 <= 1;

/** 20 points on an ellipse in landmark order: 0 left corner, 1-9 upper, 10 right corner, 11-19 lower. */
function contour(rx: number, ry: number): Point[] {
  return Array.from({ length: 20 }, (_, i) => {
    const th = i <= 10 ? Math.PI - (Math.PI * i) / 10 : -(Math.PI * (i - 10)) / 10;
    return { x: CX + rx * Math.cos(th), y: CY - ry * Math.sin(th) };
  });
}

/** Lips (an ellipse RX x RY) on skin, with noise. */
function photo(lipRgb: number[], skinRgb: number[], noise = 8) {
  const px = new Uint8ClampedArray(W * H * 4);
  let seed = 3;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * noise;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const c = inEllipse(x + 0.5, y + 0.5, RX, RY) ? lipRgb : skinRgb;
      const v = rnd();
      px.set([c[0] + v, c[1] + v, c[2] + v, 255], (y * W + x) * 4);
    }
  return px;
}

/** Mean distance (px, approximately) of outline points from the true lip border, corners excluded. */
function borderError(pts: Point[]): number {
  let sum = 0,
    count = 0;
  for (const p of pts) {
    if (Math.abs(p.x - CX) > RX * 0.8) continue; // corners stay anchored by design
    const r = Math.hypot((p.x - CX) / RX, (p.y - CY) / RY);
    sum += Math.abs(r - 1) * (Math.hypot(p.x - CX, p.y - CY) / r);
    count++;
  }
  return sum / count;
}

const LIP = [190, 95, 105],
  SKIN = [222, 178, 150];
const inner = contour(50, 4);
const run = (pixels: Uint8ClampedArray, outer: Point[]) =>
  snapLipOutline({ pixels, x0: 0, y0: 0, width: W, height: H, outer, inner });

describe("lip outline snapping", () => {
  it("pulls a too-big outline back onto the lip border (no bleed onto skin)", () => {
    const outer = contour(RX + 3, RY + 3);
    const r = run(photo(LIP, SKIN), outer);
    expect(r.separation).toBeGreaterThan(2.5);
    expect(borderError(r.outer)).toBeLessThan(borderError(densify(outer, 4)) * 0.4);
  });

  it("grows a too-small outline out towards the border (no pale gap)", () => {
    const outer = contour(RX - 2.5, RY - 2.5);
    const r = run(photo(LIP, SKIN), outer);
    expect(borderError(r.outer)).toBeLessThan(borderError(densify(outer, 4)) * 0.5);
  });

  it("keeps the landmark outline when lips and skin are the same colour", () => {
    const outer = contour(RX + 3, RY + 3);
    const r = run(photo(SKIN, SKIN), outer);
    expect(r.separation).toBeLessThan(1.2);
    const before = densify(outer, 4);
    r.outer.forEach((p, i) => expect(Math.hypot(p.x - before[i].x, p.y - before[i].y)).toBeLessThan(1e-9));
  });

  it("keeps the mouth corners where the landmarks put them", () => {
    const outer = contour(RX + 3, RY + 3);
    const r = run(photo(LIP, SKIN), outer);
    expect(Math.hypot(r.outer[0].x - outer[0].x, r.outer[0].y - outer[0].y)).toBeLessThan(1e-9);
    expect(Math.hypot(r.outer[40].x - outer[10].x, r.outer[40].y - outer[10].y)).toBeLessThan(1e-9);
  });

  it("returns a smooth outline (no jagged neighbours), even on a noisy photo", () => {
    const r = run(photo(LIP, SKIN, 30), contour(RX + 3, RY + 3));
    let worst = 0;
    const n = r.outer.length;
    for (let i = 0; i < n; i++) {
      const a = r.outer[(i - 1 + n) % n],
        b = r.outer[i],
        c = r.outer[(i + 1) % n];
      worst = Math.max(worst, Math.hypot(b.x - (a.x + c.x) / 2, b.y - (a.y + c.y) / 2));
    }
    expect(worst).toBeLessThan(1.5);
  });
});
