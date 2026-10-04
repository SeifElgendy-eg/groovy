// A helper worker for the botox stages (wrinkles/parallel.ts): runs one stage at a time and hands
// its arrays back in shared memory.
import { STAGES, share, type StageName } from "../wrinkles/parallel";

self.onmessage = (e: MessageEvent<{ id: number; name: StageName; args: unknown }>) => {
  const { id, name, args } = e.data;
  try {
    const result = share((STAGES[name] as (a: unknown) => unknown)(args));
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
