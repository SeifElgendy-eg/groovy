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

/** Head rotation in degrees (camera frame, un-mirrored image). */
export interface HeadPose {
  /** + = face turned toward the image's right. */
  yaw: number;
  /** + = chin up (looking up). */
  pitch: number;
  /** + = head tilted counter-clockwise in the image. */
  roll: number;
}

/**
 * How far from straight-on the head may be for a capture. A frontal photo reads -10..0 deg of
 * pitch (the model's neutral is slightly chin-down), so the pitch window is off-centre. Tilt
 * matters most for the forehead and under-eyes: tipped back, the forehead foreshortens and its
 * lines change; tipped down, the brows shade the under-eyes.
 */
export const POSE_LIMITS = { yaw: 12, pitchUp: 10, pitchDown: -18, roll: 8 };

/**
 * Head pose from MediaPipe's facial transformation matrix (4x4, column-major): the face's own
 * forward axis gives yaw and pitch, its right axis gives roll.
 */
export function headPose(matrix: ArrayLike<number>): HeadPose {
  const r = (i: number, j: number) => matrix[j * 4 + i];
  const fx = r(0, 2),
    fy = r(1, 2),
    fz = r(2, 2);
  const deg = 180 / Math.PI;
  return {
    yaw: Math.atan2(fx, fz) * deg,
    pitch: Math.atan2(fy, Math.hypot(fx, fz)) * deg,
    roll: Math.atan2(r(1, 0), r(0, 0)) * deg,
  };
}

export const INITIAL_ALIGNMENT: AlignmentState = { last: null, frames: 0 };
export const STABLE_FRAMES = 4;

export function evaluateAlignment(
  points: NormalizedLandmark[] | null,
  prev: AlignmentState,
  pose: HeadPose | null = null,
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
    // Without a pose (older callers), a rough check: nose off-centre or eyes not level.
    const roughTurn =
      !pose &&
      (Math.abs(points[1].x - cx) > fw * 0.19 ||
        Math.abs(points[LM.eyeOuterRight].y - points[LM.eyeOuterLeft].y) > fh * 0.12);
    const L = POSE_LIMITS;
    const poseMessage = !pose
      ? roughTurn
        ? "Look straight ahead"
        : ""
      : Math.abs(pose.yaw) > L.yaw
        ? "Turn your face to the camera"
        : pose.pitch > L.pitchUp
          ? "Lower your chin a little"
          : pose.pitch < L.pitchDown
            ? "Raise your chin a little"
            : Math.abs(pose.roll) > L.roll
              ? "Keep your head level"
              : "";
    if (Math.abs(cx - 0.5) > 0.105 || Math.abs(cy - 0.48) > 0.13)
      message = "Move to the center of the oval";
    else if (fh < 0.46 || fw < 0.2) message = "Move closer";
    else if (fh > 0.88 || fw > 0.53) message = "Move back slightly";
    else if (poseMessage) message = poseMessage;
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
