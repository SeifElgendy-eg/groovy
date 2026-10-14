// Hands: measured once, moved as one rigid piece with their wrist (or the body they rest on), and
// grown to the whole hand from the photo's colours.
import { TUNING, bbox, blur, blurReach, partTable, sample, sstep } from "./common";

/** A hand, measured once for rigidHands (its pixels, soft edge, the ring around it, its wrist). */
export interface HandShape {
  /** The hand's pixels (person pixels with that hand's part), ascending. */
  pixels: Int32Array;
  /** Soft hand mask (a little grown), and how far it reaches beyond the box. */
  soft: Float32Array;
  reach: number;
  box: [number, number, number, number];
  /** Pixels of the ring just around the hand, and those of them that are body (not hand). */
  ring: number;
  ringBody: Int32Array;
  /** Forearm pixels just above the wrist (empty when the wrist is not found). */
  wrist: Int32Array;
}

/** Measure both hands (BodyPix parts 10 and 11) for rigidHands. */
export function handShapes(labels: Uint8Array, m: Uint8Array, w: number, h: number, sw: number, J: Float32Array | null, body: Uint8Array | null): HandShape[] {
  const n = w * h;
  const out: HandShape[] = [];
  for (const id of [10, 11]) {
    const hand = new Float32Array(n);
    const px: number[] = [];
    let hx = 0, hy = 0;
    for (let i = 0; i < n; i++)
      if (m[i] && labels[i] === id) {
        hand[i] = 1;
        px.push(i);
        hx += i % w;
        hy += (i / w) | 0;
      }
    if (px.length < 10) continue;
    hx /= px.length;
    hy /= px.length;
    // the forearm just above this hand's wrist (the wrist nearest to the hand)
    const wrist: number[] = [];
    if (J) {
      const W = Math.hypot(J[12] - hx, J[13] - hy) <= Math.hypot(J[21] - hx, J[22] - hy) ? 4 : 7;
      const forearm = partTable(W === 4 ? [8, 9] : [6, 7]);
      const wx = J[W * 3], wy = J[W * 3 + 1], R = 0.15 * sw;
      for (let y = Math.max(0, Math.floor(wy - R)); y <= Math.min(h - 1, wy + R); y++)
        for (let x = Math.max(0, Math.floor(wx - R)); x <= Math.min(w - 1, wx + R); x++) {
          const i = y * w + x;
          if (m[i] && forearm[labels[i]] && Math.hypot(x - wx, y - wy) <= R) wrist.push(i);
        }
    }
    // the ring around the hand, and the body in it
    let ring = 0;
    const ringBody: number[] = [];
    if (body) {
      const rb = blur(hand, w, h, 0.03 * sw + 1);
      for (let i = 0; i < n; i++) {
        if (hand[i] || rb[i] < 0.03) continue;
        ring++;
        if (body[i] && !(labels[i] === 10 || labels[i] === 11)) ringBody.push(i);
      }
    }
    const sigma = 0.025 * sw + 1;
    out.push({
      pixels: Int32Array.from(px),
      soft: blur(hand, w, h, sigma),
      reach: blurReach(sigma),
      box: bbox(hand, w, h)!,
      ring,
      ringBody: Int32Array.from(ringBody),
      wrist: wrist.length >= 5 ? Int32Array.from(wrist) : new Int32Array(0),
    });
  }
  return out;
}

/**
 * Give each hand one movement in the field `f` (movement at strength 1; `full`: the strength at
 * 100%): the movement of the forearm just above its wrist (the hand goes where its wrist goes; the
 * hand's own average also picks up the movement around its edge, and a hand moved more than its
 * wrist bends at the wrist), or the hand's average when the wrist is not found. A hand against the
 * body (on the hip, the thigh, a coat's side) whose arm stays goes with the body around it instead
 * (`bodyDx`, the body's own field in `f`'s area; null: the body does not move in it): kept where the
 * arm puts it, the body slid away under the hand and left a notch below it. An arm turning in with
 * the waist takes its hand along. Applied wherever the hand is on its way at up to 100%.
 */
