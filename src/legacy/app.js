import { AcneEffect } from "../effects/acne/effect";
import { WrinklesEffect } from "../effects/wrinkles/effect";
import { metaOf } from "../effects/registry";
import { buildLipData } from "../effects/lips/geometry";
import { LipRenderer, needsWarp } from "../effects/lips/renderer";
import { insetSkinMask } from "../imaging/maskOps";
import { evaluateAlignment } from "../face/alignment";
import {
  describeCameraError,
  openUserCamera,
  stopStream,
} from "../io/camera";
import { loadModels } from "../ml/models";
import { dom } from "../ui/dom";

const {
  acneSection,
  acneSlider,
  acneStatus,
  acneValue,
  backHomeBtn,
  beforeBtn,
  blendSlider,
  blendValue,
  brightnessSlider,
  brightnessValue,
  cameraBtn,
  chooseLipsBtn,
  chooseSkinBtn,
  colorSection,
  colorSlider,
  colorValue,
  compareSection,
  faceBadge,
  fileInput,
  fileInputOverlay,
  lipDebug,
  lipSlider,
  lipValue,
  lipsSection,
  liveBadge,
  moduleEyebrow,
  moduleHeader,
  moduleHome,
  moduleTitle,
  overlay,
  perfBadge,
  photo,
  resetBtn,
  resetSection,
  sampleBtn,
  sampleBtnOverlay,
  skinDebug,
  skinDebugSection,
  skinSection,
  sourceBadge,
  stage,
  stageWrap,
  startBtn,
  verticalSlider,
  verticalValue,
  video,
} = dom;
const debugCanvas = document.createElement("canvas"),
  debugCtx = debugCanvas.getContext("2d");
const acne = new AcneEffect();
const wrinkles = new WrinklesEffect();
let facePoints = null,
  photoKind = "upload";
const { wrinklesSection, wrinklesSlider, wrinklesValue } = dom;
function sampleKind() {
  return metaOf(currentModule).sampleKind;
}
function syncWrinklesPreset() {
  const value = Number(wrinklesSlider.value);
  let label = "Custom";
  dom.wrinklesPresetButtons.forEach((btn) => {
    const active = Number(btn.dataset.wrinklesPreset) === value;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", String(active));
    if (active) label = btn.textContent;
  });
  wrinklesValue.textContent = `${value}%`;
  dom.wrinklesSelection.textContent =
    `Selected: ${label} · ${value}%`;
}
const skinEffectMask = document.createElement("canvas");
const skinEffectMaskCtx = skinEffectMask.getContext("2d");
const maskCanvas = document.createElement("canvas");
const maskCtx = maskCanvas.getContext("2d");
const skinCanvas = document.createElement("canvas");
const skinCtx = skinCanvas.getContext("2d");
const ctx = stage.getContext("2d");






const presetBtns = dom.lipPresetButtons;
const shadeBtns = dom.shadeButtons;

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
  const result = evaluateAlignment(points, {
    last: lastAlignment,
    frames: alignmentFrames,
  });
  lastAlignment = result.state.last;
  alignmentFrames = result.state.frames;
  faceAligned = result.aligned;
  faceGuide.classList.toggle("aligned", faceAligned);
  faceGuideLabel.textContent = result.label;
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

// Only problems are shown to the user. Progress messages stay silent, but any newer status
// (loading, ready) replaces a previous error, so a retry starts from a clean screen.
const statusToast = document.createElement("div");
statusToast.className = "status-toast";
statusToast.setAttribute("role", "alert");
statusToast.hidden = true;
stageWrap.append(statusToast);
function setStatus(text, type = "loading") {
  if (type === "error") {
    statusToast.textContent = text;
    statusToast.hidden = false;
  } else {
    statusToast.hidden = true;
  }
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
  dom.acnePresetButtons.forEach((btn) => {
    const selected = Number(btn.dataset.acnePreset) === value;
    btn.classList.toggle("active", selected);
    btn.setAttribute("aria-pressed", String(selected));
    if (selected) label = btn.textContent;
  });
  dom.acneSelection.textContent =
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
    ({ faceLandmarker, segmenter } = await loadModels());
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
    stopStream(stream);
    stream = await openUserCamera();
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
    stopStream(stream);
    stream = null;
    setStatus(describeCameraError(err), "error");
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
  const status = dom.wrinklesStatus;
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

// A user edit of any control leaves "Before" mode and redraws.
function userChanged() {
  showBefore = false;
  syncBefore();
  renderAll();
}

function showPercent(label, slider) {
  label.textContent = `${slider.value}%`;
}

/** Slider -> label + optional extra sync, then redraw. */
function bindSlider(slider, label, extra) {
  slider.addEventListener("input", () => {
    if (label) showPercent(label, slider);
    extra?.();
    userChanged();
  });
}

dom.chooseWrinklesBtn.addEventListener("click", () => setModule("wrinkles"));
dom.wrinklesSampleBtn.addEventListener("click", loadSamplePhoto);
dom.chooseAcneBtn.addEventListener("click", () => setModule("acne"));
dom.acneSampleBtn.addEventListener("click", loadSamplePhoto);
chooseSkinBtn.addEventListener("click", () => setModule("skin"));
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

// Wrinkles
bindSlider(wrinklesSlider, null, syncWrinklesPreset);
dom.wrinklesPresetButtons.forEach((btn) =>
  btn.addEventListener("click", () => {
    wrinklesSlider.value = btn.dataset.wrinklesPreset;
    syncWrinklesPreset();
    userChanged();
  }),
);
skinDebug.addEventListener("change", userChanged);

// Acne
bindSlider(acneSlider, acneValue, syncAcnePreset);
dom.acnePresetButtons.forEach((btn) =>
  btn.addEventListener("click", () => {
    acneSlider.value = btn.dataset.acnePreset;
    showPercent(acneValue, acneSlider);
    syncAcnePreset();
    userChanged();
  }),
);

// Skin brightness
bindSlider(brightnessSlider, brightnessValue);

// Lips
const lipPresetDefaults = {
  16: { roll: 60, blend: 55 },
  28: { roll: 84, blend: 57 },
  50: { roll: 76, blend: 55 },
};
presetBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    lipSlider.value = btn.dataset.lipPreset;
    showPercent(lipValue, lipSlider);
    const defaults = lipPresetDefaults[btn.dataset.lipPreset];
    if (defaults) {
      verticalSlider.value = defaults.roll;
      blendSlider.value = defaults.blend;
      showPercent(verticalValue, verticalSlider);
      showPercent(blendValue, blendSlider);
    }
    syncPreset();
    userChanged();
  });
});
shadeBtns.forEach((btn) => {
  btn.addEventListener("click", () =>
    setShade(btn.dataset.shade, btn.dataset.hex),
  );
});
bindSlider(lipSlider, lipValue, syncPreset);
bindSlider(verticalSlider, verticalValue);
bindSlider(blendSlider, blendValue);
bindSlider(colorSlider, colorValue, () => {
  selectedShade = Number(colorSlider.value) > 0 ? "brightred" : "off";
  selectedShadeHex = selectedShade === "off" ? "" : "#DE4B50";
  syncShadeButtons();
});
lipDebug.addEventListener("change", renderAll);

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
