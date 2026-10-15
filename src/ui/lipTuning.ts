// Staff-only lip tuning (Lip Roll, Edge Blend, and which filler look): hidden from customers, who
// only choose the volume in ml. Shown with Ctrl+Alt+L (or Ctrl+Shift+L), or by opening the page
// with ?tuning.

/** Which filler look the clinic uses: the current one or the classic one (kept on this kiosk). */
export type LipStyle = "current" | "classic";
const KEY = "groovy.lipStyle";

export function lipStyle(): LipStyle {
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
    try {
      localStorage.setItem(KEY, classic.checked ? "classic" : "current");
    } catch {
      // (private window: the choice lasts until the page is closed)
    }
    changed();
  });
}
