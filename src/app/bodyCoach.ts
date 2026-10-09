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
/** A good pose held this long starts the hands-free countdown. */
const HOLD_MS = 900;
/** Hands-free countdown, seconds. */
const AUTO_SECONDS = 3;

let lastCheck = -Infinity;
let running = false;
const stillness = new Stillness();

/** Hands-free capture is switched on in the body panel. */
const handsFree = () => dom.bodyHandsFree.checked;

/** Stop coaching (left the camera or the service). */
export function resetBodyCoach(): void {
  stillness.reset();
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
      const held = r.ok ? stillness.update(J, performance.now()) : (stillness.reset(), 0);
      if (autoCaptureRunning() && !r.ok) cancelCountdown(); // the pose broke: start again when it is back
      setBodyCoach({ message: r.message, ok: r.ok });
      if (r.ok && held >= HOLD_MS && handsFree() && state.countdown === null) beginAutoCapture(AUTO_SECONDS);
    })
    .finally(() => (running = false));
}
