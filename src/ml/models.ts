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

export async function loadModels(): Promise<Models> {
  const vision = await FilesetResolver.forVisionTasks(WASM_PATH);

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
    faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
      ...faceCommon,
      baseOptions: { ...faceCommon.baseOptions, delegate: "GPU" },
    });
  } catch {
    faceLandmarker = await FaceLandmarker.createFromOptions(vision, faceCommon);
  }

  const segmentOptions = {
    baseOptions: { modelAssetPath: SEG_MODEL },
    runningMode: "IMAGE" as const,
    outputCategoryMask: true,
    outputConfidenceMasks: false,
  };
  let segmenter: ImageSegmenter;
  try {
    segmenter = await ImageSegmenter.createFromOptions(vision, {
      ...segmentOptions,
      baseOptions: { modelAssetPath: SEG_MODEL, delegate: "GPU" },
    });
  } catch {
    segmenter = await ImageSegmenter.createFromOptions(vision, segmentOptions);
  }
  return { faceLandmarker, segmenter };
}
