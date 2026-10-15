import { describe, expect, it } from "vitest";
import { boundAlpha, composite, despill, findKey, keyAlpha, unmix } from "../../src/effects/body/greenScreen";

/** A w x h photo: green screen everywhere, with a `person` colour in the middle box. */
function photo(w: number, h: number, screen: number[], person: number[], box = [0.3, 0.2, 0.7, 0.9]): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const inside = x >= box[0] * w && x < box[2] * w && y >= box[1] * h && y < box[3] * h;
      px.set([...(inside ? person : screen), 255], (y * w + x) * 4);
    }
  return px;
}
const SCREEN = [40, 180, 50], SKIN = [205, 160, 135];

describe("green screen", () => {
  it("finds the screen on the photo's border, and none on an ordinary photo", () => {
    const k = findKey(photo(100, 200, SCREEN, SKIN), 100, 200);
    expect(k).not.toBeNull();
    expect(k!.share).toBeGreaterThan(0.9);
    expect(findKey(photo(100, 200, [200, 200, 205], SKIN), 100, 200)).toBeNull(); // a white wall
  });

  it("keys the screen out and keeps the person, shadows on the screen included", () => {
    const w = 100, h = 200, px = photo(w, h, SCREEN, SKIN);
    // a shadow on the screen: darker, same hue
    for (let x = 0; x < 20; x++) px.set([20, 95, 26, 255], (10 * w + x) * 4);
    const a = keyAlpha(px, w, h, findKey(px, w, h)!);
    expect(a[100 * w + 50]).toBe(255); // the person
    expect(a[5 * w + 5]).toBe(0); // the screen
    expect(a[10 * w + 5]).toBe(0); // its shadow
  });

  it("keeps dark clothes and skin even though they are not far from the screen in brightness", () => {
    const w = 60, h = 120;
    const a = keyAlpha(photo(w, h, SCREEN, [25, 28, 30]), w, h, findKey(photo(w, h, SCREEN, [25, 28, 30]), w, h)!);
    expect(a[60 * w + 30]).toBe(255);
  });

  it("gives an edge between screen and person a soft value", () => {
    const w = 60, h = 120, px = photo(w, h, SCREEN, SKIN);
    const mixPx = SCREEN.map((s, i) => Math.round((s + SKIN[i]) / 2));
    px.set([...mixPx, 255], (60 * w + 17) * 4); // half screen, half skin (the edge of an arm)
    const a = keyAlpha(px, w, h, findKey(px, w, h)!);
    expect(a[60 * w + 17]).toBeGreaterThan(0);
  });

  it("gives an edge pixel back the person's own colour (no green fringe)", () => {
    // half skin, half screen
    const mixed = SKIN.map((s, i) => Math.round(0.5 * s + 0.5 * SCREEN[i]));
    const px = new Uint8ClampedArray([...mixed, 255]);
    unmix(px, new Uint8Array([128]), SCREEN as [number, number, number]);
    for (let c = 0; c < 3; c++) expect(Math.abs(px[c] - SKIN[c])).toBeLessThan(4);
  });

  it("takes the screen's green cast out of the person, not their colour", () => {
    const px = new Uint8ClampedArray([200, 190, 150, 255, 120, 170, 110, 255]);
    despill(px, new Uint8Array([255, 255]));
    expect(px[1]).toBe(190); // skin: green below red, unchanged
    expect(px[5]).toBe(126); // green cast: down to red + a little
  });

  it("drops what is not green but far from the person (a floor that is not green)", () => {
    const alpha = new Uint8Array([255, 255, 255, 255]);
    boundAlpha(alpha, 4, 1, { data: new Float32Array([1, 1, 0, 0]), w: 4, h: 1 });
    expect([...alpha]).toEqual([255, 255, 0, 0]);
  });

  it("puts the person over the background", () => {
    const out = new Uint8ClampedArray(8);
    composite(new Uint8ClampedArray([200, 100, 50, 255, 200, 100, 50, 255]), new Uint8Array([255, 0]), new Uint8ClampedArray([10, 20, 30, 255, 10, 20, 30, 255]), out);
    expect([...out]).toEqual([200, 100, 50, 255, 10, 20, 30, 255]);
  });
});
