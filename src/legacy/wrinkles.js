// Wrinkle ("botox") smoothing.
//
// reduceWrinkles() returns a SIGNED correction as two RGBA images:
//   mul : per-channel gain <= 1 (255 = no change)   -> composite with "multiply"
//   add : per-channel light to add (0 = no change)  -> composite with "lighter"
// The caller draws the native photo, then mul, then add, so the full-resolution photo
// keeps its own colour and pore texture; only the smooth correction is ever upscaled.
//
// Pipeline (all inside the treated regions and the skin mask):
//   1. Crease fill   - per-channel morphological closing fills narrow dark valleys up to
//                      the colour of their banks (deep lines, hair-thin lines alike).
//   2. Smoothing     - masked, edge-preserving (guided) filter flattens the remaining
//                      folds, ridges and blotches while strong edges stay put.
//   3. Texture       - pore-level detail (high-pass) is put back so skin does not turn
//                      plastic; sharp crease edges are not (they would leave hairlines).
const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const smooth = (t) => t * t * (3 - 2 * t);
const BIG = 1e9;

// ---------------------------------------------------------------- regions
// points: landmarks in canvas pixels. Returns ellipses that follow the eye axis.
export function wrinkleRegions(points, faceWidth) {
  const P = points,
    fw = faceWidth;
  const angle = Math.atan2(P[263].y - P[33].y, P[263].x - P[33].x);
  const ux = Math.cos(angle),
    uy = Math.sin(angle),
    vx = -uy,
    vy = ux;
  const mid = (a, b, t = 0.5) => ({
    x: P[a].x + (P[b].x - P[a].x) * t,
    y: P[a].y + (P[b].y - P[a].y) * t,
  });
  const regions = [];

  // Forehead
  const brow = { x: (P[105].x + P[334].x) / 2, y: (P[105].y + P[334].y) / 2 };
  const foreheadHeight = Math.abs(
    (brow.x - P[10].x) * vx + (brow.y - P[10].y) * vy,
  );
  regions.push({
    x: (P[10].x + brow.x) / 2 - vx * fw * 0.06,
    y: (P[10].y + brow.y) / 2 - vy * fw * 0.06,
    rx: fw * 0.46,
    ry: Math.max(4, foreheadHeight * 0.7 + fw * 0.1),
    angle,
    strength: 1,
  });
  // Glabella (between the brows)
  regions.push({
    x: (P[107].x + P[336].x) / 2,
    y: (P[107].y + P[336].y) / 2,
    rx: fw * 0.115,
    ry: fw * 0.15,
    angle,
    strength: 0.95,
  });
  // Lower lateral forehead, above each brow
  for (const b of [105, 334])
    regions.push({
      x: P[b].x - vx * fw * 0.07,
      y: P[b].y - vy * fw * 0.07,
      rx: fw * 0.24,
      ry: fw * 0.11,
      angle,
      strength: 0.95,
      feather: 0.5,
    });

  // Eyes: crow's feet toward the temple, and the under-eye area
  for (const [outer, inner, lower, side] of [
    [33, 133, 145, -1],
    [263, 362, 374, 1],
  ]) {
    const ew = Math.hypot(P[outer].x - P[inner].x, P[outer].y - P[inner].y);
    regions.push({
      x: P[outer].x + ux * side * ew * 0.42,
      y: P[outer].y + uy * side * ew * 0.42,
      rx: ew * 0.78,
      ry: ew * 0.95,
      angle,
      strength: 0.95,
    });
    regions.push({
      x: (P[outer].x + P[inner].x) / 2 + vx * ew * 0.34,
      y: P[lower].y + vy * ew * 0.34,
      rx: ew * 0.75,
      ry: ew * 0.42,
      angle,
      strength: 0.85,
    });
  }

  // Eyes are protected: lashes sit just outside the lid contour, so the protection is wider
  // than the eye opening, reaches higher above the lid (upper lashes) than below it.
  for (const [outer, inner] of [
    [33, 133],
    [263, 362],
  ]) {
    const ew = Math.hypot(P[outer].x - P[inner].x, P[outer].y - P[inner].y),
      cx = (P[outer].x + P[inner].x) / 2,
      cy = (P[outer].y + P[inner].y) / 2;
    regions.push({
      protect: true,
      x: cx - vx * ew * 0.07,
      y: cy - vy * ew * 0.07,
      rx: ew * 0.62,
      ry: ew * 0.42,
      angle,
      strength: 1,
      feather: 0.3,
    });
  }

  // Cheek folds: nasolabial (nose wing -> mouth corner) and marionette (mouth corner -> jaw).
  // Ellipses lie ALONG the fold, so the lip/nose exclusions still protect the features.
  for (const [wing, corner, jaw] of [
    [48, 61, 172],
    [278, 291, 397],
  ]) {
    const a = P[wing],
      b = P[corner],
      len = Math.hypot(b.x - a.x, b.y - a.y);
    regions.push({
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
      rx: len * 0.62,
      ry: fw * 0.05,
      angle: Math.atan2(b.y - a.y, b.x - a.x),
      strength: 0.8,
      feather: 0.6,
    });
    const c = P[jaw],
      len2 = Math.hypot(c.x - b.x, c.y - b.y);
    regions.push({
      x: (b.x + c.x) / 2,
      y: (b.y + c.y) / 2,
      rx: len2 * 0.6,
      ry: fw * 0.045,
      angle: Math.atan2(c.y - b.y, c.x - b.x),
      strength: 0.7,
      feather: 0.6,
    });
  }
  // Gentle continuation through the cheeks, restricted to shallow lines.
  for (const [eye, mouth] of [
    [33, 61],
    [263, 291],
  ])
    regions.push({
      x: P[eye].x * 0.6 + P[mouth].x * 0.4,
      y: P[eye].y * 0.6 + P[mouth].y * 0.4,
      rx: fw * 0.22,
      ry: fw * 0.3,
      angle,
      strength: 0.35,
      feather: 0.65,
      support: true,
    });
  return regions;
}

