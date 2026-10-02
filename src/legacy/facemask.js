// Face-only masking for skin effects (wrinkles, and optionally acne).
//
// Three layers, each fixing a different leak:
//   1. faceOval()       - landmark polygon. The segmenter's "face skin" class bleeds onto the
//                         ears; anything outside this polygon can never be treated. The top is
//                         pushed up so the mask can reach the real hairline (the segmenter, not
//                         the polygon, decides where the hair starts).
//   2. guardContours()  - lash / eyebrow guards. The old exclusions used 6 of the 16 eye
//                         landmarks and sat exactly ON the lid, so lashes (which grow outward
//                         from it) were treated. These are the full eye/brow loops, grown
//                         outward by the length lashes and brow hairs actually have.
//   3. refineSkinMask() - the segmenter runs at 256px and is upscaled, so its edge is soft and
//                         off by several pixels. Boundary pixels are re-tested against the skin
//                         colour next to them at full resolution; hair/brow pixels get dropped.
//                         This is what lets the mask run right up to the hairline.
const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const smooth = (t) => t * t * (3 - 2 * t);

export const FACE_OVAL = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378,
  400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21,
  54, 103, 67, 109,
];
// Full lid loops, outer corner first (index 0), inner corner at index 8.
export const RIGHT_EYE = [
  33, 246, 161, 160, 159, 158, 157, 173, 133, 155, 154, 153, 145, 144, 163, 7,
];
export const LEFT_EYE = [
  263, 466, 388, 387, 386, 385, 384, 398, 362, 382, 381, 380, 374, 373, 390,
  249,
];
export const BROWS = [
  [70, 63, 105, 66, 107, 55, 65, 52, 53, 46],
  [336, 296, 334, 293, 300, 276, 283, 282, 295, 285],
];

// ------------------------------------------------------------------ 1. oval
export function faceOval(points, faceWidth) {
  const top = points[10],
    chin = points[152];
  let ux = top.x - chin.x,
    uy = top.y - chin.y;
  const len = Math.hypot(ux, uy) || 1;
  ux /= len;
  uy /= len;
  let sx = points[454].x - points[234].x,
    sy = points[454].y - points[234].y;
  const wid = Math.hypot(sx, sy) || 1;
  sx /= wid;
  sy /= wid;
  const cx = (top.x + chin.x) / 2,
    cy = (top.y + chin.y) / 2;
  return FACE_OVAL.map((i) => {
    const p = points[i],
      dx = p.x - cx,
      dy = p.y - cy,
      up = (dx * ux + dy * uy) / (len / 2), // -1 chin .. +1 top of oval
      side = (dx * sx + dy * sy) / (wid / 2); // -1 .. +1 across the face
    let x = p.x,
      y = p.y;
    // Forehead: the landmark oval often stops below the real hairline.
    if (up > 0.35) {
      const k = smooth(clamp((up - 0.35) / 0.65)) * faceWidth * 0.16;
      x += ux * k;
      y += uy * k;
    }
    // Cheek edge / temple: pull in slightly so the ear root is never inside.
    if (Math.abs(side) > 0.8) {
      const k = smooth(clamp((Math.abs(side) - 0.8) / 0.2)) * faceWidth * 0.02,
        s = Math.sign(side);
      x -= sx * s * k;
      y -= sy * s * k;
    }
    return { x, y };
  });
}

// ------------------------------------------------------------------ 2. guards
// Grow a contour along the head's own axes: sideways, upward, downward.
function growAxial(pts, ux, uy, g) {
  const vx = -uy,
    vy = ux;
  let cx = 0,
    cy = 0;
  for (const p of pts) {
    cx += p.x;
    cy += p.y;
  }
  cx /= pts.length;
  cy /= pts.length;
  return pts.map((p) => {
    const dx = p.x - cx,
      dy = p.y - cy;
    let du = dx * ux + dy * uy,
      dv = dx * vx + dy * vy;
    const t = clamp(dv / g.blend, -1, 1); // -1 upper edge .. +1 lower edge
    du += Math.sign(du) * g.side;
    dv += t < 0 ? t * g.up : t * g.down;
    return { x: cx + du * ux + dv * vx, y: cy + du * uy + dv * vy };
  });
}

