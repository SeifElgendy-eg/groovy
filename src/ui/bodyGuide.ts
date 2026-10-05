// The "how to stand" guide shown over the live camera for body shaping: a standing outline to fit
// the whole body into, a ring for the feet, and the four things that make the analysis work.
// It replaces the face oval in that service (see updateFaceGuide in faceGuide.ts).
import { getSourceDims } from "../app/frames";
import { dom } from "./dom";
import { FEET_RING, GUIDE_VIEWBOX, silhouettePath } from "./bodySilhouette";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Free space needed on each side of the outline for the steps card; narrower stages get a one-line hint. */
const CARD_MIN_SIDE = 216;

const STEPS: [title: string, detail: string][] = [
  ["Face the camera", "Stand straight and look ahead."],
  ["Arms slightly away", "Leave a small gap between your arms and your body."],
  ["Feet a little apart", "Weight even, as in the outline."],
  ["Whole body in the guide", "Keep your whole body roughly inside; a little extra space is okay."],
];

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

function buildFigure(): HTMLDivElement {
  const box = document.createElement("div");
  box.className = "body-guide";
  box.hidden = true;
  const root = svg("svg", {
    viewBox: `0 0 ${GUIDE_VIEWBOX.w} ${GUIDE_VIEWBOX.h}`,
    role: "img",
    "aria-label": "Outline of a person standing facing the camera, arms slightly away from the body, feet a little apart",
  });
  const defs = svg("defs", {});
  const grad = svg("linearGradient", { id: "bodyGuideRing", x1: 0, y1: 0, x2: 1, y2: 0 });
  grad.append(svg("stop", { offset: "0", "stop-color": "#edbdcf" }), svg("stop", { offset: "1", "stop-color": "#a98be0" }));
  defs.append(grad);
  const { cx, cy, rx, ry } = FEET_RING;
  root.append(
    defs,
    svg("ellipse", { class: "body-guide-pad", cx, cy, rx: rx * 0.55, ry: ry * 0.5 }),
    svg("ellipse", { class: "body-guide-ring", cx, cy, rx, ry }),
    svg("path", { class: "body-guide-figure", d: silhouettePath() }),
  );
  box.append(root);
  return box;
}

function buildTips(): HTMLDivElement {
  const card = document.createElement("div");
  card.className = "body-guide-tips";
  card.hidden = true;
  const title = document.createElement("strong");
  title.textContent = "How to stand";
  const list = document.createElement("ol");
  for (const [head, detail] of STEPS) {
    const li = document.createElement("li");
    const b = document.createElement("b");
    b.textContent = head;
    const span = document.createElement("span");
    span.textContent = detail;
    li.append(b, span);
    list.append(li);
  }
  const note = document.createElement("p");
  note.textContent = "Close-fitting clothes give the best result.";
  card.append(title, list, note);
  return card;
}

const figure = buildFigure();
const tips = buildTips();
const hint = document.createElement("div");
hint.className = "face-guide-label body-guide-hint";
hint.textContent = "Face the camera · arms slightly away · feet a little apart · whole body inside the outline";
hint.hidden = true;

const zone = document.createElement("div");
zone.className = "body-guide-zone";
zone.hidden = true;

export function mountBodyGuide(): void {
  dom.stageWrap.append(zone, figure, tips, hint);
}

/** Size/position key of the last layout, so the per-frame calls do not touch the DOM needlessly. */
let lastKey = "";

/** Show the guide over the live camera (`active`) or hide it. Called from updateFaceGuide. */
export function updateBodyGuide(active: boolean): void {
  const { stageWrap } = dom;
  stageWrap.classList.toggle("body-guide-on", active);
  if (!active) {
    stageWrap.classList.remove("body-guide-roomy");
    zone.hidden = figure.hidden = tips.hidden = hint.hidden = true;
    lastKey = "";
    return;
  }
  const W = stageWrap.clientWidth, H = stageWrap.clientHeight;
  const { w, h } = getSourceDims();
  const key = `${W}x${H}:${w}x${h}`;
  figure.hidden = false;
  if (key === lastKey) return;
  lastKey = key;
  // The outline is sized from the picture the camera shows (letterboxed in the stage), centred.
  const scale = Math.min(W / w, H / h);
  const dw = w * scale;
  const dh = h * scale;
  const imageLeft = (W - dw) / 2;
  const imageTop = (H - dh) / 2;
  const gh = dh * 0.88;
  const gw = (gh * GUIDE_VIEWBOX.w) / GUIDE_VIEWBOX.h;
  figure.style.width = `${gw}px`;
  figure.style.height = `${gh}px`;
  figure.style.left = `${imageLeft + (dw - gw) / 2}px`;
  figure.style.top = `${imageTop + dh * 0.06}px`;

  // The safe zone is an intentionally generous target area, but it must stay inside the actual
  // displayed image so it never suggests standing in a letterbox bar.
  const maxZoneW = Math.max(0, dw - 24);
  const maxZoneH = Math.max(0, dh - 24);
  if (maxZoneW <= 0 || maxZoneH <= 0) {
    zone.hidden = true;
  } else {
    const zoneW = Math.min(maxZoneW, Math.max(gw + 120, dw * 0.72));
    const zoneH = Math.min(maxZoneH, dh * 0.92);
    zone.style.width = `${zoneW}px`;
    zone.style.height = `${zoneH}px`;
    zone.style.left = `${imageLeft + (dw - zoneW) / 2}px`;
    zone.style.top = `${imageTop + (dh - zoneH) / 2}px`;
    zone.hidden = false;
  }

  const side = Math.max(0, (dw - gw) / 2);
  const roomy = side >= CARD_MIN_SIDE;
  stageWrap.classList.toggle("body-guide-roomy", roomy);
  tips.hidden = !roomy;
  hint.hidden = roomy;
  if (roomy) tips.style.width = `${Math.min(320, side - 24)}px`;
}
