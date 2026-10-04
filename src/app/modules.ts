// Switching between the home screen and the services: shows the right control sections and
// header, and re-runs the pipeline when a retained photo needs data the last service skipped.
import { metaOf, type ModuleId, type ServiceId } from "../effects/registry";
import { syncBefore, syncWrinklesPreset } from "../ui/controls";
import { dom } from "../ui/dom";
import { updateFaceGuide } from "../ui/faceGuide";
import { body, markEffectsDirty } from "./effects";
import { processCurrentSource } from "./pipeline";
import { renderAll } from "./render";
import { cancelCountdown, loadSamplePhoto } from "./source";
import { resetAlignment, state } from "./state";

const serviceSections: Record<ServiceId, HTMLElement[]> = {
  lips: [dom.lipsSection, dom.colorSection],
  wrinkles: [dom.wrinklesSection],
  acne: [dom.acneSection],
  skin: [dom.skinSection],
  body: [dom.bodySection],
};

function showEl(el: HTMLElement, show: boolean): void {
  el.classList.toggle("hidden-section", !show);
}

export function setModule(moduleName: ModuleId): void | Promise<void> {
  cancelCountdown();
  state.module = moduleName;
  resetAlignment();
  updateFaceGuide(null);
  const isHome = moduleName === "home";
  document.body.classList.toggle("home-screen", isHome);

  showEl(dom.moduleHome, isHome);
  showEl(dom.moduleHeader, !isHome);
  showEl(dom.backHomeBtn, !isHome);
  showEl(dom.compareSection, !isHome);
  showEl(dom.resetSection, !isHome);
  const meta = metaOf(moduleName);
  showEl(dom.skinDebugSection, meta.usesSkinMask);
  for (const [id, els] of Object.entries(serviceSections))
    for (const el of els) showEl(el, moduleName === id);

  // Body slimming's model is large: load it when the service is first chosen.
  if (moduleName === "body") body.warmUp();
  if (moduleName === "wrinkles") {
    dom.wrinklesSlider.value = "100";
    syncWrinklesPreset();
  }
  dom.moduleEyebrow.textContent = meta.eyebrow;
  dom.moduleTitle.textContent = meta.title;
  dom.sampleBtn.textContent = meta.sampleButtonLabel;
  state.showBefore = false;
  syncBefore();
  markEffectsDirty();
  if (!isHome && state.sourceMode === "photo") {
    // A bundled test photo is service-specific: swap it when the service changes.
    if (state.photoKind.startsWith("sample") && state.photoKind !== meta.sampleKind) {
      void loadSamplePhoto();
      return;
    }
    // Uploaded/captured photos are retained between services, but their skin
    // mask may not exist when the first service was lips.
    return processCurrentSource().then(() => renderAll());
  }
  renderAll();
}
