// Keeps the control panel's visual state (active chips, labels, Before button) in sync with the
// slider values and session state. Read-only with respect to the effects.
import type { LipParams } from "../effects/lips/geometry";
import { state } from "../app/state";
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

export function syncAcnePreset(): void {
  const value = Number(dom.acneSlider.value);
  const label = syncPresetChips(
    dom.acnePresetButtons,
    value,
    (b) => b.dataset.acnePreset,
  );
  dom.acneSelection.textContent = `Selected: ${label} · ${value}%`;
}

export function syncLipPreset(): void {
  const v = Number(dom.lipSlider.value);
  for (const btn of dom.lipPresetButtons) {
    btn.classList.toggle("active", Number(btn.dataset.lipPreset) === v);
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
    showOutline: dom.lipDebug.checked,
  };
}

/** The camera/photo toggle button, source badge and which of <video>/<img> is shown. */
export function applySourceMode(): void {
  const cam = state.sourceMode === "camera";
  dom.cameraBtn.classList.toggle("active", cam);
  dom.sourceBadge.textContent = `SOURCE — ${cam ? "CAMERA" : "PHOTO"}`;
  dom.video.style.display = cam ? "block" : "none";
  dom.photo.style.display = cam ? "none" : "block";
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