// ------------------------------------------------------------ primitives
// Separable [1 4 6 4 1]/16 blur, edge-clamped.
function blur5(src, w, h, passes = 1) {
  let a = src;
  const k = [1 / 16, 4 / 16, 6 / 16, 4 / 16, 1 / 16];
  for (let n = 0; n < passes; n++) {
    const b = new Float32Array(src.length),
      c = new Float32Array(src.length);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let t = -2; t <= 2; t++)
          s += a[y * w + Math.min(w - 1, Math.max(0, x + t))] * k[t + 2];
        b[y * w + x] = s;
      }
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let t = -2; t <= 2; t++)
          s += b[Math.min(h - 1, Math.max(0, y + t)) * w + x] * k[t + 2];
        c[y * w + x] = s;
      }
    a = c;
  }
  return a;
}

// Separable max/min over a (2k+1)^2 window, only inside `box`.
function windowFilter(src, w, h, box, k, isMax) {
  const tmp = new Float32Array(w * h),
    out = new Float32Array(w * h);
  const ya = Math.max(0, box.y0 - k),
    yb = Math.min(h - 1, box.y1 + k);
  for (let y = ya; y <= yb; y++) {
    const row = y * w;
    for (let x = box.x0; x <= box.x1; x++) {
      let best = isMax ? -BIG : BIG;
      const a = Math.max(0, x - k),
        b = Math.min(w - 1, x + k);
      if (isMax) {
        for (let t = a; t <= b; t++) {
          const v = src[row + t];
          if (v > best) best = v;
        }
      } else {
        for (let t = a; t <= b; t++) {
          const v = src[row + t];
          if (v < best) best = v;
        }
      }
      tmp[row + x] = best;
    }
  }
  for (let y = box.y0; y <= box.y1; y++) {
    const a = Math.max(0, y - k),
      b = Math.min(h - 1, y + k);
    for (let x = box.x0; x <= box.x1; x++) {
      let best = isMax ? -BIG : BIG;
      if (isMax) {
        for (let t = a; t <= b; t++) {
          const v = tmp[t * w + x];
          if (v > best) best = v;
        }
      } else {
        for (let t = a; t <= b; t++) {
          const v = tmp[t * w + x];
          if (v < best) best = v;
        }
      }
      out[y * w + x] = best;
    }
  }
  return out;
}

