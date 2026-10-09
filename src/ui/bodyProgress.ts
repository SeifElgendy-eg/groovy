// Over the photo in body shaping: whether the body is still being processed (and which step), or
// done (and what was applied), or failed. A clear, always-visible answer to "is it working?".
import { dom } from "./dom";

export type BodyProgress =
  | { kind: "working"; step: string; since: number }
  | { kind: "done"; detail: string }
  | { kind: "ready"; detail: string }
  | { kind: "failed"; message: string }
  | null;

const box = document.createElement("div");
box.className = "body-progress";
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
  box.classList.remove("working", "done", "ready", "failed");
  if (!p) return;
  box.classList.add(p.kind);
  if (p.kind === "working") {
    title.textContent = `Processing the body… ${Math.floor((performance.now() - p.since) / 1000)} s`;
    detail.textContent = p.step;
  } else if (p.kind === "done") {
    title.textContent = "Done: body shaping applied";
    detail.textContent = p.detail;
  } else if (p.kind === "ready") {
    title.textContent = "Done: ready to preview";
    detail.textContent = p.detail;
  } else {
    title.textContent = "Body shaping not applied";
    detail.textContent = p.message;
  }
}

/** Show the body's processing state over the photo (null: hide). */
export function setBodyProgress(p: BodyProgress): void {
  const same =
    JSON.stringify(p) === JSON.stringify(current) ||
    (p?.kind === "working" && current?.kind === "working" && p.step === current.step);
  if (p?.kind === "working" && current?.kind === "working") p = { ...p, since: current.since };
  current = p;
  if (!same) paint();
  // the seconds keep counting while it works
  if (p?.kind === "working" && !timer) timer = window.setInterval(paint, 500);
  if (p?.kind !== "working" && timer) {
    clearInterval(timer);
    timer = 0;
  }
}
