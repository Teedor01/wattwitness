import { synthClip, type SynthKind } from "../../test/sensing/synth";

export const FIXTURE_KINDS: ReadonlyArray<{ kind: SynthKind; title: string }> = [
  { kind: "generator", title: "Generator-like engine signal" },
  { kind: "grid_hum", title: "Mains hum only" },
  { kind: "silence", title: "Quiet room" },
  { kind: "other", title: "Other noise (speech, fan, traffic)" },
];

export function fixtureSamples(kind: SynthKind, seed = 1, seconds = 60): Float64Array {
  return synthClip(kind, seed, seconds);
}
export const FIXTURE_RATE = 16_000;
