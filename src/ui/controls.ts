// Keeps the control panel's visual state (active chips, labels, Before button) in sync with the
// slider values and session state. Read-only with respect to the effects.
import type { LipParams } from "../effects/lips/geometry";
import { state } from "../app/state";
import { matchAcnePreset, type AcnePlan } from "../effects/acne/presets";
import { mlToAmount } from "../effects/lips/geometry";
import { dom } from "./dom";

export function showPercent(label: HTMLElement, slider: HTMLInputElement): void {
  label.textContent = `${slider.value}%`;
}

export function syncBefore(): void {
  dom.beforeBtn.classList.toggle("active", state.showBefore);
  dom.beforeBtn.textContent = state.showBefore
    ? "Showing Before — Show After"
    : "Show Before";
}

function syncPresetChips(
  buttons: HTMLButtonElement[],
  value: number,
  presetOf: (btn: HTMLButtonElement) => string | undefined,
): string {
  let label = "Custom";
  for (const btn of buttons) {
    const active = Number(presetOf(btn)) === value;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", String(active));
    if (active) label = btn.textContent ?? label;
  }
  return label;
}

/**
 * A stepped slider (lip volume, botox dose): the value label, the filled track, and the
 * radio-style stop labels under the ticks (checked when the slider sits on them).
 */
function syncStepper(slider: HTMLInputElement, stops: HTMLButtonElement[], label: HTMLElement, text: string, stopValue: (b: HTMLButtonElement) => string | undefined): void {
  const v = Number(slider.value);
  label.textContent = text;
  const max = Number(slider.max) || 1;
  slider.parentElement?.style.setProperty("--fill", `${(v / max) * 100}%`);
  for (const btn of stops) {
    const on = Number(stopValue(btn)) === v;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-checked", String(on));
  }
}

/** Botox dose (units) that gives the full softening of an area. */
export const FULL_DOSE_UNITS = 40;

export function syncWrinklesPreset(): void {
  const v = Number(dom.wrinklesSlider.value);
  syncStepper(dom.wrinklesSlider, dom.wrinklesPresetButtons, dom.wrinklesValue, `${v} U`, (b) => b.dataset.wrinklesPreset);
}

/** Toggle state of the botox area chips. */
export function syncBotoxAreas(): void {
  const on = dom.botoxAreaButtons.filter((b) => b.getAttribute("aria-pressed") === "true");
  for (const btn of dom.botoxAreaButtons) {
    const pressed = on.includes(btn);
    btn.classList.toggle("active", pressed);
    // The last area that is on cannot be switched off: say so instead of ignoring the tap.
    const last = pressed && on.length === 1;
    btn.setAttribute("aria-disabled", String(last));
    btn.title = last ? "At least one area stays selected" : "";
  }
}

/** Per-area strength (0..1) from the dose slider and the area chips. */
export function readBotoxDoses(): Record<"forehead" | "frown" | "crows" | "undereye", number> {
  const dose = Math.min(1, Number(dom.wrinklesSlider.value) / FULL_DOSE_UNITS);
  const on = (id: string) => dom.botoxAreaButtons.some((b) => b.dataset.botoxArea === id && b.getAttribute("aria-pressed") === "true");
  return {
    forehead: on("forehead") ? dose : 0,
    frown: on("frown") ? dose : 0,
    crows: on("crows") ? dose : 0,
    undereye: on("undereye") ? dose : 0,
  };
}

/** Body slimming sliders, 0..1. */
export function readBodySettings(): { overall: number; arms: number; waist: number; legs: number } {
  return {
    overall: Number(dom.bodySlider.value) / 100,
    arms: Number(dom.bodyArmsSlider.value) / 100,
    waist: Number(dom.bodyWaistSlider.value) / 100,
    legs: Number(dom.bodyLegsSlider.value) / 100,
  };
}

/** The acne sliders' current values. */
export function readAcnePlan(): AcnePlan {
  return {
    spots: Number(dom.acneSlider.value),
    redness: Number(dom.rednessSlider.value),
    pores: Number(dom.poresSlider.value),
    scars: Number(dom.scarsSlider.value),
  };
}

/** A month chip is active only while every acne slider still matches its plan. */
export function syncAcnePreset(): void {
  const plan = readAcnePlan();
  const match = matchAcnePreset(plan);
  const label = syncPresetChips(dom.acnePresetButtons, match === undefined ? NaN : Number(match), (b) => b.dataset.acnePreset);
  for (const [slider, out] of [
    [dom.acneSlider, dom.acneValue],
    [dom.scarsSlider, dom.scarsValue],
    [dom.poresSlider, dom.poresValue],
    [dom.rednessSlider, dom.rednessValue],
  ] as const)
    showPercent(out, slider);
  dom.acneSelection.textContent = `Selected: ${label.trim()} · ${plan.spots}%`;
}

/** "2.5 ml" */
export const formatMl = (v: number): string => `${Number(v.toFixed(2))} ml`;

export function syncLipPreset(): void {
  const v = Number(dom.lipSlider.value);
  syncStepper(dom.lipSlider, dom.lipPresetButtons, dom.lipValue, formatMl(v), (b) => b.dataset.lipPreset);
}

export function syncFinishButtons(): void {
  for (const btn of dom.finishButtons) {
    const active = btn.dataset.finish === state.lipFinish;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", String(active));
  }
}

export function syncShadeButtons(): void {
  for (const btn of dom.shadeButtons) {
    btn.classList.toggle("active", btn.dataset.shade === state.selectedShade);
  }
}

export function readLipParams(): LipParams {
  return {
    amount: mlToAmount(Number(dom.lipSlider.value)),
    roll: Number(dom.verticalSlider.value) / 100,
    blend: Number(dom.blendSlider.value) / 100,
    colorIntensity: Number(dom.colorSlider.value) / 100,
    shadeHex: state.selectedShadeHex,
    finish: state.lipFinish,
    showOutline: dom.lipDebug.checked,
  };
}

/** The camera/photo toggle button, source badge and which of <video>/<img> is shown. */
export function applySourceMode(): void {
  const cam = state.sourceMode === "camera";
  dom.cameraBtn.classList.toggle("active", cam);
  dom.sourceBadge.textContent = `SOURCE — ${cam ? "CAMERA" : "PHOTO"}`;
  dom.video.style.display = cam ? "block" : "none";
  // A captured still (see app/frames.ts) is shown instead of the <img> while it exists.
  const still = dom.stageWrap.querySelector<HTMLElement>(".captured-still");
  dom.photo.style.display = cam || still ? "none" : "block";
  if (still) still.style.display = cam ? "none" : "block";
  dom.stageWrap.classList.toggle("camera-mode", cam);
  dom.stageWrap.classList.toggle("photo-mode", !cam);
  dom.liveBadge.classList.toggle("hidden", !cam);
  dom.perfBadge.textContent = cam ? "PROC -- fps" : "PHOTO READY";
  dom.cameraBtn.textContent = cam
    ? "Camera"
    : state.capturedPhoto
      ? "Retake photo"
      : "Back to camera";
}
