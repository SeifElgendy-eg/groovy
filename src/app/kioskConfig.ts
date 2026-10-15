// The kiosk's own settings, from kiosk.json next to "Start Groovy.vbs" (served by the launcher at
// /kiosk.json; in development, the repository's kiosk.json). Staff edit it with Notepad. A missing
// or broken file leaves the defaults, and says so (the status line, the console).
import { setStatus } from "../ui/status";

export interface KioskConfig {
  /** Which lips filter: "classic" (before 3 Oct 2026) or "current". Unset: the staff toggle decides. */
  lipsLook?: "classic" | "current";
  /**
   * Body shaping on a green screen: "auto" (default) puts the person on the branded background
   * whenever the photo has a green screen around them; "off" never does.
   */
  greenScreen: "auto" | "off";
  /** The branded background (kiosk folder path, e.g. "booth/background.jpg"). */
  background: string;
}

const DEFAULTS: KioskConfig = { greenScreen: "auto", background: "booth/background.jpg" };

let config: KioskConfig = { ...DEFAULTS };
/** What was wrong with kiosk.json (shown once the app is ready), or null. */
let problem: string | null = null;
export const kioskConfigProblem = (): string | null => problem;

export const kioskConfig = (): KioskConfig => config;

/** Read kiosk.json (once, at start). */
export async function loadKioskConfig(): Promise<void> {
  let raw: unknown;
  try {
    const res = await fetch(new URL("kiosk.json", document.baseURI), { cache: "no-store" });
    if (!res.ok) return; // no file: the defaults
    raw = await res.json();
  } catch (err) {
    console.warn("kiosk.json could not be read; using the defaults", err);
    problem = "kiosk.json has a mistake (check its quotes and commas): using the default settings";
    setStatus(problem, "error");
    return;
  }
  const r = (raw ?? {}) as Record<string, unknown>;
  const next: KioskConfig = { ...DEFAULTS };
  const wrong = (key: string, want: string) => {
    problem = `kiosk.json: ${key} must be ${want} (it is ${JSON.stringify(r[key])}): using the default`;
    console.warn(problem);
  };
  if (r.lipsLook === "classic" || r.lipsLook === "current") next.lipsLook = r.lipsLook;
  else if (r.lipsLook !== undefined) wrong("lipsLook", '"classic" or "current"');
  if (r.greenScreen === "auto" || r.greenScreen === "off") next.greenScreen = r.greenScreen;
  else if (r.greenScreen !== undefined) wrong("greenScreen", '"auto" or "off"');
  if (typeof r.background === "string" && /^[\w./ -]+\.(jpe?g|png|webp)$/i.test(r.background) && !r.background.includes("..")) next.background = r.background;
  else if (r.background !== undefined) wrong("background", 'a picture in the kiosk folder, e.g. "booth/background.jpg"');
  config = next;
  console.info("kiosk.json:", JSON.stringify(config));
}
