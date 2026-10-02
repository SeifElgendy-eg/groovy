// The one place mutable session state lives. Modules import `state` instead of sharing
// closure variables, so who reads and writes what is visible from the imports.
import type { LipData } from "../effects/lips/geometry";
import type { ModuleId, SampleKind } from "../effects/registry";
import type { NormalizedLandmark } from "../effects/skin/input";
import { INITIAL_ALIGNMENT, type AlignmentState } from "../face/alignment";

export type SourceMode = "camera" | "photo";
export type PhotoKind = "upload" | SampleKind;

export const state = {
  module: "home" as ModuleId,
  sourceMode: "camera" as SourceMode,
  photoKind: "upload" as PhotoKind,
  /** The "Show Before" toggle. */
  showBefore: false,
  /** A camera stream or photo is loaded and the stage is live. */
  running: false,
  modelReady: false,
  /** The latest detected face (normalised landmarks), or null. */
  facePoints: null as NormalizedLandmark[] | null,
  lipData: null as LipData | null,
  skinMaskReady: false,
  /** Camera capture guide. */
  faceAligned: false,
  alignment: { ...INITIAL_ALIGNMENT } as AlignmentState,
  /** The current photo came from the camera's "Take photo" button. */
  capturedPhoto: false,
  selectedShade: "off",
  selectedShadeHex: "",
  lipFinish: "natural" as "natural" | "matte" | "gloss",
};

export function resetAlignment(): void {
  state.faceAligned = false;
  state.alignment = { ...INITIAL_ALIGNMENT };
}
