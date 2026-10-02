// The skin effects call these instead of the pure functions directly: the work runs in a Web
// Worker when one can be started, and on the main thread otherwise (same results either way).
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

interface Handle {
  api: Remote<SkinWorkerApi>;
  /** Rejects if the worker script fails to load or crashes. */
  failed: Promise<never>;
}

let handle: Handle | null | undefined;

function worker(): Handle | null {
  if (handle !== undefined) return handle;
  try {
    const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "skin-effects" });
    const failed = new Promise<never>((_, reject) =>
      w.addEventListener("error", (e) => {
        console.warn("skin worker failed; using the main thread", e.message);
        handle = null;
        reject(new Error("skin worker failed"));
      }),
    );
    failed.catch(() => {}); // only observed through race()
    handle = { api: wrap<SkinWorkerApi>(w), failed };
  } catch (err) {
    console.warn("skin worker unavailable; using the main thread", err);
    handle = null;
  }
  return handle;
}

// Inputs are copied to the worker (not transferred), so a failed worker can fall back to the main
// thread with the same data. Outputs are transferred back without copying.
async function run<J, R>(job: J, remoteCall: (h: Handle) => Promise<R>, local: (j: J) => R): Promise<R> {
  const h = worker();
  if (!h) return local(job);
  try {
    const result = await Promise.race([remoteCall(h), h.failed]);
    document.body.dataset.skinCompute = "worker"; // lets tests confirm the worker really ran
    return result;
  } catch {
    document.body.dataset.skinCompute = "main";
    return local(job);
  }
}

export const runAcne = (job: AcneJob): Promise<AcneResult> =>
  run(job, (h) => h.api.acne(job) as Promise<AcneResult>, acneCompute);

export const runWrinkles = (job: WrinklesJob): Promise<WrinklesResult> =>
  run(job, (h) => h.api.wrinkles(job) as Promise<WrinklesResult>, wrinklesCompute);
