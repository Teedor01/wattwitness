import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const solc = require("solc");
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const contractsDir = path.join(root, "contracts");
const out = path.join(root, "build");

const files = ["WattWitnessCore.sol", "WattWitnessRegistry.sol"];
const sources: Record<string, { content: string }> = {};
for (const f of files) sources[f] = { content: readFileSync(path.join(contractsDir, f), "utf8") };

const settings = {
  evmVersion: "cancun",
  optimizer: { enabled: true, runs: 200 },
  outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } },
};
const input = { language: "Solidity", sources, settings };
const result = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (result.errors ?? []).filter((e: { severity: string }) => e.severity === "error");
if (errors.length > 0) {
  console.error(errors.map((e: { formattedMessage: string }) => e.formattedMessage).join("\n"));
  process.exit(1);
}
for (const w of (result.errors ?? []).filter((e: { severity: string }) => e.severity === "warning")) console.warn(w.formattedMessage);

const c = result.contracts["WattWitnessRegistry.sol"]["WattWitnessRegistry"];
mkdirSync(out, { recursive: true });
const artifact = {
  contractName: "WattWitnessRegistry",
  solcVersion: solc.version(),
  settings: { evmVersion: settings.evmVersion, optimizer: settings.optimizer },
  abi: c.abi,
  bytecode: "0x" + c.evm.bytecode.object,
  deployedBytecodeBytes: c.evm.deployedBytecode.object.length / 2,
};
writeFileSync(path.join(out, "WattWitnessRegistry.json"), JSON.stringify(artifact, null, 2) + "\n");
writeFileSync(
  path.join(out, "WattWitnessRegistry.standard-input.json"),
  JSON.stringify({ language: "Solidity", sources, settings: { evmVersion: settings.evmVersion, optimizer: settings.optimizer, outputSelection: { "*": { "*": ["abi", "evm.bytecode", "evm.deployedBytecode"] } } } }, null, 2) + "\n",
);
console.log(`solc ${solc.version()}`);
console.log(`WattWitnessRegistry deployed bytecode: ${artifact.deployedBytecodeBytes} bytes (EIP-170 limit 24576)`);
console.log(`wrote ${path.join("build", "WattWitnessRegistry.json")} and the standard-input file for explorer verification`);
