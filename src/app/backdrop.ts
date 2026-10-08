// The booth's empty backdrop for body shaping: staff capture it once with nobody in view (and again
// after moving the camera or changing the lights). Slimming then shows the real background where
// the body used to be, instead of stretching the background beside it (effects/body/backdrop.ts).
// Kept in IndexedDB so it survives a restart of the kiosk.
import { startCountdown, type Countdown } from "../core/countdown";
import { flashCapture, showCountdown } from "../ui/countdown";
import { dom } from "../ui/dom";
import { setStatus } from "../ui/status";
import { body } from "./effects";
import { grabFrame } from "./source";
import { state } from "./state";

/** Seconds to step out of view after pressing the button. */
const STEP_OUT_SECONDS = 5;
const DB = "groovy", STORE = "backdrop", KEY = "plate";

let countdown: Countdown | null = null;
let capturedAt: Date | null = null;

/** A backdrop capture is counting down (the posture coach stays quiet meanwhile). */
export const backdropCapturing = (): boolean => countdown !== null;

function showState(): void {
  const { bodyBackdropStatus, bodyBackdropBtn } = dom;
  bodyBackdropBtn.textContent = countdown ? "Cancel" : body.plate ? "Capture again" : "Capture backdrop";
  bodyBackdropStatus.textContent = body.plate
    ? `Captured${capturedAt ? ` at ${capturedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}. Capture again after moving the camera or changing the lights.`
    : "Not captured yet. With nobody in view, capture the empty booth once for the cleanest background around the body.";
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function save(canvas: HTMLCanvasElement, at: Date): Promise<void> {
  try {
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
    if (!blob) return;
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put({ blob, at: at.getTime() }, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (err) {
    console.warn("backdrop not saved", err);
  }
}

/** Load the backdrop saved earlier, if any. */
export async function loadBackdrop(): Promise<void> {
  showState();
  try {
    const db = await openDb();
    const rec = await new Promise<{ blob: Blob; at: number } | undefined>((resolve, reject) => {
      const req = db.transaction(STORE).objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    if (!rec || body.plate) return;
    const img = await createImageBitmap(rec.blob);
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    c.getContext("2d")!.drawImage(img, 0, 0);
    body.plate = c;
    capturedAt = new Date(rec.at);
  } catch (err) {
    console.warn("no saved backdrop", err);
  }
  showState();
}

/** Someone is (partly) in the frame: shoulders or face seen with some confidence. */
async function personInView(frame: HTMLCanvasElement): Promise<boolean | null> {
  for (let tries = 0; tries < 20; tries++) {
    const J = await body.pose(frame, frame.width, frame.height);
    if (J) return [0, 2, 5].some((i) => J[i * 3 + 2] > 0.5);
    await new Promise((r) => setTimeout(r, 150)); // the live posture check is running: wait for it
  }
  return null; // could not check
}

async function capture(): Promise<void> {
  const frame = grabFrame();
  const someone = await personInView(frame);
  if (someone === null) {
    setStatus("Could not check the backdrop: try again in a moment.", "error");
    return;
  }
  if (someone) {
    setStatus("Someone is still in view: step out of the camera's view and capture the backdrop again.", "error");
    return;
  }
  body.plate = frame;
  capturedAt = new Date();
  body.dirty = true;
  flashCapture();
  setStatus("Empty backdrop captured", "ready");
  showState();
  await save(frame, capturedAt);
}

/** The panel's backdrop button: count down so staff can step out of view, then capture. */
export function mountBackdrop(): void {
  dom.bodyBackdropBtn.addEventListener("click", () => {
    if (countdown) {
      countdown.cancel();
      return;
    }
    if (state.sourceMode !== "camera" || !state.running || dom.video.readyState < 2) {
      setStatus("Start the camera first, then capture the empty backdrop.", "error");
      return;
    }
    const end = () => {
      countdown = null;
      showCountdown(null);
      showState();
    };
    countdown = startCountdown(STEP_OUT_SECONDS, {
      onTick: (n) => showCountdown(n, false, "Step out of the camera's view"),
      onDone: () => {
        end();
        void capture();
      },
      onCancel: end,
    });
    showState();
  });
  void loadBackdrop();
}
