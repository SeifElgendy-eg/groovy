// Keeps the live camera well exposed for the effects: re-applies the staff's saved camera
// settings, and (optionally) runs face-metered auto exposure from the frames the pipeline sees.
import {
  readControls,
  restoreAuto,
  setControl,
  type CameraControl,
  type ControlName,
  type RangeControl,
} from "../io/cameraControls";
import { cameraInfo, type CameraInfo } from "../io/camera";
import {
  DEFAULT_TARGET,
  faceMeterBox,
  isUnusableFrame,
  meterPixels,
  type FaceMeter,
} from "../face/exposure";
import { calibrate, verdict, type CalibrationResult } from "../face/calibrate";
import { liftGamma } from "../face/exposure";
import { previewFilter } from "../io/softwareLift";
import { dom } from "../ui/dom";
import { tracked } from "./activity";
import type { NormalizedLandmark } from "../effects/skin/input";

const STORAGE_KEY = "groovy.camera.v1";

interface Saved {
  faceAuto: boolean;
  values: Partial<Record<ControlName, number | string>>;
}

function load(): Saved {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { faceAuto: false, values: {}, ...JSON.parse(raw) };
  } catch {
    /* storage unavailable */
  }
  return { faceAuto: false, values: {} };
}

function save(s: Saved): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}

type Listener = () => void;

// Metering reads a tiny downscaled copy, never the full frame: a full-frame getImageData forces
// the GPU to hand the whole picture back to the CPU, which stalls the live preview.
const METER = 48;
const meterCanvas = document.createElement("canvas");
meterCanvas.width = meterCanvas.height = METER;
const meterCtx = meterCanvas.getContext("2d", { willReadFrequently: true })!;

function readScaled(src: CanvasImageSource, sx: number, sy: number, sw: number, sh: number): Uint8ClampedArray {
  meterCtx.drawImage(src, sx, sy, sw, sh, 0, 0, METER, METER);
  return meterCtx.getImageData(0, 0, METER, METER).data;
}

class CameraTuning {
  private track: MediaStreamTrack | null = null;
  private saved = load();
  private lastMeterAt = 0;
  /** A calibration run is in progress. */
  calibrating = false;
  /** The camera is at its brightest the browser can set, so darkness is left to the software lift. */
  private atBrightest = false;
  /** Software exposure lift (gamma; 1 = none), applied to the captured photo and the preview. */
  lift = 1;
  private lastCalibratedAt = -Infinity;
  /** When the face first drifted off target (0 = on target). */
  private driftSince = 0;
  /** Calibration waits for readings taken after the camera has had time to apply a value. */
  private waiters: { after: number; frames: number; resolve: (m: FaceMeter | null) => void }[] = [];
  /** The staff panel is open (it shows the live reading). */
  panelOpen = false;
  private listeners = new Set<Listener>();
  info: CameraInfo | null = null;
  controls: CameraControl[] = [];
  meter: FaceMeter | null = null;
  /** What the auto-exposure loop last did, for the staff panel. */
  autoNote = "";

  get faceAuto(): boolean {
    return this.saved.faceAuto;
  }