// Closing of one channel: valleys narrower than the window fill to the lower bank.
// NaN where no valid skin is in reach.
function closeChannel(values, valid, w, h, box, k) {
  const n = w * h,
    hi = new Float32Array(n),
    big = k + 1;
  const grown = {
    x0: Math.max(0, box.x0 - big),
    x1: Math.min(w - 1, box.x1 + big),
    y0: Math.max(0, box.y0 - big),
    y1: Math.min(h - 1, box.y1 + big),
  };
  for (let p = 0; p < n; p++) hi[p] = valid[p] ? values[p] : -BIG;
  const dilated = windowFilter(hi, w, h, grown, k, true);
  for (let p = 0; p < n; p++)
    if (!valid[p] || dilated[p] < -BIG / 2) dilated[p] = BIG;
  const eroded = windowFilter(dilated, w, h, box, k, false);
  for (let p = 0; p < n; p++) if (eroded[p] > BIG / 2) eroded[p] = NaN;
  return eroded;
}

// Opening of one channel: bright ridges narrower than the window are cut to the higher floor.
function openChannel(values, valid, w, h, box, k) {
  const n = w * h,
    lo = new Float32Array(n),
    big = k + 1;
  const grown = {
    x0: Math.max(0, box.x0 - big),
    x1: Math.min(w - 1, box.x1 + big),
    y0: Math.max(0, box.y0 - big),
    y1: Math.min(h - 1, box.y1 + big),
  };
  for (let p = 0; p < n; p++) lo[p] = valid[p] ? values[p] : BIG;
  const eroded = windowFilter(lo, w, h, grown, k, false);
  for (let p = 0; p < n; p++)
    if (!valid[p] || eroded[p] > BIG / 2) eroded[p] = -BIG;
  const dilated = windowFilter(eroded, w, h, box, k, true);
  for (let p = 0; p < n; p++) if (dilated[p] < -BIG / 2) dilated[p] = NaN;
  return dilated;
}

// Window SUMS (not means) over (2r+1)^2, computed for pixels inside `box`.
function boxSum(src, w, h, r, box) {
  const tmp = new Float32Array(w * h),
    out = new Float32Array(w * h);
  const ya = Math.max(0, box.y0 - r),
    yb = Math.min(h - 1, box.y1 + r);
  for (let y = ya; y <= yb; y++) {
    const row = y * w;
    let s = 0;
    for (let t = Math.max(0, box.x0 - r); t <= Math.min(w - 1, box.x0 + r); t++)
      s += src[row + t];
    tmp[row + box.x0] = s;
    for (let x = box.x0 + 1; x <= box.x1; x++) {
      if (x + r < w) s += src[row + x + r];
      if (x - r - 1 >= 0) s -= src[row + x - r - 1];
      tmp[row + x] = s;
    }
  }
  for (let x = box.x0; x <= box.x1; x++) {
    let s = 0;
    for (let t = Math.max(0, box.y0 - r); t <= Math.min(h - 1, box.y0 + r); t++)
      s += tmp[t * w + x];
    out[box.y0 * w + x] = s;
    for (let y = box.y0 + 1; y <= box.y1; y++) {
      if (y + r < h) s += tmp[(y + r) * w + x];
      if (y - r - 1 >= 0) s -= tmp[(y - r - 1) * w + x];
      out[y * w + x] = s;
    }
  }
  return out;
}

