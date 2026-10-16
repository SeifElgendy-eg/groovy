// Draws the stage: the chosen service's effect over the photo or camera frame, and the staff debug
// mask overlay. Every service is reached through the Service interface (app/services); declarative
// facts about them live in effects/registry.ts.
import { usesSkinMask } from "../effects/registry";
import { dom } from "../ui/dom";
import { drawForDisplay, getSourceDims, stageCtx as ctx } from "./frames";
import { allServices, anyBusy, services } from "./services";
import { connectServices } from "./services/service";
import { state } from "./state";
import { tracked } from "./activity";

connectServices({ redraw: () => renderAll(), anyBusy });

/** The chosen service, or null on the home screen. */
const current = () => (state.module === "home" ? null : services[state.module]);

/** Whether the current settings change the picture (so the pipeline must run on camera frames). */
export function cameraNeedsEffect(): boolean {
  if (state.sourceMode === "camera") return false;
  const service = current();
  if (state.showBefore || !service) return false;
  if (dom.skinDebug.checked && usesSkinMask(state.module)) return true;
  return service.active();
}

const debugCanvas = document.createElement("canvas");
const debugCtx = debugCanvas.getContext("2d")!;

/** Staff view ("Show face mask"): the effect's area tinted green over the stage. */
function renderSkinDebug(w: number, h: number): void {
  const service = current();
  if (!service || !dom.skinDebug.checked || !usesSkinMask(state.module) || !state.facePoints) return;
  const actual = service.debugMask?.();
  if (!actual) return;
  const mw = actual.width,
    mh = actual.height;
  if (!mw || !mh) return;
  debugCanvas.width = mw;
  debugCanvas.height = mh;
  const source = actual.getContext("2d")!.getImageData(0, 0, mw, mh).data;
  const pixels = debugCtx.createImageData(mw, mh);
  for (let y = 0; y < mh; y++)
    for (let x = 0; x < mw; x++) {
      const i = (y * mw + x) * 4;
      if (source[i + 3] === 0) continue;
      pixels.data[i] = 80;
      pixels.data[i + 1] = 255;
      pixels.data[i + 2] = 150;
      pixels.data[i + 3] = (80 * source[i + 3]) / 255;
    }
  debugCtx.putImageData(pixels, 0, 0);
  ctx.save();
  if (state.sourceMode === "camera" && service.debugMaskMirrored) {
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(debugCanvas, 0, 0, w, h);
  ctx.restore();
}

export function renderAll(): void {
  tracked.sync("drawing the effect", drawStage);
}

function drawStage(): void {
  const { w, h } = getSourceDims();
  if (!w || !h) return;
  const service = current();
  for (const s of allServices) s.sync?.(s === service);
  ctx.clearRect(0, 0, w, h);
  if (state.sourceMode === "camera" && (!cameraNeedsEffect() || !state.faceAligned)) return;
  // Composite the effect over the exact captured frame used by the models.
  if (state.sourceMode === "camera") drawForDisplay(ctx, w, h);
  if (!service || service.holdsOriginal?.()) return;
  if (state.showBefore) return void service.drawBefore?.({ ctx, w, h });
  service.draw({ ctx, w, h });
  renderSkinDebug(w, h);
}
