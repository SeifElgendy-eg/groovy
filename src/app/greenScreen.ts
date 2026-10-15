// Body shaping on a green screen (effects/body/greenScreen.ts does the keying): on each body photo
// with a green screen around the person, the person (green spill taken out) is put on the clinic's
// branded background, at the photo's full resolution. The slimming then works on that picture, with
// the branded background filling wherever the body moves away (as the empty backdrop does), and the
// keyed outline (exact to the pixel) replaces the segmenter's. Photos without a green screen, or
// with kiosk.json "greenScreen": "off", are not touched.
import type { PersonMask } from "../effects/body/effect";
import { composite, findKey, keyPerson } from "../effects/body/greenScreen";
import { kioskConfig } from "./kioskConfig";

/** A body photo on a green screen, put on the branded background. */
export interface GreenPhoto {
  /** The person on the branded background (photo size). */
  composite: HTMLCanvasElement;
  /** The branded background alone, fitted to the photo (photo size). */
  background: HTMLCanvasElement;
  /** The keyed outline of the person, for the body analysis (1 = person). */
  mask: PersonMask;
}

let picture: HTMLImageElement | null = null;
let loading: Promise<void> | null = null;

/** Load the branded background (at start, with the other models). */
export function loadBackground(): Promise<void> {
  loading ??= new Promise<void>((resolve) => {
    if (kioskConfig().greenScreen === "off") return resolve();
    const img = new Image();
    img.onload = () => {
      picture = img;
      console.info(`green screen: branded background ${kioskConfig().background} (${img.naturalWidth} x ${img.naturalHeight})`);
      resolve();
    };
    img.onerror = () => {
      console.warn(`green screen: the background ${kioskConfig().background} could not be loaded; green screen photos stay as taken`);
      resolve();
    };
    img.src = new URL(kioskConfig().background, document.baseURI).href;
  });
  return loading;
}

/**
 * The background fitted to w x h, filling it, as a canvas: cropped evenly at the sides, and from
 * the bottom only (the logo at the top stays whole on a wider photo).
 */
function fitted(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const img = picture!;
  const k = Math.max(w / img.naturalWidth, h / img.naturalHeight);
  const dw = img.naturalWidth * k, dh = img.naturalHeight * k;
  c.getContext("2d")!.drawImage(img, (w - dw) / 2, 0, dw, dh);
  return c;
}

/** Longest side of the keyed outline handed to the body analysis (it works at up to 800 px). */
const MASK_LONG_SIDE = 1024;

/**
 * Key the photo (`source`, full size): null when green screen is off, the background is missing,
 * or there is no green screen around the person. `person`: the segmenter's outline, if it is sure
 * of it (what is not green but far from the person, like a floor that is not green, is background).
 */
export function keyPhoto(source: HTMLCanvasElement, person: PersonMask | null): GreenPhoto | null {
  if (kioskConfig().greenScreen === "off" || !picture) return null;
  const w = source.width, h = source.height;
  const pixels = source.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, w, h);
  const key = findKey(pixels.data, w, h);
  if (!key) return null;
  const t0 = performance.now();
  const alpha = keyPerson(pixels.data, w, h, key, person);
  const background = fitted(w, h);
  const bg = background.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, w, h);
  const out = new ImageData(w, h);
  composite(pixels.data, alpha, bg.data, out.data);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d")!.putImageData(out, 0, 0);
  // the keyed outline at the analysis' size (averaged: its soft edge stays soft)
  const k = Math.min(1, MASK_LONG_SIDE / Math.max(w, h));
  const mw = Math.max(1, Math.round(w * k)), mh = Math.max(1, Math.round(h * k));
  const sum = new Float32Array(mw * mh), cnt = new Float32Array(mw * mh);
  const col = new Int32Array(w);
  for (let x = 0; x < w; x++) col[x] = Math.min(mw - 1, Math.floor(x * k));
  for (let y = 0; y < h; y++) {
    const my = Math.min(mh - 1, Math.floor(y * k)) * mw, row = y * w;
    for (let x = 0; x < w; x++) {
      const i = my + col[x];
      sum[i] += alpha[row + x];
      cnt[i]++;
    }
  }
  for (let i = 0; i < sum.length; i++) sum[i] /= 255 * (cnt[i] || 1);
  console.info(`green screen: keyed (screen on ${Math.round(100 * key.share)}% of the border) in ${Math.round(performance.now() - t0)} ms`);
  return { composite: canvas, background, mask: { data: sum, w: mw, h: mh } };
}