// Guided filter (He et al.) with a gray guide and per-pixel sample weights `wt`,
// so pixels outside the skin never contribute colour to the result.
function guidedFilter(guide, channels, wt, w, h, r, eps, box) {
  const n = w * h,
    big = {
      x0: Math.max(0, box.x0 - r),
      x1: Math.min(w - 1, box.x1 + r),
      y0: Math.max(0, box.y0 - r),
      y1: Math.min(h - 1, box.y1 + r),
    };
  const sW = boxSum(wt, w, h, r, big);
  const gw = new Float32Array(n),
    gg = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    gw[p] = guide[p] * wt[p];
    gg[p] = guide[p] * guide[p] * wt[p];
  }
  const sI = boxSum(gw, w, h, r, big),
    sII = boxSum(gg, w, h, r, big);
  const have = new Float32Array(n);
  for (let p = 0; p < n; p++) have[p] = sW[p] > 1e-3 ? 1 : 0;
  const sHave = boxSum(have, w, h, r, box);
  return channels.map((p0) => {
    const pw = new Float32Array(n),
      Ip = new Float32Array(n);
    for (let p = 0; p < n; p++) {
      pw[p] = p0[p] * wt[p];
      Ip[p] = guide[p] * p0[p] * wt[p];
    }
    const sP = boxSum(pw, w, h, r, big),
      sIP = boxSum(Ip, w, h, r, big);
    const A = new Float32Array(n),
      B = new Float32Array(n);
    for (let y = big.y0; y <= big.y1; y++)
      for (let x = big.x0; x <= big.x1; x++) {
        const p = y * w + x;
        if (!have[p]) continue;
        const m = sW[p],
          mI = sI[p] / m,
          mP = sP[p] / m;
        const a =
          (sIP[p] / m - mI * mP) / (Math.max(0, sII[p] / m - mI * mI) + eps);
        A[p] = a;
        B[p] = mP - a * mI;
      }
    const sA = boxSum(A, w, h, r, box),
      sB = boxSum(B, w, h, r, box),
      out = new Float32Array(n);
    for (let y = box.y0; y <= box.y1; y++)
      for (let x = box.x0; x <= box.x1; x++) {
        const p = y * w + x,
          c = sHave[p];
        out[p] = c > 0 ? (sA[p] / c) * guide[p] + sB[p] / c : p0[p];
      }
    return out;
  });
}

function buildFocus(regions, width, height) {
  const target = new Float32Array(width * height),
    support = new Float32Array(width * height),
    protect = new Float32Array(width * height);
  for (const r of regions) {
    const c = Math.cos(r.angle || 0),
      s = Math.sin(r.angle || 0),
      reach = Math.ceil(Math.max(r.rx, r.ry)) + 1;
    const field = r.protect ? protect : r.support ? support : target,
      strength = r.strength ?? 0.9,
      feather = r.feather ?? 0.45;
    for (
      let y = Math.max(0, Math.floor(r.y - reach));
      y <= Math.min(height - 1, Math.ceil(r.y + reach));
      y++
    ) {
      for (
        let x = Math.max(0, Math.floor(r.x - reach));
        x <= Math.min(width - 1, Math.ceil(r.x + reach));
        x++
      ) {
        const xx = x - r.x,
          yy = y - r.y,
          d = Math.hypot((xx * c + yy * s) / r.rx, (-xx * s + yy * c) / r.ry),
          p = y * width + x;
        field[p] = Math.max(
          field[p],
          smooth(clamp((1 - d) / feather)) * strength,
        );
      }
    }
  }
  return { target, support, protect };
}

