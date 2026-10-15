// The kiosk's own settings, from kiosk.json next to "Start Groovy.vbs" (served by the launcher at
// /kiosk.json; in development, the repository's kiosk.json). Staff edit it with Notepad. A missing
// or broken file leaves the defaults, and says so (the status line, the console).
import { setStatus } from "../ui/status";

export interface KioskConfig {
  /** Which lips filter: "classic" (before 3 Oct 2026) or "current". Unset: the staff toggle decides. */
  lipsLook?: "classic" | "current";
}

let config: KioskConfig = {};
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
  const next: KioskConfig = {};
  if (r.lipsLook === "classic" || r.lipsLook === "current") next.lipsLook = r.lipsLook;
  else if (r.lipsLook !== undefined) {
    problem = `kiosk.json: lipsLook must be "classic" or "current" (it is ${JSON.stringify(r.lipsLook)}): using the default`;
    console.warn(problem);
  }
  config = next;
  console.info("kiosk.json:", JSON.stringify(config));
}
