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
  nextExposure,
  nextOffset,
  type FaceMeter,
} from "../face/exposure";
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
  private lastAdjustAt = 0;
  private adjusting = false;
  /** Last step landed in the dead band: hold until the face drifts clearly off target. */
  private onTarget = false;
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
    this.autoNote = on ? "waiting for a face" : "";
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
   * Called with live frames the pipeline analysed (un-mirrored source canvas).
   * Meters ~3x/s; adjusts at most every 800 ms so the camera can settle between steps.
   */
  observe(
    src: CanvasImageSource,
    w: number,
    h: number,
    landmarks: NormalizedLandmark[] | null,
  ): void {
    if (!this.wantsFrames) return;
    const now = performance.now();
    if (now - this.lastMeterAt < 330) return;
    this.lastMeterAt = now;
    const box = landmarks ? faceMeterBox(landmarks, w, h, false) : null;
    this.meter = box ? meterPixels(readScaled(src, box.x, box.y, box.w, box.h), METER) : null;
    this.emit();
    if (!this.saved.faceAuto || !this.track || this.adjusting) return;
    if (now - this.lastAdjustAt < 800) return;
    if (this.meter) {
      const off = Math.abs(this.meter.mean - DEFAULT_TARGET.mean) / DEFAULT_TARGET.mean;
      const blown = this.meter.clipped > DEFAULT_TARGET.maxClipped;
      if (this.onTarget && off < 0.2 && !blown) return; // hysteresis: no needless camera calls
      return void this.adjust(this.meter);
    }
    // No face: only act if the whole frame is so dark/bright that a face could not be seen.
    // (A black frame hides the face from the detector, which would otherwise stay stuck.)
    const frame = meterPixels(readScaled(src, 0, 0, w, h), METER)!;
    if (isUnusableFrame(frame)) void this.adjust(frame, "frame");
    else this.autoNote = "waiting for a face";
  }

  private async adjust(meter: FaceMeter, basis: "face" | "frame" = "face"): Promise<void> {
    const track = this.track!;
    this.adjusting = true;
    try {
      const time = this.range("exposureTime");
      if (time) {
        // exposureTime is in 100 µs units; longer than one frame would drop the frame rate.
        const fps = this.info?.frameRate || 30;
        const current = Number((track.getSettings() as Record<string, unknown>).exposureTime ?? time.value);
        // Never force the value below where the camera already is in one jump: the frame-time
        // cap only stops us going LONGER than one frame, it must not slam a longer auto value down.
        const max = Math.max(Math.min(time.max, 10000 / fps), current);
        const next = nextExposure(current, meter, { min: time.min, max });
        if (next !== null) {
          const stepped = Math.max(time.min, Math.round(next / time.step) * time.step);
          await setControl(track, "exposureTime", stepped);
          this.autoNote = `${basis === "frame" ? "dark/bright frame, " : ""}exposure ${current.toFixed(0)} → ${stepped.toFixed(0)}`;
          this.lastAdjustAt = performance.now();
          this.onTarget = false;
          this.refresh();
        } else {
          this.autoNote = "face exposure on target";
          this.onTarget = true;
        }
        return;
      }
      const brightness = this.range("brightness");
      if (brightness) {
        const current = Number((track.getSettings() as Record<string, unknown>).brightness ?? brightness.value);
        const next = nextOffset(current, meter, brightness);
        if (next !== null) {
          await setControl(track, "brightness", next);
          this.autoNote = `brightness ${current} → ${next}`;
          this.lastAdjustAt = performance.now();
          this.onTarget = false;
          this.refresh();
        } else {
          this.autoNote = "face exposure on target";
          this.onTarget = true;
        }
        return;
      }
      this.autoNote = "this camera exposes no exposure or brightness control";
    } finally {
      this.adjusting = false;
    }
  }
}

export const cameraTuning = new CameraTuning();