// ------------------------------------------------------------------ main
// options: smoothing 0..1.5 (edge tolerance of the smoother), texture 0..1 (pore detail kept)
export function reduceWrinkles(
  source,
  mask,
  width,
  height,
  radius,
  regions = [],
  options = {},
) {
  const {
    smoothing = 1,
    texture = 0.9,
    denoise = 2,
    clampDetail = 3,
    lines = 1,
  } = options;
  const count = width * height;
  const add = new Uint8ClampedArray(source.length),
    mul = new Uint8ClampedArray(source.length);
  for (let i = 0; i < mul.length; i += 4) {
    mul[i] = mul[i + 1] = mul[i + 2] = 255;
    mul[i + 3] = 255;
    add[i + 3] = 255;
  }

  const { target, support, protect } = buildFocus(regions, width, height);
  const focus = new Float32Array(count),
    valid = new Uint8Array(count),
    wt = new Float32Array(count);
  const box = { x0: width, x1: -1, y0: height, y1: -1 };
  for (let p = 0; p < count; p++) {
    focus[p] = (target[p] + support[p] * (1 - target[p])) * (1 - protect[p]);
    const a = mask[p * 4 + 3];
    valid[p] = a >= 180 ? 1 : 0;
    wt[p] = valid[p];
    if (focus[p] > 0.01 && a >= 20) {
      const x = p % width,
        y = (p - x) / width;
      if (x < box.x0) box.x0 = x;
      if (x > box.x1) box.x1 = x;
      if (y < box.y0) box.y0 = y;
      if (y > box.y1) box.y1 = y;
    }
  }
  if (box.x1 < 0) return { add, mul };

  // Thin dark structures (lashes, brow and stray hair) are found on the RAW luminance. On the
  // denoised image a 1-2 px lash is already too light to recognise, which is how lashes used to
  // slip through and get smoothed away.
  const k = Math.max(3, Math.round(radius * 1.5));
  const rawLum = new Float32Array(count);
  for (let p = 0; p < count; p++)
    rawLum[p] =
      source[p * 4] * 0.2126 +
      source[p * 4 + 1] * 0.7152 +
      source[p * 4 + 2] * 0.0722;
  const rawClosed = closeChannel(rawLum, valid, width, height, box, k);
  const hair = new Float32Array(count);
  {
    // Creases are only mildly darker than the skin around them; lashes, brow and stray hair are
    // far darker. So the detector is strict ONLY around the eyes (where lashes are
    // anti-aliased to faint pixels) and lenient everywhere else. Using the strict threshold on
    // the forehead classifies the creases themselves as hair and leaves them untouched.
    const hk = new Float32Array(count),
      hkEye = new Float32Array(count);
    for (let p = 0; p < count; p++) {
      if (Number.isNaN(rawClosed[p])) continue;
      const ratio = rawLum[p] / Math.max(rawClosed[p], 1);
      hk[p] = clamp((0.62 - ratio) / 0.1); // full below 52%, none above 62%
      if (protect[p] > 0.01) hkEye[p] = clamp((0.76 - ratio) / 0.12);
    }
    const near = windowFilter(hk, width, height, box, 1, true), // 1px margin
      eye = windowFilter(hkEye, width, height, box, 3, true); // 3px margin at the eyes
    for (let p = 0; p < count; p++) hair[p] = Math.max(0, near[p], eye[p]);
  }
  // Hair never contributes colour to anything below.
  for (let p = 0; p < count; p++) wt[p] = valid[p] ? 1 - hair[p] : 0;

  // Denoised colour: detection helper and base of the smooth layer. Masked blur, so lash/hair
  // and non-skin pixels cannot bleed a dark halo into the skin beside them.
  const wBlur = blur5(wt, width, height, denoise);
  const ch = [0, 1, 2].map((c) => {
    const a = new Float32Array(count);
    for (let p = 0; p < count; p++) a[p] = source[p * 4 + c] * wt[p];
    const b = blur5(a, width, height, denoise);
    for (let p = 0; p < count; p++)
      b[p] = wBlur[p] > 0.05 ? b[p] / wBlur[p] : source[p * 4 + c];
    return b;
  });
  const lum = new Float32Array(count);
  for (let p = 0; p < count; p++)
    lum[p] = ch[0][p] * 0.2126 + ch[1][p] * 0.7152 + ch[2][p] * 0.0722;

  // 1. Crease fill.
  const closed = ch.map((v) => closeChannel(v, valid, width, height, box, k));
  const filled = ch.map((v) => Float32Array.from(v));
  for (let p = 0; p < count; p++) {
    if (focus[p] < 0.01 || !valid[p] || Number.isNaN(closed[0][p])) continue;
    const depth =
      closed[0][p] * 0.2126 +
      closed[1][p] * 0.7152 +
      closed[2][p] * 0.0722 -
      lum[p];
    if (depth <= 0.5) continue;
    const notEdge = clamp((95 - depth) / 30); // very deep = hair, brow, accessory
    const notDark = clamp((lum[p] - 38) / 22); // near-black = hair/shadow, not skin
    const f =
      clamp(
        (Math.max(0, depth - 1.2) *
          notEdge *
          notDark *
          (1 - hair[p]) *
          (0.35 + 0.65 * target[p])) /
          depth,
      ) * Math.min(1, focus[p] * 1.5);
    for (let c = 0; c < 3; c++)
      filled[c][p] = ch[c][p] + (closed[c][p] - ch[c][p]) * f;
  }

  // 2. Edge-preserving smoothing of what is left (folds, ridges, blotches).
  const flum = new Float32Array(count);
  for (let p = 0; p < count; p++)
    flum[p] =
      filled[0][p] * 0.2126 + filled[1][p] * 0.7152 + filled[2][p] * 0.0722;
  const r = Math.max(4, Math.round(radius * 2.6)),
    eps = Math.pow(11 + 13 * smoothing, 2);
  const smoothed = guidedFilter(flum, filled, wt, width, height, r, eps, box);

  // 2b. Faint thin lines survive an edge-preserving filter because they are low contrast but
  // sharp. Alternating closing (dark lines) and opening (bright ridges) removes them.
  const slum = new Float32Array(count),
    lineDelta = new Float32Array(count);
  for (let p = 0; p < count; p++)
    slum[p] =
      smoothed[0][p] * 0.2126 +
      smoothed[1][p] * 0.7152 +
      smoothed[2][p] * 0.0722;
  if (lines > 0) {
    const k2 = Math.max(2, Math.round(radius * 0.9));
    const cl = closeChannel(slum, valid, width, height, box, k2),
      op = openChannel(slum, valid, width, height, box, k2);
    for (let p = 0; p < count; p++) {
      if (
        focus[p] < 0.01 ||
        !valid[p] ||
        Number.isNaN(cl[p]) ||
        Number.isNaN(op[p])
      )
        continue;
      const dd = Math.max(-14, Math.min(14, (cl[p] + op[p]) * 0.5 - slum[p]));
      lineDelta[p] = dd * lines;
    }
  }

  // 3. Compose the correction, put pore texture back, and encode as mul / add.
  for (let y = box.y0; y <= box.y1; y++)
    for (let x = box.x0; x <= box.x1; x++) {
      const p = y * width + x,
        i = p * 4,
        a = mask[i + 3],
        f = focus[p];
      if (a < 20 || f < 0.01) continue;
      const edge = a >= 180 ? 1 : a / 180;
      const sm = smooth(clamp(f * 1.15)) * edge * (1 - hair[p]);
      // Pore texture stays, but not where a line was just removed (it would redraw the line).
      const removed =
        clamp(Math.abs(lineDelta[p]) / 3) * 0.55 +
        clamp(Math.abs(slum[p] - lum[p]) / 18) * 0.35;
      const texKeep =
        1 - sm * (1 - texture) - Math.min(1, removed) * sm * texture;
      for (let c = 0; c < 3; c++) {
        const o = source[i + c],
          detail = o - ch[c][p],
          keep = clamp(detail, -clampDetail, clampDetail),
          excess = detail - keep;
        const base =
          filled[c][p] + (smoothed[c][p] + lineDelta[p] - filled[c][p]) * sm;
        const out = base + keep * texKeep + excess * (1 - sm);
        const d = Math.max(-o, Math.min(255 - o, out - o));
        if (d >= 0) add[i + c] = Math.round(d);
        else
          mul[i + c] = Math.round(255 * Math.max(0, (o + d) / Math.max(o, 8)));
      }
    }
  return { add, mul };
}
