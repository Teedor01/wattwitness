import { encodeWav16 } from "../../src";
import { App, ACTORS } from "../../pwa/src/app";
import { buildDemoBundle } from "../../pwa/src/demomodel";
import { FIXTURE_RATE, fixtureSamples } from "../../pwa/src/fixtures";
import { MemoryBackend, PersistentKv } from "../../pwa/src/store";
import type { AppConfig, GateStatus, ModelBundle } from "../../pwa/src/types";

export { ACTORS, FIXTURE_RATE, fixtureSamples, MemoryBackend, PersistentKv, encodeWav16 };

let cached: ModelBundle | undefined;
export function demoBundle(): ModelBundle {
  return (cached ??= buildDemoBundle());
}

export const NOW_MS = Date.UTC(2026, 9, 18, 12, 0, 0);

export interface Rig {
  app: App;
  backend: MemoryBackend;
  online: { value: boolean };
  clock: { ms: number };
  config: AppConfig;
}

export function configFor(gate: GateStatus, withProduction = false): AppConfig {
  const demo = demoBundle();
  return {
    buildLabel: "test",
    gate: { status: gate, detail: "" },
    models: { demo, ...(withProduction ? { production: { ...demo, synthetic: false } } : {}) },
    testnet: {},
  };
}

export async function makeRig(opts: { gate?: GateStatus; production?: boolean; backend?: MemoryBackend; online?: boolean; clockMs?: number } = {}): Promise<Rig> {
  const backend = opts.backend ?? new MemoryBackend();
  const online = { value: opts.online ?? true };
  const clock = { ms: opts.clockMs ?? NOW_MS };
  const config = configFor(opts.gate ?? "NOT_RUN", opts.production ?? false);
  const kv = await PersistentKv.open(backend);
  const app = await App.create({ kv, now: () => clock.ms, isOnline: () => online.value, config });
  return { app, backend, online, clock, config };
}

export async function reload(rig: Rig): Promise<Rig> {
  return makeRig({ backend: rig.backend, online: rig.online.value, clockMs: rig.clock.ms, gate: rig.config.gate.status, production: rig.config.models.production !== undefined });
}

export const todayDay = (ms: number): number => Math.floor(ms / 86_400_000);
