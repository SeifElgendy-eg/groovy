// Runs in vendor/mediapipe-pose/frame.html (a hidden frame of the app): see src/effects/body/mediapipe.ts.
(function () {
  let last = null;
  const pose = new Pose({ locateFile: (f) => f });
  pose.setOptions({ staticImageMode: true, modelComplexity: 1, smoothLandmarks: false, enableSegmentation: false, minDetectionConfidence: 0.3 });
  pose.onResults((r) => (last = r.poseLandmarks || null));
  const ready = pose.initialize();
  const canvas = document.createElement("canvas");
  window.poseReady = ready;
  /** Landmarks ([x, y, visibility] x 33, 0..1) of the body in `image` (w x h), or null. */
  window.findPose = async (image, w, h) => {
    await ready;
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(image, 0, 0, w, h);
    last = null;
    await pose.send({ image: canvas });
    return last && last.length >= 33 ? last.map((p) => [p.x, p.y, p.visibility ?? 0]) : null;
  };
})();
