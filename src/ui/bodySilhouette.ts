// The standing figure drawn over the live camera for body shaping: where to stand and how.
// Pure geometry (no DOM) so it can be unit-tested and rendered anywhere.
//
// The reference pose (the example images) on a neutral, average adult build, so it reads as a pose
// cue and not a body type: facing the camera, arms hanging about 13 degrees out with a clear gap at
// the hips, feet about hip-width apart. It matches the pose the posture check coaches toward
// (effects/body/posture.ts).
//
// Proportions are fractions of the standing height, averaged over men and women (50th-percentile
// adult anthropometry, NC State Ergonomics Center summary tables): shoulder height 0.82, elbow
// 0.62, hip joint 0.51, fingertips 0.37, bideltoid breadth 0.28, hip breadth 0.21, head 0.13;
// knee 0.29, crotch 0.47 and waist 0.62 up from the usual body-segment ratios; waist about 0.85 of
// the hip width (between typical male and female shapes). The height is 508 units (5 to 513). Only the right half is written out (top of the head down to the
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
  // head (~0.13 of the height) and neck
  [120, 5], [133, 7], [142, 15], [145, 28], [145, 42], [142, 55], [136, 66], [130, 73], [133, 80],
  // shoulder line (acromion ~0.82 of the height up), deltoid (~0.28 of the height across)
  [138, 86], [152, 90], [168, 93], [182, 98], [191, 106], [195, 118],
  // outside of the arm, ~13 degrees out: elbow ~0.62 up, wrist, hand (fingertips ~0.37 up)
  [199, 135], [204, 155], [209, 174], [214, 191], [218, 210], [221, 230], [224, 250], [227, 268],
  [232, 282], [236, 295], [235, 308], [230, 318], [223, 320], [216, 312], [213, 300],
  // inside of the arm up to the armpit, a gap to the body that widens toward the hand
  [210, 285], [208, 272], [204, 254], [200, 236], [195, 217], [188, 199], [183, 182], [179, 165],
  [175, 150], [170, 140],
  // side of the body: chest, waist (~0.62 up, ~0.85 of the hip width), hips (~0.21 across)
  [167, 152], [166, 170], [165, 190], [165, 205], [167, 222], [170, 238], [173, 254],
  // outside of the leg: thigh, knee (~0.29 up), calf, ankle, foot
  [172, 272], [170, 295], [166, 322], [162, 346], [159, 368], [161, 390], [162, 412], [159, 440],
  [155, 468], [153, 490], [156, 502], [160, 509], [156, 513],
  // inside of the foot and leg up to the crotch (~0.47 up)
  [140, 513], [131, 511], [132, 500], [134, 488], [132, 465], [127, 440], [126, 412], [128, 388],
  [128, 368], [126, 345], [124, 318], [122, 295], [120, 278],
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
export const FEET_RING = { cx: GUIDE_CENTRE_X, cy: 516, rx: 84, ry: 12 } as const;
