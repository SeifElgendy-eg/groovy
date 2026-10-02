import { AcneEffect } from "../effects/acne/effect";
import { WrinklesEffect } from "../effects/wrinkles/effect";
import { metaOf } from "../effects/registry";
import { buildLipData } from "../effects/lips/geometry";
import { LipRenderer, needsWarp } from "../effects/lips/renderer";
import { insetSkinMask } from "../imaging/maskOps";
import {
  FilesetResolver,
  ImageSegmenter,
  FaceLandmarker,
} from "@mediapipe/tasks-vision";

const MP_BASE = "./vendor/mediapipe";
const FACE_MODEL = "./models/face_landmarker.task";

const SEG_MODEL = "./models/selfie_multiclass_256x256.tflite";
const skinDebug = document.getElementById("skinDebug");
const skinDebugSection = document.getElementById("skinDebugSection");
const debugCanvas = document.createElement("canvas"),
  debugCtx = debugCanvas.getContext("2d");
const acneSection = document.getElementById("acneSection");
const acneSlider = document.getElementById("acneSlider");
const acneValue = document.getElementById("acneValue");
const acneStatus = document.getElementById("acneStatus");
const acne = new AcneEffect();
const wrinkles = new WrinklesEffect();
let facePoints = null,
  photoKind = "upload";
const wrinklesSection = document.getElementById("wrinklesSection"),
  wrinklesSlider = document.getElementById("wrinklesSlider"),
  wrinklesValue = document.getElementById("wrinklesValue");
function sampleKind() {
  return metaOf(currentModule).sampleKind;
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

const lipRenderer = new LipRenderer();

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

  showEl(moduleHome, isHome);
  showEl(moduleHeader, !isHome);
  showEl(backHomeBtn, !isHome);
  showEl(compareSection, !isHome);
  showEl(resetSection, !isHome);
  const meta = metaOf(moduleName);
  showEl(skinDebugSection, meta.usesSkinMask);
  for (const [id, els] of Object.entries(serviceSections))
    for (const el of els) showEl(el, moduleName === id);

  if (moduleName === "wrinkles") {
    wrinklesSlider.value = 100;
    syncWrinklesPreset();
  }
  moduleEyebrow.textContent = meta.eyebrow;
  moduleTitle.textContent = meta.title;
  sampleBtn.textContent = meta.sampleButtonLabel;
  showBefore = false;
  syncBefore();
  acne.dirty = true;
  wrinkles.dirty = true;
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
  ]) {
    c.width = w;
    c.height = h;
  }
  lipRenderer.resize(w, h);
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
  acne.dirty = true;
  wrinkles.dirty = true;
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
  acne.dirty = true;
  wrinkles.dirty = true;
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
  acne.dirty = true;
  wrinkles.dirty = true;
  updateFaceGuide(landmarks);
  lipData = buildLipData(landmarks, w, h, sourceMode === "camera");
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
      metaOf(currentModule).usesSkinMask
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
      acne.dirty = true;
      wrinkles.dirty = true;
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
      acne.dirty = true;
      wrinkles.dirty = true;
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
  acne.dirty = true;
  wrinkles.dirty = true;
  const { w, h } = getSourceDims();
  ensureSizes(w, h);
  cameraFrameRequest = requestAnimationFrame(renderLoop);
}

function readLipParams() {
  return {
    amount: Number(lipSlider.value) / 100,
    roll: Number(verticalSlider.value) / 100,
    blend: Number(blendSlider.value) / 100,
    colorIntensity: Number(colorSlider.value) / 100,
    shadeHex: selectedShadeHex,
    showOutline: lipDebug.checked,
  };
}

function renderLips(w, h) {
  if (currentModule !== "lips" || !lipData) return;
  const params = readLipParams();
  if (needsWarp(params)) {
    // The warp samples the display-oriented frame (mirrored for the camera).
    sourceCtx.clearRect(0, 0, w, h);
    drawForDisplay(sourceCtx, w, h);
  }
  lipRenderer.render(ctx, sourceCanvas, lipData, params, w, h);
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
  if (wrinkles.dirty) wrinkles.prepare(skinInput(w, h));
  // Photos: draw the native photo first. Camera frames are already on the stage.
  if (sourceMode === "photo") {
    ctx.save();
    ctx.globalAlpha = 1;
    drawForDisplay(ctx, w, h);
    ctx.restore();
  }
  wrinkles.draw(ctx, w, h, amount);
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
  if (acne.dirty) acne.prepare(skinInput(w, h));
  acne.draw(ctx, w, h, amount);
}

// Everything the skin effects need from this app, as plain data.
function skinInput(w, h) {
  return {
    drawFrame: (c, aw, ah) => drawForDisplay(c, aw, ah),
    segMask: maskCanvas,
    landmarks: facePoints,
    mirrored: sourceMode === "camera",
    w,
    h,
  };
}

function renderSkinDebug(w, h) {
  if (
    !skinDebug.checked ||
    !metaOf(currentModule).usesSkinMask ||
    !facePoints
  )
    return;
  const actual = debugMasks[currentModule]();
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
  if (metaOf(currentModule).paintsBaseFrame && lipData)
    drawForDisplay(ctx, w, h);
  effectRender[currentModule]?.(w, h);
  renderSkinDebug(w, h);
}

// Per-service behaviour, looked up by module id (declarative facts live in effects/registry.ts).
const serviceSections = {
  lips: [lipsSection, colorSection],
  wrinkles: [wrinklesSection],
  acne: [acneSection],
  skin: [skinSection],
};
const effectRender = {
  skin: renderSkin,
  lips: renderLips,
  acne: renderAcne,
  wrinkles: renderWrinkles,
};
const effectActive = {
  wrinkles: () => Number(wrinklesSlider.value) > 0,
  acne: () => Number(acneSlider.value) > 0,
  skin: () => Number(brightnessSlider.value) > 0,
  lips: () =>
    Number(lipSlider.value) > 0 ||
    Number(colorSlider.value) > 0 ||
    lipDebug.checked,
};
const debugMasks = {
  acne: () => acne.maskCanvas,
  wrinkles: () => wrinkles.maskCanvas,
  skin: () => skinEffectMask,
};

function cameraNeedsEffect() {
  if (sourceMode === "camera") return false;
  if (showBefore || currentModule === "home") return false;
  if (skinDebug.checked && metaOf(currentModule).usesSkinMask) return true;
  return effectActive[currentModule]();
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
  showBefore = metaOf(currentModule).resetShowsBefore;
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
