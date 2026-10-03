import { describe, expect, it } from "vitest";
import { ACNE_PRESETS, matchAcnePreset } from "../../src/effects/acne/presets";

describe("acne month presets", () => {
  const months = ["50", "80", "100"].map((k) => ACNE_PRESETS[k]);

  it("every treatment gets stronger month by month", () => {
    for (const key of ["spots", "redness", "pores", "scars"] as const)
      for (let m = 1; m < months.length; m++) expect(months[m][key]).toBeGreaterThan(months[m - 1][key]);
  });

  it("spots clear fastest and scars slowest", () => {
    for (const m of months) {
      expect(m.spots).toBeGreaterThanOrEqual(m.redness);
      expect(m.redness).toBeGreaterThanOrEqual(m.pores);
      expect(m.pores).toBeGreaterThanOrEqual(m.scars);
    }
  });

  it("matches a preset only when every slider agrees", () => {
    expect(matchAcnePreset({ ...ACNE_PRESETS["80"] })).toBe("80");
    expect(matchAcnePreset({ ...ACNE_PRESETS["80"], scars: 31 })).toBeUndefined();
    expect(matchAcnePreset({ spots: 0, redness: 0, pores: 0, scars: 0 })).toBe("0");
  });
});
