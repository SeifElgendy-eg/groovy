// Green screen (chroma key) for body shaping. Pure functions on RGBA pixels (no DOM), unit-tested.
//
// On a green backdrop "not green" is the person, at the photo's full resolution and exact to the
// pixel: a far better outline than any model's, whatever the light or the clothes. The app then
// puts the person on the clinic's branded background, and slimming can never bend the background
// (it is replaced; where the body moves away, the branded background shows).
//
// The screen is found on the photo's border (around the person), so nothing needs setting up.
// Each pixel's greenness against the screen's (brightness ignored: shadows and folds on the screen
// stay screen) gives a soft alpha. Green light the screen throws on the edges of skin and hair
// ("spill") is taken out.

/** The screen: how green it is (see greenness), and how much of the photo's border it covers. */
export interface Key {
  /** The screen's typical greenness (0..1). */
  green: number;
  /** Share (0..1) of the photo's border that is the screen. */
  share: number;
  /** The screen's typical colour (r, g, b), to unmix the edges. */
  rgb: [number, number, number];
}

/** Below this share of the border, there is no green screen in the photo (the app works as without). */
export const MIN_SHARE = 0.35;

/**
 * How green a pixel is, whatever its brightness: how far green rises above the larger of red and
 * blue, as a share of the green itself (a lit screen and its shadow score the same; skin, white,
 * grey and dark clothes score 0 or less).
 */
export const greenness = (r: number, g: number, b: number): number => (g - Math.max(r, b)) / Math.max(g, 1);

/** A clearly green pixel (as a screen is). */
const greenish = (r: number, g: number, b: number) => g > 30 && greenness(r, g, b) > 0.2;

/**
 * The green screen of a photo, from its border (an outer band `band` x the short side wide), or
 * null when the border is not mostly green.
 */
export function findKey(rgba: Uint8ClampedArray, w: number, h: number, band = 0.06): Key | null {
  const bw = Math.max(1, Math.round(band * Math.min(w, h)));
  const step = Math.max(1, Math.round(Math.min(w, h) / 400)); // a sample of the band is plenty
  const gs: number[] = [], rs: number[] = [], gg: number[] = [], bs: number[] = [];
  let n = 0;
  for (let y = 0; y < h; y += step)
    for (let x = 0; x < w; x += step) {
      if (x >= bw && x < w - bw && y >= bw && y < h - bw) continue;
      n++;
      const i = (y * w + x) * 4, r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      if (greenish(r, g, b)) {
        gs.push(greenness(r, g, b));
        rs.push(r);
        gg.push(g);
        bs.push(b);
      }
    }
  const share = n ? gs.length / n : 0;
  if (share < MIN_SHARE) return null;
  const med = (v: number[]) => v.sort((a, b) => a - b)[v.length >> 1];
  return { green: med(gs), share, rgb: [med(rs), med(gg), med(bs)] };
}

/**
 * Alpha (0 screen .. 255 person) of each pixel, from its greenness relative to the screen's: at or
 * above `inner` of it, screen; at or below `outer` of it, person; a soft ramp between (the edge:
 * hair, motion blur, a half-covered pixel). Shadows and folds on the screen stay screen.
 */
export function keyAlpha(rgba: Uint8ClampedArray, w: number, h: number, key: Key, inner = 0.7, outer = 0.3): Uint8Array {
  const out = new Uint8Array(w * h);
  const g0 = Math.max(0.05, key.green);
  for (let p = 0, i = 0; p < out.length; p++, i += 4) {
    const k = greenness(rgba[i], rgba[i + 1], rgba[i + 2]) / g0;
    const t = (inner - k) / (inner - outer); // 0 screen .. 1 person
    out[p] = t <= 0 ? 0 : t >= 1 ? 255 : Math.round(255 * t * t * (3 - 2 * t));
  }
  return out;
}

/**
 * The person's own colour on the soft edge (hair, the edge of an arm), in place: an edge pixel is
 * the person's colour and the screen's mixed by alpha, so the screen's share is taken back out
 * (F = (C - (1 - a) K) / a). Without this the edge keeps a light green or grey fringe on any
 * background.
 */
export function unmix(rgba: Uint8ClampedArray, alpha: Uint8Array, screen: [number, number, number]): void {
  for (let p = 0, i = 0; p < alpha.length; p++, i += 4) {
    const a8 = alpha[p];
    if (a8 === 0 || a8 === 255) continue;
    // (very faint edge pixels are nearly all screen: their own colour cannot be told apart, so the
    // division is limited; their small alpha hides them anyway)
    const a = Math.max(a8 / 255, 0.15);
    for (let c = 0; c < 3; c++) rgba[i + c] = (rgba[i + c] - (1 - a) * screen[c]) / a;
  }
}

/**
 * Take the screen's green out of the person (in place): no pixel keeps more green than the larger
 * of its red and blue, plus a little (skin and neutral colours lose only the green cast). Only where
 * the person is (alpha > 0).
 */
export function despill(rgba: Uint8ClampedArray, alpha: Uint8Array, slack = 6): void {
  for (let p = 0, i = 0; p < alpha.length; p++, i += 4) {
    if (!alpha[p]) continue;
    const limit = Math.max(rgba[i], rgba[i + 2]) + slack;
    if (rgba[i + 1] > limit) rgba[i + 1] = limit;
  }
}

/**
 * Keep the alpha only where the person can be (`allowed`, 0..1 at any size, e.g. the person mask
 * grown generously): what is not green but is far from the person (a floor that is not green, a
 * stand, a bag on the floor) is background too. In place.
 */
export function boundAlpha(alpha: Uint8Array, w: number, h: number, allowed: { data: Float32Array; w: number; h: number }): void {
  for (let y = 0; y < h; y++) {
    const ay = Math.min(allowed.h - 1, Math.floor(((y + 0.5) * allowed.h) / h)) * allowed.w;
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (!alpha[p]) continue;
      const k = allowed.data[ay + Math.min(allowed.w - 1, Math.floor(((x + 0.5) * allowed.w) / w))];
      if (k < 1) alpha[p] = Math.round(alpha[p] * k);
    }
  }
}

/** The person (despilled) over the background: `out` = bg x (1 - a) + photo x a. All the same size. */
export function composite(photo: Uint8ClampedArray, alpha: Uint8Array, bg: Uint8ClampedArray, out: Uint8ClampedArray): void {
  for (let p = 0, i = 0; p < alpha.length; p++, i += 4) {
    const a = alpha[p] / 255;
    out[i] = bg[i] + (photo[i] - bg[i]) * a;
    out[i + 1] = bg[i + 1] + (photo[i + 1] - bg[i + 1]) * a;
    out[i + 2] = bg[i + 2] + (photo[i + 2] - bg[i + 2]) * a;
    out[i + 3] = 255;
  }
}
