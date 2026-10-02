import { describe, expect, it } from "vitest";
import { describeCameraError } from "../../src/io/camera";

describe("describeCameraError", () => {
  it("explains the common failures in plain language", () => {
    expect(describeCameraError({ name: "NotAllowedError" })).toBe(
      "Allow camera access in your browser settings.",
    );
    expect(describeCameraError({ name: "NotFoundError" })).toBe(
      "No camera found. Connect a camera and try again.",
    );
    expect(describeCameraError({ name: "NotReadableError" })).toBe(
      "Camera is busy. Close other camera apps and try again.",
    );
  });

  it("falls back to the error message, then a generic one", () => {
    expect(describeCameraError(new Error("Camera requires HTTPS or localhost."))).toBe(
      "Camera requires HTTPS or localhost.",
    );
    expect(describeCameraError({})).toBe("Unable to start camera.");
  });
});