// Returns polygons (arrays of {x,y}) to carve out of the treatable mask.
export function guardContours(points, faceWidth) {
  const P = points,
    angle = Math.atan2(P[263].y - P[33].y, P[263].x - P[33].x),
    ux = Math.cos(angle),
    uy = Math.sin(angle),
    out = [];
  for (const loop of [RIGHT_EYE, LEFT_EYE]) {
    const ew = Math.hypot(
      P[loop[0]].x - P[loop[8]].x,
      P[loop[0]].y - P[loop[8]].y,
    );
    out.push(
      growAxial(
        loop.map((i) => P[i]),
        ux,
        uy,
        {
          side: ew * 0.12, // lashes flare past the corners
          up: ew * 0.3, // upper lashes are the long ones
          down: ew * 0.15,
          blend: ew * 0.06,
        },
      ),
    );
  }
  for (const brow of BROWS)
    out.push(
      growAxial(
        brow.map((i) => P[i]),
        ux,
        uy,
        {
          side: faceWidth * 0.012,
          up: faceWidth * 0.016,
          down: faceWidth * 0.012,
          blend: faceWidth * 0.01,
        },
      ),
    );
  return out;
}

// ------------------------------------------------------------------ 3. refine
// mask, source: RGBA arrays. Returns a new RGBA mask with hair/brow/shadow pixels removed from
// the boundary band (`band` px wide) of the skin region.
export function refineSkinMask(
  mask,
  source,
  width,
  height,
  band = 4,
  opt = {},
) {
  const {
    darkRatio = 0.72,
    chromaRatio = 0.5,
    radius = Math.max(6, band * 3),
    passes = 3,
  } = opt;
  const n = width * height,
    BIG = 1e6,
    dist = new Float32Array(n),
    inside = new Uint8Array(n);
  for (let p = 0; p < n; p++) inside[p] = mask[p * 4 + 3] >= 128 ? 1 : 0;
  // Chamfer distance (4-neighbour) to the nearest non-skin pixel; image border counts as non-skin.
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      dist[p] =
        inside[p] && x && y && x < width - 1 && y < height - 1 ? BIG : 0;
      if (x) dist[p] = Math.min(dist[p], dist[p - 1] + 1);
      if (y) dist[p] = Math.min(dist[p], dist[p - width] + 1);
    }
  for (let y = height - 1; y >= 0; y--)
    for (let x = width - 1; x >= 0; x--) {
      const p = y * width + x;
      if (x < width - 1) dist[p] = Math.min(dist[p], dist[p + 1] + 1);
      if (y < height - 1) dist[p] = Math.min(dist[p], dist[p + width] + 1);
    }
  // Integral images of luminance and redness (r-g) over the RELIABLE interior only.
  const W = width + 1,
    L = new Float64Array(W * (height + 1)),
    C = new Float64Array(W * (height + 1)),
    N = new Float64Array(W * (height + 1));
  const lumAt = (i) =>
    source[i] * 0.2126 + source[i + 1] * 0.7152 + source[i + 2] * 0.0722;
  for (let y = 0; y < height; y++) {
    let rl = 0,
      rc = 0,
      rn = 0;
    for (let x = 0; x < width; x++) {
      const p = y * width + x,
        i = p * 4;
      if (dist[p] > band * 1.5) {
        rl += lumAt(i);
        rc += source[i] - source[i + 1];
        rn++;
      }
      const q = (y + 1) * W + x + 1;
      L[q] = L[q - W] + rl;
      C[q] = C[q - W] + rc;
      N[q] = N[q - W] + rn;
    }
  }
  const sum = (S, x0, y0, x1, y1) =>
    S[(y1 + 1) * W + x1 + 1] -
    S[y0 * W + x1 + 1] -
    S[(y1 + 1) * W + x0] +
    S[y0 * W + x0];
  const total = N[height * W + width] || 1,
    gL = L[height * W + width] / total,
    gC = C[height * W + width] / total;
  const out = Uint8ClampedArray.from(mask);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (!inside[p] || dist[p] > band) continue;
      const x0 = Math.max(0, x - radius),
        x1 = Math.min(width - 1, x + radius),
        y0 = Math.max(0, y - radius),
        y1 = Math.min(height - 1, y + radius),
        cnt = sum(N, x0, y0, x1, y1),
        refL = cnt >= 20 ? sum(L, x0, y0, x1, y1) / cnt : gL,
        refC = cnt >= 20 ? sum(C, x0, y0, x1, y1) / cnt : gC,
        i = p * 4;
      const tooDark = lumAt(i) < refL * darkRatio; // hair, brow, dark lash root
      const notSkin =
        refC > 10 && source[i] - source[i + 1] < refC * chromaRatio; // blond/grey hair
      if (tooDark || notSkin) out[i + 3] = 0;
    }
  // Peel again: the new edge is tested too, so hair bleed deeper than `band` is removed.
  return passes > 1
    ? refineSkinMask(out, source, width, height, band, {
        ...opt,
        passes: passes - 1,
      })
    : out;
}
