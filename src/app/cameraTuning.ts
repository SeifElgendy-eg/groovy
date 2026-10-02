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
import { meterFace, nextExposure, nextOffset, type FaceMeter } from "../face/exposure";
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

class CameraTuning {
  private track: MediaStreamTrack | null = null;
  private saved = load();
  private lastMeterAt = 0;
  private lastAdjustAt = 0;
  private adjusting = false;
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

  /**
   * Called with every live frame the pipeline analysed (un-mirrored source canvas).
   * Meters ~3x/s; adjusts at most every 600 ms so the camera can settle between steps.
   */
  observe(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    landmarks: NormalizedLandmark[] | null,
  ): void {
    const now = performance.now();
    if (now - this.lastMeterAt < 330) return;
    this.lastMeterAt = now;
    this.meter = landmarks
      ? meterFace(ctx.getImageData(0, 0, w, h).data, w, h, landmarks, false)
      : null;
    this.emit();
    if (!this.saved.faceAuto || !this.meter || !this.track || this.adjusting) return;
    if (now - this.lastAdjustAt < 600) return;
    void this.adjust(this.meter);
  }

  private async adjust(meter: FaceMeter): Promise<void> {
    const track = this.track!;
    this.adjusting = true;
    try {
      const time = this.range("exposureTime");
      if (time) {
        // exposureTime is in 100 µs units; longer than one frame would drop the frame rate.
        const fps = this.info?.frameRate || 30;
        const max = Math.min(time.max, 10000 / fps);
        const current = Number((track.getSettings() as Record<string, unknown>).exposureTime ?? time.value);
        const next = nextExposure(current, meter, { min: time.min, max });
        if (next !== null) {
          const stepped = Math.max(time.min, Math.round(next / time.step) * time.step);
          await setControl(track, "exposureTime", stepped);
          this.autoNote = `exposure ${current.toFixed(0)} → ${stepped.toFixed(0)}`;
          this.lastAdjustAt = performance.now();
          this.refresh();
        } else this.autoNote = "face exposure on target";
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
          this.refresh();
        } else this.autoNote = "face exposure on target";
        return;
      }
      this.autoNote = "this camera exposes no exposure or brightness control";
    } finally {
      this.adjusting = false;
    }
  }
}

export const cameraTuning = new CameraTuning();
