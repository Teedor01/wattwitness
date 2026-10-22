import { dbfs, hann, isPowerOfTwo, powerSpectrum, rms } from "./dsp";


export interface SensingConfig {
  sampleRate: number;
  windowSec: number;
  frameSize: number; 
  hopSize: number;
  mainsHz: number; 
}

export const DEFAULT_SENSING: SensingConfig = { sampleRate: 16_000, windowSec: 2, frameSize: 2048, hopSize: 1024, mainsHz: 50 };

export const BAND_EDGES_HZ = [20, 60, 120, 250, 500, 1000, 2000, 4000, 8000] as const;
const NB = BAND_EDGES_HZ.length - 1;
const bandName = (i: number): string => `${BAND_EDGES_HZ[i]}_${BAND_EDGES_HZ[i + 1]}`;

export const FEATURE_NAMES: readonly string[] = [
  ...Array.from({ length: NB }, (_, i) => `bandShape_${bandName(i)}`),
  ...Array.from({ length: NB }, (_, i) => `bandStd_${bandName(i)}`),
  "centroidLogHz",
  "flatness100_4000",
  "rmsDbfsMean",
  "rmsDbfsStd",
  "humRatio",
];

export interface WindowQuality {
  clippedFraction: number;
  digitalSilence: boolean;
  rmsDbfs: number;
}

export interface WindowFeatures {
  features: number[];
  quality: WindowQuality;
}

export function windowSamples(cfg: SensingConfig): number {
  return Math.round(cfg.windowSec * cfg.sampleRate);
}

export function validateSensingConfig(cfg: SensingConfig): void {
  if (!isPowerOfTwo(cfg.frameSize)) throw new RangeError("frameSize must be a power of two");
  if (cfg.hopSize < 1 || cfg.hopSize > cfg.frameSize) throw new RangeError("hopSize must be in 1..frameSize");
  if (windowSamples(cfg) < cfg.frameSize) throw new RangeError("window must contain at least one frame");
  if (cfg.mainsHz !== 50 && cfg.mainsHz !== 60) throw new RangeError("mainsHz must be 50 or 60");
}

const cache = new Map<string, Float64Array>();
function hannCached(n: number): Float64Array {
  const k = String(n);
  let w = cache.get(k);
  if (!w) {
    w = hann(n);
    cache.set(k, w);
  }
  return w;
}

const mean = (a: number[]): number => (a.length === 0 ? 0 : a.reduce((s, x) => s + x, 0) / a.length);
const std = (a: number[]): number => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length);
};

export function extractWindowFeatures(samples: ArrayLike<number>, cfg: SensingConfig = DEFAULT_SENSING): WindowFeatures {
  validateSensingConfig(cfg);
  const { frameSize, hopSize, sampleRate, mainsHz } = cfg;
  if (samples.length < frameSize) throw new RangeError("window shorter than one frame");
  const win = hannCached(frameSize);
  const binHz = sampleRate / frameSize;
  const nBins = frameSize / 2 + 1;

  const bandOf = new Int16Array(nBins).fill(-1);
  const humBin = new Uint8Array(nBins);
  const lowBin = new Uint8Array(nBins);
  const flatBin = new Uint8Array(nBins);
  for (let k = 0; k < nBins; k++) {
    const f = k * binHz;
    for (let b = 0; b < NB; b++) if (f >= (BAND_EDGES_HZ[b] as number) && f < (BAND_EDGES_HZ[b + 1] as number)) bandOf[k] = b;
    for (let h = 1; h <= 4; h++) if (Math.abs(f - mainsHz * h) <= 6) humBin[k] = 1;
    if (f >= 20 && f < 400) lowBin[k] = 1;
    if (f >= 100 && f < 4000) flatBin[k] = 1;
  }

  const bandLogs: number[][] = Array.from({ length: NB }, () => []);
  const centroids: number[] = [];
  const flatness: number[] = [];
  const levels: number[] = [];
  let humSum = 0;
  let lowSum = 0;
  const frame = new Float64Array(frameSize);
  for (let start = 0; start + frameSize <= samples.length; start += hopSize) {
    for (let i = 0; i < frameSize; i++) frame[i] = samples[start + i] as number;
    levels.push(dbfs(rms(frame)));
    const p = powerSpectrum(frame, win);
    const be = new Float64Array(NB);
    let num = 0;
    let den = 0;
    let logSum = 0;
    let flatSum = 0;
    let flatN = 0;
    for (let k = 1; k < nBins; k++) {
      const pk = p[k] as number;
      const b = bandOf[k] as number;
      if (b >= 0) {
        be[b] = (be[b] as number) + pk;
        num += k * binHz * pk;
        den += pk;
      }
      if (humBin[k]) humSum += pk;
      if (lowBin[k]) lowSum += pk;
      if (flatBin[k]) {
        logSum += Math.log(pk + 1e-12);
        flatSum += pk + 1e-12;
        flatN++;
      }
    }
    for (let b = 0; b < NB; b++) (bandLogs[b] as number[]).push(Math.log10((be[b] as number) + 1e-12));
    centroids.push(Math.log10((den > 0 ? num / den : 20) + 1e-9));
    flatness.push(flatN > 0 ? Math.exp(logSum / flatN) / (flatSum / flatN) : 0);
  }

  const bandMeans = bandLogs.map(mean);
  const overall = mean(bandMeans);
  const features = [
    ...bandMeans.map((m) => m - overall),
    ...bandLogs.map(std),
    mean(centroids),
    mean(flatness),
    mean(levels),
    std(levels),
    lowSum > 0 ? humSum / lowSum : 0,
  ];

  let clipped = 0;
  let maxAbs = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i] as number);
    if (a >= 0.999) clipped++;
    if (a > maxAbs) maxAbs = a;
  }
  return {
    features,
    quality: { clippedFraction: clipped / samples.length, digitalSilence: maxAbs === 0, rmsDbfs: dbfs(rms(samples)) },
  };
}

export interface AudioWindow {
  startSec: number;
  samples: Float64Array;
}

export function splitWindows(samples: Float64Array, cfg: SensingConfig = DEFAULT_SENSING, hopSec: number = cfg.windowSec): AudioWindow[] {
  validateSensingConfig(cfg);
  if (!(hopSec > 0)) throw new RangeError("hopSec must be positive");
  const len = windowSamples(cfg);
  const hop = Math.max(1, Math.round(hopSec * cfg.sampleRate));
  const out: AudioWindow[] = [];
  for (let s = 0; s + len <= samples.length; s += hop) out.push({ startSec: s / cfg.sampleRate, samples: samples.subarray(s, s + len) });
  return out;
}
