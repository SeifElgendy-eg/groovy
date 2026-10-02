// Camera access, free of any UI state.

export async function openUserCamera(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia)
    throw new Error("Camera requires HTTPS or localhost.");
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: "user",
      // Ask for the sensor's full 4K mode (EMEET S600: 3840x2160@30). The browser falls back to
      // the closest mode the camera offers; cameraInfo() reports what was actually granted.
      width: { ideal: 3840 },
      height: { ideal: 2160 },
      frameRate: { ideal: 30, max: 30 },
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

export interface CameraInfo {
  label: string;
  width: number;
  height: number;
  frameRate: number;
  /** The stream is below the requested 4K. */
  below4k: boolean;
}

export function cameraInfo(stream: MediaStream): CameraInfo | null {
  const track = stream.getVideoTracks()[0];
  if (!track) return null;
  const s = track.getSettings();
  const width = s.width ?? 0,
    height = s.height ?? 0;
  return {
    label: track.label,
    width,
    height,
    frameRate: Math.round(s.frameRate ?? 0),
    below4k: Math.max(width, height) < 3840,
  };
}
