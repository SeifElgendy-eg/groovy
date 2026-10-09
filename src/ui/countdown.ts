// What the person sees during the capture countdown: a big number (readable from a couple of
// metres) with a short instruction, and a quick flash when the photo is taken.
import { countdownCaption } from "../core/countdown";
import { dom } from "./dom";

const overlay = document.createElement("div");
overlay.className = "capture-countdown";
overlay.hidden = true;
overlay.setAttribute("role", "status");
overlay.setAttribute("aria-live", "polite");
overlay.setAttribute("aria-atomic", "true");
const numberEl = document.createElement("span");
numberEl.className = "capture-countdown-number";
const captionEl = document.createElement("span");
captionEl.className = "capture-countdown-caption";
overlay.append(numberEl, captionEl);

const flash = document.createElement("div");
flash.className = "capture-flash";
flash.hidden = true;

export function mountCountdown(): void {
  dom.stageWrap.append(overlay, flash);
}

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Show `remaining` (whole seconds left), or hide the countdown with null. `holding`: the person is
 * already in place (hands-free capture), so the caption only asks them to hold still. `caption`:
 * a caption of its own (the empty-backdrop capture).
 */
export function showCountdown(remaining: number | null, holding = false, caption?: string): void {
  overlay.hidden = remaining === null;
  if (remaining === null) return;
  numberEl.textContent = String(remaining);
  captionEl.textContent = caption ?? (holding ? "Hold still" : countdownCaption(remaining));
  if (!reducedMotion())
    numberEl.animate(
      [
        { transform: "scale(1.4)", opacity: 0 },
        { transform: "scale(1)", opacity: 1 },
      ],
      { duration: 450, easing: "ease-out" },
    );
}

/** A short white flash over the stage: the photo was taken (no flash for reduced motion). */
export function flashCapture(): void {
  if (reducedMotion()) return;
  flash.hidden = false;
  flash.animate([{ opacity: 0.85 }, { opacity: 0 }], { duration: 350, easing: "ease-out" }).onfinish = () => {
    flash.hidden = true;
  };
}
