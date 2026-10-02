import { describe, expect, it } from "vitest";
import { colorLips, oklabToSrgb, srgbToOklab } from "../../src/effects/lips/color";

const lum = (p: Uint8ClampedArray, i: number) => 0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2];

/** A tiny "lip": base colour, one crease pixel (darker), one highlight pixel (lighter). */
function lip(): { pixels: Uint8ClampedArray; mask: Uint8ClampedArray } {
  const base = [170, 95, 100];
  const px = [base, base, [120, 60, 65], [235, 190, 190], base, base];
  const pixels = new Uint8ClampedArray(px.length * 4);
  px.forEach((c, k) => pixels.set([...c, 255], k * 4));
  const mask = new Uint8ClampedArray(px.length * 4).fill(255);
  return { pixels, mask };
}

describe("OKLab conversion", () => {
  it("round-trips sRGB colours", () => {
    for (const c of [[0, 0, 0], [255, 255, 255], [222, 75, 80], [120, 60, 65], [30, 200, 90]] as const) {
      const lab = srgbToOklab(c[0], c[1], c[2]);
      const back = oklabToSrgb(lab.L, lab.a, lab.b);
      back.forEach((v, i) => expect(Math.abs(v - c[i])).toBeLessThanOrEqual(1));
    }
  });
  it("keeps out-of-gamut colours inside sRGB by reducing chroma, not clipping hue", () => {
    const out = oklabToSrgb(0.7, 0.4, 0.2);
    out.forEach((v) => expect(v).toBeGreaterThanOrEqual(0));
    out.forEach((v) => expect(v).toBeLessThanOrEqual(255));
  });
});

describe("colorLips", () => {
  it("does nothing at zero intensity", () => {
    const { pixels, mask } = lip();
    const before = pixels.slice();
    colorLips(pixels, mask, "#DE4B50", 0);
    expect([...pixels]).toEqual([...before]);
  });

  it("keeps the lip's texture: the crease stays darker and the highlight lighter", () => {
    const { pixels, mask } = lip();
    colorLips(pixels, mask, "#DE4B50", 1);
    expect(lum(pixels, 8)).toBeLessThan(lum(pixels, 0)); // crease
    expect(lum(pixels, 12)).toBeGreaterThan(lum(pixels, 0)); // highlight
  });

  it("moves the hue toward the shade", () => {
    const { pixels, mask } = lip();
    colorLips(pixels, mask, "#DE4B50", 1);
    const shade = srgbToOklab(0xde, 0x4b, 0x50);
    const got = srgbToOklab(pixels[0], pixels[1], pixels[2]);
    const hue = (l: { a: number; b: number }) => Math.atan2(l.b, l.a);
    expect(Math.abs(hue(got) - hue(shade))).toBeLessThan(0.15);
  });

  it("gloss shows brighter highlights than matte", () => {
    const g = lip(), m = lip();
    colorLips(g.pixels, g.mask, "#DE4B50", 1, "gloss");
    colorLips(m.pixels, m.mask, "#DE4B50", 1, "matte");
    expect(lum(g.pixels, 12)).toBeGreaterThan(lum(m.pixels, 12) + 10);
  });

  it("leaves pixels outside the mask untouched", () => {
    const { pixels, mask } = lip();
    mask[3] = 0; // first pixel not lip
    const first = [...pixels.slice(0, 4)];
    colorLips(pixels, mask, "#DE4B50", 1);
    expect([...pixels.slice(0, 4)]).toEqual(first);
  });
});
