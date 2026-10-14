// Body slimming: where each pixel of the photo moves. Pure functions (no DOM), run in the body worker.
//
// Inputs, at a working resolution (the photo scaled so the person is about 800 px tall; the movement
// is smooth, so it is computed small and applied to the full photo by the GPU, see warp.ts):
//   - person: soft person mask (0..1) from the app's segmenter (arms it missed filled in by BodyPix)
//   - labels: BodyPix part per pixel (0..23, 255 = none): arms, hands, torso, legs, feet, face
//   - joints: 18 body points in OpenPose order (see JOINT below), from BodyPix's keypoints
//   - rgb: the photo's colours (to find whole hands)
//
// How the body slims (worked out on test photos; scripts/body/ measures any change):
//   - Torso and legs (the body without the arms): each row narrows toward the body's centre line
//     (the torso: a little over the chest and bust, full from the natural waist down, so the
//     waist-to-hip ratio stays) or toward each leg's own middle (full on the thighs, easing into the
//     knee, less on the calves, none at the ankles). The outer edges move smoothly from row to row.
//     Legs far from upright (crouching, a knee raised) are left as they are.
//   - Arms: each part (upper arm, forearm) narrows across its own direction, but only for an arm
//     hanging down (armHanging); the side lying against the body stays against it. An arm resting
//     on the body's side turns in with it (shoulder and elbow, two rigid pieces); a free arm stays.
//   - Hands move as one piece, as their wrist does, or with the body they rest on.
//   - One smooth warp: every pixel follows the arm's motion or the body's, softly blended at the
//     arm's edge. The background beside the person follows the person's edge and fades out with
//     distance; nothing moves at the photo's edges, and the picture never folds over itself
//     (unfold), whatever the sliders' mix.
//   - Slim builds get a smaller maximum than heavy ones (waist width relative to body height).
//
// The result is linear in the three strengths (arms, waist & hips, legs): the worker returns one
// unit field per area and the GPU adds them with the slider weights, so the sliders are instant.

//
// The code is split by concern in ./field/ (common, torso, arms, hands, sides, fields, shoulders,
// proportions, guard); this file is the public face the worker, the effect and the tests import.
export { JOINT, JOINT_COUNT, UNFOLD_MIN_SCALE, FULL, TUNING, type BodyInput, type BodyFields, sstep, blur, distanceTransform, runsOf, noseToAnkles, pointsSeen, anklesSeen } from "./field/common";
export { waistRatio, waistY } from "./field/torso";
export { armHanging, frontOfBody } from "./field/arms";
export { type HandShape, handShapes, rigidHands, growHands } from "./field/hands";
export { jointsBySide, armsBySide } from "./field/sides";
export { bodyFields } from "./field/fields";
export { shoulderShift } from "./field/shoulders";
export { proportionStrength } from "./field/proportions";
export { CAP, strengthCaps, unfold } from "./field/guard";
