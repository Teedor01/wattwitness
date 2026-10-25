import type { ClassifiedWindow, GnbModel, Hex32 } from "../../src";

export type Source = "microphone" | "fixture" | "file" | "simulated";
export type GateStatus = "NOT_RUN" | "PASS" | "FAIL" | "STUBBED_FOR_TESTS";

export interface LocalWindowRecord extends ClassifiedWindow {
  id: string;
  siteId: Hex32;
  day: number;
  attesterId: string;
  modelVersion: string;
  modelSynthetic: boolean;
  source: Source;
  createdAt: number;
}

export const WINDOW_RECORD_KEYS: readonly string[] = [
  "startSec", "label", "confidenceMilli", "qualityOk",
  "id", "siteId", "day", "attesterId", "modelVersion", "modelSynthetic", "source", "createdAt",
];

export interface ModelBundle {
  model: GnbModel;
  version: string;
  synthetic: boolean;
}

export interface AppConfig {
  buildLabel: string;
  gate: { status: GateStatus; detail: string };
  models: { demo: ModelBundle; production?: ModelBundle };
  testnet: { address?: string; chainId?: number; explorerTxBase?: string };
}

export type FailureCode = "TOO_SHORT" | "DEAD_MICROPHONE" | "CLIPPED" | "MALFORMED_AUDIO" | "UNSUPPORTED_FORMAT" | "NO_MODEL";
export interface ObservationFailure {
  code: FailureCode;
  message: string;
}
