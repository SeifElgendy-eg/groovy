// The body shaping panel follows the step the person is on: on the camera, how to stand; with a
// photo, the result (weight loss, Before | After, retake). Area sliders and the booth's setup
// (hands-free, empty backdrop, Body Brush) are folded away. The Before | After switch drives the
// shared Before button so the rest of the app sees one state.
import { state } from "../app/state";
import { dom } from "./dom";

const sliders = [dom.bodySlider, dom.bodyArmsSlider, dom.bodyWaistSlider, dom.bodyLegsSlider];
const compare = [...dom.bodySection.querySelectorAll<HTMLButtonElement>("[data-compare]")];

/** Show Before (true) or After (false), through the shared Before button. */
function showBefore(on: boolean): void {
  if (state.showBefore !== on) dom.beforeBtn.click();
}

export function mountBodyPanel(): void {
  for (const b of compare) b.addEventListener("click", () => showBefore(b.dataset.compare === "before"));
  dom.bodySection.querySelector('[data-body-action="retake"]')?.addEventListener("click", () => dom.cameraBtn.click());
  // moving a slider asks to see its effect: back to After
  for (const s of sliders)
    s.addEventListener("input", () => {
      fill(s);
      showBefore(false);
    });
}

/** The filled part of a slider's track (styles.css .body-panel input[type=range]). */
function fill(s: HTMLInputElement): void {
  const v = `${((Number(s.value) - Number(s.min)) / (Number(s.max) - Number(s.min) || 1)) * 100}%`;
  if (s.style.getPropertyValue("--fill") !== v) s.style.setProperty("--fill", v);
}

/** Keep the panel on the right step and the switch on the right side (cheap: called on each redraw). */
export function syncBodyPanel(): void {
  const step = state.sourceMode === "photo" ? "photo" : "camera";
  if (document.body.dataset.bodyStep !== step) dom.bodySection.dataset.step = document.body.dataset.bodyStep = step;
  sliders.forEach(fill);
  for (const b of compare) {
    const on = String((b.dataset.compare === "before") === state.showBefore);
    if (b.getAttribute("aria-pressed") !== on) b.setAttribute("aria-pressed", on);
  }
}
