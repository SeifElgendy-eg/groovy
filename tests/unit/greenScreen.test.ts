import { describe, expect, it } from "vitest";
import { boundAlpha, composite, despill, findFloor, findKey, keyAlpha, keyPerson, screenMap, unmix } from "../../src/effects/body/greenScreen";

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
    const w = 40, h = 40, px = photo(w, h, SCREEN, SKIN);
    const map = screenMap(px, w, h, findKey(px, w, h)!);
    // half skin, half screen
    const mixed = SKIN.map((s, i) => Math.round(0.5 * s + 0.5 * SCREEN[i]));
    const one = new Uint8ClampedArray(w * h * 4);
    one.set([...mixed, 255], 0);
    const alpha = new Uint8Array(w * h);
    alpha[0] = 128;
    unmix(one, alpha, w, map);
    for (let c = 0; c < 3; c++) expect(Math.abs(one[c] - SKIN[c])).toBeLessThan(4);
  });

  it("takes the screen's green light off the person's edge, not their colour or green clothes inside", () => {
    // a 1 x 3 row: an edge pixel with a green cast, skin next to it, a green shirt far inside (band 1 px)
    const w = 40, h = 1, px = new Uint8ClampedArray(w * h * 4), alpha = new Uint8Array(w);
    for (let x = 0; x < w; x++) px.set([200, 190, 150, 255], x * 4);
    px.set([120, 170, 110, 255], 0);
    px.set([40, 160, 60, 255], 20 * 4);
    alpha.fill(255);
    alpha[0] = 200; // the edge
    despill(px, alpha, w, h, 2);
    expect(px[1]).toBe(126); // green cast on the edge: down to red + a little
    expect(px[5]).toBe(190); // skin: green below red, unchanged
    expect(px[20 * 4 + 1]).toBe(160); // the green shirt inside keeps its colour
  });

  it("keys an unevenly lit screen and its shadows, keeps the person", () => {
    const w = 80, h = 160, px = photo(w, h, SCREEN, SKIN);
    // light falling off to the right, and the person's shadow beside them
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (px[i] === SKIN[0]) continue;
        const k = (1.2 - (0.6 * x) / w) * (x >= 56 && x < 64 ? 0.45 : 1);
        for (let c = 0; c < 3; c++) px[i + c] = SCREEN[c] * k;
      }
    const a = keyPerson(px, w, h, findKey(px, w, h)!, null);
    expect(a[80 * w + 40]).toBe(255);
    for (const x of [2, 20, 58, 62, 77]) expect(a[80 * w + x]).toBe(0);
  });

  it("keeps green clothes inside the body, where the segmenter is sure", () => {
    const w = 80, h = 160, px = photo(w, h, SCREEN, SKIN);
    // a green print in the middle of the body (a different green from the screen's)
    for (let y = 70; y < 90; y++) for (let x = 35; x < 45; x++) px.set([100, 190, 40, 255], (y * w + x) * 4);
    const person = { data: new Float32Array(w * h), w, h };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) person.data[y * w + x] = x >= 0.3 * w && x < 0.7 * w && y >= 0.2 * h && y < 0.9 * h ? 1 : 0;
    const a = keyPerson(px, w, h, findKey(px, w, h)!, person);
    expect(a[80 * w + 40]).toBe(255);
    expect(a[80 * w + 5]).toBe(0);
  });

  it("finds a floor that is not green, and none when the floor is green", () => {
    const w = 60, h = 120, px = photo(w, h, SCREEN, SKIN);
    expect(findFloor(px, w, h)).toBeNull();
    for (let y = 100; y < h; y++) for (let x = 0; x < w; x++) px.set([120, 118, 115, 255], (y * w + x) * 4);
    const f = findFloor(px, w, h)!;
    expect(f).not.toBeNull();
    expect(f.top).toBeGreaterThan(0.8);
  });

  it("drops a grey floor around the feet, keeps the feet", () => {
    const w = 60, h = 120, px = photo(w, h, SCREEN, SKIN, [0.3, 0.2, 0.7, 0.95]);
    for (let y = 100; y < h; y++) for (let x = 0; x < w; x++) if (!(x >= 18 && x < 42 && y < 114)) px.set([120, 118, 115, 255], (y * w + x) * 4);
    const person = { data: new Float32Array(w * h), w, h };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) person.data[y * w + x] = x >= 18 && x < 42 && y >= 24 && y < 114 ? 1 : 0;
    const a = keyPerson(px, w, h, findKey(px, w, h)!, person);
    expect(a[110 * w + 30]).toBe(255); // a foot
    expect(a[110 * w + 15]).toBe(0); // the floor right beside it
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
