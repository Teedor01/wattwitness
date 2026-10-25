import { describe, expect, it } from "vitest";
import { ValidationError } from "../../src";
import { dbfs, fft, hann, isPowerOfTwo, powerSpectrum, rms } from "../../src/sensing/dsp";
import { decodeWav, encodeWav16, resample } from "../../src/sensing/wav";

const tone = (hz: number, rate: number, seconds: number, amp = 0.5): Float64Array => {
  const n = Math.floor(rate * seconds);
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * hz * i) / rate);
  return x;
};

describe("fft", () => {
  it("puts a pure tone in the expected bin", () => {
    const n = 1024;
    const rate = 16000;
    const x = tone(1000, rate, n / rate);
    const p = powerSpectrum(x, hann(n));
    let peak = 0;
    for (let k = 1; k < p.length; k++) if ((p[k] as number) > (p[peak] as number)) peak = k;
    expect(peak).toBe(Math.round((1000 * n) / rate));
  });

  it("satisfies Parseval's relation on an unwindowed frame", () => {
    const n = 256;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    let timeEnergy = 0;
    for (let i = 0; i < n; i++) {
      re[i] = Math.sin(i * 0.37) + 0.3 * Math.cos(i * 1.9);
      timeEnergy += (re[i] as number) ** 2;
    }
    fft(re, im);
    let freqEnergy = 0;
    for (let k = 0; k < n; k++) freqEnergy += (re[k] as number) ** 2 + (im[k] as number) ** 2;
    expect(freqEnergy / n).toBeCloseTo(timeEnergy, 8);
  });

  it("rejects bad sizes", () => {
    expect(() => fft(new Float64Array(10), new Float64Array(10))).toThrow(RangeError);
    expect(() => fft(new Float64Array(8), new Float64Array(16))).toThrow(RangeError);
    expect(isPowerOfTwo(2048)).toBe(true);
    expect(isPowerOfTwo(1000)).toBe(false);
  });

  it("rms and dbfs behave", () => {
    expect(rms(tone(100, 8000, 1, 1))).toBeCloseTo(Math.SQRT1_2, 3);
    expect(dbfs(1)).toBeCloseTo(0, 9);
    expect(dbfs(0)).toBeCloseTo(-180, 6);
    expect(rms([])).toBe(0);
  });
});

describe("wav", () => {
  it("round-trips PCM16 within one quantisation step", () => {
    const x = tone(440, 16000, 0.25, 0.8);
    const decoded = decodeWav(encodeWav16(x, 16000));
    expect(decoded.sampleRate).toBe(16000);
    expect(decoded.samples.length).toBe(x.length);
    let maxErr = 0;
    for (let i = 0; i < x.length; i++) maxErr = Math.max(maxErr, Math.abs((x[i] as number) - (decoded.samples[i] as number)));
    expect(maxErr).toBeLessThan(1 / 16000);
  });

  it("clips out-of-range samples instead of wrapping", () => {
    const d = decodeWav(encodeWav16([2, -2, 0.5], 8000));
    expect(d.samples[0]).toBeCloseTo(1, 3);
    expect(d.samples[1]).toBeCloseTo(-1, 3);
  });

  it("averages stereo to mono", () => {
    const mono = encodeWav16([0.5, 0.5], 8000);
    // hand-build a stereo file: L = 0.5, R = -0.5 -> average 0
    const bytes = new Uint8Array(44 + 8);
    bytes.set(mono.subarray(0, 44));
    const v = new DataView(bytes.buffer);
    v.setUint16(22, 2, true);
    v.setUint16(32, 4, true);
    v.setUint32(40, 8, true);
    v.setInt16(44, 16384, true);
    v.setInt16(46, -16384, true);
    v.setInt16(48, 16384, true);
    v.setInt16(50, -16384, true);
    const d = decodeWav(bytes);
    expect(d.samples.length).toBe(2);
    expect(Math.abs(d.samples[0] as number)).toBeLessThan(1e-6);
  });

  it("rejects malformed, truncated and unsupported files rather than guessing", () => {
    expect(() => decodeWav(new Uint8Array(10))).toThrow(ValidationError);
    const good = encodeWav16([0, 0, 0, 0], 8000);
    const noRiff = Uint8Array.from(good);
    noRiff[0] = 0;
    expect(() => decodeWav(noRiff)).toThrowError(expect.objectContaining({ code: "INVALID_WAV" }));
    const eightBit = Uint8Array.from(good);
    new DataView(eightBit.buffer).setUint16(34, 8, true);
    expect(() => decodeWav(eightBit)).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_WAV" }));
    expect(() => encodeWav16([0], 10)).toThrow(ValidationError);
  });
});

describe("resample", () => {
  const peakHz = (x: Float64Array, rate: number): number => {
    const n = 4096;
    const p = powerSpectrum(x.subarray(1000, 1000 + n), hann(n));
    let k0 = 1;
    for (let k = 1; k < p.length; k++) if ((p[k] as number) > (p[k0] as number)) k0 = k;
    return (k0 * rate) / n;
  };

  it("keeps a 1 kHz tone at 1 kHz when 48 kHz -> 16 kHz", () => {
    const out = resample(tone(1000, 48000, 1), 48000, 16000);
    expect(out.length).toBe(16000);
    expect(Math.abs(peakHz(out, 16000) - 1000)).toBeLessThan(10);
    expect(rms(out.subarray(1000, 9000))).toBeGreaterThan(0.3);
  });

  it("removes content above the new Nyquist instead of aliasing it", () => {
    // 12 kHz would alias to 4 kHz at 16 kHz if not filtered
    const out = resample(tone(12000, 48000, 1), 48000, 16000);
    expect(rms(out.subarray(1000, 9000))).toBeLessThan(0.01);
  });

  it("is the identity at equal rates and handles upsampling", () => {
    const x = tone(200, 8000, 0.1);
    expect(Array.from(resample(x, 8000, 8000))).toEqual(Array.from(x));
    expect(resample(x, 8000, 16000).length).toBe(1600);
    expect(() => resample(x, 0, 16000)).toThrow(RangeError);
  });
});
