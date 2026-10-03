// Keeps the control panel's visual state (active chips, labels, Before button) in sync with the
// slider values and session state. Read-only with respect to the effects.
import type { LipParams } from "../effects/lips/geometry";
import { state } from "../app/state";
import { matchAcnePreset, type AcnePlan } from "../effects/acne/presets";
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

export function syncWrinklesPreset(): void {
  const value = Number(dom.wrinklesSlider.value);
  const label = syncPresetChips(
    dom.wrinklesPresetButtons,
    value,
    (b) => b.dataset.wrinklesPreset,
  );
  dom.wrinklesValue.textContent = `${value}%`;
  dom.wrinklesSelection.textContent = `Selected: ${label} · ${value}%`;
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

export function syncLipPreset(): void {
  const v = Number(dom.lipSlider.value);
  for (const btn of dom.lipPresetButtons) {
    btn.classList.toggle("active", Number(btn.dataset.lipPreset) === v);
  }
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
    amount: Number(dom.lipSlider.value) / 100,
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
