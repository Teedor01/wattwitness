import { FEATURE_NAMES, LABELS, evaluateLeaveOneClipOut, extractWindowFeatures, splitWindows, type TrainingSample } from "../src";
import { synthClip, type SynthKind } from "../test/sensing/synth";
import { formatConfusion } from "./audio-lib";

const samples: TrainingSample[] = [];
for (const kind of LABELS as readonly SynthKind[]) {
  for (let i = 0; i < 6; i++) {
    for (const w of splitWindows(synthClip(kind, i + 1 + LABELS.indexOf(kind) * 1000, 20))) {
      samples.push({ features: extractWindowFeatures(w.samples).features, label: kind, groupId: `${kind}-${i}` });
    }
  }
}
const r = evaluateLeaveOneClipOut(samples, { featureNames: FEATURE_NAMES });
console.log("SYNTHETIC DEMO: not evidence about real generators\n");
console.log(formatConfusion(r.labels, r.confusion));
console.log(`\nwindow accuracy ${r.accuracy.toFixed(3)} over ${r.windows} windows, ${r.clipsEvaluated} clips held out one at a time`);
