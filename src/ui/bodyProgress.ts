// Over the photo in body shaping, only while the body is being processed: which step, and for how
// long. It goes away as soon as the result is shown.
import { dom } from "./dom";

export type BodyProgress = { kind: "working"; step: string; since: number } | null;

const box = document.createElement("div");
box.className = "body-progress working";
box.hidden = true;
box.setAttribute("role", "status");
box.setAttribute("aria-live", "polite");
const icon = document.createElement("span");
icon.className = "body-progress-icon";
const text = document.createElement("div");
const title = document.createElement("strong");
const detail = document.createElement("span");
text.append(title, detail);
box.append(icon, text);

let current: BodyProgress = null;
let timer = 0;

export function mountBodyProgress(): void {
  dom.stageWrap.append(box);
}

function paint(): void {
  const p = current;
  box.hidden = p === null;
  if (!p) return;
  title.textContent = `Processing the body… ${Math.floor((performance.now() - p.since) / 1000)} s`;
  detail.textContent = p.step;
}

/** Show the body's processing state over the photo (null: hide). */
export function setBodyProgress(p: BodyProgress): void {
  const same =
    JSON.stringify(p) === JSON.stringify(current) ||
    (p !== null && current !== null && p.step === current.step);
  if (p && current) p = { ...p, since: current.since };
  current = p;
  if (!same) paint();
  // the seconds keep counting while it works
  if (p && !timer) timer = window.setInterval(paint, 500);
  if (!p && timer) {
    clearInterval(timer);
    timer = 0;
  }
}
