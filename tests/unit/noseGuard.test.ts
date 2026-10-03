import { describe, expect, it } from "vitest";
import { noseGuard } from "../../src/effects/wrinkles/effect";

/** Point in polygon (even-odd). */
const inside = (poly: { x: number; y: number }[], x: number, y: number) => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++)
    if (poly[i].y > y !== poly[j].y > y && x < ((poly[j].x - poly[i].x) * (y - poly[i].y)) / (poly[j].y - poly[i].y) + poly[i].x) c = !c;
  return c;
};

describe("nose guard", () => {
  // A frontal face: eyes' inner corners at y=100, nose from the bridge (y=105) to its base (y=190).
  const P = Array.from({ length: 478 }, () => ({ x: 0, y: 0 }));
  const set = (i: number, x: number, y: number) => (P[i] = { x, y });
  set(6, 200, 105); // bridge between the eyes
  set(2, 200, 190); // base of the nose
  set(4, 200, 170); // tip
  set(133, 170, 100); // inner eye corners
  set(362, 230, 100);
  set(98, 175, 180); // nostril wings
  set(327, 225, 180);
  const g = noseGuard(P);
  it("covers the bridge, tip and nostrils", () => {
    expect(inside(g, 200, 110)).toBe(true);
    expect(inside(g, 200, 170)).toBe(true);
    expect(inside(g, 180, 182)).toBe(true);
    expect(inside(g, 220, 182)).toBe(true);
  });
  it("leaves the inner under-eyes free", () => {
    // Just below each inner eye corner, where the tear trough starts.
    expect(inside(g, 168, 115)).toBe(false);
    expect(inside(g, 232, 115)).toBe(false);
    expect(inside(g, 160, 130)).toBe(false);
    expect(inside(g, 240, 130)).toBe(false);
  });
});
