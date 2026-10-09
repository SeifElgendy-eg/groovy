// MediaPipe Pose (the legacy solution, offline from vendor/mediapipe-pose/): a second opinion on the
// body points, checked against BodyPix's body parts in the worker (joints.ts). It runs in a hidden
// frame of the page (vendor/mediapipe-pose/frame.html): it draws with WebGL, so not in a worker, and
// its WebAssembly loader uses page globals that the app's other MediaPipe also uses. It works
// alongside BodyPix. Anything going wrong here only means BodyPix's points are used alone.

const FRAME = "vendor/mediapipe-pose/frame.html";
/** Longest wait for one photo, loading included (a stuck GPU must not hold the photo back). */
const TIMEOUT_MS = 10000;
/** Longest side of the image handed to MediaPipe (it looks at 256 px crops of it anyway). */
const LONG_SIDE = 1280;

/** [x, y, visibility] per landmark (x, y 0..1 of the image). */
export type Landmarks = number[][];

interface PoseFrame extends Window {
  poseReady: Promise<void>;
  findPose(image: CanvasImageSource, w: number, h: number): Promise<Landmarks | null>;
}

let ready: Promise<PoseFrame> | null = null;
/** One photo at a time. */
let queue: Promise<unknown> = Promise.resolve();

function load(base: string): Promise<PoseFrame> {
  if (!ready) {
    ready = new Promise<PoseFrame>((resolve, reject) => {
      const f = document.createElement("iframe");
      f.title = "body points";
      f.setAttribute("aria-hidden", "true");
      f.tabIndex = -1;
      f.style.cssText = "position:fixed;left:-10px;top:-10px;width:1px;height:1px;border:0;opacity:0;pointer-events:none";
      f.onload = () => {
        const w = f.contentWindow as PoseFrame | null;
        if (!w?.findPose) return reject(new Error("MediaPipe Pose did not load"));
        w.poseReady.then(() => resolve(w), reject);
      };
      f.onerror = () => reject(new Error("MediaPipe Pose frame did not load"));
      f.src = new URL(FRAME, base).href;
      document.body.appendChild(f);
    });
    ready.catch((err) => {
      console.warn("MediaPipe Pose unavailable (BodyPix's body points are used alone)", err);
      ready = null; // try again with the next photo
    });
  }
  return ready;
}

/** Load ahead of the first photo. */
export function warmUpPose(base: string): void {
  void load(base).catch(() => {});
}

/** The body's landmarks in this photo (w x h), or null (none found, or MediaPipe unavailable). */
export function findPose(base: string, image: CanvasImageSource, w: number, h: number): Promise<Landmarks | null> {
  const run = queue.then(async () => {
    let timer = 0;
    const timeout = new Promise<never>((_, reject) => (timer = window.setTimeout(() => reject(new Error("MediaPipe Pose timed out")), TIMEOUT_MS)));
    try {
      const k = Math.min(1, LONG_SIDE / Math.max(w, h));
      const lm = await Promise.race([load(base).then((f) => f.findPose(image, Math.round(w * k), Math.round(h * k))), timeout]);
      return lm && lm.length >= 33 ? lm : null;
    } catch (err) {
      console.warn("MediaPipe Pose failed on this photo", err);
      return null;
    } finally {
      clearTimeout(timer);
    }
  });
  queue = run;
  return run;
}
