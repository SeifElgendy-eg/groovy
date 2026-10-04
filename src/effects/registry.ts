// Declarative description of every service ("effect") the app offers. UI wiring and the render
// loop read these records instead of branching on module names, so adding a service means adding
// one entry here (plus its implementation) rather than editing every if/else chain.

export type ServiceId = "lips" | "wrinkles" | "acne" | "skin" | "body";
export type ModuleId = "home" | ServiceId;
export type SampleKind = "sample" | "sample-acne" | "sample-wrinkles";

export interface ModuleMeta {
  id: ModuleId;
  /** Small label above the title in the sidebar header. */
  eyebrow: string;
  title: string;
  /** Which bundled test photo the "Test Photo" button loads. */
  sampleKind: SampleKind;
  sampleButtonLabel: string;
  /** Needs the skin segmentation mask (and offers the "show face mask" debug view). */
  usesSkinMask: boolean;
  /** Draws the whole photo itself before its effect (otherwise it overlays the <img>). */
  paintsBaseFrame: boolean;
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
  usesSkinMask: false,
  paintsBaseFrame: false,
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
    usesSkinMask: false,
    paintsBaseFrame: true,
    resetShowsBefore: false,
  captureDelaySeconds: 0,
  },
  wrinkles: {
    id: "wrinkles",
    eyebrow: "WRINKLES",
    title: "Botox (wrinkles)",
    sampleKind: "sample-wrinkles",
    sampleButtonLabel: "Test Photo · Wrinkles",
    usesSkinMask: true,
    paintsBaseFrame: false,
    resetShowsBefore: true,
  captureDelaySeconds: 0,
  },
  acne: {
    id: "acne",
    eyebrow: "ACNE",
    title: "Acne Treatment",
    sampleKind: "sample-acne",
    sampleButtonLabel: "Test Photo · Acne",
    usesSkinMask: true,
    paintsBaseFrame: false,
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
    usesSkinMask: false,
    paintsBaseFrame: false,
    resetShowsBefore: false,
  captureDelaySeconds: 5,
  },
  skin: {
    id: "skin",
    eyebrow: "SKIN",
    title: "Skin Brightness",
    sampleKind: "sample",
    sampleButtonLabel: "Test Photo",
    usesSkinMask: true,
    paintsBaseFrame: false,
    resetShowsBefore: false,
  captureDelaySeconds: 0,
  },
};

export const metaOf = (id: ModuleId): ModuleMeta =>
  id === "home" ? HOME_META : SERVICES[id];
