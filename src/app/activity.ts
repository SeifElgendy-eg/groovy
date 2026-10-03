// Freeze finder. Records what the app was doing (labelled spans) and matches the browser's
// "long task" reports against them, so a freeze on the kiosk can be named ("live face tracking",
// "camera control", ...) instead of guessed. Costs two numbers per span.

interface Span {
  label: string;
  start: number;
  end: number;
}

export interface Freeze {
  ms: number;
  label: string;
  at: number;
}

const spans: Span[] = [];
const MAX_SPANS = 200;
const recent: Freeze[] = [];
const listeners = new Set<() => void>();

function record(label: string, start: number): void {
  spans.push({ label, start, end: performance.now() });
  if (spans.length > MAX_SPANS) spans.splice(0, spans.length - MAX_SPANS);
}

/** Label an async operation. */
export async function tracked<T>(label: string, fn: () => Promise<T> | T): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    record(label, start);
  }
}

/** Label a synchronous operation. */
tracked.sync = function <T>(label: string, fn: () => T): T {
  const start = performance.now();
  try {
    return fn();
  } finally {
    record(label, start);
  }
};

function labelFor(start: number, end: number): string {
  let best = "",
    bestOverlap = 0;
  for (const s of spans) {
    const overlap = Math.min(end, s.end) - Math.max(start, s.start);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = s.label;
    }
  }
  return best || "page work (unlabelled)";
}

/** How long the last run of each kind of heavy work took (ms), for the diagnostics panel. */
const lastWork = new Map<string, number>();

/** Note how long a piece of heavy work took (e.g. "botox" in the worker). */
export function noteWork(label: string, ms: number): void {
  lastWork.set(label, Math.round(ms));
  for (const fn of listeners) fn();
}

/** The last time taken by each kind of heavy work, in the order first seen. */
export function recentWork(): [string, number][] {
  return [...lastWork];
}

/** The longest freeze in the last `windowMs`, if any. */
export function worstRecentFreeze(windowMs = 30000): Freeze | null {
  const since = performance.now() - windowMs;
  let worst: Freeze | null = null;
  for (const f of recent) if (f.at >= since && (!worst || f.ms > worst.ms)) worst = f;
  return worst;
}

export function onFreeze(fn: () => void): void {
  listeners.add(fn);
}

try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (e.duration < 150) continue;
      const f: Freeze = { ms: Math.round(e.duration), label: labelFor(e.startTime, e.startTime + e.duration), at: e.startTime };
      recent.push(f);
      if (recent.length > 50) recent.shift();
      if (f.ms >= 300) console.warn(`freeze ${f.ms} ms during: ${f.label}`);
      for (const fn of listeners) fn();
    }
  }).observe({ type: "longtask", buffered: true });
} catch {
  /* long-task reporting unsupported: the panel just shows nothing */
}
