import { describe, expect, it } from "vitest";
import { acneStatus, backdropButton, backdropStatus, bodyFindingStep, bodyStatus, wrinklesStatus } from "../../src/app/statusMessages";

describe("status messages", () => {
  it("face services ask for a face, then point to Before / After", () => {
    expect(wrinklesStatus({ modelReady: false, faceFound: false })).toBe("Loading face model…");
    expect(wrinklesStatus({ modelReady: true, faceFound: false })).toBe("Face forward or choose a clear photo");
    expect(wrinklesStatus({ modelReady: true, faceFound: true })).toMatch(/Before and After/);
    expect(acneStatus({ modelReady: true, faceFound: false })).toBe("Face forward to preview the effect");
    expect(acneStatus({ modelReady: true, faceFound: true })).toMatch(/blemishes/);
  });

  it("body shaping says what to do at each stage", () => {
    expect(bodyStatus({ stage: "camera", handsFree: true })).toMatch(/takes itself/);
    expect(bodyStatus({ stage: "camera", handsFree: false })).toMatch(/press Take photo/);
    expect(bodyStatus({ stage: "finding", modelReady: false })).toBe("Loading models…");
    expect(bodyStatus({ stage: "no-effect" })).toMatch(/Weight loss slider/);
    expect(bodyStatus({ stage: "failed" })).toMatch(/No full body/);
    expect(bodyFindingStep(true)).toBe("Finding the person in the photo");
  });

  it("a good result has nothing to say; problems are listed together", () => {
    expect(bodyStatus({ stage: "ready", legsInView: true, backdropMismatch: false, postureTip: null })).toBe("");
    const all = bodyStatus({ stage: "ready", legsInView: false, backdropMismatch: true, postureTip: "Arms a little further out." });
    expect(all).toMatch(/legs are left/);
    expect(all).toMatch(/Booth setup/);
    expect(all).toMatch(/next time: Arms a little further out\./);
  });

  it("the backdrop line and button follow its state", () => {
    expect(backdropStatus(false, null)).toMatch(/^Not captured yet/);
    expect(backdropStatus(true, null)).toMatch(/^Captured\. /);
    expect(backdropButton(true, true)).toBe("Cancel");
    expect(backdropButton(false, true)).toBe("Capture again");
    expect(backdropButton(false, false)).toBe("Capture backdrop");
  });
});
