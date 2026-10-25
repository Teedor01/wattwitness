import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "./serve-lib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.resolve(root, process.argv[2] ?? "dist/pwa");
const port = Number(process.env["PORT"] ?? 4173);
serve(dir, port).then((s) => console.log(`serving ${dir}\n${s.url}   (open on this machine; a phone needs https or a tunnel for the microphone)`));
