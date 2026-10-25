import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FEATURE_NAMES, modelVersion, trainGnb } from "../src";
import { loadDataset } from "./audio-lib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { samples, clips } = loadDataset(path.join(root, "data", "clips"));
if (clips.length === 0) {
  console.log("No clips found in data/clips. Nothing to train.");
  process.exit(2);
}
const model = trainGnb(samples, { featureNames: FEATURE_NAMES });
const version = modelVersion(model);
mkdirSync(path.join(root, "models"), { recursive: true });
writeFileSync(path.join(root, "models", "classifier.json"), JSON.stringify({ version, model }, null, 2) + "\n");
console.log(`trained on ${samples.length} windows from ${clips.length} clips`);
console.log(`model version: ${version}`);
console.log("This string is what a baseline package commits to as its classifierVersion (hashed).");
