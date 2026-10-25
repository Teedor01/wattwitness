import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_SENSING,
  LABELS,
  decodeWav,
  extractWindowFeatures,
  resample,
  splitWindows,
  type Label,
  type TrainingSample,
} from "../src";

export interface ClipInfo {
  groupId: string;
  label: Label;
  file: string;
  seconds: number;
  windows: number;
  rejectedWindows: number;
  sourceRate: number;
}

export interface Dataset {
  samples: TrainingSample[];
  clips: ClipInfo[];
}

export function loadDataset(root: string, labels: readonly Label[] = LABELS): Dataset {
  const samples: TrainingSample[] = [];
  const clips: ClipInfo[] = [];
  for (const label of labels) {
    const dir = path.join(root, label);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((n) => n.toLowerCase().endsWith(".wav")).sort()) {
      const decoded = decodeWav(new Uint8Array(readFileSync(path.join(dir, f))));
      const pcm = resample(decoded.samples, decoded.sampleRate, DEFAULT_SENSING.sampleRate);
      const groupId = `${label}/${f}`;
      let kept = 0;
      let rejected = 0;
      for (const w of splitWindows(pcm)) {
        const { features, quality } = extractWindowFeatures(w.samples);
        if (quality.digitalSilence || quality.clippedFraction >= 0.05) {
          rejected++;
          continue;
        }
        samples.push({ features, label, groupId });
        kept++;
      }
      clips.push({ groupId, label, file: path.join(dir, f), seconds: pcm.length / DEFAULT_SENSING.sampleRate, windows: kept, rejectedWindows: rejected, sourceRate: decoded.sampleRate });
    }
  }
  return { samples, clips };
}

export function formatConfusion(labels: readonly string[], confusion: number[][]): string {
  const w = Math.max(10, ...labels.map((l) => l.length + 2));
  const head = "true \\ predicted".padEnd(w + 6) + labels.map((l) => l.padStart(w)).join("");
  const rows = labels.map((l, i) => l.padEnd(w + 6) + (confusion[i] as number[]).map((n) => String(n).padStart(w)).join(""));
  return [head, ...rows].join("\n");
}
