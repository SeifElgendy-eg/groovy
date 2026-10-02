// Hardware camera controls through the Media Capture "image capture" constraints
// (exposure, focus, white balance, brightness...). What exists depends on the browser, OS and
// camera: Chrome on Windows exposes exposureMode/exposureTime, focusMode/focusDistance,
// whiteBalanceMode/colorTemperature, brightness, contrast, saturation and sharpness for UVC
// webcams. Everything here degrades to "not supported" instead of throwing.

export type ControlName =
  | "exposureMode"
  | "exposureTime"
  | "exposureCompensation"
  | "brightness"
  | "contrast"
  | "saturation"
  | "sharpness"
  | "focusMode"
  | "focusDistance"
  | "whiteBalanceMode"
  | "colorTemperature";

export interface RangeControl {
  kind: "range";
  name: ControlName;
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  /** The mode control that must be "manual" for this value to take effect. */
  needsManual?: ControlName;
}

export interface ModeControl {
  kind: "mode";
  name: ControlName;
  label: string;
  modes: string[];
  value: string;
}

export type CameraControl = RangeControl | ModeControl;

const MODE_CONTROLS: [ControlName, string][] = [
  ["exposureMode", "Exposure"],
  ["focusMode", "Focus"],
  ["whiteBalanceMode", "White balance"],
];

const RANGE_CONTROLS: [ControlName, string, ControlName?][] = [
  ["exposureTime", "Exposure time", "exposureMode"],
  ["exposureCompensation", "Exposure compensation"],
  ["brightness", "Brightness"],
  ["contrast", "Contrast"],
  ["saturation", "Saturation"],
  ["sharpness", "Sharpness"],
  ["focusDistance", "Focus distance", "focusMode"],
  ["colorTemperature", "Colour temperature", "whiteBalanceMode"],
];

type Loose = Record<string, unknown>;

function capabilitiesOf(track: MediaStreamTrack): Loose {
  try {
    return (track.getCapabilities?.() ?? {}) as Loose;
  } catch {
    return {};
  }
}

/** The controls this camera actually offers, with their current values. */
export function readControls(track: MediaStreamTrack): CameraControl[] {
  const caps = capabilitiesOf(track);
  const settings = track.getSettings() as Loose;
  const out: CameraControl[] = [];
  for (const [name, label] of MODE_CONTROLS) {
    const modes = caps[name];
    if (Array.isArray(modes) && modes.length)
      out.push({
        kind: "mode",
        name,
        label,
        modes: modes as string[],
        value: String(settings[name] ?? modes[0]),
      });
  }
  for (const [name, label, needsManual] of RANGE_CONTROLS) {
    const r = caps[name] as { min?: number; max?: number; step?: number } | undefined;
    if (!r || typeof r.min !== "number" || typeof r.max !== "number" || r.max <= r.min)
      continue;
    out.push({
      kind: "range",
      name,
      label,
      min: r.min,
      max: r.max,
      step: r.step || (r.max - r.min) / 100,
      value: Number(settings[name] ?? r.min),
      needsManual,
    });
  }
  return out;
}

async function apply(track: MediaStreamTrack, set: Loose): Promise<boolean> {
  try {
    await track.applyConstraints({ advanced: [set as MediaTrackConstraintSet] });
    return true;
  } catch (err) {
    console.warn("camera control rejected", set, err);
    return false;
  }
}

/**
 * Set one control. Manual values (exposure time, focus distance, colour temperature) only stick
 * once their mode is "manual", and Chrome needs the mode and the value in separate calls.
 */
export async function setControl(
  track: MediaStreamTrack,
  name: ControlName,
  value: number | string,
): Promise<boolean> {
  const needs = RANGE_CONTROLS.find(([n]) => n === name)?.[2];
  if (needs) {
    const modes = capabilitiesOf(track)[needs];
    const current = (track.getSettings() as Loose)[needs];
    if (Array.isArray(modes) && modes.includes("manual") && current !== "manual")
      await apply(track, { [needs]: "manual" });
  }
  return apply(track, { [name]: value });
}

/** Hand everything back to the camera's automatic modes. */
export async function restoreAuto(track: MediaStreamTrack): Promise<void> {
  const caps = capabilitiesOf(track);
  for (const [name] of MODE_CONTROLS) {
    const modes = caps[name];
    if (Array.isArray(modes) && modes.includes("continuous"))
      await apply(track, { [name]: "continuous" });
  }
}
