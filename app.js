import { reduceWrinkles, wrinkleRegions } from "./wrinkles.js?v=95";
import { faceOval, guardContours, refineSkinMask } from "./facemask.js?v=1";
import { repairBlemishes, insetSkinMask } from "./acne.js?v=78";
import {
  FilesetResolver,
  ImageSegmenter,
  FaceLandmarker,
} from "./vendor/mediapipe/vision_bundle.mjs";

const MP_BASE = "./vendor/mediapipe";
const FACE_MODEL = "./models/face_landmarker.task";

const OUTER_LIP = [
  61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84,
  181, 91, 146,
];
const INNER_MOUTH = [
  78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, 324, 318, 402, 317, 14, 87,
  178, 88, 95,
];

// Eyes, brows, outer lips and nose underside: never corrected by acne or wrinkles.
const EXCLUSION_CONTOURS = [
  [33, 160, 158, 133, 153, 144],
  [362, 385, 387, 263, 373, 380],
  [70, 63, 105, 66, 107, 55, 65, 52, 53, 46],
  [336, 296, 334, 293, 300, 276, 283, 282, 295, 285],
  OUTER_LIP,
  [48, 64, 98, 97, 2, 326, 327, 294, 278],
];
// Wrinkles: eyes and brows are guarded by facemask.js guardContours() (full loops, grown to
// cover lashes / brow hair), so only the mouth and nose underside stay as plain contours.
const WRINKLE_EXCLUSIONS = [OUTER_LIP, [48, 64, 98, 97, 2, 326, 327, 294, 278]];

const SEG_MODEL = "./models/selfie_multiclass_256x256.tflite";
const skinDebug = document.getElementById("skinDebug");
const skinDebugSection = document.getElementById("skinDebugSection");
const debugCanvas = document.createElement("canvas"),
  debugCtx = debugCanvas.getContext("2d");
const acneSection = document.getElementById("acneSection");
const acneSlider = document.getElementById("acneSlider");
const acneValue = document.getElementById("acneValue");
const acneStatus = document.getElementById("acneStatus");
const acneCanvas = document.createElement("canvas"),
  acneWork = document.createElement("canvas"),
  acneBlur = document.createElement("canvas"),
  acneMask = document.createElement("canvas");
const acneCtx = acneCanvas.getContext("2d"),
  acneWorkCtx = acneWork.getContext("2d", { willReadFrequently: true }),
  acneBlurCtx = acneBlur.getContext("2d", { willReadFrequently: true }),
  acneMaskCtx = acneMask.getContext("2d", { willReadFrequently: true });
let facePoints = null,
  photoKind = "upload",
  acneDirty = true,
  acneLastFrame = 0;
const wrinklesSection = document.getElementById("wrinklesSection"),
  wrinklesSlider = document.getElementById("wrinklesSlider"),
  wrinklesValue = document.getElementById("wrinklesValue");
const wrinklesCanvas = document.createElement("canvas"),
  wrinklesMulCanvas = document.createElement("canvas"),
  wrinklesWork = document.createElement("canvas"),
  wrinklesMask = document.createElement("canvas");
const wrinklesCtx = wrinklesCanvas.getContext("2d"),
  wrinklesMulCtx = wrinklesMulCanvas.getContext("2d"),
  wrinklesWorkCtx = wrinklesWork.getContext("2d", { willReadFrequently: true }),
  wrinklesMaskCtx = wrinklesMask.getContext("2d", { willReadFrequently: true });
let wrinklesDirty = true,
  wrinklesLastFrame = 0;
function sampleKind() {
  return currentModule === "acne"
    ? "sample-acne"
    : currentModule === "wrinkles"
      ? "sample-wrinkles"
      : "sample";
}
function syncWrinklesPreset() {
  const value = Number(wrinklesSlider.value);
  let label = "Custom";
  document.querySelectorAll("[data-wrinkles-preset]").forEach((btn) => {
    const active = Number(btn.dataset.wrinklesPreset) === value;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", String(active));
    if (active) label = btn.textContent;
  });
  wrinklesValue.textContent = `${value}%`;
  document.getElementById("wrinklesSelection").textContent =
    `Selected: ${label} · ${value}%`;
}
const skinSection = document.getElementById("skinSection");
const chooseSkinBtn = document.getElementById("chooseSkinBtn");
const brightnessSlider = document.getElementById("brightnessSlider");
const brightnessValue = document.getElementById("brightnessValue");
const skinEffectMask = document.createElement("canvas");
const skinEffectMaskCtx = skinEffectMask.getContext("2d");
const maskCanvas = document.createElement("canvas");
const maskCtx = maskCanvas.getContext("2d");
const skinCanvas = document.createElement("canvas");
const skinCtx = skinCanvas.getContext("2d");
const video = document.getElementById("video");
const photo = document.getElementById("photo");
const stage = document.getElementById("stage");
const ctx = stage.getContext("2d");

const cameraBtn = document.getElementById("cameraBtn");
const fileInput = document.getElementById("fileInput");
const fileInputOverlay = document.getElementById("fileInputOverlay");
const sampleBtn = document.getElementById("sampleBtn");
const sampleBtnOverlay = document.getElementById("sampleBtnOverlay");
const stageWrap = document.getElementById("stageWrap");
const liveBadge = document.getElementById("liveBadge");
const startBtn = document.getElementById("startBtn");
const overlay = document.getElementById("overlay");

const sourceBadge = document.getElementById("sourceBadge");
const faceBadge = document.getElementById("faceBadge");
const perfBadge = document.getElementById("perfBadge");

const beforeBtn = document.getElementById("beforeBtn");
const resetBtn = document.getElementById("resetBtn");
const chooseLipsBtn = document.getElementById("chooseLipsBtn");
const backHomeBtn = document.getElementById("backHomeBtn");
const moduleHome = document.getElementById("moduleHome");
const moduleHeader = document.getElementById("moduleHeader");
const compareSection = document.getElementById("compareSection");
const lipsSection = document.getElementById("lipsSection");
const colorSection = document.getElementById("colorSection");
const resetSection = document.getElementById("resetSection");
const moduleTitle = document.getElementById("moduleTitle");
const moduleEyebrow = document.getElementById("moduleEyebrow");

const lipSlider = document.getElementById("lipSlider");
const verticalSlider = document.getElementById("verticalSlider");
const blendSlider = document.getElementById("blendSlider");
const colorSlider = document.getElementById("colorSlider");

const lipValue = document.getElementById("lipValue");
const verticalValue = document.getElementById("verticalValue");
const blendValue = document.getElementById("blendValue");
const colorValue = document.getElementById("colorValue");

const lipDebug = document.getElementById("lipDebug");
const presetBtns = [...document.querySelectorAll(".preset-btn")];
const shadeBtns = [...document.querySelectorAll(".shade-btn")];

let segmenter = null,
  faceLandmarker = null,
  modelReady = false,
  modelMode = "IMAGE";
let stream = null,
  running = false,
  sourceMode = "camera",
  showBefore = false;
let lipData = null;
let faceAligned = false,
  alignmentFrames = 0,
  lastAlignment = null;
let capturedPhoto = false,
  capturingPhoto = false;
