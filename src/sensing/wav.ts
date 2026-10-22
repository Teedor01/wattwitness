import { ValidationError } from "../errors";

export interface DecodedAudio {
  sampleRate: number;
  samples: Float64Array;
}

export function encodeWav16(samples: ArrayLike<number>, sampleRate: number): Uint8Array {
  if (!Number.isInteger(sampleRate) || sampleRate < 1000 || sampleRate > 384_000) {
    throw new ValidationError("INVALID_SAMPLE_RATE", ["sampleRate must be an integer between 1000 and 384000"]);
  }
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const ascii = (off: number, s: string): void => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(36, "data");
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] as number));
    v.setInt16(44 + i * 2, s < 0 ? Math.round(s * 32768) : Math.round(s * 32767), true);
  }
  return new Uint8Array(buf);
}

export function decodeWav(bytes: Uint8Array): DecodedAudio {
  if (bytes.length < 44) throw new ValidationError("INVALID_WAV", ["file too short to be a WAV"]);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (off: number): string => String.fromCharCode(v.getUint8(off), v.getUint8(off + 1), v.getUint8(off + 2), v.getUint8(off + 3));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new ValidationError("INVALID_WAV", ["missing RIFF/WAVE header"]);

  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null;
  let dataOff = -1;
  let dataLen = 0;
  let off = 12;
  while (off + 8 <= bytes.length) {
    const id = tag(off);
    const size = v.getUint32(off + 4, true);
    const body = off + 8;
    if (id === "fmt ") {
      if (body + 16 > bytes.length) throw new ValidationError("INVALID_WAV", ["truncated fmt chunk"]);
      fmt = { format: v.getUint16(body, true), channels: v.getUint16(body + 2, true), sampleRate: v.getUint32(body + 4, true), bits: v.getUint16(body + 14, true) };
    } else if (id === "data") {
      dataOff = body;
      dataLen = Math.min(size, bytes.length - body);
      break;
    }
    off = body + size + (size & 1);
  }
  if (!fmt) throw new ValidationError("INVALID_WAV", ["no fmt chunk"]);
  if (dataOff < 0) throw new ValidationError("INVALID_WAV", ["no data chunk"]);
  const { format, channels, sampleRate, bits } = fmt;
  if (channels < 1 || channels > 8) throw new ValidationError("UNSUPPORTED_WAV", [`${channels} channels`]);
  const supported = (format === 1 && bits === 16) || (format === 3 && bits === 32);
  if (!supported) throw new ValidationError("UNSUPPORTED_WAV", [`format ${format} with ${bits} bits (only PCM16 and float32 are supported)`]);

  const bytesPer = bits / 8;
  const frames = Math.floor(dataLen / (bytesPer * channels));
  const out = new Float64Array(frames);
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) {
      const p = dataOff + (i * channels + c) * bytesPer;
      acc += format === 1 ? v.getInt16(p, true) / 32768 : v.getFloat32(p, true);
    }
    out[i] = acc / channels;
  }
  return { sampleRate, samples: out };
}

export function resample(samples: Float64Array, fromRate: number, toRate: number): Float64Array {
  if (!(fromRate > 0) || !(toRate > 0)) throw new RangeError("rates must be positive");
  if (fromRate === toRate) return Float64Array.from(samples);
  const ratio = fromRate / toRate;
  const outLen = Math.floor(samples.length / ratio);
  const out = new Float64Array(outLen);
  if (ratio > 1) {
    const cutoff = (0.45 * toRate) / fromRate; 
    const half = Math.max(8, Math.ceil(8 * ratio));
    const taps = new Float64Array(2 * half + 1);
    let sum = 0;
    for (let k = -half; k <= half; k++) {
      const x = 2 * Math.PI * cutoff * k;
      const sinc = k === 0 ? 2 * cutoff : Math.sin(x) / (Math.PI * k);
      const w = 0.54 + 0.46 * Math.cos((Math.PI * k) / half);
      taps[k + half] = sinc * w;
      sum += sinc * w;
    }
    for (let i = 0; i < taps.length; i++) taps[i] = (taps[i] as number) / sum;
    for (let i = 0; i < outLen; i++) {
      const centre = Math.round(i * ratio);
      let acc = 0;
      for (let k = -half; k <= half; k++) {
        const j = centre + k;
        if (j >= 0 && j < samples.length) acc += (samples[j] as number) * (taps[k + half] as number);
      }
      out[i] = acc;
    }
  } else {
    for (let i = 0; i < outLen; i++) {
      const p = i * ratio;
      const j = Math.floor(p);
      const f = p - j;
      const a = samples[j] as number;
      const b = (samples[Math.min(j + 1, samples.length - 1)] as number) ?? a;
      out[i] = a + (b - a) * f;
    }
  }
  return out;
}
