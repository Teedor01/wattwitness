import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { buildDemoBundle } from "../pwa/src/demomodel";
import type { AppConfig, GateStatus, ModelBundle } from "../pwa/src/types";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const test = process.argv.includes("--test");
const out = path.join(root, "dist", test ? "pwa-test" : "pwa");

async function main(): Promise<void> {
  if (!existsSync(path.join(root, "build", "WattWitnessRegistry.json"))) {
    const r = spawnSync(process.execPath, [path.join(root, "node_modules", "tsx", "dist", "cli.mjs"), path.join(root, "scripts", "build-contracts.ts")], { stdio: "inherit", cwd: root });
    if (r.status !== 0) throw new Error("contract build failed");
  }
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const demo = buildDemoBundle();
  let gate: AppConfig["gate"] = { status: "NOT_RUN", detail: "The real-audio feasibility gate has not been run." };
  let production: ModelBundle | undefined;
  const gateFile = path.join(root, "models", "gate.json");
  const modelFile = path.join(root, "models", "classifier.json");
  if (test) {
    gate = { status: "STUBBED_FOR_TESTS", detail: "Test build: gate stubbed." };
    production = { ...demo, synthetic: true }; 
  } else {
    if (existsSync(gateFile)) {
      const g = JSON.parse(readFileSync(gateFile, "utf8")) as { status?: string; evaluatedAt?: string };
      if (g.status === "PASS" || g.status === "FAIL") gate = { status: g.status as GateStatus, detail: `Evaluated ${g.evaluatedAt ?? "(date unknown)"} on the developer's recordings.` };
    }
    if (existsSync(modelFile)) {
      const m = JSON.parse(readFileSync(modelFile, "utf8")) as { version: string; model: ModelBundle["model"] };
      production = { model: m.model, version: m.version, synthetic: false };
    }
    if (gate.status === "PASS" && !production) gate = { status: "NOT_RUN", detail: "The gate passed but no trained model was found. Run npm run audio:train." };
  }
  let testnet: AppConfig["testnet"] = {};
  const depDir = path.join(root, "deployments");
  if (existsSync(depDir)) {
    for (const f of readdirSync(depDir).filter((n) => /^\d+\.json$/.test(n))) {
      const d = JSON.parse(readFileSync(path.join(depDir, f), "utf8")) as { address?: string; chainId?: number };
      if (d.address) testnet = { address: d.address, chainId: d.chainId, ...(process.env["EXPLORER_TX_BASE"] ? { explorerTxBase: process.env["EXPLORER_TX_BASE"] } : {}) };
    }
  }
  const config: AppConfig = { buildLabel: test ? "TEST BUILD" : "production", gate, models: { demo, ...(production ? { production } : {}) }, testnet };
  writeFileSync(path.join(out, "config.json"), JSON.stringify(config));

  // ---- bundles
  await build({ entryPoints: [path.join(root, "pwa", "src", "main.ts")], bundle: true, platform: "browser", format: "iife", outfile: path.join(out, "app.js"), minify: true, define: { global: "window" }, logLevel: "warning", target: "es2022" });
  for (const f of ["index.html", "styles.css", "manifest.webmanifest", "icon.svg"]) copyFileSync(path.join(root, "pwa", f), path.join(out, f));
  const shell = ["./", "index.html", "app.js", "styles.css", "manifest.webmanifest", "icon.svg", "config.json"];
  const buildId = `${Date.now().toString(36)}${test ? "-test" : ""}`;
  await build({ entryPoints: [path.join(root, "pwa", "sw.ts")], bundle: true, platform: "browser", format: "iife", outfile: path.join(out, "sw.js"), minify: true, logLevel: "warning", define: { __SHELL__: JSON.stringify(shell), __BUILD__: JSON.stringify(buildId) } });

  const size = (f: string): string => `${(statSync(path.join(out, f)).size / 1024).toFixed(0)} KB`;
  console.log(`built ${path.relative(root, out)}  (${test ? "TEST BUILD: gate stubbed" : "production"})`);
  console.log(`  gate: ${gate.status}   live sensing available: ${(gate.status === "PASS" || gate.status === "STUBBED_FOR_TESTS") && production ? "yes" : "NO (locked)"}`);
  console.log(`  demo model: ${demo.version} (SYNTHETIC)   production model: ${production ? production.version : "none"}`);
  console.log(`  app.js ${size("app.js")}, sw.js ${size("sw.js")}, config.json ${size("config.json")}`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
