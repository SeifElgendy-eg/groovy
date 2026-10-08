// Body slimming (weight-loss preview) on a photo: BodyPix + the movement fields are worked out once
// per photo in a worker; the sliders then only re-weight three fields on the GPU (instant).
import { wrap, type Remote } from "comlink";
import { BODYPIX_LONG_SIDE, inputSide } from "./bodypix";
import { FULL } from "./field";
import { checkPosture, legsVisible, type PostureResult } from "./posture";
import { BodyWarp, type Strengths } from "./warp";
import type { BodyResult, BodyWorkerApi } from "./worker";

/** Longest side of the image for the live posture check (body points only: small and quick). */
const POSE_LONG_SIDE = 384;

/** Longest side of the movement fields (they are smooth; the GPU applies them to the full photo). */
const FIELD_LONG_SIDE = 800;

/** The person mask from the app's segmenter (0..1, its own resolution). */
export interface PersonMask {
  data: Float32Array;
  w: number;
  h: number;
}

/** Slider values, 0..1: overall weight loss and how much of it each area gets. */
export interface BodySettings {
  overall: number;
  arms: number;
  waist: number;
  legs: number;
}

export class BodyEffect {
  dirty = true;
  busy = false;
  ready = false;
  /** The last analysis failed (no person found, model error): shown as a status. */
  failed = false;
  /** Timings of the last analysis (diagnostics). */
  lastMs: { model: number; fields: number } | null = null;
  /** The legs are clearly in the photo (knees and ankles): otherwise they are left as they are. */
  legs = true;
  /** How the person stands in the analysed photo (advice only: the slimming runs anyway). */
  posture: PostureResult | null = null;
  private posing = false;
  private poseCanvas: HTMLCanvasElement | null = null;
  private result: BodyResult | null = null;
  private worker: Worker | null = null;
  private api: Remote<BodyWorkerApi> | null = null;
  private stop: ((e: Error) => void) | null = null;
  private readonly warp = new BodyWarp();

  private start(): Remote<BodyWorkerApi> {
    if (!this.api) {
      this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "body" });
      this.api = wrap<BodyWorkerApi>(this.worker);
    }
    return this.api;
  }

  /** Load the model in the background (first photo then does not wait for it). */
  warmUp(): void {
    void this.start()
      .warmUp(document.baseURI)
      .catch((err) => console.warn("body model failed to load", err));
  }

  /** Stop a running analysis (its photo was replaced). The next one starts a fresh worker. */
  cancel(): void {
    if (!this.busy) return;
    this.worker?.terminate();
    this.worker = null;
    this.api = null;
    this.stop?.(new Error("cancelled"));
  }

  /**
   * Body points of a live frame (`source`, w x h) for the posture check, in that frame's pixels.
   * Null while a photo is being analysed or the last check is still running.
   */
  async pose(source: CanvasImageSource, w: number, h: number): Promise<Float32Array | null> {
    if (this.busy || this.posing || !w || !h) return null;
    this.posing = true;
    try {
      const k = Math.min(1, POSE_LONG_SIDE / Math.max(w, h));
      const W = inputSide(Math.round(w * k)), H = inputSide(Math.round(h * k));
      const c = (this.poseCanvas ??= document.createElement("canvas"));
      c.width = W;
      c.height = H;
      const cx = c.getContext("2d", { willReadFrequently: true })!;
      cx.drawImage(source, 0, 0, W, H);
      const J = await this.start().pose(document.baseURI, cx.getImageData(0, 0, W, H).data, W, H);
      for (let i = 0; i < J.length; i += 3) {
        J[i] *= w / W;
        J[i + 1] *= h / H;
      }
      return J;
    } catch (err) {
      console.warn("posture check failed", err);
      return null;
    } finally {
      this.posing = false;
    }
  }

  /** Analyse the photo (`frame`, photo size) with its person mask. Resolves true when ready. */
  async prepare(frame: HTMLCanvasElement, person: PersonMask): Promise<boolean> {
    this.dirty = false;
    this.busy = true;
    this.ready = false;
    this.failed = false;
    this.result = null;
    this.posture = null;
    this.legs = true;
    this.warp.clear();
    try {
      const { width: w, height: h } = frame;
      const k = BODYPIX_LONG_SIDE / Math.max(w, h);
      const W = inputSide(Math.round(w * k)), H = inputSide(Math.round(h * k));
      const c = document.createElement("canvas");
      c.width = W;
      c.height = H;
      const cx = c.getContext("2d", { willReadFrequently: true })!;
      cx.drawImage(frame, 0, 0, W, H);
      const input = cx.getImageData(0, 0, W, H).data;
      const f = Math.min(1, FIELD_LONG_SIDE / Math.max(w, h));
      const ww = Math.max(16, Math.round(w * f)), wh = Math.max(16, Math.round(h * f));
      const api = this.start();
      const cancelled = new Promise<never>((_, reject) => (this.stop = reject));
      const r = await Promise.race([
        api.analyse({ base: document.baseURI, input, W, H, ww, wh, person: Float32Array.from(person.data), pw: person.w, ph: person.h }),
        cancelled,
      ]);
      this.lastMs = r.ms;
      // No body found (BodyPix's shoulders unsure or on top of each other): nothing to slim.
      const conf = Math.min(r.joints[2 * 3 + 2], r.joints[5 * 3 + 2]);
      const sw = Math.hypot(r.joints[2 * 3] - r.joints[5 * 3], r.joints[2 * 3 + 1] - r.joints[5 * 3 + 1]);
      if (conf < 0.3 || sw < 0.03 * Math.max(ww, wh)) {
        this.failed = true;
        return false;
      }
      this.result = r;
      this.legs = legsVisible(r.joints, ww, wh);
      this.posture = checkPosture(r.joints, ww, wh, false);
      this.warp.set(frame, r);
      this.ready = true;
      return true;
    } catch (err) {
      if ((err as Error).message !== "cancelled") {
        console.error("body analysis failed", err);
        this.failed = true;
      }
      return false;
    } finally {
      this.busy = false;
      this.stop = null;
    }
  }

  /** Strengths for the warp from the sliders (and the person's build). */
  strengths(s: BodySettings): Strengths {
    const k = this.result?.build ?? 1;
    return {
      arms: FULL.arms * k * s.overall * s.arms,
      torso: FULL.torso * k * s.overall * s.waist,
      legs: this.legs ? FULL.legs * k * s.overall * s.legs : 0,
    };
  }

  /** Draw the slimmed photo over the whole stage. */
  draw(ctx: CanvasRenderingContext2D, w: number, h: number, s: BodySettings): void {
    if (!this.ready) return;
    const out = this.warp.render(this.strengths(s));
    if (out) ctx.drawImage(out, 0, 0, w, h);
  }
}
