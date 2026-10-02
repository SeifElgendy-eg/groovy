const BIG = 1e6;

/**
 * Chamfer (4-neighbour) distance from every pixel to the nearest non-skin pixel.
 * A pixel is "inside" when its alpha >= minAlpha; the image border counts as outside.
 */
export function distanceToOutside(
  mask: Uint8ClampedArray,
  width: number,
  height: number,
  minAlpha: number,
): Float32Array {
  const dist = new Float32Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      dist[p] =
        mask[p * 4 + 3] >= minAlpha && x && y && x < width - 1 && y < height - 1
          ? BIG
          : 0;
      if (x) dist[p] = Math.min(dist[p], dist[p - 1] + 1);
      if (y) dist[p] = Math.min(dist[p], dist[p - width] + 1);
    }
  for (let y = height - 1; y >= 0; y--)
    for (let x = width - 1; x >= 0; x--) {
      const p = y * width + x;
      if (x < width - 1) dist[p] = Math.min(dist[p], dist[p + 1] + 1);
      if (y < height - 1) dist[p] = Math.min(dist[p], dist[p + width] + 1);
    }
  return dist;
}

/**
 * Inset the segmentation mask, then feather inward: hair, face silhouette, eyes and mouth
 * must never contribute to a repair or receive one. Returns a white RGBA mask.
 */
export function insetSkinMask(
  mask: Uint8ClampedArray,
  width: number,
  height: number,
  margin: number,
  feather: number = Math.max(2, margin * 0.4),
): Uint8ClampedArray<ArrayBuffer> {
  const distance = distanceToOutside(mask, width, height, 246);
  const out = new Uint8ClampedArray(mask.length);
  for (let p = 0; p < width * height; p++) {
    out[p * 4] = out[p * 4 + 1] = out[p * 4 + 2] = 255;
    const t = Math.max(0, Math.min(1, (distance[p] - margin) / feather));
    out[p * 4 + 3] = 255 * t * t * (3 - 2 * t);
  }
  return out;
}
