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
import { calibrate, type CalibrationResult } from "../face/calibrate";
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
    if (!this.saved.faceAuto || !this.track || this.calibrating) return;

    // Keep-right mode: recalibrate only when the face has been clearly off target for a moment.
    const off = this.meter
      ? Math.abs(this.meter.mean - DEFAULT_TARGET.mean) / DEFAULT_TARGET.mean > 0.25 ||
        this.meter.clipped > DEFAULT_TARGET.maxClipped * 3
      : !!reading && isUnusableFrame(reading);
    if (!off) {
      this.driftSince = 0;
      return;
    }
    this.driftSince ||= now;
    if (now - this.driftSince > 1200 && now - this.lastCalibratedAt > 3000) void this.calibrateNow();
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

  /** Measure the face and set the camera so the face sits at the target brightness. */
  async calibrateNow(): Promise<void> {
    const track = this.track;
    if (!track || this.calibrating) return;
    this.calibrating = true;
    this.autoNote = "calibrating…";
    this.emit();
    try {
      const fps = this.info?.frameRate || 30;
      const settings = track.getSettings() as Record<string, unknown>;
      const run = (name: "exposureTime" | "brightness", r: RangeControl, kind: "multiplicative" | "additive") =>
        calibrate(
          {
            set: async (v) => void (await setControl(track, name, v)),
            measure: () => this.nextReading(),
          },
          Number(this.saved.values[name] ?? settings[name] ?? r.value),
          r,
          kind,
        );
      let result: CalibrationResult | null = null;
      let used: "exposureTime" | "brightness" | null = null;
      const time = this.range("exposureTime");
      if (time) {
        result = await run("exposureTime", time, "multiplicative");
        used = "exposureTime";
      }
      const brightness = this.range("brightness");
      if (brightness && (!result || result.reason === "ignored")) {
        result = await run("brightness", brightness, "additive");
        used = "brightness";
      }
      if (!result || !used) {
        this.autoNote = "this camera exposes no exposure or brightness control";
        return;
      }
      console.info(`camera calibration (${used}): ${result.reason}\n  ` + result.log.join("\n  "));
      this.saved.values[used] = result.value;
      if (used === "exposureTime") this.saved.values.exposureMode = "manual";
      save(this.saved);
      const face = result.meter ? `face ${result.meter.mean.toFixed(0)}/255` : "no reading";
      const slow = used === "exposureTime" && result.value > 10000 / fps ? " · longer than one frame: add light for full frame rate" : "";
      this.autoNote = {
        "on-target": `calibrated in ${result.steps} steps: ${face} (${used} ${result.value})${slow}`,
        limit: `best possible: ${face} at the camera's ${used} limit${slow}`,
        "max-steps": `stopped after ${result.steps} steps: ${face} (${used} ${result.value})`,
        ignored: `the camera ignores ${used} changes from the browser`,
        unreadable: "could not read the picture: start the camera inside a service",
      }[result.reason];
    } finally {
      this.calibrating = false;
      this.lastCalibratedAt = performance.now();
      this.driftSince = 0;
      this.refresh();
    }
  }
}

export const cameraTuning = new CameraTuning();
