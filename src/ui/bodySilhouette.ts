// The standing figure drawn over the live camera for body shaping: where to stand and how.
// Pure geometry (no DOM) so it can be unit-tested and rendered anywhere.
//
// Traced from the reference pose (the example images): facing the camera, arms hanging about
// 15-20 degrees out with a clear gap at the hips, feet about hip-width apart, a fuller build so
// most people fit inside comfortably. It matches the pose the posture check coaches toward
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
  [120.0, 5.0], [134.9, 9.7], [144.2, 22.1], [146.9, 37.5], [147.5, 52.5], [139.9, 66.3], [142.2, 80.6], [156.3, 87.8],
  [171.1, 93.4], [186.0, 98.5], [196.4, 110.1], [200.4, 125.4], [201.3, 141.2], [204.1, 156.8], [206.8, 172.4], [211.7, 187.4],
  [217.5, 202.1], [220.5, 217.6], [222.7, 233.3], [226.0, 248.8], [230.3, 264.0], [236.3, 278.6], [237.6, 294.4], [231.1, 305.8],
  [217.8, 301.2], [216.5, 285.8], [210.8, 271.2], [209.7, 255.5], [202.3, 241.6], [194.3, 227.9], [187.6, 213.5], [184.0, 198.1],
  [180.7, 182.7], [172.7, 178.2], [174.0, 193.5], [179.5, 208.4], [182.6, 223.8], [180.5, 239.4], [183.2, 254.8], [186.1, 270.3],
  [186.3, 286.1], [184.3, 301.8], [180.6, 317.2], [176.3, 332.5], [171.5, 347.5], [167.5, 362.8], [167.7, 378.5], [169.1, 394.3],
  [167.7, 410.0], [164.1, 425.4], [159.4, 440.5], [154.5, 455.6], [151.3, 471.0], [153.5, 486.6], [161.8, 499.9], [161.1, 511.5],
  [145.4, 513.0], [132.6, 506.9], [128.7, 491.7], [127.4, 476.0], [130.4, 460.5], [129.8, 444.7], [126.8, 429.2], [123.6, 413.7],
  [123.3, 397.9], [126.3, 382.4], [125.5, 366.8], [123.5, 351.2], [123.1, 335.4], [120.0, 320.7],
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
