// Declarative description of every service ("effect") the app offers. UI wiring and the render
// loop read these records instead of branching on module names, so adding a service means adding
// one entry here (plus its implementation) rather than editing every if/else chain.

export type ServiceId = "lips" | "wrinkles" | "acne" | "skin" | "body";
export type ModuleId = "home" | ServiceId;
export type SampleKind = "sample" | "sample-acne" | "sample-wrinkles";

/**
 * What a photo is analysed for before the service draws (app/pipeline.ts runs exactly these, once
 * per photo): the face's landmarks, the skin mask (needs the face), the person's outline.
 */
export type PhotoNeed = "face" | "skinMask" | "person";
/**
 * What the live camera analyses: "track" the face for the capture guide (every live analysis),
 * the face only for the camera's "exposure" (when the staff camera panel or the face-exposure
 * option uses it, a few times a second), or "none".
 */
export type LiveNeed = "track" | "exposure" | "none";

export interface ServiceNeeds {
  photo: readonly PhotoNeed[];
  live: LiveNeed;
}

const FACE_PHOTO: ServiceNeeds = { photo: ["face"], live: "track" };
const SKIN_PHOTO: ServiceNeeds = { photo: ["face", "skinMask"], live: "track" };

export interface ModuleMeta {
  id: ModuleId;
  /** Small label above the title in the sidebar header. */
  eyebrow: string;
  title: string;
  /** Which bundled test photo the "Test Photo" button loads. */
  sampleKind: SampleKind;
  sampleButtonLabel: string;
  /** What the photo and the live camera are analysed for (see ServiceNeeds). */
  needs: ServiceNeeds;
  /** "Reset All" leaves the view on the Before image. */
  resetShowsBefore: boolean;
  /**
   * Seconds between pressing "Take photo" and the photo being taken (0: immediately). Services
   * shot from a distance (the whole body) need time to step back into position.
   */
  captureDelaySeconds: number;
}

export const HOME_META: ModuleMeta = {
  id: "home",
  eyebrow: "SERVICE",
  title: "Choose a service",
  sampleKind: "sample",
  sampleButtonLabel: "Test Photo",
  needs: { photo: [], live: "none" },
  resetShowsBefore: false,
  captureDelaySeconds: 0,
};

export const SERVICES: Record<ServiceId, ModuleMeta> = {
  lips: {
    id: "lips",
    eyebrow: "LIPS",
    title: "Filler (lips)",
    sampleKind: "sample",
    sampleButtonLabel: "Test Photo",
    needs: FACE_PHOTO,
    resetShowsBefore: false,
    captureDelaySeconds: 0,
  },
  wrinkles: {
    id: "wrinkles",
    eyebrow: "WRINKLES",
    title: "Botox (wrinkles)",
    sampleKind: "sample-wrinkles",
    sampleButtonLabel: "Test Photo · Wrinkles",
    needs: SKIN_PHOTO,
    resetShowsBefore: true,
    captureDelaySeconds: 0,
  },
  acne: {
    id: "acne",
    eyebrow: "ACNE",
    title: "Acne Treatment",
    sampleKind: "sample-acne",
    sampleButtonLabel: "Test Photo · Acne",
    needs: SKIN_PHOTO,
    resetShowsBefore: false,
    captureDelaySeconds: 0,
  },
  body: {
    id: "body",
    eyebrow: "BODY",
    title: "Weight loss (body shaping)",
    // No full-body test photo is bundled yet: the button loads the face test photo.
    sampleKind: "sample",
    sampleButtonLabel: "Test Photo",
    needs: { photo: ["person"], live: "exposure" },
    resetShowsBefore: false,
  captureDelaySeconds: 5,
  },
  skin: {
    id: "skin",
    eyebrow: "SKIN",
    title: "Skin Brightness",
    sampleKind: "sample",
    sampleButtonLabel: "Test Photo",
    needs: SKIN_PHOTO,
    resetShowsBefore: false,
    captureDelaySeconds: 0,
  },
};

export const metaOf = (id: ModuleId): ModuleMeta =>
  id === "home" ? HOME_META : SERVICES[id];

/** The service uses the skin mask (and offers the staff "show face mask" view). */
export const usesSkinMask = (id: ModuleId): boolean => metaOf(id).needs.photo.includes("skinMask");
