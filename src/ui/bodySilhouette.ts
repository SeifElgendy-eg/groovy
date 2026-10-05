// The standing figure drawn over the live camera for body shaping: where to stand and how.
// Pure geometry (no DOM) so it can be unit-tested and rendered anywhere.
//
// The figure is an average, neutral build (it is a pose cue, not a body-type target), facing the
// camera with the arms slightly away from the body and the feet slightly apart. Only the right
// half is written out; the left is its mirror image, so the figure is exactly symmetric.

/** SVG viewBox of the guide: the figure fills 6..194 wide and 5..513 tall; feet rings sit below. */
export const GUIDE_VIEWBOX = { w: 200, h: 530 } as const;
export const GUIDE_CENTRE_X = GUIDE_VIEWBOX.w / 2;

type Pt = readonly [number, number];

/**
 * Right half, top of the head down to the armpit: head, neck, shoulder, outside of the arm, hand,
 * back up the inside of the arm. The last point is a corner (armpit).
 */
const UPPER: Pt[] = [
  [100, 5], [112, 7], [120, 14], [123, 26], [123, 39], [120, 51], [115, 60], [111, 67], [111, 78],
  [117, 83], [131, 88], [147, 94], [157, 102], [162, 114], [164, 128], [167, 148], [171, 175],
  [176, 203], [181, 230], [186, 252], [191, 268], [194, 285], [193, 300], [188, 306], [183, 300],
  [181, 284], [177, 264], [173, 246], [165, 220], [157, 194], [152, 170], [149, 150], [148, 136],
];

/**
 * Right half, armpit down the side of the body and the outside of the leg, round the foot and up
 * the inside of the leg to the crotch (a corner on the centre line).
 */
const LOWER: Pt[] = [
  [148, 136], [146, 154], [143, 178], [139, 206], [140, 234], [145, 256], [148, 277], [147, 302],
  [143, 342], [138, 385], [136, 405], [135, 420], [131, 446], [126, 468], [130, 488], [135, 503],
  [130, 513], [112, 513], [106, 505], [108, 486], [109, 468], [106, 445], [105, 420], [106.5, 388],
  [103, 345], [100.5, 312], [100, 292],
];

const mirror = ([x, y]: Pt): Pt => [GUIDE_VIEWBOX.w - x, y];
const round = (v: number) => Math.round(v * 100) / 100;

/** Open Catmull-Rom spline through `pts` as cubic Bezier segments ("C ..." only; no "M"). */
function spline(pts: readonly Pt[]): string {
  let d = "";
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1: Pt = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: Pt = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${round(c1[0])} ${round(c1[1])} ${round(c2[0])} ${round(c2[1])} ${round(p2[0])} ${round(p2[1])}`;
  }
  return d;
}

/**
 * The closed outline. One smooth curve over the head and both shoulders (so the top of the head
 * has no kink), then the right body side, then the left, joined at the two corners (armpits and
 * crotch) where the outline is allowed to turn sharply.
 */
export function silhouettePath(): string {
  const leftUpper = [...UPPER].reverse().map(mirror); // left armpit -> top of head (mirror)
  const over = [...leftUpper, ...UPPER.slice(1)]; // left armpit -> over the head -> right armpit
  const leftLower = [...LOWER].reverse().map(mirror); // crotch -> left armpit
  const start = over[0];
  return `M${round(start[0])} ${round(start[1])}${spline(over)}${spline(LOWER)}${spline(leftLower)}Z`;
}

/** Where the feet stand: a ring to step into, centred between the feet (the soles are at y = 513). */
export const FEET_RING = { cx: GUIDE_CENTRE_X, cy: 516, rx: 94, ry: 14 } as const;
