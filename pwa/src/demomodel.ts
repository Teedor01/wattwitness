import { FEATURE_NAMES, LABELS, extractWindowFeatures, modelVersion, splitWindows, trainGnb, type TrainingSample } from "../../src";
import { synthClip, type SynthKind } from "../../test/sensing/synth";
import type { ModelBundle } from "./types";

export function buildDemoBundle(): ModelBundle {
  const samples: TrainingSample[] = [];
  for (const kind of LABELS as readonly SynthKind[]) {
    for (let i = 0; i < 6; i++) {
      const clip = synthClip(kind, i + 1 + LABELS.indexOf(kind) * 1000, 20);
      for (const w of splitWindows(clip)) samples.push({ features: extractWindowFeatures(w.samples).features, label: kind, groupId: `${kind}-${i}` });
    }
  }
  const model = trainGnb(samples, { featureNames: FEATURE_NAMES });
  return { model, version: modelVersion(model), synthetic: true };
}
