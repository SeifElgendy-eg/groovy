import { describe, expect, it } from "vitest";
import { healTexture } from "../../src/effects/wrinkles/lines";

describe("healing texture", () => {
  // Clean skin with a known grain everywhere except a band across the middle that needs new texture.
  const w = 160,
    h = 120,
    n = w * h;
  const fine = new Float32Array(n),
    low = new Float32Array(n).fill(150),
    clean = new Float32Array(n),
    need = new Float32Array(n);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const band = y >= 50 && y < 70;
      need[p] = band ? 1 : 0;
      clean[p] = band ? 0 : 1;
      // Grain: deterministic, zero-mean, amplitude ~4; inside the band, a crease (the old texture).
      fine[p] = band ? -20 : ((((x * 73856093) ^ (y * 19349663)) >>> 0) % 9) - 4;
    }
  const healed = healTexture(fine, low, clean, need, w, h, 300);
  const vals: number[] = [];
  for (let y = 50; y < 70; y++) for (let x = 10; x < w - 10; x++) vals.push(healed[y * w + x]);

  it("covers the band with texture from clean skin (none of the crease's own detail)", () => {
    expect(vals.every((v) => !Number.isNaN(v))).toBe(true);
    expect(Math.min(...vals)).toBeGreaterThan(-12); // the crease's -20 is never copied
  });

  it("keeps the grain's contrast through the cross-fades", () => {
    const sd = (a: number[]) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
    const src: number[] = [];
    for (let y = 0; y < 40; y++) for (let x = 0; x < w; x++) src.push(fine[y * w + x]);
    const ratio = sd(vals) / sd(src);
    expect(ratio).toBeGreaterThan(0.8);
    expect(ratio).toBeLessThan(1.25);
  });

  it("leaves pixels that need nothing alone", () => {
    expect(Number.isNaN(healed[10 * w + 10])).toBe(true);
  });
});
