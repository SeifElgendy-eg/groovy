// Body Brush: fix the outline of the person by hand when the automatic one is wrong (a dim camera, a
// chair or a bag taken for the body, an arm missed). The outline is shown in green over the photo
// (as it is, not slimmed); the operator paints more of it, erases some, or traces a shape to fill,
// then applies it. The slimming then runs on that outline instead of the automatic one.
//
// After the team's Body Brush (Groovy Local "Body Brush" build, 12 Oct 2026), reworked to fit this
// app: the selection lives in the alpha of a canvas at up to 1024 px; brush strokes are round lines
// (added with source-over, erased with destination-out); a traced shape is filled on release; each
// stroke saves the canvas for undo. Applied, the alpha becomes the person mask (0..1).
import type { PersonMask } from "../effects/body/effect";
import { dom } from "./dom";

/** Longest side of the selection canvas (the slimming's own outline is at most ~800 px). */
const MAX_SIDE = 1024;
/** Undo steps kept. */
const UNDO = 20;

type Tool = "add" | "erase" | "trace";

export interface BodyBrushHost {
  /** The photo's size (the stage's pixels). */
  size(): { w: number; h: number };
  /** The outline to start from: the one the slimming used, else the segmenter's; null while it loads. */
  outline(): PersonMask | null;
  /** The automatic outline (segmenter's), for "Start again from automatic". */
  automatic(): PersonMask | null;
  /** The hand-made outline was applied (a mask) or dropped (null). */
  apply(mask: PersonMask | null): void;
  /** Whether a hand-made outline is in use. */
  manual(): boolean;
  /** Redraw the stage (the editor shows the photo as it is). */
  redraw(): void;
}

const overlay = document.createElement("canvas");
overlay.className = "body-brush-overlay";
const view = overlay.getContext("2d")!;
const sel = document.createElement("canvas");
const selCtx = sel.getContext("2d", { willReadFrequently: true })!;

const panel = document.createElement("div");
panel.className = "body-brush";
panel.innerHTML = `
  <button type="button" class="ghost-btn" data-action="start">Fix body outline</button>
  <button type="button" class="ghost-btn" data-action="auto" hidden>Use automatic outline</button>
  <div class="body-brush-tools" hidden>
    <p>The green area is the body. Paint to add, erase what is not body, or trace a shape to fill it.</p>
    <div class="body-brush-row" role="group" aria-label="Tool">
      <button type="button" data-tool="add" aria-pressed="true">Add</button>
      <button type="button" data-tool="erase" aria-pressed="false">Erase</button>
      <button type="button" data-tool="trace" aria-pressed="false">Trace &amp; fill</button>
    </div>
    <label class="body-brush-size">Brush <input type="range" min="6" max="120" value="36" aria-label="Brush size" /></label>
    <div class="body-brush-row">
      <button type="button" data-action="undo">Undo</button>
      <button type="button" data-action="reset">Start again</button>
    </div>
    <div class="body-brush-row">
      <button type="button" class="primary" data-action="apply">Apply outline</button>
      <button type="button" data-action="cancel">Cancel</button>
    </div>
  </div>
  <small class="body-brush-status" role="status"></small>`;
const tools = panel.querySelector<HTMLElement>(".body-brush-tools")!;
const status = panel.querySelector<HTMLElement>(".body-brush-status")!;
const sizeInput = panel.querySelector<HTMLInputElement>('input[type="range"]')!;
const startBtn = panel.querySelector<HTMLButtonElement>('[data-action="start"]')!;
const autoBtn = panel.querySelector<HTMLButtonElement>('[data-action="auto"]')!;

let host: BodyBrushHost | null = null;
let editing = false;
let tool: Tool = "add";
let pointer: number | null = null;
let last: [number, number] = [0, 0];
let trace: [number, number][] = [];
let undo: ImageData[] = [];

/** The editor is open (the stage then shows the photo as it is). */
export function bodyBrushEditing(): boolean {
  return editing;
}

