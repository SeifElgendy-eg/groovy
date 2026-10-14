// Switching between the home screen and the services: shows the right control sections and
// header, and re-runs the pipeline when a retained photo needs data the last service skipped.
import { metaOf, usesSkinMask, type ModuleId } from "../effects/registry";
import { syncBefore } from "../ui/controls";
import { dom } from "../ui/dom";
import { updateFaceGuide } from "../ui/faceGuide";
import { markEffectsDirty, services } from "./services";
import { processCurrentSource } from "./pipeline";
import { renderAll } from "./render";
import { cancelCountdown, loadSamplePhoto } from "./source";
import { resetAlignment, state } from "./state";


/** The start screen's words: the face services' own, or the body's (stand back, the whole body). */
const startTitle = dom.overlay.querySelector("h2")!;
const startText = dom.overlay.querySelector("p")!;
const faceStart = [startTitle.textContent, startText.textContent];
const bodyStart = ["See your new shape", "Stand back so your whole body is in view. Hold still in the outline and the photo takes itself."];

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
  // Body shaping has its own, quieter layout (styles.css "body-mode").
  const isBody = moduleName === "body";
  document.body.classList.toggle("body-mode", isBody);
  dom.backHomeBtn.textContent = isBody ? "All services" : "Back";
  [startTitle.textContent, startText.textContent] = isBody ? bodyStart : faceStart;

  showEl(dom.moduleHome, isHome);
  showEl(dom.moduleHeader, !isHome);
  showEl(dom.backHomeBtn, !isHome);
  showEl(dom.compareSection, !isHome);
  showEl(dom.resetSection, !isHome);
  const meta = metaOf(moduleName);
  showEl(dom.skinDebugSection, usesSkinMask(moduleName));
  for (const service of Object.values(services))
    for (const el of service.sections) showEl(el, moduleName === service.id);

  if (!isHome) services[moduleName].chosen?.();
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
