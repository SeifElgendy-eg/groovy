// Camera access, free of any UI state.

export async function openUserCamera(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia)
    throw new Error("Camera requires HTTPS or localhost.");
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: "user",
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 24, max: 30 },
    },
  });
}

export function stopStream(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((track) => track.stop());
}

export function describeCameraError(err: unknown): string {
  const e = err as { name?: string; message?: string };
  return e.name === "NotAllowedError"
    ? "Allow camera access in your browser settings."
    : e.name === "NotFoundError"
      ? "No camera found. Connect a camera and try again."
      : e.name === "NotReadableError"
        ? "Camera is busy. Close other camera apps and try again."
        : e.message || "Unable to start camera.";
}
