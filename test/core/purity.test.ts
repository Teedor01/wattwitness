import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");
const files = readdirSync(SRC).filter((f) => f.endsWith(".ts"));

function code(file: string): string {
  return readFileSync(path.join(SRC, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("core is pure: no network, no clock, no randomness, no LLM", () => {
  it("scans the expected modules", () => {
    expect(files.sort()).toEqual(
      ["ablation.ts", "baseline.ts", "bitmask.ts", "errors.ts", "evaluator.ts", "hash.ts", "impact.ts", "index.ts", "merkle.ts", "period.ts", "registry.ts", "types.ts", "validate.ts"].sort(),
    );
  });

  const forbidden: Array<[string, RegExp]> = [
    ["network fetch", /\bfetch\s*\(/],
    ["XMLHttpRequest", /XMLHttpRequest/],
    ["WebSocket", /WebSocket/],
    ["node http/https/net/dgram/tls", /node:(http|https|net|dgram|tls|http2)|from\s+["'](http|https|net|dgram|tls)["']/],
    ["ethers providers/signers", /JsonRpcProvider|BrowserProvider|WebSocketProvider|InfuraProvider|AlchemyProvider|Wallet\b|Contract\b/],
    ["LLM SDKs or hosts", /anthropic|openai|claude|gpt-|langchain|api\.anthropic|generativelanguage/i],
    ["wall-clock time", /Date\.now|new Date|performance\.now/],
    ["randomness", /Math\.random|crypto\.getRandomValues|randomBytes|randomUUID/],
    ["filesystem / process / env", /node:fs|node:child_process|process\.env/],
  ];

  for (const [name, pattern] of forbidden) {
    it(`no ${name} in src/`, () => {
      const offenders = files.filter((f) => pattern.test(code(f)));
      expect(offenders).toEqual([]);
    });
  }

  it("the only external import in src/ is ethers (hashing and ABI encoding only)", () => {
    const external = new Set<string>();
    for (const f of files) {
      for (const m of code(f).matchAll(/from\s+["']([^"']+)["']/g)) {
        const spec = m[1] as string;
        if (!spec.startsWith(".")) external.add(spec);
      }
    }
    expect([...external]).toEqual(["ethers"]);
  });
});
