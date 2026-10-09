// Runs in vendor/mediapipe-pose/frame.html (a hidden frame of the app): see src/effects/body/mediapipe.ts.
(function () {
  // A file that does not load (the server does not serve it) stops MediaPipe without rejecting
  // initialize(): report it, so the app stops waiting and uses BodyPix's body points alone.
  let fail;
  window.poseFailed = new Promise((r) => (fail = r));
  window.addEventListener("error", (e) => fail(String(e.message || "error")));
  window.addEventListener("unhandledrejection", (e) => fail(String(e.reason)));
  let last = null;
  const pose = new Pose({ locateFile: (f) => f });
  pose.setOptions({ staticImageMode: true, modelComplexity: 1, smoothLandmarks: false, enableSegmentation: false, minDetectionConfidence: 0.3 });
  pose.onResults((r) => (last = r.poseLandmarks || null));
  const ready = pose.initialize();
  ready.catch((e) => fail(String(e)));
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
