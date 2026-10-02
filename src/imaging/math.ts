export const clamp = (v: number, lo = 0, hi = 1): number => Math.max(lo, Math.min(hi, v));
/** Smoothstep. */
export const smooth = (t: number): number => t * t * (3 - 2 * t);
