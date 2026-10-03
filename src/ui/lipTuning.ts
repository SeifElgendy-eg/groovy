// Staff-only lip tuning (Lip Roll, Edge Blend): hidden from customers, who only choose the volume
// in ml. Shown with Ctrl+Alt+L (or Ctrl+Shift+L), or by opening the page with ?tuning.
export function mountLipTuning(): void {
  const panel = document.getElementById("lipTuning");
  if (!panel) return;
  if (new URLSearchParams(location.search).has("tuning")) panel.hidden = false;
  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey && (e.altKey || e.shiftKey) && e.key.toLowerCase() === "l") {
      e.preventDefault();
      panel.hidden = !panel.hidden;
    }
  });
}
