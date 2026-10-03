// Treatment-duration presets for the acne service: what each "month" button sets every acne
// slider to (0-100). Active breakouts clear first; redness fades over the following weeks; pores
// and especially scars change slowly and only partly (atrophic scars mostly need procedures).
// Illustrative only: these are the simulation's settings, not clinical predictions.

export interface AcnePlan {
  /** Active spots ("Treatment intensity"). */
  spots: number;
  redness: number;
  pores: number;
  scars: number;
}

/** Keyed by the button's data-acne-preset value. */
export const ACNE_PRESETS: Record<string, AcnePlan> = {
  "0": { spots: 0, redness: 0, pores: 0, scars: 0 },
  "50": { spots: 50, redness: 35, pores: 20, scars: 15 },
  "80": { spots: 80, redness: 60, pores: 35, scars: 30 },
  "100": { spots: 100, redness: 80, pores: 50, scars: 45 },
};

/** The preset whose plan matches these slider values exactly, if any. */
export function matchAcnePreset(v: AcnePlan): string | undefined {
  return Object.keys(ACNE_PRESETS).find((k) => {
    const p = ACNE_PRESETS[k];
    return p.spots === v.spots && p.redness === v.redness && p.pores === v.pores && p.scars === v.scars;
  });
}