const captureBtn = document.createElement("button");
captureBtn.className = "primary capture-photo";
captureBtn.textContent = "Take photo";
captureBtn.hidden = true;
stageWrap.append(captureBtn);
captureBtn.addEventListener("click", async () => {
  if (capturingPhoto || sourceMode !== "camera" || video.readyState < 2) return;
  capturingPhoto = true;
  captureBtn.disabled = true;
  try {
    const still = document.createElement("canvas");
    still.width = video.videoWidth;
    still.height = video.videoHeight;
    const c = still.getContext("2d");
    c.translate(still.width, 0);
    c.scale(-1, 1);
    c.drawImage(video, 0, 0);
    const blob = await new Promise((resolve) =>
      still.toBlob(resolve, "image/png"),
    );
    if (!blob) throw new Error("Unable to capture photo. Please try again.");
    showBefore = false;
    syncBefore();
    capturedPhoto = true;
    await handlePhoto(
      new File([blob], "camera-photo.png", { type: "image/png" }),
    );
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    capturingPhoto = false;
    captureBtn.disabled = false;
  }
});
const faceGuide = document.createElement("div");
faceGuide.className = "face-guide";
const faceGuideLabel = document.createElement("div");
faceGuideLabel.className = "face-guide-label";
faceGuideLabel.textContent = "Position your face inside the oval";
stageWrap.append(faceGuide, faceGuideLabel);
function updateFaceGuide(points) {
  const camera = sourceMode === "camera" && currentModule !== "home";
  faceGuide.hidden = faceGuideLabel.hidden = !camera;
  captureBtn.hidden = !camera || !running;
  captureBtn.disabled = capturingPhoto || video.readyState < 2;
  if (!camera) return;
  const { w, h } = getSourceDims();
  const scale = Math.min(stageWrap.clientWidth / w, stageWrap.clientHeight / h);
  const dw = w * scale,
    dh = h * scale;
  faceGuide.style.width = `${dw * 0.44}px`;
  faceGuide.style.height = `${dh * 0.82}px`;
  faceGuide.style.left = `${(stageWrap.clientWidth - dw) / 2 + dw * 0.28}px`;
  faceGuide.style.top = `${(stageWrap.clientHeight - dh) / 2 + dh * 0.07}px`;
  let message = "Position your face inside the oval",
    valid = false;
  if (points) {
    const left = points[234],
      right = points[454],
      top = points[10],
      bottom = points[152];
    const cx = (left.x + right.x) / 2,
      cy = (top.y + bottom.y) / 2;
    const fw = Math.hypot(left.x - right.x, left.y - right.y),
      fh = Math.abs(bottom.y - top.y);
    const moving =
      lastAlignment &&
      Math.hypot(cx - lastAlignment.cx, cy - lastAlignment.cy) > 0.025;
    const turned =
      Math.abs(points[1].x - cx) > fw * 0.19 ||
      Math.abs(points[33].y - points[263].y) > fh * 0.12;
    if (Math.abs(cx - 0.5) > 0.105 || Math.abs(cy - 0.48) > 0.13)
      message = "Move to the center of the oval";
    else if (fh < 0.46 || fw < 0.2) message = "Move closer";
    else if (fh > 0.88 || fw > 0.53) message = "Move back slightly";
    else if (turned) message = "Look straight ahead";
    else if (moving) message = "Hold still for a moment";
    else valid = true;
    lastAlignment = { cx, cy };
  } else lastAlignment = null;
  alignmentFrames = valid ? alignmentFrames + 1 : 0;
  faceAligned = valid && alignmentFrames >= 4;
  faceGuide.classList.toggle("aligned", faceAligned);
  faceGuideLabel.textContent = faceAligned
    ? "Face aligned — take photo"
    : valid
      ? "Hold still for a moment"
      : message;
}
window.addEventListener("resize", () => updateFaceGuide(facePoints));
let processing = false,
  processingPending = false,
  skinMaskReady = false;
let procFrames = 0;
let procWindow = performance.now();
let selectedShade = "off";
let selectedShadeHex = "";
let currentModule = "home";

const cameraSnapshot = document.createElement("canvas");
const cameraSnapshotCtx = cameraSnapshot.getContext("2d");
const sourceCanvas = document.createElement("canvas");
const sourceCtx = sourceCanvas.getContext("2d");

const lipMaskCanvas = document.createElement("canvas");
const lipMaskCtx = lipMaskCanvas.getContext("2d");
const lipSourceCanvas = document.createElement("canvas");
const lipSourceCtx = lipSourceCanvas.getContext("2d");
const lipFeatherCanvas = document.createElement("canvas");
const lipFeatherCtx = lipFeatherCanvas.getContext("2d");
const lipColorCanvas = document.createElement("canvas");
const lipColorCtx = lipColorCanvas.getContext("2d");

function setStatus(_text, _type = "loading") {
  // Status UI has been removed; keep this function as a no-op
  // so existing loading/camera flow remains unchanged.
}

function setSourceMode(mode) {
  sourceMode = mode;
  const cam = mode === "camera";
  cameraBtn.classList.toggle("active", cam);
  sourceBadge.textContent = `SOURCE — ${cam ? "CAMERA" : "PHOTO"}`;
  video.style.display = cam ? "block" : "none";
  photo.style.display = cam ? "none" : "block";
  stageWrap.classList.toggle("camera-mode", cam);
  stageWrap.classList.toggle("photo-mode", !cam);
  liveBadge.classList.toggle("hidden", !cam);
  perfBadge.textContent = cam ? "PROC -- fps" : "PHOTO READY";
  cameraBtn.textContent = cam
    ? "Camera"
    : capturedPhoto
      ? "Retake photo"
      : "Back to camera";
}

function syncBefore() {
  beforeBtn.classList.toggle("active", showBefore);
  beforeBtn.textContent = showBefore
    ? "Showing Before — Show After"
    : "Show Before";
}

function syncAcnePreset() {
  const value = Number(acneSlider.value);
  let label = "Custom";
  document.querySelectorAll("[data-acne-preset]").forEach((btn) => {
    const selected = Number(btn.dataset.acnePreset) === value;
    btn.classList.toggle("active", selected);
    btn.setAttribute("aria-pressed", String(selected));
    if (selected) label = btn.textContent;
  });
  document.getElementById("acneSelection").textContent =
    `Selected: ${label} · ${value}%`;
}

function syncPreset() {
  const v = Number(lipSlider.value);
  presetBtns.forEach((btn) => {
    btn.classList.toggle("active", Number(btn.dataset.lipPreset) === v);
  });
}

function syncShadeButtons() {
  shadeBtns.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.shade === selectedShade);
  });
}

function showEl(el, show) {
  el.classList.toggle("hidden-section", !show);
}

