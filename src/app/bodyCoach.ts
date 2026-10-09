// Body shaping on the live camera: checks the person's pose a few times a second and coaches them
// into the best one (effects/body/posture.ts). With hands-free capture on, holding a good pose
// still starts the countdown; breaking the pose during it stops it.
import { checkPosture, Stillness } from "../effects/body/posture";
import { setBodyCoach } from "../ui/bodyGuide";
import { dom } from "../ui/dom";
import { backdropCapturing } from "./backdrop";
import { body } from "./effects";
import { autoCaptureRunning, beginAutoCapture, cancelCountdown } from "./source";
import { state } from "./state";

/** Time between posture checks (each is a quick BodyPix pass on a small frame). */
const CHECK_MS = 300;
/** A good pose held this long starts the hands-free countdown (about two checks in a row). */
const HOLD_MS = 500;
/** Hands-free countdown, seconds. */
const AUTO_SECONDS = 2;
/** The hands-free countdown stops after this many checks in a row without a usable pose (one bad
 * reading of a noisy body point should not cancel it). */
const BREAK_CHECKS = 2;

let lastCheck = -Infinity;
let running = false;
// (body points from the quick small-frame pass jitter by a few percent of the height)
const stillness = new Stillness(0.07);
let broken = 0;

/** Hands-free capture is switched on in the body panel. */
const handsFree = () => dom.bodyHandsFree.checked;

/** Stop coaching (left the camera or the service). */
export function resetBodyCoach(): void {
  stillness.reset();
  broken = 0;
  lastCheck = -Infinity;
  setBodyCoach(null);
}

/** Called from the camera loop on every frame. */
export function bodyCoachTick(now: number): void {
  const live = state.module === "body" && state.sourceMode === "camera" && state.running;
  if (!live || backdropCapturing()) return;
  if (running || now - lastCheck < CHECK_MS) return;
  const { video } = dom;
  if (video.readyState < 2 || !video.videoWidth) return;
  // a countdown started with the button: the person is walking into place, leave it alone
  if (state.countdown !== null && !autoCaptureRunning()) {
    stillness.reset();
    return;
  }
  lastCheck = now;
  running = true;
  const w = video.videoWidth, h = video.videoHeight;
  void body
    .pose(video, w, h)
    .then((J) => {
      if (!J || state.module !== "body" || state.sourceMode !== "camera") return;
      const r = checkPosture(J, w, h, true);
      // A pose with only a tip left (arms a little further out, the feet) is good enough for the
      // photo: the tip is shown, the capture goes ahead.
      const held = r.ready ? stillness.update(J, performance.now()) : (stillness.reset(), 0);
      broken = r.ready ? 0 : broken + 1;
      if (autoCaptureRunning() && broken >= BREAK_CHECKS) cancelCountdown(); // the pose broke: start again when it is back
      const message = r.ok || !r.ready ? r.message : `Good. Hold still… Tip: ${r.message}`;
      setBodyCoach({ message, ok: r.ready });
      if (r.ready && held >= HOLD_MS && handsFree() && state.countdown === null) beginAutoCapture(AUTO_SECONDS);
    })
    .finally(() => (running = false));
}
