// Botox on several cores must give exactly what it gives on one: same stages, same inputs.
import { describe, expect, it } from "vitest";
import { linesCompute, type Zone } from "../../src/effects/wrinkles/lines";
import { linesComputeParallel, share, STAGES, type RunStage } from "../../src/effects/wrinkles/parallel";

const W = 240,
  H = 200;
function job() {
  const px = new Uint8ClampedArray(W * H * 4);
  let seed = 9;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 6;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let v = rnd();
      for (const ly of [40, 60, 80]) if (x > 30 && x < 200) v -= 22 * Math.exp(-(((y - ly - 4 * Math.sin(x / 20)) / 1.8) ** 2));
      if (y > 100 && y < 150) v -= 20 * Math.exp(-(((x - 120) / 1.6) ** 2));
      v -= 28 * Math.exp(-((x - 60) ** 2 + (y - 160) ** 2) / 18);
      px.set([200 + v, 158 + v, 138 + v, 255], (y * W + x) * 4);
    }
  const mask = new Uint8ClampedArray(px.length).fill(255);
  const zones: Zone[] = [
    { id: "forehead", cx: 120, cy: 60, rx: 110, ry: 50, angle: 0, lineAngle: 0 },
    { id: "frown", cx: 120, cy: 125, rx: 30, ry: 35, angle: 0, lineAngle: Math.PI / 2 },
    { id: "crows", cx: 210, cy: 150, rx: 40, ry: 40, angle: 0, from: { x: 180, y: 150 }, tolerance: [35, 65], fine: true },
    { id: "undereye", cx: 70, cy: 165, rx: 45, ry: 20, angle: 0, anyDirection: true, fine: true },
  ];
  return { pixels: px, mask, width: W, height: H, faceWidth: 240, zones };
}

describe("botox on several cores", () => {
  it("gives the same layers as on one, bit for bit", async () => {
    const one = linesCompute(job());
    // Each stage on its own copy of its inputs, as a helper worker gets them.
    const run: RunStage = async (name, args) => share((STAGES[name] as (a: unknown) => never)(structuredClone(args)));
    const many = await linesComputeParallel(job(), run);
    for (const id of Object.keys(one) as (keyof typeof one)[]) {
      expect(Buffer.from(many[id].mul).equals(Buffer.from(one[id].mul))).toBe(true);
      expect(Buffer.from(many[id].add).equals(Buffer.from(one[id].add))).toBe(true);
    }
  });
});
