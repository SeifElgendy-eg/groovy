import { describe, expect, it } from "vitest";
import { linesCompute, MAX_SOFTEN, type Zone } from "../../src/effects/wrinkles/lines";

const W = 240,
  H = 160;
/** Skin with: a horizontal crease, a vertical crease, a round freckle, and fine grain. */
function skin() {
  const px = new Uint8ClampedArray(W * H * 4);
  let seed = 5;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 6;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let v = rnd();
      if (x > 30 && x < 120) v -= 26 * Math.exp(-(((y - 50) / 1.6) ** 2)); // horizontal line
      if (y > 70 && y < 150) v -= 26 * Math.exp(-(((x - 70) / 1.6) ** 2)); // vertical line
      v -= 30 * Math.exp(-((x - 180) ** 2 + (y - 50) ** 2) / (2 * 3 * 3)); // freckle
      px.set([205 + v, 160 + v, 140 + v, 255], (y * W + x) * 4);
    }
  return px;
}
const lum = (a: ArrayLike<number>, i: number) => 0.2126 * a[i] + 0.7152 * a[i + 1] + 0.0722 * a[i + 2];
const apply = (px: Uint8ClampedArray, l: { mul: Uint8ClampedArray; add: Uint8ClampedArray }) => {
  const out = new Float32Array(px.length);
  for (let i = 0; i < px.length; i += 4) for (let c = 0; c < 3; c++) out[i + c] = (px[i + c] * l.mul[i + c]) / 255 + l.add[i + c];
  return out;
};

describe("botox line finder", () => {
  const px = skin();
  const mask = new Uint8ClampedArray(px.length).fill(255);
  // One forehead zone over everything, lines expected to run horizontally.
  const zones: Zone[] = [{ id: "forehead", cx: 120, cy: 80, rx: 400, ry: 400, angle: 0, lineAngle: 0 }];
  const r = linesCompute({ pixels: px, mask, width: W, height: H, faceWidth: 400, zones });
  const out = apply(px, r.forehead);
  const at = (x: number, y: number) => (y * W + x) * 4;
  const lift = (x: number, y: number) => lum(out, at(x, y)) - lum(px, at(x, y));

  it("softens a line running the area's way", () => {
    expect(lift(75, 50)).toBeGreaterThan(10);
  });

  it("softens, never erases (at most ~MAX_SOFTEN of its depth)", () => {
    const depth = lum(px, at(75, 40)) - lum(px, at(75, 50));
    expect(lift(75, 50)).toBeLessThan(depth * (MAX_SOFTEN + 0.1));
  });

  it("softens lines running the wrong way for the area less", () => {
    // Softened too (crepey texture runs every way), but clearly less than the area's own lines.
    expect(lift(70, 110)).toBeLessThan(lift(75, 50) * 0.75);
  });

  it("leaves a freckle (round, not a line)", () => {
    expect(lift(180, 50)).toBeLessThan(lift(75, 50) * 0.25);
  });

  it("leaves plain skin and its grain alone", () => {
    expect(Math.abs(lift(200, 130))).toBeLessThan(1);
  });

  it("does nothing in areas with no zone", () => {
    const empty = new Uint8ClampedArray(px.length);
    for (let i = 3; i < empty.length; i += 4) empty[i] = 255;
    const o2 = apply(px, r.frown);
    expect(Math.abs(lum(o2, at(75, 50)) - lum(px, at(75, 50)))).toBeLessThan(0.5);
  });
});

describe("next to the lid (strict zone)", () => {
  it("removes a line along the lid but never touches lashes crossing it", () => {
    const px = skin();
    // Lashes: short thin dark strokes crossing a horizontal lid line at y=50.
    for (let x = 140; x < 230; x += 6)
      for (let y = 40; y < 62; y++)
        for (const dx of [0, 1]) {
          const i = (y * W + x + dx) * 4;
          px[i] -= 45; px[i + 1] -= 45; px[i + 2] -= 45;
        }
    const mask = new Uint8ClampedArray(px.length).fill(255);
    const zones: Zone[] = [
      { id: "undereye", cx: 120, cy: 50, rx: 400, ry: 60, angle: 0, lineAngle: 0, tolerance: [20, 40], strict: true, fine: true },
    ];
    const r = linesCompute({ pixels: px, mask, width: W, height: H, faceWidth: 400, zones });
    const out = apply(px, r.undereye);
    const at = (x: number, y: number) => (y * W + x) * 4;
    const lift = (x: number, y: number) => lum(out, at(x, y)) - lum(px, at(x, y));
    expect(lift(75, 50)).toBeGreaterThan(8); // the line along the lid
    let worst = 0;
    for (let x = 140; x < 230; x += 6) for (const y of [42, 56, 60]) worst = Math.max(worst, Math.abs(lift(x, y)));
    expect(worst).toBeLessThan(3); // the lashes
  });
});
