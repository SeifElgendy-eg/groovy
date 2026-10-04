// A whole-second countdown before the photo is taken, so the person can press the button and then
// walk back into position (body shaping is shot from a couple of metres away). Pure: no DOM, and
// the timers can be replaced, so it is unit-tested without a browser.

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

// Looked up on every call (not captured at load), so fake timers in tests are honoured.
const realTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
};

export interface CountdownHooks {
  /** Once per second with the whole seconds left: N, N-1, ... 1. */
  onTick(remaining: number): void;
  /** One second after the last tick: take the photo. */
  onDone(): void;
  /** Stopped before it finished (never called after onDone). */
  onCancel?(): void;
}

export interface Countdown {
  cancel(): void;
  readonly running: boolean;
}

/**
 * Start counting down `seconds` (rounded down). Ticks N..1 at one-second steps, then `onDone`
 * after N seconds in all. Less than one second: `onDone` straight away, nothing to cancel.
 */
export function startCountdown(seconds: number, hooks: CountdownHooks, timers: Timers = realTimers): Countdown {
  let remaining = Math.floor(seconds);
  let running = remaining >= 1;
  let id: unknown = null;

  if (!running) {
    hooks.onDone();
    return { cancel() {}, running: false };
  }

  const step = (): void => {
    id = null;
    if (remaining === 0) {
      running = false;
      hooks.onDone();
      return;
    }
    hooks.onTick(remaining);
    if (!running) return; // cancelled from inside onTick
    remaining--;
    id = timers.setTimeout(step, 1000);
  };

  const countdown: Countdown = {
    cancel() {
      if (!running) return;
      running = false;
      if (id !== null) timers.clearTimeout(id);
      id = null;
      hooks.onCancel?.();
    },
    get running() {
      return running;
    },
  };
  step();
  return countdown;
}

/** Text of the capture button: the service's own timer, or Cancel while one is running. */
export function captureLabel(delaySeconds: number, remaining: number | null): string {
  if (remaining !== null) return "Cancel";
  const s = Math.floor(delaySeconds);
  return s >= 1 ? `Start ${s}-second timer` : "Take photo";
}

/** Short instruction under the big number. */
export function countdownCaption(remaining: number): string {
  return remaining > 1 ? "Get into position" : "Hold still";
}
