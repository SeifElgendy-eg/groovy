// Helper workers for the botox stages (see wrinkles/parallel.ts), started once and kept.
import type { RunStage } from "../wrinkles/parallel";

interface Helper {
  worker: Worker;
  busy: boolean;
}
interface Waiting {
  name: string;
  args: unknown;
  resolve: (v: never) => void;
  reject: (e: Error) => void;
}

let helpers: Helper[] | null = null;
const waiting: Waiting[] = [];
const pending = new Map<number, { resolve: (v: never) => void; reject: (e: Error) => void; helper: Helper }>();
let nextId = 0;

/** How many helpers to use: one per spare core, at most four (the four areas). 0: not worth it, or no shared memory. */
export function helperCount(): number {
  if (typeof SharedArrayBuffer === "undefined" || !(globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated) return 0;
  const cores = navigator.hardwareConcurrency || 1;
  return cores >= 3 ? Math.min(4, cores - 1) : 0;
}

function start(): Helper[] {
  if (helpers) return helpers;
  helpers = Array.from({ length: helperCount() }, () => {
    const h: Helper = { worker: new Worker(new URL("./helper.ts", import.meta.url), { type: "module", name: "botox-helper" }), busy: false };
    h.worker.onmessage = (e: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
      const job = pending.get(e.data.id);
      if (!job) return;
      pending.delete(e.data.id);
      h.busy = false;
      if (e.data.error !== undefined) job.reject(new Error(e.data.error));
      else job.resolve(e.data.result as never);
      next();
    };
    h.worker.onerror = (e) => {
      e.preventDefault();
      // A helper that fails takes its job with it; the caller falls back to one core.
      for (const [id, job] of pending) if (job.helper === h) {
        pending.delete(id);
        job.reject(new Error("botox helper failed: " + e.message));
      }
      h.busy = false;
    };
    return h;
  });
  return helpers;
}

function next(): void {
  const list = helpers ?? [];
  for (const h of list) {
    if (h.busy || !waiting.length) continue;
    const job = waiting.shift()!;
    const id = nextId++;
    h.busy = true;
    pending.set(id, { resolve: job.resolve, reject: job.reject, helper: h });
    h.worker.postMessage({ id, name: job.name, args: job.args });
  }
}

/** Run a stage on the next free helper. */
export const runStage: RunStage = (name, args) =>
  new Promise((resolve, reject) => {
    start();
    waiting.push({ name, args, resolve: resolve as (v: never) => void, reject });
    next();
  });
