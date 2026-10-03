import { describe, expect, it } from "vitest";
import type { Point } from "../../src/core/types";
import { lipShading } from "../../src/effects/lips/shading";

function ring(u: number, d: number, width = 300, cx = 400, cy = 300): Point[] {
  return Array.from({ length: 20 }, (_, i) => {
    const t = (i % 10) / 10;
    const upper = i < 10;
    const x = upper ? cx - width / 2 + width * t : cx + width / 2 - width * t;
    const s = Math.sin(Math.PI * t);
    return { x, y: upper ? cy - u * s : cy + d * s };
  });
}
const outer = ring(45, 70),
  inner = ring(3, 3);

describe("lip volume shading", () => {
  it("adds nothing without filler", () => {
    expect(lipShading(outer, inner, 0)).toEqual([]);
  });

  it("grows in strength with the filler level", () => {
    const a = lipShading(outer, inner, 0.3).map((s) => s.alpha);
    const b = lipShading(outer, inner, 0.9).map((s) => s.alpha);
    a.forEach((v, i) => expect(b[i]).toBeGreaterThan(v));
  });

  it("puts the gloss on the lower lip and the shadow on the skin below it", () => {
    const spots = lipShading(outer, inner, 1);
    const gloss = spots.find((s) => s.kind === "light" && s.region === "lips" && s.cy > 300)!;
    expect(gloss.cy).toBeGreaterThan(303);
    expect(gloss.cy).toBeLessThan(370);
    const shadow = spots.find((s) => s.kind === "shadow")!;
    expect(shadow.region).toBe("skin");
    expect(shadow.cy).toBeGreaterThan(370);
  });
});
