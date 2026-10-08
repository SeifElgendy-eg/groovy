// The standing figure drawn over the live camera for body shaping: where to stand and how.
// Pure geometry (no DOM) so it can be unit-tested and rendered anywhere.
//
// The reference pose (the example images) on a neutral, average build, so it reads as a pose cue
// and not a body type: facing the camera, arms hanging about 15 degrees out with a clear gap at the
// hips, feet about hip-width apart. It matches the pose the posture check coaches toward
// (effects/body/posture.ts). Only the right half is written out (top of the head down to the
// crotch); the left is its mirror image, so the figure is exactly symmetric.

/** SVG viewBox of the guide. */
export const GUIDE_VIEWBOX = { w: 240, h: 530 } as const;
export const GUIDE_CENTRE_X = GUIDE_VIEWBOX.w / 2;

type Pt = readonly [number, number];

/**
 * Right half, clockwise from the top of the head: head, ear, neck, shoulder, outside of the arm,
 * hand, inside of the arm, armpit, side of the body, outside of the leg, foot, inside of the leg,
 * up to the crotch on the centre line.
 */
const RIGHT: Pt[] = [
  // head and neck
  [120, 5], [133, 8], [142, 18], [146, 33], [145, 48], [141, 60], [135, 70], [134, 80],
  // shoulder, outside of the arm, hand
  [143, 88], [162, 95], [182, 101], [195, 110], [201, 126], [205, 150], [210, 178], [215, 205],
  [221, 232], [227, 258], [232, 280], [236, 297], [237, 312], [233, 325], [225, 330], [217, 324],
  // inside of the arm up to the armpit
  [213, 309], [208, 292], [201, 268], [194, 243], [188, 218], [182, 194], [176, 176], [171, 168],
  // side of the body, outside of the leg, foot
  [167, 182], [165, 204], [162, 226], [161, 248], [165, 270], [171, 292], [175, 314], [175, 340],
  [171, 372], [166, 403], [166, 430], [162, 458], [153, 484], [149, 496], [154, 505], [152, 513],
  // inside of the leg up to the crotch
  [131, 513], [126, 505], [127, 492], [126, 468], [125, 444], [127, 417], [127, 400], [125, 375],
  [123, 352], [120, 334],
];

const mirror = ([x, y]: Pt): Pt => [GUIDE_VIEWBOX.w - x, y];
const round = (v: number) => Math.round(v * 100) / 100;

/** The closed outline: a smooth closed Catmull-Rom curve through the right half and its mirror. */
export function silhouettePath(): string {
  const pts: Pt[] = [...RIGHT, ...RIGHT.slice(1, -1).reverse().map(mirror)];
  const n = pts.length;
  let d = `M${round(pts[0][0])} ${round(pts[0][1])}`;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    const c1: Pt = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: Pt = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${round(c1[0])} ${round(c1[1])} ${round(c2[0])} ${round(c2[1])} ${round(p2[0])} ${round(p2[1])}`;
  }
  return `${d}Z`;
}

/** Where the feet stand: a ring centred under the two feet. */
export const FEET_RING = { cx: GUIDE_CENTRE_X, cy: 516, rx: 96, ry: 13 } as const;
