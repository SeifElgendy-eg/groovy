// Staff-only camera panel (Ctrl+Alt+C or Ctrl+Shift+C, or open the page with ?camera). Shows the resolution the
// camera really delivers, a live face-exposure reading, and the camera's hardware controls.
import { cameraTuning } from "../app/cameraTuning";
import type { CameraControl } from "../io/cameraControls";
import { DEFAULT_TARGET } from "../face/exposure";
import { dom } from "./dom";

const panel = document.createElement("div");
panel.className = "camera-panel";
panel.hidden = true;
panel.setAttribute("role", "dialog");
panel.setAttribute("aria-label", "Camera settings");

const MANUAL_HINT: Record<string, string> = {
  exposureTime: "100 µs units",
  focusDistance: "sets Focus to manual",
  colorTemperature: "Kelvin, sets White balance to manual",
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function controlRow(c: CameraControl): HTMLElement {
  if (c.kind === "mode") {
    const select = el("select", { className: "cam-select" });
    for (const m of c.modes) select.append(el("option", { value: m, selected: m === c.value }, m));
    select.addEventListener("change", () => void cameraTuning.set(c.name, select.value));
    return el("label", { className: "cam-row" }, el("span", {}, c.label), select);
  }
  const out = el("span", { className: "value" }, String(Math.round(c.value * 100) / 100));
  const input = el("input", {
    type: "range",
    min: String(c.min),
    max: String(c.max),
    step: String(c.step),
    value: String(c.value),
  });
  input.addEventListener("input", () => (out.textContent = input.value));
  input.addEventListener("change", () => void cameraTuning.set(c.name, Number(input.value)));
  const hint = MANUAL_HINT[c.name];
  return el(
    "label",
    { className: "cam-row cam-range" },
    el("span", {}, c.label, hint ? el("small", {}, ` (${hint})`) : ""),
    out,
    input,
  );
}

let renderedControls = "";

function render(): void {
  if (panel.hidden) return;
  const info = cameraTuning.info;
  const m = cameraTuning.meter;
  const res = panel.querySelector<HTMLElement>("[data-res]")!;
  res.textContent = info
    ? `${info.width}×${info.height} @ ${info.frameRate} fps`
    : "Camera not started";
  res.classList.toggle("bad", !!info?.below4k);
  panel.querySelector<HTMLElement>("[data-res-note]")!.textContent = info?.below4k
    ? "Below 4K: check the USB 3 port/cable and that no other app holds the camera."
    : "";
  const meter = panel.querySelector<HTMLElement>("[data-meter]")!;
  meter.textContent = m
    ? `face ${m.mean.toFixed(0)}/255 (target ${DEFAULT_TARGET.mean}) · blown ${(m.clipped * 100).toFixed(1)}% · crushed ${(m.crushed * 100).toFixed(1)}%`
    : "no face in view";
  meter.classList.toggle("bad", !!m && (m.clipped > DEFAULT_TARGET.maxClipped || m.mean > 190 || m.mean < 60));
  const auto = panel.querySelector<HTMLInputElement>("[data-auto]")!;
  auto.checked = cameraTuning.faceAuto;
  panel.querySelector<HTMLElement>("[data-auto-note]")!.textContent = cameraTuning.autoNote;

  // Rebuild control rows only when the set of controls or their values change (not every meter tick),
  // so a slider being dragged is not replaced under the pointer.
  const sig = JSON.stringify(cameraTuning.controls);
  if (sig !== renderedControls) {
    renderedControls = sig;
    const box = panel.querySelector<HTMLElement>("[data-controls]")!;
    box.replaceChildren(
      ...(cameraTuning.controls.length
        ? cameraTuning.controls.map(controlRow)
        : [el("div", { className: "small-note" }, "This browser/camera exposes no hardware controls.")]),
    );
  }
}

export function toggleCameraPanel(force?: boolean): void {
  panel.hidden = !(force ?? panel.hidden);
  render();
}

export function mountCameraPanel(): void {
  const auto = el("input", { type: "checkbox" });
  auto.dataset.auto = "";
  auto.addEventListener("change", () => cameraTuning.setFaceAuto(auto.checked));
  const reset = el("button", { className: "ghost-btn", type: "button" }, "Camera auto (reset)");
  reset.addEventListener("click", () => void cameraTuning.resetToCameraAuto());
  const close = el("button", { className: "ghost-btn", type: "button", title: "Close (Ctrl+Shift+C)" }, "✕");
  close.addEventListener("click", () => toggleCameraPanel(false));
  const res = el("strong", {});
  res.dataset.res = "";
  const resNote = el("div", { className: "small-note" });
  resNote.dataset.resNote = "";
  const meter = el("div", { className: "cam-meter" });
  meter.dataset.meter = "";
  const autoNote = el("div", { className: "small-note" });
  autoNote.dataset.autoNote = "";
  const controls = el("div", { className: "cam-controls" });
  controls.dataset.controls = "";
  panel.append(
    el("div", { className: "cam-head" }, el("span", {}, "CAMERA"), close),
    res,
    resNote,
    meter,
    el("label", { className: "check-row" }, el("span", {}, "Face-metered auto exposure"), auto),
    autoNote,
    controls,
    reset,
  );
  dom.stageWrap.append(panel);
  cameraTuning.onChange(render);
  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey && (e.shiftKey || e.altKey) && e.key.toLowerCase() === "c") {
      e.preventDefault();
      toggleCameraPanel();
    }
  });
  if (new URLSearchParams(location.search).has("camera")) toggleCameraPanel(true);
}
