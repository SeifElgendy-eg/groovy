// Staff-only lip tuning (Lip Roll, Edge Blend, and which filler look): hidden from customers, who
// only choose the volume in ml. Shown with Ctrl+Alt+L (or Ctrl+Shift+L), or by opening the page
// with ?tuning.

import { kioskConfig } from "../app/kioskConfig";

/** Which filler look the clinic uses: the current one or the classic one (kept on this kiosk). */
export type LipStyle = "current" | "classic";
const KEY = "groovy.lipStyle";

/** The staff toggle's choice this session, when kiosk.json sets the look (not remembered then). */
let session: LipStyle | null = null;

/** kiosk.json's lipsLook wins; without it, the staff toggle's remembered choice. */
export function lipStyle(): LipStyle {
  if (session) return session;
  const fromConfig = kioskConfig().lipsLook;
  if (fromConfig) return fromConfig;
  try {
    return localStorage.getItem(KEY) === "classic" ? "classic" : "current";
  } catch {
    return "current";
  }
}

/** `changed`: the look was switched (redraw). */
export function mountLipTuning(changed: () => void): void {
  const panel = document.getElementById("lipTuning");
  if (!panel) return;
  if (new URLSearchParams(location.search).has("tuning")) panel.hidden = false;
  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey && (e.altKey || e.shiftKey) && e.key.toLowerCase() === "l") {
      e.preventDefault();
      panel.hidden = !panel.hidden;
    }
  });
  const classic = document.getElementById("lipClassic") as HTMLInputElement | null;
  if (!classic) return;
  classic.checked = lipStyle() === "classic";
  classic.addEventListener("change", () => {
    const style: LipStyle = classic.checked ? "classic" : "current";
    // kiosk.json decides the look: the toggle only tries the other one until the app restarts
    if (kioskConfig().lipsLook) {
      session = style;
      return changed();
    }
    try {
      localStorage.setItem(KEY, classic.checked ? "classic" : "current");
    } catch {
      // (private window: the choice lasts until the page is closed)
    }
    changed();
  });
}
