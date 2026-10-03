// Composition root: mounts the overlay UI, wires controls to actions, and starts the models.
import { metaOf } from "../effects/registry";
import { ACNE_PRESETS } from "../effects/acne/presets";
import {
  showPercent,
  syncAcnePreset,
  syncBefore,
  syncLipPreset,
  syncFinishButtons,
  syncShadeButtons,
  syncWrinklesPreset,
} from "../ui/controls";
import { dom } from "../ui/dom";
import { mountFaceGuide } from "../ui/faceGuide";
import { mountCameraPanel } from "../ui/cameraPanel";
import { mountLipTuning } from "../ui/lipTuning";
import { mountStatusToast, setStatus } from "../ui/status";
import { stopCameraLoop } from "./loop";
import { setModule } from "./modules";
import { closeModels, initModels } from "./pipeline";
import { renderAll } from "./render";
import {
  handlePhoto,
  loadSamplePhoto,
  mountCaptureButton,
  startCamera,
  stopCamera,
  useCameraAgain,
} from "./source";
import { state } from "./state";

// A user edit of any control leaves "Before" mode and redraws.
function userChanged(): void {
  state.showBefore = false;
  syncBefore();
  renderAll();
}

/** Slider -> label + optional extra sync, then redraw. */
function bindSlider(
  slider: HTMLInputElement,
  label: HTMLElement | null,
  extra?: () => void,
): void {
  slider.addEventListener("input", () => {
    if (label) showPercent(label, slider);
    extra?.();
    userChanged();
  });
}


function setShade(name: string, hex: string): void {
  state.selectedShade = name;
  state.selectedShadeHex = hex || "";
  if (name !== "off" && Number(dom.colorSlider.value) === 0) {
    dom.colorSlider.value = "28";
    dom.colorValue.textContent = "28%";
  }
  if (name === "off") {
    dom.colorSlider.value = "0";
    dom.colorValue.textContent = "0%";
  }
  userChanged();
  syncShadeButtons();
}

function resetAll(): void {
  dom.skinDebug.checked = false;
  dom.wrinklesSlider.value = "100";
  syncWrinklesPreset();
  for (const slider of [dom.acneSlider, dom.scarsSlider, dom.poresSlider, dom.rednessSlider]) slider.value = "0";
  syncAcnePreset();
  dom.brightnessSlider.value = "0";
  dom.brightnessValue.textContent = "0%";
  dom.lipSlider.value = "0";
  dom.verticalSlider.value = "60";
  dom.blendSlider.value = "55";
  dom.colorSlider.value = "0";
  dom.verticalValue.textContent = "60%";
  dom.blendValue.textContent = "55%";
  dom.colorValue.textContent = "0%";
  dom.lipDebug.checked = false;
  state.selectedShade = "off";
  state.selectedShadeHex = "";
  state.lipFinish = "natural";
  syncFinishButtons();
  state.showBefore = metaOf(state.module).resetShowsBefore;
  syncBefore();
  syncLipPreset();
  syncShadeButtons();
  renderAll();
}

function bindControls(): void {
  // Navigation and sources
  dom.chooseLipsBtn.addEventListener("click", () => setModule("lips"));
  dom.chooseWrinklesBtn.addEventListener("click", () => setModule("wrinkles"));
  dom.chooseAcneBtn.addEventListener("click", () => setModule("acne"));
  dom.chooseSkinBtn.addEventListener("click", () => setModule("skin"));
  dom.backHomeBtn.addEventListener("click", () => setModule("home"));
  dom.cameraBtn.addEventListener("click", () => useCameraAgain());
  dom.startBtn.addEventListener("click", startCamera);
  for (const input of [dom.fileInput, dom.fileInputOverlay])
    input.addEventListener("change", () => handlePhoto(input.files?.[0]));
  for (const btn of [
    dom.sampleBtn,
    dom.sampleBtnOverlay,
    dom.wrinklesSampleBtn,
    dom.acneSampleBtn,
  ])
    btn.addEventListener("click", loadSamplePhoto);
  dom.beforeBtn.addEventListener("click", () => {
    state.showBefore = !state.showBefore;
    syncBefore();
    renderAll();
  });
  dom.resetBtn.addEventListener("click", resetAll);

  // Wrinkles
  bindSlider(dom.wrinklesSlider, null, syncWrinklesPreset);
  for (const btn of dom.wrinklesPresetButtons)
    btn.addEventListener("click", () => {
      dom.wrinklesSlider.value = btn.dataset.wrinklesPreset!;
      syncWrinklesPreset();
      userChanged();
    });
  dom.skinDebug.addEventListener("change", userChanged);

  // Acne
  bindSlider(dom.acneSlider, dom.acneValue, syncAcnePreset);
  // A month sets every acne slider (spots, redness, pores, scars) to that month's plan.
  for (const btn of dom.acnePresetButtons)
    btn.addEventListener("click", () => {
      const plan = ACNE_PRESETS[btn.dataset.acnePreset!];
      if (!plan) return;
      dom.acneSlider.value = String(plan.spots);
      dom.rednessSlider.value = String(plan.redness);
      dom.poresSlider.value = String(plan.pores);
      dom.scarsSlider.value = String(plan.scars);
      syncAcnePreset();
      userChanged();
    });

  // Acne scars, pores and redness (fine-tuning after a month is picked)
  bindSlider(dom.scarsSlider, dom.scarsValue, syncAcnePreset);
  bindSlider(dom.poresSlider, dom.poresValue, syncAcnePreset);
  bindSlider(dom.rednessSlider, dom.rednessValue, syncAcnePreset);

  // Skin brightness
  bindSlider(dom.brightnessSlider, dom.brightnessValue);

  // Lips
  for (const btn of dom.lipPresetButtons)
    btn.addEventListener("click", () => {
      // A preset sets the volume in ml only; Lip Roll and Edge Blend keep the user's choice.
      dom.lipSlider.value = btn.dataset.lipPreset!;
      syncLipPreset();
      userChanged();
    });
  for (const btn of dom.shadeButtons)
    btn.addEventListener("click", () =>
      setShade(btn.dataset.shade!, btn.dataset.hex!),
    );
  for (const btn of dom.finishButtons)
    btn.addEventListener("click", () => {
      state.lipFinish = btn.dataset.finish as typeof state.lipFinish;
      syncFinishButtons();
      userChanged();
    });
  bindSlider(dom.lipSlider, null, syncLipPreset);
  bindSlider(dom.verticalSlider, dom.verticalValue);
  bindSlider(dom.blendSlider, dom.blendValue);
  bindSlider(dom.colorSlider, dom.colorValue, () => {
    state.selectedShade = Number(dom.colorSlider.value) > 0 ? "brightred" : "off";
    state.selectedShadeHex = state.selectedShade === "off" ? "" : "#DE4B50";
    syncShadeButtons();
  });
  dom.lipDebug.addEventListener("change", renderAll);

  window.addEventListener("beforeunload", () => {
    stopCameraLoop();
    stopCamera();
    closeModels();
  });
}

export function start(): void {
  mountFaceGuide();
  mountStatusToast();
  mountCaptureButton();
  mountCameraPanel();
  mountLipTuning();
  bindControls();
  setStatus("Loading models…");
  dom.stageWrap.classList.add("camera-mode");
  syncBefore();
  syncLipPreset();
  syncShadeButtons();
  syncAcnePreset();
  syncWrinklesPreset();
  setModule("home");
  void initModels();
}
