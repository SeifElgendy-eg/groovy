// "Is the face where the camera guide wants it?" - pure decision logic for the capture guide.
// Landmarks are normalised (0..1) MediaPipe points.
import type { NormalizedLandmark } from "../effects/skin/input";
import { LM } from "../core/landmarks";

export interface AlignmentState {
  /** Face centre seen on the previous frame, for the "hold still" check. */
  last: { cx: number; cy: number } | null;
  /** Consecutive frames that satisfied every check. */
  frames: number;
}

export interface AlignmentResult {
  state: AlignmentState;
  /** This frame satisfies every check. */
  valid: boolean;
  /** Stable for enough frames: the photo can be taken. */
  aligned: boolean;
  /** Guidance text for the user. */
  label: string;
}

export const INITIAL_ALIGNMENT: AlignmentState = { last: null, frames: 0 };
export const STABLE_FRAMES = 4;

export function evaluateAlignment(
  points: NormalizedLandmark[] | null,
  prev: AlignmentState,
): AlignmentResult {
  let message = "Position your face inside the oval",
    valid = false,
    last: AlignmentState["last"] = null;
  if (points) {
    const left = points[LM.faceLeft],
      right = points[LM.faceRight],
      top = points[LM.foreheadTop],
      bottom = points[LM.chin];
    const cx = (left.x + right.x) / 2,
      cy = (top.y + bottom.y) / 2;
    const fw = Math.hypot(left.x - right.x, left.y - right.y),
      fh = Math.abs(bottom.y - top.y);
    const moving =
      prev.last !== null &&
      Math.hypot(cx - prev.last.cx, cy - prev.last.cy) > 0.025;
    const turned =
      Math.abs(points[1].x - cx) > fw * 0.19 ||
      Math.abs(points[LM.eyeOuterRight].y - points[LM.eyeOuterLeft].y) > fh * 0.12;
    if (Math.abs(cx - 0.5) > 0.105 || Math.abs(cy - 0.48) > 0.13)
      message = "Move to the center of the oval";
    else if (fh < 0.46 || fw < 0.2) message = "Move closer";
    else if (fh > 0.88 || fw > 0.53) message = "Move back slightly";
    else if (turned) message = "Look straight ahead";
    else if (moving) message = "Hold still for a moment";
    else valid = true;
    last = { cx, cy };
  }
  const frames = valid ? prev.frames + 1 : 0;
  const aligned = valid && frames >= STABLE_FRAMES;
  const label = aligned
    ? "Face aligned — take photo"
    : valid
      ? "Hold still for a moment"
      : message;
  return { state: { last, frames }, valid, aligned, label };
}
