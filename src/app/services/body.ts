// Weight loss (body shaping): the photo's body is analysed once (in a worker), then drawn at the
// sliders' strengths. Also owns body shaping's own overlays: the processing indicator, the Body
// Brush (hand-fixed outline) and the step panel.
import { readBodySettings } from "../../ui/controls";
import { dom } from "../../ui/dom";
import { setBodyProgress, type BodyProgress } from "../../ui/bodyProgress";
import { bodyBrushEditing, mountBodyBrush, syncBodyBrush } from "../../ui/bodyBrush";
import { syncBodyPanel } from "../../ui/bodyPanel";
import { noteWork } from "../activity";
import { body, bodyPerson } from "../effects";
import { getSourceDims, sourceCanvas } from "../frames";
import { state } from "../state";
import { bodyFindingStep, bodyStatus, type BodyFacts } from "../statusMessages";
import { redraw, settled, working, type Service } from "./service";

let analysisStart = 0;
let analysisMs = 0;
/** The photo the Body Brush was last shown for (a new one closes an open editor). */
let brushPhoto = -1;

/**
 * The indicator over the photo: shown only while the body is being processed; gone the moment the
 * result is ready (the photo is what matters then).
 */
function progress(): BodyProgress {
  if (body.busy || body.dirty) return { kind: "working", step: body.step ?? "Starting", since: analysisStart || performance.now() };
  return null;
}
body.onStep = () => setBodyProgress(progress());

/** One line in the console per analysis: what it found and used (for checking a kiosk). */
function logAnalysis(): void {
  if (body.failed) return console.info("body shaping: no full body found");
  console.info(
    `body shaping ready in ${(analysisMs / 1000).toFixed(1)} s: ${body.legs ? "arms, waist & legs" : "arms & waist (legs not in view)"}; ` +
      `body points ${body.pointsFrom === "both" ? "BodyPix + MediaPipe" : "BodyPix"}; outline ${body.outline}; backdrop ${body.backdropState}; ` +
      `strength ${body.strength.toFixed(2)} (cap ${body.cap.all.toFixed(2)}, arms ${body.cap.arms.toFixed(2)})`,
  );
}

const say = (facts: BodyFacts) => (dom.bodyStatus.textContent = bodyStatus(facts));

/** Start analysing the photo's body (`person`: the outline to use). */
function analyse(person: NonNullable<typeof bodyPerson.mask>): void {
  working();
  const start = (analysisStart = performance.now());
  void body
    .prepare(sourceCanvas, person, person === bodyPerson.manual)
    .then((ok) => {
      analysisMs = performance.now() - start;
      if (ok) noteWork("body analysis", analysisMs);
      logAnalysis();
    })
    .finally(settled);
}

export const bodyService: Service = {
  id: "body",
  sections: [dom.bodySection],
  active: () => Number(dom.bodySlider.value) > 0,
  invalidate: () => void (body.dirty = true),
  busy: () => body.busy,
  // the body models are large: ready in the background (prepare), or at the latest when chosen
  chosen: () => void body.warmUp(),
  prepare: () => body.warmUp(),
  holdsOriginal: bodyBrushEditing,

  sync(shown) {
    const onPhoto = shown && state.sourceMode === "photo";
    if (!onPhoto) setBodyProgress(null);
    syncBodyBrush(onPhoto, brushPhoto !== bodyPerson.photo);
    brushPhoto = bodyPerson.photo;
    if (shown) syncBodyPanel();
  },

  draw({ ctx, w, h }) {
    if (state.sourceMode !== "photo") return void say({ stage: "camera", handsFree: dom.bodyHandsFree.checked });
    // (an outline drawn by hand with the Body Brush replaces the automatic one)
    const person = bodyPerson.manual ?? bodyPerson.mask;
    const settings = readBodySettings();
    if (!person) {
      say({ stage: "finding", modelReady: state.modelReady });
      setBodyProgress({ kind: "working", step: bodyFindingStep(state.modelReady), since: performance.now() });
      return;
    }
    if (settings.overall <= 0) {
      say({ stage: "no-effect" });
      setBodyProgress(progress());
      if (!body.dirty || body.busy) return;
    }
    // A new photo while the last one is still being analysed: stop that analysis.
    if (body.dirty && body.busy) body.cancel();
    if (body.dirty && !body.busy) {
      say({ stage: "analysing" });
      analyse(person);
      setBodyProgress(progress());
      return;
    }
    setBodyProgress(progress());
    if (body.busy) return;
    if (body.failed) return void say({ stage: "failed" });
    say({
      stage: "ready",
      legsInView: body.legs,
      backdropMismatch: body.backdropState === "mismatch" && state.capturedPhoto,
      postureTip: body.posture && !body.posture.ok ? body.posture.message : null,
    });
    body.draw(ctx, w, h, settings);
  },
};

/** The Body Brush (ui/bodyBrush.ts): its outline in, the hand-made one out. */
export function setupBodyBrush(): void {
  const usedOutline = () => {
    const r = body.analysis;
    return r && body.ready ? { data: r.person, w: r.w, h: r.h } : null;
  };
  const slot = document.getElementById("bodyBrushSlot")!; // in "Booth setup and fixes"
  mountBodyBrush(
    {
      size: () => getSourceDims(),
      outline: () => usedOutline() ?? bodyPerson.manual ?? bodyPerson.mask,
      automatic: () => bodyPerson.mask,
      manual: () => bodyPerson.manual !== null,
      apply: (mask) => {
        bodyPerson.manual = mask;
        body.dirty = true;
        redraw();
      },
      redraw,
    },
    slot.parentElement!,
    slot,
  );
}
