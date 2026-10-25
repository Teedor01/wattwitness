import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeWav } from "../../src";

const html = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/recorder.html"), "utf8");
const pure = html.slice(html.indexOf("// <pure>"), html.indexOf("// </pure>"));
const lib = new Function(`${pure}; return { encodeWav16, peakOf, clipName };`)() as {
  encodeWav16: (chunks: Float32Array[], rate: number) => Uint8Array;
  peakOf: (chunks: Float32Array[]) => number;
  clipName: (label: string, session: string, n: number) => string;
};

describe("web/recorder.html helpers", () => {
  it("encodes chunked Float32 audio that the pipeline decodes back within quantisation error", () => {
    const rate = 48_000;
    const a = new Float32Array(4096);
    const b = new Float32Array(1500);
    for (let i = 0; i < a.length; i++) a[i] = 0.6 * Math.sin((2 * Math.PI * 300 * i) / rate);
    for (let i = 0; i < b.length; i++) b[i] = 0.6 * Math.sin((2 * Math.PI * 300 * (i + a.length)) / rate);
    const decoded = decodeWav(lib.encodeWav16([a, b], rate));
    expect(decoded.sampleRate).toBe(rate);
    expect(decoded.samples.length).toBe(a.length + b.length);
    for (let i = 0; i < a.length; i += 97) expect(Math.abs((decoded.samples[i] as number) - (a[i] as number))).toBeLessThan(1 / 16000);
    expect(Math.abs((decoded.samples[a.length + 10] as number) - (b[10] as number))).toBeLessThan(1 / 16000);
  });

  it("clips out-of-range samples and reports peaks", () => {
    const x = Float32Array.from([2, -2, 0.25]);
    expect(lib.peakOf([x])).toBe(2);
    const d = decodeWav(lib.encodeWav16([x], 8000));
    expect(d.samples[0]).toBeCloseTo(1, 3);
    expect(d.samples[1]).toBeCloseTo(-1, 3);
  });

  it("builds safe file names (no spaces, no path characters) that the dataset loader can group", () => {
    expect(lib.clipName("generator", "Kitchen Oct17!", 3)).toBe("generator__kitchenoct17__003.wav");
    expect(lib.clipName("silence", "../../etc", 12)).toBe("silence__etc__012.wav");
    expect(lib.clipName("other", "", 1)).toBe("other__session__001.wav");
  });

  it("disables the browser's audio processing that would distort a steady engine tone", () => {
    expect(html).toContain("echoCancellation: false");
    expect(html).toContain("noiseSuppression: false");
    expect(html).toContain("autoGainControl: false");
  });

  it("is dependency free and never uploads audio", () => {
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/fetch\(|XMLHttpRequest|sendBeacon|WebSocket/);
  });
});