export function rigidHands(f: { dx: Float32Array; dy: Float32Array }, hands: HandShape[], w: number, h: number, sw: number, full: number, bodyDx: Float32Array | null): void {
  for (const hs of hands) {
    let vx = 0, vy = 0;
    for (const i of hs.pixels) {
      vx += f.dx[i];
      vy += f.dy[i];
    }
    vx /= hs.pixels.length;
    vy /= hs.pixels.length;
    const wristFound = hs.wrist.length > 0;
    if (wristFound) {
      let fx = 0, fy = 0;
      for (const i of hs.wrist) {
        fx += f.dx[i];
        fy += f.dy[i];
      }
      vx = fx / hs.wrist.length;
      vy = fy / hs.wrist.length;
    }
    if (hs.ring) {
      let bx = 0;
      for (const i of hs.ringBody) bx += bodyDx ? bodyDx[i] : 0;
      const bc = hs.ringBody.length;
      const H = TUNING.hands;
      const still = wristFound ? 1 - sstep(H.armMoves[0] * sw, H.armMoves[1] * sw, Math.abs(full * vx)) : 1;
      const touch = sstep(H.touch[0], H.touch[1], bc / hs.ring) * still;
      if (touch > 0) {
        vx += touch * (bx / bc - vx);
        vy *= 1 - touch;
      }
    }
    const at = (x: number, y: number) => Math.min(1, sample(hs.soft, w, h, x, y) * 2.5);
    // only near the hand: the soft mask is 0 beyond its reach, and the hand moves by full * v
    const reach = hs.reach + Math.ceil(full * Math.hypot(vx, vy)) + 2;
    const [bx0, by0, bx1, by1] = hs.box;
    for (let y = Math.max(0, by0 - reach); y <= Math.min(h - 1, by1 + reach); y++)
      for (let x = Math.max(0, bx0 - reach); x <= Math.min(w - 1, bx1 + reach); x++) {
        const i = y * w + x;
        const k = Math.max(at(x, y), at(x + 0.5 * full * vx, y + 0.5 * full * vy), at(x + full * vx, y + full * vy));
        if (!k) continue;
        f.dx[i] += (vx - f.dx[i]) * k;
        f.dy[i] += (vy - f.dy[i]) * k;
      }
  }
}

/**
 * Grow each hand (BodyPix parts 10 and 11) to the whole hand. BodyPix often labels only the palm and
 * gives the fingers the part they lie on (a thigh, the belly); those fingers would then be slimmed
 * with the leg while the palm moves with the arm, and the hand is torn or squashed. The hand is the
 * person's pixels from the wrist up to a hand's length past it, in the hand's direction and about a
 * hand wide, joined to the palm, and of the palm's colour (when the colours are known).
 */
export function growHands(labels: Uint8Array, m: Uint8Array, rgb: Uint8ClampedArray | undefined, w: number, h: number, J: Float32Array, sw: number): void {
  const n = w * h;
  for (const id of [10, 11]) {
    let c = 0, hx = 0, hy = 0;
    for (let i = 0; i < n; i++)
      if (m[i] && labels[i] === id) {
        c++;
        hx += i % w;
        hy += (i / w) | 0;
      }
    if (c < 6) continue;
    hx /= c;
    hy /= c;
    // the wrist and elbow of this hand: the wrist nearest to the palm
    const [W, E] = Math.hypot(J[12] - hx, J[13] - hy) <= Math.hypot(J[21] - hx, J[22] - hy) ? [4, 3] : [7, 6];
    const wx = J[W * 3], wy = J[W * 3 + 1];
    if (J[W * 3 + 2] < 0.3 || Math.hypot(wx - hx, wy - hy) > 0.5 * sw) continue;
    // the hand's direction: wrist to palm, or along the forearm when the palm is at the wrist
    let ux = hx - wx, uy = hy - wy;
    let len = Math.hypot(ux, uy);
    if (len < 0.05 * sw) {
      ux = wx - J[E * 3];
      uy = wy - J[E * 3 + 1];
      len = Math.hypot(ux, uy);
    }
    if (len < 1e-3) continue;
    ux /= len;
    uy /= len;
    const L = 0.5 * sw, R = 0.13 * sw;
    // the palm's colour
    let mr = 0, mg = 0, mb = 0, vr = 0;
    if (rgb) {
      for (let i = 0; i < n; i++)
        if (m[i] && labels[i] === id) {
          mr += rgb[i * 3];
          mg += rgb[i * 3 + 1];
          mb += rgb[i * 3 + 2];
        }
      mr /= c;
      mg /= c;
      mb /= c;
      for (let i = 0; i < n; i++)
        if (m[i] && labels[i] === id) vr += (rgb[i * 3] - mr) ** 2 + (rgb[i * 3 + 1] - mg) ** 2 + (rgb[i * 3 + 2] - mb) ** 2;
      vr /= c;
    }
    const maxD2 = Math.max(45 * 45, 6 * vr); // ~2.5 standard deviations of the palm's colour
    const cand = (x: number, y: number): boolean => {
      const i = y * w + x;
      if (!m[i] || labels[i] === 10 || labels[i] === 11 || labels[i] <= 1) return false; // not a hand already, not the face
      const t = (x - wx) * ux + (y - wy) * uy;
      if (t < 0 || t > L) return false;
      if (Math.abs((x - wx) * -uy + (y - wy) * ux) > R) return false;
      if (rgb && (rgb[i * 3] - mr) ** 2 + (rgb[i * 3 + 1] - mg) ** 2 + (rgb[i * 3 + 2] - mb) ** 2 > maxD2) return false;
      return true;
    };
    // flood from the palm through the candidates
    const stack: number[] = [];
    for (let i = 0; i < n; i++) if (m[i] && labels[i] === id) stack.push(i);
    const seen = new Uint8Array(n);
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % w, y = (i / w) | 0;
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const k = ny * w + nx;
        if (seen[k] || !cand(nx, ny)) continue;
        seen[k] = 1;
        labels[k] = id;
        stack.push(k);
      }
    }
  }
}
