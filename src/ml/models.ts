// MediaPipe model loading: face landmarks (478-point mesh) and skin segmentation.
// Each tries the GPU delegate first and falls back to CPU.
import {
  FaceLandmarker,
  FilesetResolver,
  ImageSegmenter,
} from "@mediapipe/tasks-vision";

// Relative to the page: these live in public/ and are copied verbatim into the build.
const WASM_PATH = "./vendor/mediapipe/wasm";
const FACE_MODEL = "./models/face_landmarker.task";
const SEG_MODEL = "./models/selfie_multiclass_256x256.tflite";

export interface Models {
  faceLandmarker: FaceLandmarker;
  segmenter: ImageSegmenter;
}

let fileset: ReturnType<typeof FilesetResolver.forVisionTasks> | null = null;
const vision = () => (fileset ??= FilesetResolver.forVisionTasks(WASM_PATH));

/**
 * A second face landmarker in VIDEO mode for the live camera. Switching one instance between
 * IMAGE and VIDEO rebuilds its whole graph (a ~1 s freeze on every photo capture and every return
 * to the camera); keeping one instance per mode removes that.
 */
export async function loadVideoLandmarker(): Promise<FaceLandmarker> {
  const options = {
    baseOptions: { modelAssetPath: FACE_MODEL },
    runningMode: "VIDEO" as const,
    numFaces: 1,
    minFaceDetectionConfidence: 0.5,
    minFacePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  };
  const fs = await vision();
  try {
    return await FaceLandmarker.createFromOptions(fs, {
      ...options,
      baseOptions: { ...options.baseOptions, delegate: "GPU" },
    });
  } catch {
    return FaceLandmarker.createFromOptions(fs, options);
  }
}

export async function loadModels(): Promise<Models> {
  const vision_ = await vision();

  const faceCommon = {
    baseOptions: { modelAssetPath: FACE_MODEL },
    runningMode: "IMAGE" as const,
    numFaces: 1,
    minFaceDetectionConfidence: 0.5,
    minFacePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  };
  let faceLandmarker: FaceLandmarker;
  try {
    faceLandmarker = await FaceLandmarker.createFromOptions(vision_, {
      ...faceCommon,
      baseOptions: { ...faceCommon.baseOptions, delegate: "GPU" },
    });
  } catch {
    faceLandmarker = await FaceLandmarker.createFromOptions(vision_, faceCommon);
  }

  const segmentOptions = {
    baseOptions: { modelAssetPath: SEG_MODEL },
    runningMode: "IMAGE" as const,
    outputCategoryMask: true,
    outputConfidenceMasks: false,
  };
  let segmenter: ImageSegmenter;
  try {
    segmenter = await ImageSegmenter.createFromOptions(vision_, {
      ...segmentOptions,
      baseOptions: { modelAssetPath: SEG_MODEL, delegate: "GPU" },
    });
  } catch {
    segmenter = await ImageSegmenter.createFromOptions(vision_, segmentOptions);
  }
  return { faceLandmarker, segmenter };
}
