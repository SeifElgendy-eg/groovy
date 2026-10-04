// Botox on several processor cores. The stages of linesCompute (lines.ts) that do not depend on
// each other run at the same time, each on a helper worker, and the four areas run side by side
// at the end. Same stage functions, same inputs: the result is the same to the last bit as the
// one-core linesCompute. The big arrays travel as SharedArrayBuffers, so no helper copies them
// (that needs a cross-origin isolated page; without one, the caller uses linesCompute).
import {
  AREAS,
  linesBase,
  linesFinish,
  stageArea,
  stageBands,
  stageHair,
  stageHeal,
  stageLines,
  stageSkin,
  stageSpots,
  stageValley,
  type LinesJob,
  type LinesResult,
} from "./lines";

export const STAGES = {
  lines: stageLines,
  valley: stageValley,
  bands: stageBands,
  skin: stageSkin,
  spots: stageSpots,
  hair: stageHair,
  heal: stageHeal,
  area: stageArea,
};
export type StageName = keyof typeof STAGES;
export type RunStage = <K extends StageName>(
  name: K,
  args: Parameters<(typeof STAGES)[K]>[0],
) => Promise<ReturnType<(typeof STAGES)[K]>>;

type Typed = Float32Array | Uint8Array | Uint8ClampedArray | Int32Array | Float64Array;
const isTyped = (v: unknown): v is Typed => ArrayBuffer.isView(v) && !(v instanceof DataView);

/**
 * The same values with every typed array (also inside plain objects and arrays) in shared memory,
 * so it can be handed to other workers without a copy. Arrays already shared stay as they are.
 */
export function share<T>(value: T): T {
  if (typeof SharedArrayBuffer === "undefined") return value;
  if (isTyped(value)) {
    if (value.buffer instanceof SharedArrayBuffer) return value;
    const Ctor = value.constructor as new (b: SharedArrayBuffer) => Typed;
    const out = new Ctor(new SharedArrayBuffer(value.byteLength));
    out.set(value as never);
    return out as T;
  }
  if (Array.isArray(value)) return value.map(share) as T;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = share(v);
    return out as T;
  }
  return value;
}

export async function linesComputeParallel(j: LinesJob, run: RunStage): Promise<LinesResult> {
  const b = share(linesBase(j));
  const linesP = run("lines", b),
    bandsP = run("bands", b),
    skinP = run("skin", b);
  const L = await linesP;
  const spotsP = run("spots", { ...b, spots: L.spots, strength: L.strength, fineRef: L.fineRef }),
    hairP = run("hair", { ...b, widthOf: L.widthOf, strength: L.strength }),
    valleyP = run("valley", { ...b, smooth0: L.smooth0, level: L.level, widthOf: L.widthOf });
  const [B, P, H] = await Promise.all([bandsP, spotsP, hairP]);
  const E = await run("heal", {
    ...b,
    strength: L.strength,
    lineShaped: B.lineShaped,
    spotNear: P.spotNear,
    spotRef: P.spotRef,
    strayNear: H.strayNear,
    fineBand: B.fineBand,
    lowBand: B.lowBand,
  });
  const [S, V] = await Promise.all([skinP, valleyP]);
  const all = { ...b, ...L, ...V, ...B, ...P, ...H, ...E, areaWeight: S.areaWeight };
  const areas = await Promise.all(AREAS.map((id) => run("area", { ...all, id })));
  return linesFinish(b, S, areas);
}
