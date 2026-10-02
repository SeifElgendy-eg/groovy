// MediaPipe FaceLandmarker (478-point mesh) index groups used by the effects.

export const OUTER_LIP = [
  61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84,
  181, 91, 146,
];
export const INNER_MOUTH = [
  78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, 324, 318, 402, 317, 14, 87,
  178, 88, 95,
];

export const NOSE_UNDERSIDE = [48, 64, 98, 97, 2, 326, 327, 294, 278];
export const EYE_RIGHT_CONTOUR = [33, 160, 158, 133, 153, 144];
export const EYE_LEFT_CONTOUR = [362, 385, 387, 263, 373, 380];

// Brows, outer-corner first. Left/right are the subject's.
export const BROWS = [
  [70, 63, 105, 66, 107, 55, 65, 52, 53, 46],
  [336, 296, 334, 293, 300, 276, 283, 282, 295, 285],
];

// Eyes, brows, outer lips and nose underside: never corrected by acne.
export const ACNE_EXCLUSION_CONTOURS = [
  EYE_RIGHT_CONTOUR,
  EYE_LEFT_CONTOUR,
  BROWS[0],
  BROWS[1],
  OUTER_LIP,
  NOSE_UNDERSIDE,
];

// Wrinkles: eyes and brows are guarded by guardContours() (full loops, grown to cover
// lashes / brow hair), so only the mouth and nose underside stay as plain contours.
export const WRINKLE_EXCLUSION_CONTOURS = [OUTER_LIP, NOSE_UNDERSIDE];

export const FACE_OVAL = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378,
  400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21,
  54, 103, 67, 109,
];
// Full lid loops, outer corner first (index 0), inner corner at index 8.
export const RIGHT_EYE = [
  33, 246, 161, 160, 159, 158, 157, 173, 133, 155, 154, 153, 145, 144, 163, 7,
];
export const LEFT_EYE = [
  263, 466, 388, 387, 386, 385, 384, 398, 362, 382, 381, 380, 374, 373, 390,
  249,
];

// Single-landmark anchors.
export const LM = {
  faceLeft: 234,
  faceRight: 454,
  foreheadTop: 10,
  chin: 152,
  noseTop: 6,
  noseBottom: 2,
  noseWingLeft: 98,
  noseWingRight: 327,
  eyeOuterRight: 33,
  eyeOuterLeft: 263,
} as const;
