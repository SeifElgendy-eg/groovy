// Web Worker: runs the skin effects' pixel work off the main thread, so the page stays responsive
// while a photo is processed.
import { expose, transfer } from "comlink";
import { acneCompute, wrinklesCompute, type AcneJob, type WrinklesJob } from "./compute";
import { textureCompute, type TextureJob } from "../acne/texture";

const api = {
  acne(job: AcneJob) {
    const r = acneCompute(job);
    return transfer(r, [r.corrected.buffer, r.faded.buffer]);
  },
  texture(job: TextureJob) {
    const r = textureCompute(job);
    return transfer(r, [r.pores.mul.buffer, r.pores.add.buffer, r.scars.mul.buffer, r.scars.add.buffer, r.redness.mul.buffer, r.redness.add.buffer]);
  },
  wrinkles(job: WrinklesJob) {
    const r = wrinklesCompute(job);
    return transfer(r, [r.faded.buffer, r.add.buffer, r.mul.buffer]);
  },
};

export type SkinWorkerApi = typeof api;
expose(api);
