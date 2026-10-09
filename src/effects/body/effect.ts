// Body slimming (weight-loss preview) on a photo: BodyPix + the movement fields are worked out once
// per photo in a worker; the sliders then only re-weight three fields on the GPU (instant).
import { wrap, type Remote } from "comlink";
import { BODYPIX_LONG_SIDE, inputSide, personBox } from "./bodypix";
import { FULL } from "./field";
import { checkPosture, legsVisible, type PostureResult } from "./posture";
import { backdropGain, MAX_MISMATCH, personCover } from "./backdrop";
import { BodyWarp, type Strengths } from "./warp";
import type { BodyResult, BodyWorkerApi } from "./worker";

/** Longest side of the image for the live posture check (body points only: small and quick). */
const POSE_LONG_SIDE = 384;

/**
 * Longest side of the person's box in the movement fields (they are smooth; the GPU applies them to
 * the full photo), and a cap on the fields' size (pixels), for a wide frame with a small person.
 */
const FIELD_LONG_SIDE = 800;
const FIELD_MAX_PIXELS = 650_000;

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
  /** The empty backdrop of the booth (camera frame size), set by the app; null: none captured. */
  plate: HTMLCanvasElement | null = null;
  /** The backdrop for the last photo: used, not matching the photo, or not available. */
  backdropState: "used" | "mismatch" | "none" = "none";
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
    this.backdropState = "none";
    this.warp.clear();
    try {
      const { width: w, height: h } = frame;
      // BodyPix and the fields work on the person, not the whole frame: a small person in a wide
      // (landscape) frame would otherwise get too few pixels for the arms and hands. The box around
      // the person (from the segmenter's mask) is what BodyPix sees, and the fields are as detailed
      // as the person's size needs (up to FIELD_LONG_SIDE for the box, and a cap on the whole).
      const pb = personBox(person.data, person.w, person.h, 0.08);
      const bx = pb ? (pb.x * w) / person.w : 0, by = pb ? (pb.y * h) / person.h : 0;
      const bw = pb ? (pb.w * w) / person.w : w, bh = pb ? (pb.h * h) / person.h : h;
      const k = BODYPIX_LONG_SIDE / Math.max(bw, bh);
      const W = inputSide(Math.round(bw * k)), H = inputSide(Math.round(bh * k));
      const c = document.createElement("canvas");
      c.width = W;
      c.height = H;
      const cx = c.getContext("2d", { willReadFrequently: true })!;
      cx.drawImage(frame, bx, by, bw, bh, 0, 0, W, H);
      const input = cx.getImageData(0, 0, W, H).data;
      const f = Math.min(1, FIELD_LONG_SIDE / Math.max(bw, bh), Math.sqrt(FIELD_MAX_PIXELS / (w * h)));
      const ww = Math.max(16, Math.round(w * f)), wh = Math.max(16, Math.round(h * f));
      const crop = { x: (bx * ww) / w, y: (by * wh) / h, w: (bw * ww) / w, h: (bh * wh) / h };
      const fc = document.createElement("canvas");
      fc.width = ww;
      fc.height = wh;
      const fcx = fc.getContext("2d", { willReadFrequently: true })!;
      fcx.drawImage(frame, 0, 0, ww, wh);
      const rgba = fcx.getImageData(0, 0, ww, wh).data;
      const api = this.start();
      const cancelled = new Promise<never>((_, reject) => (this.stop = reject));
      const r = await Promise.race([
        api.analyse({ base: document.baseURI, input, W, H, ww, wh, person: Float32Array.from(person.data), pw: person.w, ph: person.h, crop, rgba }),
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
      // the backdrop's cover from the mask with the arms filled in (an arm the segmenter missed
      // would be painted over with the wall)
      this.backdropState = this.useBackdrop(frame, { data: r.person, w: ww, h: wh });
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

  /**
   * Use the empty backdrop for this photo if it is the same scene: same size, and the background
   * around the person matches it once its colours are corrected.
   */
  private useBackdrop(frame: HTMLCanvasElement, person: PersonMask): "used" | "mismatch" | "none" {
    const plate = this.plate;
    if (!plate || plate.width !== frame.width || plate.height !== frame.height) return "none";
    const long = Math.max(person.w, person.h);
    const mask = { data: person.data, w: person.w, h: person.h };
    const cover = personCover(mask, 0.003 * long, 0.002 * long);
    // a margin for edges the mask misses; narrow, as background in it moves with the body
    const keep = personCover(mask, 0.007 * long, 0.003 * long);
    // colour gain and the match, on small copies, away from the person (and its shadow)
    const k = Math.min(1, 192 / Math.max(frame.width, frame.height));
    const w = Math.max(8, Math.round(frame.width * k)), h = Math.max(8, Math.round(frame.height * k));
    const small = (src: HTMLCanvasElement) => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const cx = c.getContext("2d", { willReadFrequently: true })!;
      cx.drawImage(src, 0, 0, w, h);
      return cx.getImageData(0, 0, w, h).data;
    };
    const far = personCover(mask, 0.04 * long, 0);
    const away = new Float32Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        away[y * w + x] = far.data[Math.min(far.h - 1, Math.floor(((y + 0.5) * far.h) / h)) * far.w + Math.min(far.w - 1, Math.floor(((x + 0.5) * far.w) / w))];
    const gain = backdropGain(small(frame), small(plate), w, h, away);
    if (gain.mismatch > MAX_MISMATCH) {
      this.warp.setBackdrop(null);
      return "mismatch";
    }
    this.warp.setBackdrop({ plate, cover, keep, gain });
    return "used";
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
