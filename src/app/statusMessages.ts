// Every status line the services show under their controls, in one place: pure functions from
// what the app knows (plain facts) to the words shown. No DOM, so they are unit-tested
// (tests/unit/statusMessages.test.ts) and the wording can be changed (or translated) here alone.

/** What the face services (wrinkles, acne) know when they draw. */
export interface FaceFacts {
  modelReady: boolean;
  faceFound: boolean;
}

export function wrinklesStatus(f: FaceFacts): string {
  if (!f.faceFound) return f.modelReady ? "Face forward or choose a clear photo" : "Loading face model…";
  return "Compare Before and After to preview smoother skin.";
}

export function acneStatus(f: FaceFacts): string {
  if (!f.faceFound) return f.modelReady ? "Face forward to preview the effect" : "Loading face model…";
  return "Compare Before and After to preview reduced blemishes and redness";
}

/** What body shaping knows when it draws. */
export type BodyFacts =
  | { stage: "camera"; handsFree: boolean }
  | { stage: "finding"; modelReady: boolean }
  | { stage: "no-effect" }
  | { stage: "analysing" }
  | { stage: "failed" }
  | {
      stage: "ready";
      legsInView: boolean;
      /** The empty backdrop was captured but no longer matches the camera view (camera photos). */
      backdropMismatch: boolean;
      /** A posture tip for next time (the photo was usable but not ideal), or null. */
      postureTip: string | null;
    };

/** Body shaping's status line (empty: nothing to say, the line is hidden). */
export function bodyStatus(f: BodyFacts): string {
  switch (f.stage) {
    case "camera":
      return f.handsFree ? "Hold still in the outline and the photo takes itself." : "When you are in the outline, press Take photo.";
    case "finding":
      return f.modelReady ? "Analysing the photo…" : "Loading models…";
    case "no-effect":
      return "Move the Weight loss slider to see the result.";
    case "analysing":
      return "Analysing the body…";
    case "failed":
      return "No full body found. Use a photo of the whole body, facing the camera.";
    case "ready": {
      const notes: string[] = [];
      if (!f.legsInView) notes.push("The knees are not in the photo, so the legs are left as they are.");
      if (f.backdropMismatch) notes.push("The empty backdrop no longer matches the camera view: capture it again in Booth setup.");
      if (f.postureTip) notes.push(`For a better result next time: ${f.postureTip}`);
      return notes.join(" ");
    }
  }
}

/** The step shown by the progress indicator over the photo while the body is found. */
export function bodyFindingStep(modelReady: boolean): string {
  return modelReady ? "Finding the person in the photo" : "Loading the models";
}

/** The empty backdrop's line in Booth setup (`capturedAt`: when, if known). */
export function backdropStatus(captured: boolean, capturedAt: Date | null): string {
  if (!captured) return "Not captured yet. With nobody in view, capture the empty booth once for the cleanest background around the body.";
  const at = capturedAt ? ` at ${capturedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "";
  return `Captured${at}. Capture again after moving the camera or changing the lights.`;
}

/** The backdrop button: what pressing it does now. */
export function backdropButton(counting: boolean, captured: boolean): string {
  return counting ? "Cancel" : captured ? "Capture again" : "Capture backdrop";
}
