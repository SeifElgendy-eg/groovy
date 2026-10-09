// Web Worker for body slimming: runs BodyPix (onnxruntime-web, WebAssembly) and works out the
// movement fields, so the page stays responsive.
import { expose, transfer } from "comlink";
import * as ort from "onnxruntime-web/wasm";
import { addArms, decodeJoints, decodeParts, decodeSegments, resizeMask, toInput, type Crop, type Grid } from "./bodypix";
import { bodyFields, type BodyFields } from "./field";

export interface BodyJob {
  /** The page's base URL (models/ and vendor/ live under it). */
  base: string;
  /** Model input: RGBA pixels at W x H (16k + 1 sides). */
  input: Uint8ClampedArray;
  W: number;
  H: number;
  /** Working resolution of the fields (the photo's aspect). */
  ww: number;
  wh: number;
  /** Person mask (0..1) at its own resolution. */
  person: Float32Array;
  pw: number;
  ph: number;
  /** Where the model input sits in the working-resolution image (around the person). */
  crop: Crop;
  /** The photo's colours at the working resolution (RGBA). */
  rgba: Uint8ClampedArray;
}

export interface BodyResult extends BodyFields {
  /** Body points at the working resolution (x, y, score per joint), for the debug view. */
  joints: Float32Array;
  /** The person mask at the working resolution, with the arms the segmenter missed filled in. */
  person: Float32Array;
  ms: { model: number; fields: number };
}

const MODEL = "models/bodypix-mobilenet-v1-100-s8.onnx";
let session: Promise<ort.InferenceSession> | null = null;

function load(base: string): Promise<ort.InferenceSession> {
  if (!session) {
    ort.env.logLevel = "error";
    // Threads need a cross-origin isolated page (the app sets the headers); one thread otherwise.
    const cores = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated ? navigator.hardwareConcurrency || 1 : 1;
    ort.env.wasm.numThreads = Math.max(1, Math.min(4, cores - 1));
    session = ort.InferenceSession.create(new URL(MODEL, base).href, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });
    session.catch(() => (session = null));
  }
  return session;
}

const api = {
  /** Load the model ahead of the first photo. */
  async warmUp(base: string): Promise<void> {
    await load(base);
  },
  /**
   * Body points only (the live posture check): RGBA pixels at W x H (16k + 1 sides) -> 18 x
   * [x, y, score] in those pixels.
   */
  async pose(base: string, input: Uint8ClampedArray, W: number, H: number): Promise<Float32Array> {
    const s = await load(base);
    const feeds = { input: new ort.Tensor("float32", toInput(input, W, H), [1, H, W, 3]) };
    const out = await s.run(feeds, ["heatmaps", "short_offsets"]);
    const heat = out.heatmaps;
    const g: Grid = { gw: heat.dims[2], gh: heat.dims[1], W, H };
    const joints = decodeJoints(heat.data as Float32Array, out.short_offsets.data as Float32Array, g, W, H);
    for (const t of Object.values(out)) t.dispose();
    return transfer(joints, [joints.buffer]);
  },
  async analyse(job: BodyJob): Promise<BodyResult> {
    const s = await load(job.base);
    const t0 = performance.now();
    const feeds = { input: new ort.Tensor("float32", toInput(job.input, job.W, job.H), [1, job.H, job.W, 3]) };
    const out = await s.run(feeds, ["heatmaps", "short_offsets", "part_heatmaps", "segments"]);
    const heat = out.heatmaps, offs = out.short_offsets, parts = out.part_heatmaps;
    const g: Grid = { gw: heat.dims[2], gh: heat.dims[1], W: job.W, H: job.H };
    const t1 = performance.now();
    const person = resizeMask(job.person, job.pw, job.ph, job.ww, job.wh);
    const joints = decodeJoints(heat.data as Float32Array, offs.data as Float32Array, g, job.ww, job.wh, job.crop);
    // arms and hands the segmenter missed (see addArms)
    const bp = decodeSegments(out.segments.data as Float32Array, g, job.ww, job.wh, job.crop);
    addArms(person, bp, decodeParts(parts.data as Float32Array, g, job.ww, job.wh, bp, job.crop));
    const labels = decodeParts(parts.data as Float32Array, g, job.ww, job.wh, person, job.crop);
    for (const t of Object.values(out)) t.dispose();
    const rgb = new Uint8ClampedArray(job.ww * job.wh * 3);
    for (let i = 0; i < job.ww * job.wh; i++) rgb.set(job.rgba.subarray(i * 4, i * 4 + 3), i * 3);
    const f = bodyFields({ w: job.ww, h: job.wh, person, labels, joints, rgb });
    const r: BodyResult = { ...f, joints, person, ms: { model: t1 - t0, fields: performance.now() - t1 } };
    return transfer(r, [r.arms.buffer, r.torso.buffer, r.legs.buffer, r.person.buffer, r.labels.buffer]);
  },
};

export type BodyWorkerApi = typeof api;
expose(api);
