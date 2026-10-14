// The one shape every service (lips, wrinkles, acne, skin, body) has for the rest of the app. The
// stage, the service switcher and the pipeline work through this interface and the list in
// ./index.ts; they never name a service. The effects themselves (src/effects) stay plain image code:
// each service here is the small adapter between its effect and the app (its controls, its status
// line, when it must re-analyse).
import type { ServiceId } from "../../effects/registry";
import type { SkinInput } from "../../effects/skin/input";
import { hidePhotoProcessingCue, showPhotoProcessingCue } from "../../ui/faceGuide";
import { drawForDisplay } from "../frames";
import { segMask } from "../effects";
import { state } from "../state";

/** The stage to draw on (the effect's canvas, at the photo's or the camera frame's size). */
export interface Stage {
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
}

export interface Service {
  readonly id: ServiceId;
  /** The control sections shown while this service is chosen. */
  readonly sections: HTMLElement[];
  /** The current settings change the picture (so the camera must run the effect). */
  active(): boolean;
  /** The face, mask or photo changed: re-analyse before the next draw. */
  invalidate(): void;
  /** An analysis is running. */
  busy(): boolean;
  /** Draw the effect onto the stage (the Before view never calls this). */
  draw(stage: Stage): void;
  /** On every redraw, whether this service is the one shown (to show or hide its own overlays). */
  sync?(shown: boolean): void;
  /** The stage shows the photo as it is for now (the body outline being edited by hand). */
  holdsOriginal?(): boolean;
  /** The area the effect works on, for the staff "show face mask" view (null: none yet). */
  debugMask?(): HTMLCanvasElement | null;
  /** That mask is in the camera's mirrored orientation. */
  readonly debugMaskMirrored?: boolean;
  /** The service was just chosen: start loading what it needs, set its starting controls. */
  chosen?(): void;
  /** Load and run its large models once, at start (while "Loading" shows, never mid-use). */
  prepare?(): Promise<void>;
}

/** What the services need from the stage without depending on it (set by app/render.ts). */
interface Host {
  redraw(): void;
  anyBusy(): boolean;
}
let host: Host = { redraw: () => {}, anyBusy: () => false };
export function connectServices(h: Host): void {
  host = h;
}
export const redraw = (): void => host.redraw();

/**
 * Some background work finished: when nothing else is running, clear `body[data-effects-busy]`
 * (tests wait on it for the final picture) and the processing cue; then redraw.
 */
export function settled(): void {
  if (!host.anyBusy()) {
    delete document.body.dataset.effectsBusy;
    hidePhotoProcessingCue();
  }
  host.redraw();
}

/** Background work started. */
export function working(cue?: string): void {
  if (cue) showPhotoProcessingCue(cue);
  document.body.dataset.effectsBusy = "1";
}

/** Everything the skin effects need from this app, as plain data. */
export function skinInput(w: number, h: number): SkinInput {
  return {
    drawFrame: (c, aw, ah) => drawForDisplay(c, aw, ah),
    segMask: segMask.canvas,
    landmarks: state.facePoints!,
    mirrored: state.sourceMode === "camera",
    w,
    h,
  };
}

/** A face effect analysed in a worker (wrinkles, acne). */
export interface PreparedEffect {
  dirty: boolean;
  busy: boolean;
  ready: boolean;
  prepare(input: SkinInput): Promise<boolean>;
  cancel(): void;
}

/**
 * Start the effect's (worker-side) preparation if its input changed. Returns whether a prepared
 * result for the current input is ready to draw; when one arrives later the stage redraws itself.
 * `cue`: the photo processing label to show meanwhile.
 */
export function ensurePrepared(effect: PreparedEffect, w: number, h: number, cue: string): boolean {
  // A new photo while the last one is still being worked on: stop that work (its result would be
  // thrown away) so the new one starts now rather than after it. (Live camera frames change all
  // the time: there the running work is left to finish.)
  if (effect.dirty && effect.busy && state.sourceMode === "photo") effect.cancel();
  if (effect.dirty && !effect.busy) {
    working(state.sourceMode === "photo" ? cue : undefined);
    void effect
      .prepare(skinInput(w, h))
      .catch((err) => console.error("effect preparation failed", err))
      .finally(settled);
  }
  return effect.ready;
}
