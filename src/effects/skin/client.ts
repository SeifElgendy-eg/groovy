// The skin effects call these instead of the pure functions directly: the work runs in a Web
// Worker when one can be started, and on the main thread otherwise (same results either way).
//
// Botox and acne each have their own worker ("lane"), so one can be stopped without touching the
// other: a botox job for a photo that has since been replaced is cancelled by ending its worker
// (a running computation cannot be interrupted any other way), and the next job starts a fresh
// one. A job that fails in the worker (e.g. it ran out of memory) is tried once more in a fresh
// worker, whose memory starts clean, before falling back to the main thread.
import { wrap, type Remote } from "comlink";
import {
  acneCompute,
  wrinklesCompute,
  type AcneJob,
  type AcneResult,
  type WrinklesJob,
  type WrinklesResult,
} from "./compute";
import type { SkinWorkerApi } from "./worker";
import { noteWork } from "../../app/activity";
import { textureCompute, type TextureJob, type TextureResult } from "../acne/texture";
import { linesCompute, linesLayers, type AreaId, type LinesJob, type LinesResult } from "../wrinkles/lines";

export type Lane = "botox" | "acne";

/** Rejection of a job whose lane was cancelled (its input is out of date): not an error. */
export class Cancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "Cancelled";
  }
}

interface Handle {
  worker: Worker;
  api: Remote<SkinWorkerApi>;
  /** Rejects if the worker script fails to load or crashes, or the lane is cancelled. */
  failed: Promise<never>;
  stop: (reason: Error) => void;
  /** Jobs sent and not yet answered. */
  running: number;
  /** It has answered a job (so it loads and runs). */
  answered: boolean;
}

const handles = new Map<Lane, Handle>();
/** Workers cannot be started here (no Worker, or it failed to load): run on the main thread. */
let unavailable = false;

function worker(lane: Lane): Handle | null {
  if (unavailable) return null;
  const existing = handles.get(lane);
  if (existing) return existing;
  try {
    const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: `skin-${lane}` });
    let stop: (reason: Error) => void = () => {};
    const failed = new Promise<never>((_, reject) => (stop = reject));
    failed.catch(() => {}); // only observed through race()
    const h: Handle = {
      worker: w,
      api: wrap<SkinWorkerApi>(w),
      failed,
      running: 0,
      answered: false,
      stop: (reason) => {
        if (handles.get(lane) === h) handles.delete(lane);
        w.terminate();
        stop(reason);
      },
    };
    w.addEventListener("error", (e) => {
      console.warn(`skin worker (${lane}) failed`, e.message);
      e.preventDefault();
      // One that never ran a job cannot load here: use the main thread from now on.
      if (!h.answered) unavailable = true;
      h.stop(new Error("skin worker failed"));
    });
    handles.set(lane, h);
    return h;
  } catch (err) {
    console.warn("skin worker unavailable; using the main thread", err);
    unavailable = true;
    return null;
  }
}

/**
 * Stop the lane's running jobs (they reject with Cancelled) and drop its worker, with whatever it
 * cached (the botox layers): the next job starts a fresh worker. Does nothing when the lane is idle.
 */
export function cancel(lane: Lane): void {
  const h = handles.get(lane);
  if (h && h.running > 0) h.stop(new Cancelled());
}

// Inputs are copied to the worker (not transferred), so a failed worker can be retried, or fall
// back to the main thread, with the same data. Outputs are transferred back without copying.
async function run<J, R>(label: string, lane: Lane, job: J, remoteCall: (h: Handle) => Promise<R>, local: (j: J) => R): Promise<R> {
  const start = performance.now();
  const runLocal = () => {
    document.body.dataset.skinCompute = "main";
    const result = local(job);
    noteWork(`${label} (main thread)`, performance.now() - start);
    return result;
  };
  for (let attempt = 0; ; attempt++) {
    const h = worker(lane);
    if (!h) return runLocal();
    h.running++;
    try {
      const result = await Promise.race([remoteCall(h), h.failed]);
      h.answered = true;
      document.body.dataset.skinCompute = "worker"; // lets tests confirm the worker really ran
      noteWork(label, performance.now() - start);
      return result;
    } catch (err) {
      if (err instanceof Cancelled) throw err;
      console.warn(`skin job failed in the worker (${lane}, attempt ${attempt + 1})`, err);
      // Start over in a fresh worker (its memory starts clean); a second failure runs it here.
      h.stop(new Error("skin worker restarted"));
      if (attempt >= 1) return runLocal();
    } finally {
      h.running--;
    }
  }
}

export const runAcne = (job: AcneJob): Promise<AcneResult> =>
  run("acne spots", "acne", job, (h) => h.api.acne(job) as Promise<AcneResult>, acneCompute);

export const runWrinkles = (job: WrinklesJob): Promise<WrinklesResult> =>
  run("botox mask", "botox", job, (h) => h.api.wrinkles(job) as Promise<WrinklesResult>, wrinklesCompute);

export const runTexture = (job: TextureJob): Promise<TextureResult> =>
  run("pores and scars", "acne", job, (h) => h.api.texture(job) as Promise<TextureResult>, textureCompute);

export const runLines = (job: LinesJob): Promise<LinesResult> =>
  run("botox", "botox", job, (h) => h.api.lines(job) as Promise<LinesResult>, linesCompute);

/**
 * Layers for the botox areas that are on, from the last runLines (null: recompute). Never retried
 * elsewhere: a fresh worker or the main thread has no cached result, which null reports.
 */
export async function runLinesLayers(enabled: AreaId[]): Promise<Partial<LinesResult> | null> {
  const h = worker("botox");
  if (!h) return linesLayers(enabled);
  h.running++;
  try {
    const result = await Promise.race([h.api.linesLayers(enabled) as Promise<Partial<LinesResult> | null>, h.failed]);
    h.answered = true;
    return result;
  } catch (err) {
    if (err instanceof Cancelled) throw err;
    console.warn("botox layers failed in the worker", err);
    h.stop(new Error("skin worker restarted"));
    return null;
  } finally {
    h.running--;
  }
}