/** Draw a mask (0..1) into the selection canvas's alpha, scaled to it. */
export function paintMask(ctx: CanvasRenderingContext2D, w: number, h: number, mask: PersonMask): void {
  const src = document.createElement("canvas");
  src.width = mask.w;
  src.height = mask.h;
  const sctx = src.getContext("2d")!;
  const img = sctx.createImageData(mask.w, mask.h);
  for (let i = 0; i < mask.data.length; i++) {
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = 255;
    img.data[i * 4 + 3] = Math.round(Math.max(0, Math.min(1, mask.data[i])) * 255);
  }
  sctx.putImageData(img, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(src, 0, 0, w, h);
}

/** The selection canvas's alpha as a mask (0..1). */
export function readMask(ctx: CanvasRenderingContext2D, w: number, h: number): PersonMask {
  const px = ctx.getImageData(0, 0, w, h).data;
  const data = new Float32Array(w * h);
  for (let i = 0; i < data.length; i++) data[i] = px[i * 4 + 3] / 255;
  return { data, w, h };
}

function show(): void {
  view.clearRect(0, 0, overlay.width, overlay.height);
  view.globalCompositeOperation = "source-over";
  view.drawImage(sel, 0, 0);
  // the selection tinted green, its edge drawn so it can be judged against the photo
  view.globalCompositeOperation = "source-in";
  view.fillStyle = "rgba(60, 230, 170, 0.45)";
  view.fillRect(0, 0, overlay.width, overlay.height);
  view.globalCompositeOperation = "source-over";
  if (trace.length > 1) {
    view.beginPath();
    trace.forEach(([x, y], i) => (i ? view.lineTo(x, y) : view.moveTo(x, y)));
    view.strokeStyle = "#fff";
    view.lineWidth = Math.max(2, overlay.width / 400);
    view.stroke();
  }
}

function snapshot(): void {
  undo.push(selCtx.getImageData(0, 0, sel.width, sel.height));
  if (undo.length > UNDO) undo.shift();
}

/** Pointer position in selection pixels. */
function at(e: PointerEvent): [number, number] {
  const r = overlay.getBoundingClientRect();
  return [((e.clientX - r.left) / r.width) * sel.width, ((e.clientY - r.top) / r.height) * sel.height];
}

/** A brush segment to `p` (the brush size is in screen pixels: the same feel at any photo size). */
function stroke(p: [number, number]): void {
  const r = overlay.getBoundingClientRect();
  const size = (Number(sizeInput.value) * sel.width) / Math.max(1, r.width);
  selCtx.globalCompositeOperation = tool === "erase" ? "destination-out" : "source-over";
  selCtx.strokeStyle = selCtx.fillStyle = "#fff";
  selCtx.lineWidth = size;
  selCtx.lineCap = selCtx.lineJoin = "round";
  selCtx.beginPath();
  selCtx.moveTo(last[0], last[1]);
  selCtx.lineTo(p[0], p[1]);
  selCtx.stroke();
  selCtx.beginPath();
  selCtx.arc(p[0], p[1], size / 2, 0, Math.PI * 2);
  selCtx.fill();
  selCtx.globalCompositeOperation = "source-over";
  last = p;
  show();
}

function setTool(t: Tool): void {
  tool = t;
  for (const b of panel.querySelectorAll<HTMLButtonElement>("[data-tool]")) b.setAttribute("aria-pressed", String(b.dataset.tool === t));
}

function open(): void {
  if (!host || editing) return;
  const { w, h } = host.size();
  if (!w || !h) return;
  const k = Math.min(1, MAX_SIDE / Math.max(w, h));
  sel.width = overlay.width = Math.max(1, Math.round(w * k));
  sel.height = overlay.height = Math.max(1, Math.round(h * k));
  const start = host.outline();
  if (start) paintMask(selCtx, sel.width, sel.height, start);
  else selCtx.clearRect(0, 0, sel.width, sel.height);
  undo = [];
  trace = [];
  editing = true;
  setTool("add");
  status.textContent = start ? "Correct the green outline, then Apply." : "The automatic outline is still loading: you can paint it now.";
  show();
  layout();
  host.redraw();
}

function close(): void {
  editing = false;
  pointer = null;
  trace = [];
  undo = [];
  layout();
  host?.redraw();
}

overlay.addEventListener("pointerdown", (e) => {
  if (!editing || pointer !== null) return;
  e.preventDefault();
  pointer = e.pointerId;
  overlay.setPointerCapture(pointer);
  snapshot();
  last = at(e);
  if (tool === "trace") {
    trace = [last];
    show();
  } else stroke(last);
});
overlay.addEventListener("pointermove", (e) => {
  if (e.pointerId !== pointer) return;
  e.preventDefault();
  const p = at(e);
  if (tool === "trace") {
    trace.push(p);
    show();
  } else stroke(p);
});
const end = (e: PointerEvent) => {
  if (e.pointerId !== pointer) return;
  if (e.type === "pointercancel") {
    const prev = undo.pop();
    if (prev) selCtx.putImageData(prev, 0, 0);
  } else if (tool === "trace" && trace.length > 2) {
    selCtx.beginPath();
    trace.forEach(([x, y], i) => (i ? selCtx.lineTo(x, y) : selCtx.moveTo(x, y)));
    selCtx.closePath();
    selCtx.fillStyle = "#fff";
    selCtx.fill();
  }
  pointer = null;
  trace = [];
  show();
};
overlay.addEventListener("pointerup", end);
overlay.addEventListener("pointercancel", end);

panel.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button");
  if (!b || !host) return;
  if (b.dataset.tool) return setTool(b.dataset.tool as Tool);
  switch (b.dataset.action) {
    case "start":
      return open();
    case "undo": {
      const prev = undo.pop();
      if (prev) selCtx.putImageData(prev, 0, 0);
      return show();
    }
    case "reset": {
      const a = host.automatic();
      snapshot();
      if (a) paintMask(selCtx, sel.width, sel.height, a);
      else selCtx.clearRect(0, 0, sel.width, sel.height);
      status.textContent = a ? "Back to the automatic outline." : "No automatic outline yet.";
      return show();
    }
    case "cancel":
      status.textContent = "";
      return close();
    case "apply": {
      const mask = readMask(selCtx, sel.width, sel.height);
      let area = 0;
      for (const v of mask.data) area += v;
      // (a few pixels is a slip, not a body)
      if (area < 0.002 * mask.data.length) {
        status.textContent = "Paint the body before applying.";
        return;
      }
      host.apply(mask);
      status.textContent = "Your outline is used.";
      return close();
    }
    case "auto":
      host.apply(null);
      status.textContent = "The automatic outline is used.";
      return close();
  }
});

