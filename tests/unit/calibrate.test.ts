import { describe, expect, it } from "vitest";
import { calibrate, type CalibrationIO } from "../../src/face/calibrate";
import type { FaceMeter } from "../../src/face/exposure";

/**
 * A simulated webcam: picture brightness follows the sensor (linear in exposure x gain) through
 * the sRGB curve and clips at 255. `lag` = how many measurements still show the old value.
 */
function camera(opts: { gain: number; ignore?: boolean; lag?: number; start?: number }) {
  let applied = opts.start ?? 100;
  let pending: number[] = [];
  const sets: number[] = [];
  const faceAt = (x: number): FaceMeter => {
    const linear = Math.min(1, (x * opts.gain) / 1000);
    const mean = 255 * Math.pow(linear, 1 / 2.2);
    return { mean: Math.min(255, mean), clipped: linear >= 1 ? 0.9 : mean > 235 ? 0.2 : 0, crushed: mean < 12 ? 0.9 : 0 };
  };
  const io: CalibrationIO = {
    async set(v) {
      sets.push(v);
      if (opts.ignore) return;
      pending = Array(opts.lag ?? 0).fill(applied);
      applied = v;
    },
    async measure() {
      const shown = pending.length ? pending.shift()! : applied;
      return faceAt(shown);
    },
  };
  return { io, sets, faceAt };
}

const range = { min: 1, max: 5000, step: 1 };

describe("calibrate (exposure time)", () => {
  it("brings a blown-out face to the target in a few steps", async () => {
    const cam = camera({ gain: 20, start: 2500 }); // x=2500 -> fully clipped
    const r = await calibrate(cam.io, 2500, range, "multiplicative");
    expect(r.ok).toBe(true);
    expect(r.steps).toBeLessThanOrEqual(5);
    expect(Math.abs(r.meter!.mean - 120)).toBeLessThan(13);
  });

  it("brings a black face up", async () => {
    const cam = camera({ gain: 0.5, start: 20 });
    const r = await calibrate(cam.io, 20, range, "multiplicative");
    expect(r.ok).toBe(true);
    expect(r.steps).toBeLessThanOrEqual(5);
  });

  it("never jumps by more than 8x in one step (no slamming to black)", async () => {
    const cam = camera({ gain: 20, start: 2500 });
    await calibrate(cam.io, 2500, range, "multiplicative");
    for (let i = 1; i < cam.sets.length; i++)
      expect(Math.max(cam.sets[i] / cam.sets[i - 1], cam.sets[i - 1] / cam.sets[i])).toBeLessThanOrEqual(8.1);
  });

  it("reports a camera that ignores the control instead of looping", async () => {
    const cam = camera({ gain: 5, ignore: true, start: 100 }); // stuck at mean ~ 205
    const r = await calibrate(cam.io, 100, range, "multiplicative");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("ignored");
    expect(r.steps).toBeLessThanOrEqual(3);
  });

  it("reports when the light is too low even at the longest exposure", async () => {
    const cam = camera({ gain: 0.01, start: 100 });
    const r = await calibrate(cam.io, 100, range, "multiplicative");
    expect(r.ok).toBe(false);
    expect(["limit", "max-steps"]).toContain(r.reason);
    expect(r.value).toBe(5000); // best it can do
  });

  it("still converges when the camera applies values one reading late", async () => {
    const cam = camera({ gain: 20, start: 2500, lag: 1 });
    const r = await calibrate(cam.io, 2500, range, "multiplicative", undefined, 10);
    // It may need more steps, but must end on a value that really is near the target.
    expect(Math.abs(cam.faceAt(r.value).mean - 120)).toBeLessThan(25);
  });

  it("returns unreadable when nothing can be measured", async () => {
    const io: CalibrationIO = { set: async () => {}, measure: async () => null };
    const r = await calibrate(io, 100, range, "multiplicative");
    expect(r.reason).toBe("unreadable");
  });
});

describe("calibrate (brightness offset)", () => {
  it("moves an additive control toward the target", async () => {
    let b = 0;
    const io: CalibrationIO = {
      set: async (v) => void (b = v),
      measure: async () => ({ mean: Math.max(0, Math.min(255, 200 + b * 2)), clipped: 0, crushed: 0 }),
    };
    const r = await calibrate(io, 0, { min: -64, max: 64, step: 1 }, "additive");
    expect(r.ok).toBe(true);
    expect(Math.abs(200 + r.value * 2 - 120)).toBeLessThan(13);
  });
});

describe("calibrate with natural skin shine", () => {
  it("does not darken a face that is dark overall just because a few highlights are blown", async () => {
    let x = 100;
    const io: CalibrationIO = {
      set: async (v) => void (x = v),
      // Mean follows exposure; a constant 8% of pixels (glasses/forehead shine) stays blown.
      measure: async () => ({ mean: Math.min(250, 255 * Math.pow(Math.min(1, x / 1000), 1 / 2.2)), clipped: 0.08, crushed: 0 }),
    };
    const r = await calibrate(io, 100, { min: 1, max: 5000, step: 1 }, "multiplicative");
    expect(r.value).toBeGreaterThan(100); // brightened toward the target, not darkened
    expect(Math.abs(r.meter!.mean - 120)).toBeLessThan(15);
  });
});

import { frameTimeCap } from "../../src/face/exposure";

describe("frameTimeCap", () => {
  it("is the longest exposure that fits one frame, in 100 µs units", () => {
    expect(frameTimeCap({ min: 1, max: 5000, step: 1 }, 30)).toBe(333);
    expect(frameTimeCap({ min: 1, max: 5000, step: 1 }, 15)).toBe(666);
  });
  it("snaps down to the camera's step and stays in range", () => {
    expect(frameTimeCap({ min: 3, max: 2047, step: 10 }, 30)).toBe(333); // 3 + 33 steps of 10
    expect(frameTimeCap({ min: 1, max: 200, step: 1 }, 30)).toBe(200);
  });
});
