// Web Worker for body slimming: runs BodyPix (onnxruntime-web, WebAssembly) and works out the
// movement fields, so the page stays responsive.
import { expose, transfer } from "comlink";
import * as ort from "onnxruntime-web/wasm";
import { addArms, decodeJoints, decodeParts, decodeSegments, resizeMask, toInput, type Crop, type Grid } from "./bodypix";
import { bodyFields, type BodyFields } from "./field";
import { fromMediaPipe, fuseJoints } from "./joints";

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
  /** Also return the fields' inputs (debug and regression tools: scripts/body/). */
  debug?: boolean;
}

/** What the movement fields were computed from (with `debug`): enough to recompute them offline. */
export interface BodyInputs {
  person: Float32Array;
  labels: Uint8Array;
  /** The body points the fields used (BodyPix's, with MediaPipe's limbs where they fit). */
  joints: Float32Array;
  rgb: Uint8ClampedArray;
  /** BodyPix's and MediaPipe's own points (MediaPipe's: empty when it found none). */
  bodypix: Float32Array;
  mediapipe: Float32Array;
}

export interface BodyResult extends BodyFields {
  /** Body points at the working resolution (x, y, score per joint), for the debug view. */
  joints: Float32Array;
  /** The person mask at the working resolution, with the arms the segmenter missed filled in. */
  person: Float32Array;
  ms: { model: number; fields: number };
  /** Per limb (R arm, L arm, R leg, L leg, hips): whose points were used ("mp", "bp", "-"). */
  limbs: string[];
  inputs?: BodyInputs;
}

/** A photo between analyse() and fields(): BodyPix's output, waiting for MediaPipe's points. */
interface Pending {
  job: BodyJob;
  person: Float32Array;
  labels: Uint8Array;
  joints: Float32Array;
  rgb: Uint8ClampedArray;
  model: number;
}
let pending: Pending | null = null;

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
  /** BodyPix on the photo; then fields() (with MediaPipe's points, found meanwhile on the page). */
  async analyse(job: BodyJob): Promise<void> {
    pending = null;
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
    // the body parts, decoded once for both masks (BodyPix's and the app's, which only grows inside
    // BodyPix's), then kept where each mask has the person
    const n = job.ww * job.wh;
    const either = new Float32Array(n);
    for (let i = 0; i < n; i++) either[i] = Math.max(person[i], bp[i]);
    const parts0 = decodeParts(parts.data as Float32Array, g, job.ww, job.wh, either, job.crop);
    const within = (mask: Float32Array) => parts0.map((p, i) => (mask[i] > 0.3 ? p : 255));
    addArms(person, bp, within(bp));
    const labels = within(person);
    for (const t of Object.values(out)) t.dispose();
    const rgb = new Uint8ClampedArray(n * 3);
    for (let i = 0, j = 0; i < n; i++, j += 3) {
      rgb[j] = job.rgba[i * 4];
      rgb[j + 1] = job.rgba[i * 4 + 1];
      rgb[j + 2] = job.rgba[i * 4 + 2];
    }
    pending = { job, person, labels, joints, rgb, model: t1 - t0 };
  },
  /**
   * The movement fields of the analysed photo. `landmarks`: MediaPipe Pose's for the photo
   * ([x, y, visibility] x 33, 0..1), or null: each limb takes MediaPipe's points where they lie on
   * the right body parts, else BodyPix's (joints.ts).
   */
  async fields(landmarks: number[][] | null): Promise<BodyResult> {
    if (!pending) throw new Error("no photo analysed");
    const { job, person, labels, rgb, model, joints: bodypix } = pending;
    pending = null;
    const w = job.ww, h = job.wh;
    const mp = landmarks && landmarks.length >= 33 ? fromMediaPipe(landmarks, w, h) : null;
    const fused = mp ? fuseJoints({ w, h, person, labels, bodypix, mediapipe: mp }) : null;
    const joints = fused ? fused.joints : bodypix;
    const inputs = job.debug
      ? { person: person.slice(), labels: labels.slice(), joints: joints.slice(), rgb: rgb.slice(), bodypix: bodypix.slice(), mediapipe: mp ?? new Float32Array(0) }
      : undefined;
    const t2 = performance.now();
    const f = bodyFields({ w, h, person, labels, joints, rgb });
    const r: BodyResult = { ...f, joints, person, inputs, limbs: fused?.chosen ?? [], ms: { model, fields: performance.now() - t2 } };
    return transfer(r, [r.arms.buffer, r.torso.buffer, r.legs.buffer, r.person.buffer, r.labels.buffer]);
  },
};

export type BodyWorkerApi = typeof api;
expose(api);