function setModule(moduleName) {
  currentModule = moduleName;
  faceAligned = false;
  alignmentFrames = 0;
  lastAlignment = null;
  updateFaceGuide(null);
  document.body.classList.toggle("home-screen", moduleName === "home");
  const isHome = moduleName === "home";
  const isLips = moduleName === "lips";

  showEl(moduleHome, isHome);
  showEl(moduleHeader, !isHome);
  showEl(backHomeBtn, !isHome);
  showEl(compareSection, !isHome);
  showEl(resetSection, !isHome);
  showEl(skinDebugSection, ["skin", "acne", "wrinkles"].includes(moduleName));
  showEl(wrinklesSection, moduleName === "wrinkles");
  showEl(acneSection, moduleName === "acne");
  showEl(skinSection, moduleName === "skin");
  showEl(lipsSection, isLips);
  showEl(colorSection, isLips);

  if (moduleName === "wrinkles") {
    wrinklesSlider.value = 100;
    syncWrinklesPreset();
    moduleEyebrow.textContent = "WRINKLES";
    moduleTitle.textContent = "Botox (wrinkles)";
  } else if (moduleName === "acne") {
    moduleEyebrow.textContent = "ACNE";
    moduleTitle.textContent = "Acne Treatment";
  } else if (moduleName === "skin") {
    moduleEyebrow.textContent = "SKIN";
    moduleTitle.textContent = "Skin Brightness";
  } else if (isLips) {
    moduleEyebrow.textContent = "LIPS";
    moduleTitle.textContent = "Filler (lips)";
  } else {
    moduleEyebrow.textContent = "SERVICE";
    moduleTitle.textContent = "Choose a service";
  }

  sampleBtn.textContent =
    moduleName === "acne"
      ? "Test Photo · Acne"
      : moduleName === "wrinkles"
        ? "Test Photo · Wrinkles"
        : "Test Photo";
  showBefore = false;
  syncBefore();
  acneDirty = true;
  wrinklesDirty = true;
  if (
    moduleName !== "home" &&
    sourceMode === "photo" &&
    photoKind.startsWith("sample")
  ) {
    const desired = sampleKind();
    if (photoKind !== desired) {
      loadSamplePhoto();
      return;
    }
  }
  if (moduleName !== "home" && sourceMode === "photo") {
    // Uploaded/captured photos are retained between services, but their skin
    // mask may not exist when the first service was lips.
    return processCurrentSource().then(() => renderAll());
  }
  renderAll();
}

function getVisibleSource() {
  return sourceMode === "photo" ? photo : video;
}

function getSourceDims() {
  if (sourceMode === "photo" && photo.naturalWidth) {
    return { w: photo.naturalWidth, h: photo.naturalHeight };
  }
  const vw = video.videoWidth || 1280,
    vh = video.videoHeight || 720;
  const scale = Math.min(1, 640 / Math.max(vw, vh));
  return { w: Math.round(vw * scale), h: Math.round(vh * scale) };
}

function ensureSizes(w, h) {
  for (const c of [
    stage,
    skinCanvas,
    sourceCanvas,
    lipMaskCanvas,
    lipSourceCanvas,
    lipFeatherCanvas,
    lipColorCanvas,
  ]) {
    c.width = w;
    c.height = h;
  }
}

function drawForDisplay(targetCtx, w, h, filter = "none") {
  const src = sourceMode === "camera" ? cameraSnapshot : getVisibleSource();
  targetCtx.save();
  targetCtx.filter = filter;
  if (sourceMode === "camera") {
    targetCtx.translate(w, 0);
    targetCtx.scale(-1, 1);
  }
  targetCtx.drawImage(src, 0, 0, w, h);
  targetCtx.restore();
  targetCtx.filter = "none";
}

function boundsOfPoints(pts) {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity,
    sx = 0,
    sy = 0;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
    sx += p.x;
    sy += p.y;
  }
  return {
    minX,
    minY,
    maxX,
    maxY,
    cx: sx / pts.length,
    cy: sy / pts.length,
    width: maxX - minX,
    height: maxY - minY,
  };
}

function bellWeight(x, minX, maxX) {
  const t = Math.max(0, Math.min(1, (x - minX) / Math.max(1, maxX - minX)));
  return Math.pow(Math.sin(Math.PI * t), 1.45);
}

function addClosedContour(context, pts) {
  if (!pts.length) return;
  context.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) context.lineTo(pts[i].x, pts[i].y);
  context.closePath();
}

// Punch feature contours out of a mask canvas (caller sets destination-out).
function carveContours(context, contours, points, lineWidth) {
  context.lineJoin = "round";
  context.lineWidth = lineWidth;
  for (const ids of contours) {
    context.beginPath();
    addClosedContour(
      context,
      ids.map((i) => points[i]),
    );
    context.fill();
    context.stroke();
  }
}

function setShade(name, hex) {
  selectedShade = name;
  selectedShadeHex = hex || "";
  if (name !== "off" && Number(colorSlider.value) === 0) {
    colorSlider.value = 28;
    colorValue.textContent = "28%";
  }
  if (name === "off") {
    colorSlider.value = 0;
    colorValue.textContent = "0%";
  }
  showBefore = false;
  syncBefore();
  syncShadeButtons();
  renderAll();
}

async function initModels() {
  try {
    setStatus("Loading models…");
    const vision = await FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);

    const faceCommon = {
      baseOptions: { modelAssetPath: FACE_MODEL },
      runningMode: "IMAGE",
      numFaces: 1,
      minFaceDetectionConfidence: 0.5,
      minFacePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    };

    try {
      faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
        ...faceCommon,
        baseOptions: { ...faceCommon.baseOptions, delegate: "GPU" },
      });
    } catch {
      faceLandmarker = await FaceLandmarker.createFromOptions(
        vision,
        faceCommon,
      );
    }

    const segmentOptions = {
      baseOptions: { modelAssetPath: SEG_MODEL },
      runningMode: "IMAGE",
      outputCategoryMask: true,
      outputConfidenceMasks: false,
    };
    try {
      segmenter = await ImageSegmenter.createFromOptions(vision, {
        ...segmentOptions,
        baseOptions: { modelAssetPath: SEG_MODEL, delegate: "GPU" },
      });
    } catch {
      segmenter = await ImageSegmenter.createFromOptions(
        vision,
        segmentOptions,
      );
    }
    modelReady = true;
    startBtn.disabled = false;
    setStatus("Models ready", "ready");
    if (running) {
      await processCurrentSource();
      renderAll();
    }
  } catch (err) {
    console.error(err);
    setStatus("Model loading failed", "error");
  }
}

let cameraStarting = false,
  cameraFrameRequest = 0,
  lastCameraTime = -1;
async function startCamera() {
  if (cameraStarting) return;
  cameraStarting = true;
  try {
    setStatus("Opening camera…");
    if (!navigator.mediaDevices?.getUserMedia)
      throw new Error("Camera requires HTTPS or localhost.");
    stream?.getTracks().forEach((track) => track.stop());
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: "user",
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 24, max: 30 },
      },
    });
    const metadata = new Promise((r) => (video.onloadedmetadata = r));
    video.srcObject = stream;
    await metadata;
    await video.play();

    const { w, h } = getSourceDims();
    ensureSizes(w, h);
    setSourceMode("camera");
    overlay.classList.add("hidden");
    running = true;
    setStatus("Camera running", "ready");
    startCameraLoop();
    updateFaceGuide(null);
  } catch (err) {
    console.error(err);
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    const message =
      err.name === "NotAllowedError"
        ? "Allow camera access in your browser settings."
        : err.name === "NotFoundError"
          ? "No camera found. Connect a camera and try again."
          : err.name === "NotReadableError"
            ? "Camera is busy. Close other camera apps and try again."
            : err.message || "Unable to start camera.";
    setStatus(message, "error");
  } finally {
    cameraStarting = false;
  }
}

function useCameraAgain() {
  if (stream?.getVideoTracks().some((track) => track.readyState === "live")) {
    setSourceMode("camera");
    overlay.classList.add("hidden");
    running = true;
    setStatus("Camera running", "ready");
    startCameraLoop();
    updateFaceGuide(null);
  } else {
    startCamera();
  }
}

