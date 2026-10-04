// Web Worker for body slimming: runs BodyPix (onnxruntime-web, WebAssembly) and works out the
// movement fields, so the page stays responsive.
import { expose, transfer } from "comlink";
import * as ort from "onnxruntime-web/wasm";
import { decodeJoints, decodeParts, resizeMask, toInput, type Grid } from "./bodypix";
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
}

export interface BodyResult extends BodyFields {
  /** Body points at the working resolution (x, y, score per joint), for the debug view. */
  joints: Float32Array;
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
  async analyse(job: BodyJob): Promise<BodyResult> {
    const s = await load(job.base);
    const t0 = performance.now();
    const feeds = { input: new ort.Tensor("float32", toInput(job.input, job.W, job.H), [1, job.H, job.W, 3]) };
    const out = await s.run(feeds, ["heatmaps", "short_offsets", "part_heatmaps"]);
    const heat = out.heatmaps, offs = out.short_offsets, parts = out.part_heatmaps;
    const g: Grid = { gw: heat.dims[2], gh: heat.dims[1], W: job.W, H: job.H };
    const t1 = performance.now();
    const person = resizeMask(job.person, job.pw, job.ph, job.ww, job.wh);
    const joints = decodeJoints(heat.data as Float32Array, offs.data as Float32Array, g, job.ww, job.wh);
    const labels = decodeParts(parts.data as Float32Array, g, job.ww, job.wh, person);
    for (const t of Object.values(out)) t.dispose();
    const f = bodyFields({ w: job.ww, h: job.wh, person, labels, joints });
    const r: BodyResult = { ...f, joints, ms: { model: t1 - t0, fields: performance.now() - t1 } };
    return transfer(r, [r.arms.buffer, r.torso.buffer, r.legs.buffer]);
  },
};

export type BodyWorkerApi = typeof api;
expose(api);
