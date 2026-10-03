// Draws the stage: which effect is active, what it needs, and the debug mask overlay.
// Per-service behaviour is looked up by module id (declarative facts live in effects/registry.ts).
import { needsWarp } from "../effects/lips/renderer";
import { metaOf, type ModuleId, type ServiceId } from "../effects/registry";
import type { SkinInput } from "../effects/skin/input";
import { readBotoxDoses, readLipParams } from "../ui/controls";
import { dom } from "../ui/dom";
import { acne, lipRenderer, segMask, skinBrightness, skinEffectMask, wrinkles } from "./effects";
import { drawForDisplay, getSourceDims, sourceCtx, sourceCanvas, stageCtx as ctx } from "./frames";
import { state } from "./state";
import { tracked } from "./activity";

type Draw = (w: number, h: number) => void;

// Everything the skin effects need from this app, as plain data.
function skinInput(w: number, h: number): SkinInput {
  return {
    drawFrame: (c, aw, ah) => drawForDisplay(c, aw, ah),
    segMask: segMask.canvas,
    landmarks: state.facePoints!,
    mirrored: state.sourceMode === "camera",
    w,
    h,
  };
}

function renderLips(w: number, h: number): void {
  if (!state.lipData) return;
  const params = readLipParams();
  if (needsWarp(params)) {
    // The warp samples the display-oriented frame (mirrored for the camera).
    sourceCtx.clearRect(0, 0, w, h);
    drawForDisplay(sourceCtx, w, h);
  }
  lipRenderer.render(ctx, sourceCanvas, state.lipData, params, w, h);
}

function renderSkin(w: number, h: number): void {
  const brightness = Number(dom.brightnessSlider.value) / 100;
  if (brightness <= 0) return;
  skinBrightness.draw(
    ctx,
    w,
    h,
    brightness,
    state.sourceMode === "camera",
    drawForDisplay,
    skinEffectMask.canvas,
  );
}

interface AsyncEffect {
  dirty: boolean;
  busy: boolean;
  ready: boolean;
  prepare(input: SkinInput): Promise<boolean>;
}

/**
 * Start the effect's (worker-side) preparation if its input changed. Returns whether a prepared
 * result for the current input is ready to draw; when one arrives later the stage redraws itself.
 * `body[data-effects-busy]` is set meanwhile, so tests can wait for the final picture.
 */
function ensurePrepared(effect: AsyncEffect, w: number, h: number): boolean {
  if (effect.dirty && !effect.busy) {
    document.body.dataset.effectsBusy = "1";
    void effect
      .prepare(skinInput(w, h))
      .catch((err) => console.error("effect preparation failed", err))
      .finally(() => {
        if (!acne.busy && !wrinkles.busy) delete document.body.dataset.effectsBusy;
        renderAll();
      });
  }
  return effect.ready;
}

function renderWrinkles(w: number, h: number): void {
  if (!state.skinMaskReady) return;
  const status = dom.wrinklesStatus;
  if (!state.facePoints) {
    status.textContent = state.modelReady
      ? "Face forward or choose a clear photo"
      : "Loading face model…";
    return;
  }
  status.textContent = "Compare Before and After to preview smoother skin.";
  const doses = readBotoxDoses();
  const any = Object.values(doses).some((d) => d > 0);
  if (!any && !dom.skinDebug.checked) return;
  const ready = ensurePrepared(wrinkles, w, h);
  // Photos: draw the native photo first. Camera frames are already on the stage.
  if (state.sourceMode === "photo") {
    ctx.save();
    ctx.globalAlpha = 1;
    drawForDisplay(ctx, w, h);
    ctx.restore();
  }
  if (ready) wrinkles.draw(ctx, doses);
}

function renderAcne(w: number, h: number): void {
  if (!state.skinMaskReady) return;
  if (!state.facePoints) {
    dom.acneStatus.textContent = state.modelReady
      ? "Face forward to preview the effect"
      : "Loading face model…";
    return;
  }
  dom.acneStatus.textContent =
    "Compare Before and After to preview reduced blemishes and redness";
  const amount = Number(dom.acneSlider.value) / 100;
  const scars = Number(dom.scarsSlider.value) / 100;
  const pores = Number(dom.poresSlider.value) / 100;
  const redness = Number(dom.rednessSlider.value) / 100;
  if (amount <= 0 && scars <= 0 && pores <= 0 && redness <= 0 && !dom.skinDebug.checked) return;
  const ready = ensurePrepared(acne, w, h);
  // Scars and pores are multiply/add layers: they need the photo itself on the stage underneath
  // (spot repairs alone are opaque patches and can sit over the <img>).
  if (state.sourceMode === "photo" && (scars > 0 || pores > 0 || redness > 0)) drawForDisplay(ctx, w, h);
  if (ready) acne.draw(ctx, w, h, amount, scars, pores, redness);
}

const effectRender: Partial<Record<ModuleId, Draw>> = {
  skin: renderSkin,
  lips: renderLips,
  acne: renderAcne,
  wrinkles: renderWrinkles,
};

const effectActive: Record<ServiceId, () => boolean> = {
  wrinkles: () => Object.values(readBotoxDoses()).some((d) => d > 0),
  acne: () =>
    Number(dom.acneSlider.value) > 0 ||
    Number(dom.scarsSlider.value) > 0 ||
    Number(dom.poresSlider.value) > 0 ||
    Number(dom.rednessSlider.value) > 0,
  skin: () => Number(dom.brightnessSlider.value) > 0,
  lips: () =>
    Number(dom.lipSlider.value) > 0 ||
    Number(dom.colorSlider.value) > 0 ||
    dom.lipDebug.checked,
};

const debugMasks: Partial<Record<ModuleId, () => HTMLCanvasElement | null>> = {
  acne: () => (acne.ready ? acne.maskCanvas : null),
  wrinkles: () => (wrinkles.ready ? wrinkles.maskCanvas : null),
  skin: () => skinEffectMask.canvas,
};

/** Whether the current settings change the picture (so the pipeline must run on camera frames). */
export function cameraNeedsEffect(): boolean {
  if (state.sourceMode === "camera") return false;
  if (state.showBefore || state.module === "home") return false;
  if (dom.skinDebug.checked && metaOf(state.module).usesSkinMask) return true;
  return effectActive[state.module]();
}

const debugCanvas = document.createElement("canvas");
const debugCtx = debugCanvas.getContext("2d")!;

function renderSkinDebug(w: number, h: number): void {
  if (
    !dom.skinDebug.checked ||
    !metaOf(state.module).usesSkinMask ||
    !state.facePoints
  )
    return;
  const actual = debugMasks[state.module]?.();
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
  if (state.sourceMode === "camera" && state.module === "skin") {
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
  ctx.clearRect(0, 0, w, h);
  if (state.sourceMode === "camera" && (!cameraNeedsEffect() || !state.faceAligned)) return;
  // Composite the effect over the exact captured frame used by the models.
  if (state.sourceMode === "camera") drawForDisplay(ctx, w, h);
  if (state.showBefore) return;
  if (metaOf(state.module).paintsBaseFrame && state.lipData)
    drawForDisplay(ctx, w, h);
  effectRender[state.module]?.(w, h);
  renderSkinDebug(w, h);
}