async function handlePhoto(file) {
  if (!file) return;
  skinMaskReady = false;
  photoKind = "upload";
  facePoints = null;
  lipData = null;
  acneDirty = true;
  wrinklesDirty = true;
  const url = URL.createObjectURL(file);
  photo.onload = async () => {
    setSourceMode("photo");
    updateFaceGuide(null);
    const { w, h } = getSourceDims();
    ensureSizes(w, h);
    overlay.classList.add("hidden");
    running = true;
    setStatus(
      modelReady ? "Photo loaded" : "Loading models…",
      modelReady ? "ready" : "loading",
    );
    await processCurrentSource();
    renderAll();
    perfBadge.textContent = "PHOTO READY";
    URL.revokeObjectURL(url);
  };
  photo.onerror = () => {
    URL.revokeObjectURL(url);
    setStatus("Unable to load photo", "error");
  };
  photo.src = url;
}

async function loadSamplePhoto() {
  skinMaskReady = false;
  photoKind = sampleKind();
  facePoints = null;
  lipData = null;
  acneDirty = true;
  wrinklesDirty = true;
  photo.onload = async () => {
    setSourceMode("photo");
    updateFaceGuide(null);
    const { w, h } = getSourceDims();
    ensureSizes(w, h);
    overlay.classList.add("hidden");
    running = true;
    setStatus(
      modelReady ? "Test photo loaded" : "Loading models…",
      modelReady ? "ready" : "loading",
    );
    await processCurrentSource();
    renderAll();
    perfBadge.textContent = "PHOTO READY";
  };
  photo.onerror = () => setStatus("Unable to load test photo", "error");
  const samplePath =
    photoKind === "sample-acne"
      ? "./sample-acne-test.png"
      : photoKind === "sample-wrinkles"
        ? "./sample-wrinkles-test.png"
        : "./sample-face-test.png";
  // Re-read replaceable test assets on every click, including same-name updates.
  const sampleUrl = new URL(samplePath, document.baseURI);
  sampleUrl.searchParams.set(
    "reload",
    `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  photo.src = sampleUrl.href;
}

function pointForDisplay(lm, w, h) {
  return sourceMode === "camera"
    ? { x: (1 - lm.x) * w, y: lm.y * h }
    : { x: lm.x * w, y: lm.y * h };
}

function updateLipData(landmarks, w, h) {
  facePoints = landmarks;
  acneDirty = true;
  wrinklesDirty = true;
  updateFaceGuide(landmarks);
  const outerPts = OUTER_LIP.map((i) => pointForDisplay(landmarks[i], w, h));
  const innerPts = INNER_MOUTH.map((i) => pointForDisplay(landmarks[i], w, h));

  const outer = boundsOfPoints(outerPts);
  const inner = boundsOfPoints(innerPts);

  lipData = { outerPts, innerPts, outer, inner, cy: (outer.cy + inner.cy) / 2 };
  faceBadge.textContent = "Face detected";
  faceBadge.classList.add("detected");
}

async function processCurrentSource() {
  if (!modelReady) return;
  if (processing) {
    processingPending = true;
    return;
  }
  processing = true;
  try {
    const nextMode = sourceMode === "camera" ? "VIDEO" : "IMAGE";
    if (modelMode !== nextMode) {
      await faceLandmarker.setOptions({ runningMode: nextMode });
      await segmenter.setOptions({ runningMode: nextMode });
      modelMode = nextMode;
    }
    const timestamp = performance.now();
    const { w, h } = getSourceDims();
    if (sourceMode === "camera") {
      cameraSnapshot.width = w;
      cameraSnapshot.height = h;
      cameraSnapshotCtx.drawImage(video, 0, 0, w, h);
    }
    sourceCanvas.width = w;
    sourceCanvas.height = h;
    sourceCtx.clearRect(0, 0, w, h);
    const src = sourceMode === "camera" ? cameraSnapshot : getVisibleSource();
    sourceCtx.drawImage(src, 0, 0, w, h);

    const segmentation =
      (sourceMode === "photo" || cameraNeedsEffect()) &&
      ["skin", "acne", "wrinkles"].includes(currentModule)
        ? modelMode === "VIDEO"
          ? segmenter.segmentForVideo(sourceCanvas, timestamp)
          : segmenter.segment(sourceCanvas)
        : {};
    if (segmentation.categoryMask) {
      const mask = segmentation.categoryMask;
      maskCanvas.width = mask.width;
      maskCanvas.height = mask.height;
      const pixels = maskCtx.createImageData(mask.width, mask.height);
      const labels = mask.getAsUint8Array();
      for (let i = 0; i < labels.length; i++) {
        pixels.data[i * 4] =
          pixels.data[i * 4 + 1] =
          pixels.data[i * 4 + 2] =
            255;
        pixels.data[i * 4 + 3] = labels[i] === 3 ? 255 : 0;
      }
      maskCtx.putImageData(pixels, 0, 0);
      skinEffectMask.width = mask.width;
      skinEffectMask.height = mask.height;
      const faded = insetSkinMask(
        pixels.data,
        mask.width,
        mask.height,
        0,
        Math.max(3, Math.min(mask.width, mask.height) * 0.025),
      );
      skinEffectMaskCtx.putImageData(
        new ImageData(faded, mask.width, mask.height),
        0,
        0,
      );
      mask.close();
      skinMaskReady = true;
      acneDirty = true;
      wrinklesDirty = true;
    }
    const faceRes =
      modelMode === "VIDEO"
        ? faceLandmarker.detectForVideo(sourceCanvas, timestamp)
        : faceLandmarker.detect(sourceCanvas);
    if (faceRes.faceLandmarks?.length) {
      updateLipData(faceRes.faceLandmarks[0], w, h);
    } else {
      lipData = null;
      facePoints = null;
      acneDirty = true;
      wrinklesDirty = true;
      updateFaceGuide(null);
      faceBadge.textContent = "No face — try a clearer front-facing photo";
      faceBadge.classList.remove("detected");
    }
    procFrames++;
  } catch (err) {
    console.warn(err);
    skinMaskReady = false;
    facePoints = null;
    lipData = null;
    setStatus(
      "Photo processing failed. Please retake or reload the photo.",
      "error",
    );
  } finally {
    processing = false;
    if (processingPending) {
      processingPending = false;
      await processCurrentSource();
      renderAll();
    }
  }
}

function startCameraLoop() {
  cancelAnimationFrame(cameraFrameRequest);
  lastCameraTime = -1;
  facePoints = null;
  lipData = null;
  acneDirty = true;
  wrinklesDirty = true;
  const { w, h } = getSourceDims();
  ensureSizes(w, h);
  cameraFrameRequest = requestAnimationFrame(renderLoop);
}

// Work in the mouth's local coordinate system. Cap lower-lip growth by
// mouth width, so a naturally thick lower lip is not multiplied into a droop.
function transformOuterLip(pts, inner, amount, verticalBias) {
  const left = pts[0],
    right = pts[10];
  const width = Math.hypot(right.x - left.x, right.y - left.y);
  if (width < 1) return pts;
  const ux = (right.x - left.x) / width,
    uy = (right.y - left.y) / width;
  let nx = -uy,
    ny = ux;
  if ((pts[15].x - inner[15].x) * nx + (pts[15].y - inner[15].y) * ny < 0) {
    nx = -nx;
    ny = -ny;
  }
  const level = amount / 0.4;
  return pts.map((p, i) => {
    if (i === 0 || i === 10) return { ...p };
    const t = (i % 10) / 10;
    const edge = Math.pow(Math.sin(Math.PI * t), 0.9);
    const upper = i < 10;
    const thickness = Math.abs(
      (p.x - inner[i].x) * nx + (p.y - inner[i].y) * ny,
    );
    // Upper lobes lift; lower volume spreads across the shoulders with a
    // restrained centre. The inner mouth and corners remain unchanged.
    const lobes = upper
      ? 0.62 + 0.38 * Math.pow(Math.sin(2 * Math.PI * t), 2)
      : 0.55 + 0.45 * Math.pow(Math.sin(2 * Math.PI * t), 2);
    const cap = width * (upper ? 0.052 : 0.026);
    const growth =
      Math.min(thickness * (upper ? 0.55 : 0.25), cap) *
      level *
      edge *
      lobes *
      (0.35 + 1.3 * Math.max(0, Math.min(1, (verticalBias - 0.2) / 0.8)));
    const side = (t < 0.5 ? -1 : 1) * (upper ? 1 : -1);
    const spread = width * level * 0.012 * edge * Math.abs(2 * t - 1) * side;
    return {
      x: p.x + nx * growth * (upper ? -1 : 1) + ux * spread,
      y: p.y + ny * growth * (upper ? -1 : 1) + uy * spread,
    };
  });
}

// Affine texture mapping makes the actual lip tissue follow its new contour.
function drawWarpTriangle(source, target) {
  const [a, b, c] = source,
    [u, v, z] = target;
  const det = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
  if (Math.abs(det) < 0.001) return;
  const A = ((v.x - u.x) * (c.y - a.y) - (z.x - u.x) * (b.y - a.y)) / det;
  const C = ((z.x - u.x) * (b.x - a.x) - (v.x - u.x) * (c.x - a.x)) / det;
  const B = ((v.y - u.y) * (c.y - a.y) - (z.y - u.y) * (b.y - a.y)) / det;
  const D = ((z.y - u.y) * (b.x - a.x) - (v.y - u.y) * (c.x - a.x)) / det;
  lipSourceCtx.save();
  lipSourceCtx.beginPath();
  addClosedContour(lipSourceCtx, target);
  lipSourceCtx.clip();
  lipSourceCtx.setTransform(
    A,
    B,
    C,
    D,
    u.x - A * a.x - C * a.y,
    u.y - B * a.x - D * a.y,
  );
  lipSourceCtx.drawImage(sourceCanvas, 0, 0);
  lipSourceCtx.restore();
}

function warpLipRing(inner, outer, targetInner, targetOuter) {
  for (let i = 0; i < outer.length; i++) {
    const j = (i + 1) % outer.length;
    drawWarpTriangle(
      [inner[i], outer[i], outer[j]],
      [targetInner[i], targetOuter[i], targetOuter[j]],
    );
    drawWarpTriangle(
      [inner[i], outer[j], inner[j]],
      [targetInner[i], targetOuter[j], targetInner[j]],
    );
  }
}

function computeLipTargets() {
  if (!lipData) return null;
  const amount = Number(lipSlider.value) / 100;
  const verticalBias = Number(verticalSlider.value) / 100;
  const blend = Number(blendSlider.value) / 100;

  const effectiveAmount = amount;

  const targetOuter =
    amount > 0.001
      ? transformOuterLip(
          lipData.outerPts,
          lipData.innerPts,
          effectiveAmount,
          verticalBias,
        )
      : lipData.outerPts;
  const targetInner = lipData.innerPts;

  return { targetOuter, targetInner, amount, blend, effectiveAmount };
}

function buildLipFeather(targetOuter, targetInner, blend, w, h) {
  lipMaskCtx.clearRect(0, 0, w, h);
  lipMaskCtx.beginPath();
  addClosedContour(lipMaskCtx, targetOuter);
  addClosedContour(lipMaskCtx, targetInner);
  lipMaskCtx.fillStyle = "white";
  lipMaskCtx.fill("evenodd");

  lipFeatherCtx.clearRect(0, 0, w, h);
  lipFeatherCtx.save();
  lipFeatherCtx.filter = `blur(${Math.max(0.35, boundsOfPoints(targetOuter).width * (0.002 + blend * 0.004))}px)`;
  lipFeatherCtx.drawImage(lipMaskCanvas, 0, 0, w, h);
  lipFeatherCtx.restore();
  lipFeatherCtx.filter = "none";
}

function renderLipColor(targetOuter, targetInner, blend) {
  const intensity = Number(colorSlider.value) / 100;
  if (!selectedShadeHex || intensity <= 0.001) return;

  const w = stage.width,
    h = stage.height;
  buildLipFeather(targetOuter, targetInner, blend, w, h);
  const bounds = boundsOfPoints(targetOuter);
  const pad = Math.ceil(bounds.width * 0.02 + 3);
  const x = Math.max(0, Math.floor(bounds.minX - pad)),
    y = Math.max(0, Math.floor(bounds.minY - pad));
  const rw = Math.min(w - x, Math.ceil(bounds.maxX + pad) - x);
  const rh = Math.min(h - y, Math.ceil(bounds.maxY + pad) - y);
  if (rw <= 0 || rh <= 0) return;
  const pixels = ctx.getImageData(x, y, rw, rh);
  const mask = lipFeatherCtx.getImageData(x, y, rw, rh).data;
  const rgb = [1, 3, 5].map((start) =>
    parseInt(selectedShadeHex.slice(start, start + 2), 16),
  );
  const targetLuma = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  // Change chroma only: keep each pixel's photographed luminance exactly.
  // Partial coverage retains natural lip variation even at maximum strength.
  const chroma = rgb.map((v) => v - targetLuma);
  for (let i = 0; i < pixels.data.length; i += 4) {
    const lum =
      pixels.data[i] * 0.2126 +
      pixels.data[i + 1] * 0.7152 +
      pixels.data[i + 2] * 0.0722;
    const highlight = 1 - Math.max(0, Math.min(0.75, (lum - 150) / 100));
    const shadow = Math.min(1, lum / 65);
    const alpha =
      Math.pow(mask[i + 3] / 255, 1.5) * intensity * 0.62 * highlight * shadow;
    if (alpha < 0.001) continue;
    let gamut = 1;
    for (const delta of chroma) {
      if (delta > 0) gamut = Math.min(gamut, (255 - lum) / delta);
      if (delta < 0) gamut = Math.min(gamut, lum / -delta);
    }
    for (let ch = 0; ch < 3; ch++)
      pixels.data[i + ch] =
        pixels.data[i + ch] * (1 - alpha) + (lum + chroma[ch] * gamut) * alpha;
  }
  ctx.putImageData(pixels, x, y);
}

function renderLips(w, h) {
  if (currentModule !== "lips") return;
  const lipTargets = computeLipTargets();
  if (!lipTargets) return;

  const { targetOuter, targetInner, amount, blend, effectiveAmount } =
    lipTargets;
  buildLipFeather(targetOuter, targetInner, blend, w, h);

  if (amount > 0.001) {
    sourceCtx.clearRect(0, 0, w, h);
    drawForDisplay(sourceCtx, w, h);
    lipSourceCtx.clearRect(0, 0, w, h);
    // A fixed surrounding ring joins the expanded lips back to nearby skin.
    const rim = lipData.outerPts.map((p) => ({
      x: lipData.outer.cx + (p.x - lipData.outer.cx) * 2.2,
      y: lipData.cy + (p.y - lipData.cy) * 2.8,
    }));
    // Nonlinear cross-section rolls the tissue outward instead of stretching it flat.
    let previousSource = lipData.innerPts,
      previousTarget = targetInner;
    const steps = 6;
    for (let band = 1; band <= steps; band++) {
      const t = band / steps;
      const roll = Math.max(
        0,
        Math.min(1, (Number(verticalSlider.value) / 100 - 0.2) / 0.8),
      );
      const rolled = t + amount * (0.04 + roll * 0.44) * Math.sin(Math.PI * t);
      const sourceRing = lipData.outerPts.map((p, i) => ({
        x: lipData.innerPts[i].x + (p.x - lipData.innerPts[i].x) * t,
        y: lipData.innerPts[i].y + (p.y - lipData.innerPts[i].y) * t,
      }));
      const targetRing = targetOuter.map((p, i) => ({
        x: targetInner[i].x + (p.x - targetInner[i].x) * rolled,
        y: targetInner[i].y + (p.y - targetInner[i].y) * rolled,
      }));
      warpLipRing(previousSource, sourceRing, previousTarget, targetRing);
      previousSource = sourceRing;
      previousTarget = targetRing;
    }
    warpLipRing(lipData.outerPts, rim, targetOuter, rim);
    ctx.drawImage(lipSourceCanvas, 0, 0);
  }

  renderLipColor(targetOuter, targetInner, blend);

  // Preserve the photographed lighting; do not add synthetic reflections.

  if (lipDebug.checked) {
    ctx.save();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(214,255,93,.95)";
    ctx.beginPath();
    addClosedContour(ctx, targetOuter);
    ctx.stroke();
    ctx.strokeStyle = "rgba(80,220,255,.95)";
    ctx.beginPath();
    addClosedContour(ctx, targetInner);
    ctx.stroke();
    ctx.restore();
  }
}

function renderSkin(w, h) {
  const brightness = Number(brightnessSlider.value) / 100;
  if (currentModule !== "skin" || brightness <= 0) return;
  skinCtx.clearRect(0, 0, w, h);
  drawForDisplay(skinCtx, w, h, `brightness(${1 + brightness * 0.3})`);
  skinCtx.save();
  skinCtx.globalCompositeOperation = "destination-in";
  skinCtx.filter = "none";
  if (sourceMode === "camera") {
    skinCtx.translate(w, 0);
    skinCtx.scale(-1, 1);
  }
  skinCtx.drawImage(skinEffectMask, 0, 0, w, h);
  skinCtx.restore();
  ctx.drawImage(skinCanvas, 0, 0);
}

function prepareAcne(w, h) {
  const scale = Math.min(
    1,
    (sourceMode === "camera" ? 640 : 1024) / Math.max(w, h),
  );
  const aw = Math.round(w * scale),
    ah = Math.round(h * scale);
  for (const canvas of [acneCanvas, acneWork, acneBlur, acneMask]) {
    canvas.width = aw;
    canvas.height = ah;
  }
  drawForDisplay(acneWorkCtx, aw, ah);
  acneMaskCtx.save();
  if (sourceMode === "camera") {
    acneMaskCtx.translate(aw, 0);
    acneMaskCtx.scale(-1, 1);
  }
  acneMaskCtx.drawImage(maskCanvas, 0, 0, aw, ah);
  acneMaskCtx.restore();
  const points = facePoints.map((p) => pointForDisplay(p, aw, ah));
  const faceWidth = Math.hypot(
    points[234].x - points[454].x,
    points[234].y - points[454].y,
  );
  const radius = Math.max(5, faceWidth * 0.035);
  // Tight feature contours leave the forehead, under-eye skin, nose and chin
  // available for blemish repair, rather than excluding large bounding ellipses.
  acneMaskCtx.save();
  acneMaskCtx.globalCompositeOperation = "destination-out";
  carveContours(
    acneMaskCtx,
    EXCLUSION_CONTOURS,
    points,
    Math.max(1, faceWidth * 0.005),
  );
  // Protect lip corners and the natural dark crease beside the mouth.
  // Expand in the mouth's local axes, so protection follows head rotation.
  const mouth = OUTER_LIP.map((i) => points[i]);
  const mx = (mouth[0].x + mouth[10].x) / 2,
    my = (mouth[0].y + mouth[10].y) / 2;
  const angle = Math.atan2(mouth[10].y - mouth[0].y, mouth[10].x - mouth[0].x);
  const ux = Math.cos(angle),
    uy = Math.sin(angle);
  const protectedMouth = mouth.map((p) => {
    const dx = p.x - mx,
      dy = p.y - my,
      u = (dx * ux + dy * uy) * 1.3,
      v = (-dx * uy + dy * ux) * 1.35;
    return { x: mx + u * ux - v * uy, y: my + u * uy + v * ux };
  });
  acneMaskCtx.beginPath();
  addClosedContour(acneMaskCtx, protectedMouth);
  acneMaskCtx.fill();
  acneMaskCtx.lineWidth = Math.max(2, faceWidth * 0.012);
  acneMaskCtx.stroke();
  acneMaskCtx.restore();
  acneBlurCtx.filter = `blur(${radius * 0.65}px)`;
  acneBlurCtx.drawImage(acneWork, 0, 0);
  acneBlurCtx.filter = "none";
  const inset = insetSkinMask(
    acneMaskCtx.getImageData(0, 0, aw, ah).data,
    aw,
    ah,
    Math.max(2, Math.ceil(faceWidth * 0.007)),
  );
  acneMaskCtx.putImageData(new ImageData(inset, aw, ah), 0, 0);
  const corrected = repairBlemishes(
    acneWorkCtx.getImageData(0, 0, aw, ah).data,
    acneBlurCtx.getImageData(0, 0, aw, ah).data,
    acneMaskCtx.getImageData(0, 0, aw, ah).data,
    aw,
    ah,
    radius,
  );
  // Fade the correction inward from every protected boundary, without
  // expanding the correction into hair, eyes or lips.
  const faded = insetSkinMask(inset, aw, ah, 0, Math.max(4, faceWidth * 0.035));
  for (let i = 3; i < corrected.length; i += 4)
    corrected[i] = (corrected[i] * faded[i]) / 255;
  acneMaskCtx.putImageData(new ImageData(faded, aw, ah), 0, 0);
  acneCtx.putImageData(new ImageData(corrected, aw, ah), 0, 0);
  acneDirty = false;
  acneLastFrame = performance.now();
}

function prepareWrinkles(w, h) {
  const scale = Math.min(
    1,
    (sourceMode === "camera" ? 640 : 1024) / Math.max(w, h),
  );
  const aw = Math.round(w * scale),
    ah = Math.round(h * scale);
  for (const canvas of [
    wrinklesCanvas,
    wrinklesMulCanvas,
    wrinklesWork,
    wrinklesMask,
  ]) {
    canvas.width = aw;
    canvas.height = ah;
  }
  drawForDisplay(wrinklesWorkCtx, aw, ah);
  wrinklesMaskCtx.save();
  if (sourceMode === "camera") {
    wrinklesMaskCtx.translate(aw, 0);
    wrinklesMaskCtx.scale(-1, 1);
  }
  wrinklesMaskCtx.drawImage(maskCanvas, 0, 0, aw, ah);
  wrinklesMaskCtx.restore();
  const points = facePoints.map((p) => pointForDisplay(p, aw, ah));
  const faceWidth = Math.hypot(
    points[234].x - points[454].x,
    points[234].y - points[454].y,
  );

  // 1. Face only: clip to the landmark oval so ears (and anything else the segmenter calls
  //    skin outside the face) can never be treated.
  wrinklesMaskCtx.save();
  wrinklesMaskCtx.globalCompositeOperation = "destination-in";
  wrinklesMaskCtx.fillStyle = "#fff";
  wrinklesMaskCtx.beginPath();
  addClosedContour(wrinklesMaskCtx, faceOval(points, faceWidth));
  wrinklesMaskCtx.fill();
  wrinklesMaskCtx.restore();

  wrinklesMaskCtx.save();
  wrinklesMaskCtx.globalCompositeOperation = "destination-out";
  carveContours(
    wrinklesMaskCtx,
    WRINKLE_EXCLUSIONS,
    points,
    Math.max(1, faceWidth * 0.005),
  );
  // 2. Lashes and eyebrows: full loops grown outward, with a rounded edge.
  wrinklesMaskCtx.lineJoin = "round";
  wrinklesMaskCtx.lineWidth = Math.max(1.5, faceWidth * 0.008);
  for (const poly of guardContours(points, faceWidth)) {
    wrinklesMaskCtx.beginPath();
    addClosedContour(wrinklesMaskCtx, poly);
    wrinklesMaskCtx.fill();
    wrinklesMaskCtx.stroke();
  }
  // The bridge and sidewalls are facial shape, not wrinkle creases.
  // Protect the complete nose, with an inward feather below.
  const noseTop = points[6],
    noseBottom = points[2];
  const nx = (noseTop.x + noseBottom.x) / 2,
    ny = (noseTop.y + noseBottom.y) / 2;
  const noseHeight = Math.hypot(
    noseBottom.x - noseTop.x,
    noseBottom.y - noseTop.y,
  );
  const noseWidth = Math.hypot(
    points[98].x - points[327].x,
    points[98].y - points[327].y,
  );
  wrinklesMaskCtx.beginPath();
  wrinklesMaskCtx.ellipse(
    nx,
    ny,
    Math.max(4, noseWidth * 0.8),
    Math.max(6, noseHeight * 0.68),
    -Math.atan2(noseBottom.x - noseTop.x, noseBottom.y - noseTop.y),
    0,
    Math.PI * 2,
  );
  wrinklesMaskCtx.fill();
  wrinklesMaskCtx.restore();
  const original = wrinklesWorkCtx.getImageData(0, 0, aw, ah).data;
  // 3. Snap the soft 256px segmentation edge to the real hairline using the photo's own
  //    colours, then fade inward. Small margin/feather = treatment runs close to the hair.
  const refined = refineSkinMask(
    wrinklesMaskCtx.getImageData(0, 0, aw, ah).data,
    original,
    aw,
    ah,
    Math.max(3, Math.round(faceWidth * 0.02)),
  );
  const faded = insetSkinMask(
    refined,
    aw,
    ah,
    1,
    Math.max(3, faceWidth * 0.01),
  );
  wrinklesMaskCtx.putImageData(new ImageData(faded, aw, ah), 0, 0);
  const regions = wrinkleRegions(points, faceWidth);
  // reduceWrinkles returns a signed correction: `mul` (gain <= 1) and `add` (light).
  // Only these smooth maps are upscaled, never a downsampled copy of the skin, so the
  // full-resolution photo keeps its own texture inside and outside the treated areas.
  const { add, mul } = reduceWrinkles(
    original,
    faded,
    aw,
    ah,
    Math.max(2, Math.round(faceWidth * 0.012)),
    regions,
    // Smoothing strength. smoothing: how big a fold the filter flattens (default 1, max ~2.2).
    // lines: removal of faint thin lines (default 1). texture: pore detail kept (default 0.9;
    // lower = smoother but more "plastic").
    { smoothing: 1.25, lines: 1.3, texture: 0.82 },
  );
  wrinklesCtx.putImageData(new ImageData(add, aw, ah), 0, 0);
  wrinklesMulCtx.putImageData(new ImageData(mul, aw, ah), 0, 0);
  wrinklesDirty = false;
  wrinklesLastFrame = performance.now();
}
function renderWrinkles(w, h) {
  if (currentModule !== "wrinkles" || !skinMaskReady) return;
  const status = document.getElementById("wrinklesStatus");
  if (!facePoints) {
    status.textContent = modelReady
      ? "Face forward or choose a clear photo"
      : "Loading face model…";
    return;
  }
  status.textContent = "Compare Before and After to preview smoother skin.";
  const amount = Number(wrinklesSlider.value) / 100;
  if (amount <= 0 && !skinDebug.checked) return;
  if (wrinklesDirty) prepareWrinkles(w, h);
  ctx.save();
  // Photos: draw the native photo first. Camera frames are already on the stage.
  if (sourceMode === "photo") {
    ctx.globalAlpha = 1;
    drawForDisplay(ctx, w, h);
  }
  ctx.globalAlpha = amount;
  ctx.imageSmoothingEnabled = true;
  ctx.globalCompositeOperation = "multiply";
  ctx.drawImage(wrinklesMulCanvas, 0, 0, w, h); // darken ridges
  ctx.globalCompositeOperation = "lighter";
  ctx.drawImage(wrinklesCanvas, 0, 0, w, h); // fill creases
  ctx.restore();
}

function renderAcne(w, h) {
  if (currentModule !== "acne" || !skinMaskReady) return;
  if (!facePoints) {
    acneStatus.textContent = modelReady
      ? "Face forward to preview the effect"
      : "Loading face model…";
    return;
  }
  acneStatus.textContent =
    "Compare Before and After to preview reduced blemishes and redness";
  const amount = Number(acneSlider.value) / 100;
  if (amount <= 0 && !skinDebug.checked) return;
  if (acneDirty) prepareAcne(w, h);
  ctx.save();
  ctx.globalAlpha = amount;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(acneCanvas, 0, 0, w, h);
  ctx.restore();
}

function renderSkinDebug(w, h) {
  if (
    !skinDebug.checked ||
    !["skin", "acne", "wrinkles"].includes(currentModule) ||
    !facePoints
  )
    return;
  const actual =
    currentModule === "acne"
      ? acneMask
      : currentModule === "wrinkles"
        ? wrinklesMask
        : skinEffectMask;
  const mw = actual.width,
    mh = actual.height;
  if (!mw || !mh) return;
  debugCanvas.width = mw;
  debugCanvas.height = mh;
  const source = actual.getContext("2d").getImageData(0, 0, mw, mh).data;
  const pixels = debugCtx.createImageData(mw, mh);
  for (let y = 0; y < mh; y++)
    for (let x = 0; x < mw; x++) {
      const p = y * mw + x,
        i = p * 4;
      if (source[i + 3] === 0) continue;
      pixels.data[i] = 80;
      pixels.data[i + 1] = 255;
      pixels.data[i + 2] = 150;
      pixels.data[i + 3] = (80 * source[i + 3]) / 255;
    }
  debugCtx.putImageData(pixels, 0, 0);
  ctx.save();
  if (sourceMode === "camera" && currentModule === "skin") {
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(debugCanvas, 0, 0, w, h);
  ctx.restore();
}

function renderAll() {
  const { w, h } = getSourceDims();
  if (!w || !h) return;
  ctx.clearRect(0, 0, w, h);
  if (sourceMode === "camera" && (!cameraNeedsEffect() || !faceAligned)) return;
  // Composite the effect over the exact captured frame used by the models.
  if (sourceMode === "camera") drawForDisplay(ctx, w, h);
  if (showBefore) return;
  if (currentModule === "lips" && lipData) drawForDisplay(ctx, w, h);
  renderSkin(w, h);
  renderLips(w, h);
  renderAcne(w, h);
  renderWrinkles(w, h);
  renderSkinDebug(w, h);
}

function cameraNeedsEffect() {
  if (sourceMode === "camera") return false;
  if (showBefore || currentModule === "home") return false;
  if (skinDebug.checked && ["skin", "acne", "wrinkles"].includes(currentModule))
    return true;
  if (currentModule === "wrinkles") return Number(wrinklesSlider.value) > 0;
  if (currentModule === "acne") return Number(acneSlider.value) > 0;
  if (currentModule === "skin") return Number(brightnessSlider.value) > 0;
  return (
    currentModule === "lips" &&
    (Number(lipSlider.value) > 0 ||
      Number(colorSlider.value) > 0 ||
      lipDebug.checked)
  );
}
async function renderLoop(now) {
  cameraFrameRequest = 0;
  if (!running || sourceMode !== "camera") return;
  if (video.readyState >= 2 && video.currentTime !== lastCameraTime) {
    lastCameraTime = video.currentTime;
    if (currentModule !== "home") await processCurrentSource();
    if (!running || sourceMode !== "camera") return;
    renderAll();
  }
  if (now - procWindow >= 1000) {
    perfBadge.textContent = cameraNeedsEffect()
      ? `PROC ${procFrames} fps`
      : "LIVE — ORIGINAL";
    procFrames = 0;
    procWindow = now;
  }
  cameraFrameRequest = requestAnimationFrame(renderLoop);
}

document
  .getElementById("chooseWrinklesBtn")
  .addEventListener("click", () => setModule("wrinkles"));
document
  .getElementById("wrinklesSampleBtn")
  .addEventListener("click", loadSamplePhoto);
function updateWrinkles() {
  syncWrinklesPreset();
  showBefore = false;
  syncBefore();
  renderAll();
}
wrinklesSlider.addEventListener("input", updateWrinkles);
document.querySelectorAll("[data-wrinkles-preset]").forEach((btn) =>
  btn.addEventListener("click", () => {
    wrinklesSlider.value = btn.dataset.wrinklesPreset;
    updateWrinkles();
  }),
);
skinDebug.addEventListener("change", () => {
  showBefore = false;
  syncBefore();
  renderAll();
});
document
  .getElementById("chooseAcneBtn")
  .addEventListener("click", () => setModule("acne"));
document
  .getElementById("acneSampleBtn")
  .addEventListener("click", loadSamplePhoto);
acneSlider.addEventListener("input", () => {
  syncAcnePreset();
  acneValue.textContent = `${acneSlider.value}%`;
  showBefore = false;
  syncBefore();
  renderAll();
});
document.querySelectorAll("[data-acne-preset]").forEach((btn) =>
  btn.addEventListener("click", () => {
    acneSlider.value = btn.dataset.acnePreset;
    acneValue.textContent = `${acneSlider.value}%`;
    syncAcnePreset();
    showBefore = false;
    syncBefore();
    renderAll();
  }),
);
chooseSkinBtn.addEventListener("click", () => setModule("skin"));
brightnessSlider.addEventListener("input", () => {
  brightnessValue.textContent = `${brightnessSlider.value}%`;
  showBefore = false;
  syncBefore();
  renderAll();
});
chooseLipsBtn.addEventListener("click", () => setModule("lips"));
backHomeBtn.addEventListener("click", () => setModule("home"));
cameraBtn.addEventListener("click", () => useCameraAgain());
startBtn.addEventListener("click", startCamera);
fileInput.addEventListener("change", (e) => handlePhoto(e.target.files?.[0]));
fileInputOverlay.addEventListener("change", (e) =>
  handlePhoto(e.target.files?.[0]),
);
sampleBtn.addEventListener("click", loadSamplePhoto);
sampleBtnOverlay.addEventListener("click", loadSamplePhoto);

beforeBtn.addEventListener("click", () => {
  showBefore = !showBefore;
  syncBefore();
  renderAll();
});

const lipPresetDefaults = {
  16: { roll: 60, blend: 55 },
  28: { roll: 84, blend: 57 },
  50: { roll: 76, blend: 55 },
};
presetBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    lipSlider.value = btn.dataset.lipPreset;
    lipValue.textContent = `${lipSlider.value}%`;
    const defaults = lipPresetDefaults[btn.dataset.lipPreset];
    if (defaults) {
      verticalSlider.value = defaults.roll;
      blendSlider.value = defaults.blend;
      verticalValue.textContent = `${defaults.roll}%`;
      blendValue.textContent = `${defaults.blend}%`;
    }
    showBefore = false;
    syncBefore();
    syncPreset();
    renderAll();
  });
});

shadeBtns.forEach((btn) => {
  btn.addEventListener("click", () =>
    setShade(btn.dataset.shade, btn.dataset.hex),
  );
});

resetBtn.addEventListener("click", () => {
  skinDebug.checked = false;
  wrinklesSlider.value = 100;
  syncWrinklesPreset();
  acneSlider.value = 0;
  acneValue.textContent = "0%";
  syncAcnePreset();
  brightnessSlider.value = 0;
  brightnessValue.textContent = "0%";
  lipSlider.value = 0;
  verticalSlider.value = 60;
  blendSlider.value = 55;
  colorSlider.value = 0;
  lipValue.textContent = "0%";
  verticalValue.textContent = "60%";
  blendValue.textContent = "55%";
  colorValue.textContent = "0%";
  lipDebug.checked = false;
  selectedShade = "off";
  selectedShadeHex = "";
  showBefore = currentModule === "wrinkles";
  syncBefore();
  syncPreset();
  syncShadeButtons();
  renderAll();
});

lipSlider.addEventListener("input", () => {
  lipValue.textContent = `${lipSlider.value}%`;
  showBefore = false;
  syncBefore();
  syncPreset();
  renderAll();
});
verticalSlider.addEventListener("input", () => {
  verticalValue.textContent = `${verticalSlider.value}%`;
  showBefore = false;
  syncBefore();
  renderAll();
});
blendSlider.addEventListener("input", () => {
  blendValue.textContent = `${blendSlider.value}%`;
  showBefore = false;
  syncBefore();
  renderAll();
});
colorSlider.addEventListener("input", () => {
  colorValue.textContent = `${colorSlider.value}%`;
  selectedShade = Number(colorSlider.value) > 0 ? "brightred" : "off";
  selectedShadeHex = selectedShade === "off" ? "" : "#DE4B50";
  syncShadeButtons();
  showBefore = false;
  syncBefore();
  renderAll();
});
lipDebug.addEventListener("change", renderAll);

window.addEventListener("beforeunload", () => {
  cancelAnimationFrame(cameraFrameRequest);
  stream?.getTracks().forEach((t) => t.stop());
  faceLandmarker?.close?.();
  segmenter?.close?.();
});

setStatus("Loading models…");
stageWrap.classList.add("camera-mode");
syncBefore();
syncPreset();
syncShadeButtons();
syncAcnePreset();
syncWrinklesPreset();
setModule("home");
initModels();
