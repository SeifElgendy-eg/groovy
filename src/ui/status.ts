// Only problems are shown to the user. Progress messages stay silent, but any newer status
// (loading, ready) replaces a previous error, so a retry starts from a clean screen.
import { dom } from "./dom";

const statusToast = document.createElement("div");
statusToast.className = "status-toast";
statusToast.setAttribute("role", "alert");
statusToast.hidden = true;

export type StatusType = "loading" | "ready" | "error";

export function mountStatusToast(): void {
  dom.stageWrap.append(statusToast);
}

export function setStatus(text: string, type: StatusType = "loading"): void {
  if (type === "error") {
    statusToast.textContent = text;
    statusToast.hidden = false;
  } else {
    statusToast.hidden = true;
  }
}
