// The services the app offers, by id. Adding one: its effect in src/effects, its facts in
// effects/registry.ts, its adapter here (a Service), its controls in index.html.
import type { ServiceId } from "../../effects/registry";
import { acneService } from "./acne";
import { bodyService } from "./body";
import { lipsService } from "./lips";
import type { Service } from "./service";
import { skinService } from "./skin";
import { wrinklesService } from "./wrinkles";

export const services: Record<ServiceId, Service> = {
  lips: lipsService,
  wrinkles: wrinklesService,
  acne: acneService,
  skin: skinService,
  body: bodyService,
};
export const allServices: Service[] = Object.values(services);

/** The face, mask or source changed: every service re-analyses before its next draw. */
export function markEffectsDirty(): void {
  for (const s of allServices) s.invalidate();
}

export const anyBusy = (): boolean => allServices.some((s) => s.busy());

export { setupBodyBrush } from "./body";
export type { Service, Stage } from "./service";