/** Place the overlay over the photo as the stage shows it (object-fit: contain), show the right controls. */
function layout(): void {
  const on = !!host && document.body.classList.contains("body-brush-on");
  tools.hidden = !editing;
  document.body.classList.toggle("body-brush-editing", on && editing);
  startBtn.hidden = editing;
  autoBtn.hidden = editing || !host?.manual();
  overlay.style.display = on && editing ? "block" : "none";
  if (!on || !editing || !host) return;
  const { w, h } = host.size();
  const W = dom.stageWrap.clientWidth, H = dom.stageWrap.clientHeight;
  const s = Math.min(W / w, H / h);
  Object.assign(overlay.style, { left: `${(W - w * s) / 2}px`, top: `${(H - h * s) / 2}px`, width: `${w * s}px`, height: `${h * s}px` });
}

/**
 * Show the Body Brush (photo mode of body shaping) or hide it. A new photo (`photoChanged`) closes
 * an open editor; its edits belonged to the old photo.
 */
export function syncBodyBrush(active: boolean, photoChanged = false): void {
  document.body.classList.toggle("body-brush-on", active);
  panel.hidden = !active;
  if ((photoChanged || !active) && editing) {
    status.textContent = "";
    close();
  }
  if (photoChanged) status.textContent = "";
  layout();
}

export function mountBodyBrush(h: BodyBrushHost, panelParent: HTMLElement, before: Element | null): void {
  host = h;
  dom.stageWrap.append(overlay);
  panelParent.insertBefore(panel, before);
  panel.hidden = true;
  new ResizeObserver(() => layout()).observe(dom.stageWrap);
}