  onChange(fn: Listener): void {
    this.listeners.add(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  /** A new camera stream started: report it and restore the saved settings. */
  async attach(stream: MediaStream): Promise<void> {
    this.track = stream.getVideoTracks()[0] ?? null;
    this.info = cameraInfo(stream);
    if (this.info)
      console.info(
        `camera: ${this.info.label || "unknown"} ${this.info.width}x${this.info.height}@${this.info.frameRate}`,
      );
    if (!this.track) return;
    this.controls = readControls(this.track);
    // Modes first (a manual value needs its mode), then values.
    const entries = Object.entries(this.saved.values) as [ControlName, number | string][];
    entries.sort(([, a], [, b]) => Number(typeof a === "number") - Number(typeof b === "number"));
    for (const [name, value] of entries)
      if (this.controls.some((c) => c.name === name)) await setControl(this.track, name, value);
    this.refresh();
  }

  detach(): void {
    this.clearLift();
    this.track = null;
    this.controls = [];
    this.meter = null;
    this.emit();
  }

  private refresh(): void {
    if (this.track) this.controls = readControls(this.track);
    this.emit();
  }

  /** Staff changed a control by hand. */
  async set(name: ControlName, value: number | string): Promise<void> {
    if (!this.track) return;
    await setControl(this.track, name, value);
    this.saved.values[name] = value;
    // A hand-set exposure overrides the face loop.
    if (name === "exposureTime" || name === "exposureMode") this.saved.faceAuto = false;
    save(this.saved);
    this.refresh();
  }

  setFaceAuto(on: boolean): void {
    this.saved.faceAuto = on;
    this.autoNote = on ? "watching the face" : "";
    if (on) void this.calibrateNow();
    // Switching off hands exposure back to the camera, so it cannot stay stuck at the last step.
    if (!on) this.clearLift();
    if (!on && this.track) {
      delete this.saved.values.exposureTime;
      delete this.saved.values.exposureMode;
      void restoreAuto(this.track).then(() => this.refresh());
    }
    save(this.saved);
    this.emit();
  }

  async resetToCameraAuto(): Promise<void> {
    this.saved = { faceAuto: false, values: {} };
    this.clearLift();
    save(this.saved);
    if (this.track) await restoreAuto(this.track);
    this.autoNote = "";
    this.refresh();
  }

  private range(name: ControlName): RangeControl | undefined {
    return this.controls.find((c): c is RangeControl => c.kind === "range" && c.name === name);
  }

  /** Metering costs a little each time, so it only runs when someone uses the result. */
  get wantsFrames(): boolean {
    return this.panelOpen || this.saved.faceAuto;
  }

  /**
   * Called with live frames the pipeline analysed (un-mirrored source canvas). Meters ~3x/s
   * normally, every frame while calibrating.
   */
  observe(
    src: CanvasImageSource,
    w: number,
    h: number,
    landmarks: NormalizedLandmark[] | null,
  ): void {
    if (!this.wantsFrames && !this.calibrating) return;
    const now = performance.now();
    if (!this.calibrating && now - this.lastMeterAt < 330) return;
    this.lastMeterAt = now;
    const box = landmarks ? faceMeterBox(landmarks, w, h, false) : null;
    this.meter = box ? meterPixels(readScaled(src, box.x, box.y, box.w, box.h), METER) : null;
    // With no face (e.g. the picture is black or white), fall back to the whole frame, so a
    // calibration can still tell "too dark" from "too bright" and recover.
    const reading = this.meter ?? meterPixels(readScaled(src, 0, 0, w, h), METER);
    this.emit();

    if (this.waiters.length) {
      for (const wt of this.waiters) wt.frames++;
      const ready = this.waiters.filter((wt) => now >= wt.after && wt.frames >= 2);
      this.waiters = this.waiters.filter((wt) => !ready.includes(wt));
      for (const wt of ready) wt.resolve(reading);
    }
    if (!this.saved.faceAuto || !this.track) return;
    this.updateLift();
    if (this.calibrating) return;

    // Keep-right mode: recalibrate only when the face has been clearly off target for a moment,
    // and never again for "too dark" once the camera is already at its brightest.
    const m = this.meter;
    let off: boolean;
    if (m) {
      const v = verdict(m);
      if (v !== "dark") this.atBrightest = false;
      const far = Math.abs(m.mean - DEFAULT_TARGET.mean) / DEFAULT_TARGET.mean > 0.25 || m.clipped > DEFAULT_TARGET.maxClipped * 2;
      off = far && !(v === "dark" && this.atBrightest);
    } else off = !!reading && isUnusableFrame(reading) && !(reading.mean < 30 && this.atBrightest);
    if (!off) {
      this.driftSince = 0;
      return;
    }
    this.driftSince ||= now;
    if (now - this.driftSince > 1200 && now - this.lastCalibratedAt > 3000) void this.calibrateNow();
  }

  /** Smoothly follow the face brightness with the software lift (only when the camera can't). */
  private updateLift(): void {
    const m = this.meter;
    const want = m && this.atBrightest ? liftGamma(m.mean) : 1;
    this.lift = Math.abs(want - this.lift) < 0.01 ? want : this.lift + (want - this.lift) * 0.35;
    dom.video.style.filter = m ? previewFilter(this.lift, m.mean) : this.lift < 0.995 ? dom.video.style.filter : "";
  }

  private clearLift(): void {
    this.lift = 1;
    this.atBrightest = false;
    dom.video.style.filter = "";
  }

  /** A reading taken at least `settleMs` after now and two analysed frames later. */
  private nextReading(settleMs = 350): Promise<FaceMeter | null> {
    return new Promise((resolve) => {
      const waiter = { after: performance.now() + settleMs, frames: 0, resolve };
      this.waiters.push(waiter);
      setTimeout(() => {
        if (this.waiters.includes(waiter)) {
          this.waiters = this.waiters.filter((x) => x !== waiter);
          resolve(null); // no frames arrived (camera stopped, or on the home screen)
        }
      }, 3000);
    });
  }

  private setTracked(name: ControlName, value: number | string): Promise<boolean> {
    return tracked(`camera control (${name})`, () => setControl(this.track!, name, value));
  }

  /**
   * Measure the face and bring it to the target brightness.
   * - Too bright: shorten the exposure (manual), never longer than one frame: longer values are
   *   either ignored by webcams or drop the frame rate, and searching them only wastes time.
   * - Too dark: hand exposure back to the camera's automatic mode (it can also raise gain, which
   *   the browser cannot), then the brightness control, then the software lift on the photo.
   */
  async calibrateNow(): Promise<void> {
    const track = this.track;
    if (!track || this.calibrating) return;
    this.calibrating = true;
    this.autoNote = "calibrating…";
    this.emit();
    const steps: string[] = [];
    try {
      const fps = this.info?.frameRate || 30;
      const settings = () => track.getSettings() as Record<string, unknown>;
      const run = (name: "exposureTime" | "brightness", r: { min: number; max: number; step: number }, kind: "multiplicative" | "additive", start: number) =>
        calibrate(
          { set: async (v) => void (await this.setTracked(name, v)), measure: () => this.nextReading() },
          start,
          r,
          kind,
        );
      const log = (used: string, r: CalibrationResult) =>
        console.info(`camera calibration (${used}): ${r.reason}\n  ` + r.log.join("\n  "));

      let m = await this.nextReading(0);
      if (!m) {
        this.autoNote = "could not read the picture: start the camera inside a service";
        return;
      }
      let v = verdict(m);
      if (v === "ok") {
        this.autoNote = `already on target: face ${m.mean.toFixed(0)}/255`;
        return;
      }

      if (v === "bright") {
        this.atBrightest = false;
        const time = this.range("exposureTime");
        if (time) {
          const cap = Math.max(time.min, Math.min(time.max, 10000 / fps));
          const current = Number(this.saved.values.exposureTime ?? settings().exposureTime ?? cap);
          const r = await run("exposureTime", { min: time.min, max: cap, step: time.step }, "multiplicative", Math.min(current, cap));
          log("exposureTime", r);
          if (r.reason !== "ignored") {
            this.saved.values.exposureMode = "manual";
            this.saved.values.exposureTime = r.value;
            save(this.saved);
            m = r.meter;
            steps.push(`exposure ${r.value}`);
            v = m ? verdict(m) : v;
          } else steps.push("camera ignores exposure");
        }
        const brightness = this.range("brightness");
        if (v === "bright" && brightness) {
          const r = await run("brightness", brightness, "additive", Number(this.saved.values.brightness ?? settings().brightness ?? brightness.value));
          log("brightness", r);
          this.saved.values.brightness = r.value;
          save(this.saved);
          m = r.meter;
          steps.push(`brightness ${r.value}`);
          v = m ? verdict(m) : v;
        }
      } else {
        // Too dark. 1) a manual exposure we set earlier is the likely cause: back to auto.
        if (settings().exposureMode === "manual" || this.saved.values.exposureMode === "manual") {
          await this.setTracked("exposureMode", "continuous");
          delete this.saved.values.exposureMode;
          delete this.saved.values.exposureTime;
          save(this.saved);
          m = (await this.nextReading(600)) ?? m;
          v = verdict(m);
          steps.push("camera auto exposure");
        }
        // 2) the brightness control (works alongside auto exposure).
        const brightness = this.range("brightness");
        if (v === "dark" && brightness) {
          const r = await run("brightness", brightness, "additive", Number(this.saved.values.brightness ?? settings().brightness ?? brightness.value));
          log("brightness", r);
          this.saved.values.brightness = r.value;
          save(this.saved);
          m = r.meter ?? m;
          v = verdict(m);
          steps.push(`brightness ${r.value}`);
        }
        // 3) still dark: the camera is at its brightest; the software lift takes the rest.
        this.atBrightest = v === "dark";
      }
      const face = m ? `face ${m.mean.toFixed(0)}/255` : "no reading";
      this.autoNote =
        v === "ok"
          ? `on target: ${face} (${steps.join(", ")})`
          : v === "dark"
            ? `camera at its brightest: ${face}; the photo is brightened in software (add light for best quality)`
            : `still bright: ${face} (${steps.join(", ") || "no usable control"}); reduce the light on the face`;
    } finally {
      this.calibrating = false;
      this.lastCalibratedAt = performance.now();
      this.driftSince = 0;
      this.refresh();
    }
  }
}

export const cameraTuning = new CameraTuning();
