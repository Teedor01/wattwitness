import {
  DEFAULT_SENSING,
  ValidationError,
  classifyWindow,
  decodeWav,
  extractWindowFeatures,
  resample,
  splitWindows,
  textId,
  type Hex32,
} from "../../src";
import { dbfs, rms } from "../../src/sensing/dsp";
import type { LocalWindowRecord, ModelBundle, ObservationFailure, Source } from "./types";

export const FAILURE_TEXT: Record<ObservationFailure["code"], string> = {
  TOO_SHORT: "That recording is too short to analyse. Record at least a few seconds. No observation was created.",
  DEAD_MICROPHONE: "We couldn't get usable audio from this microphone: the signal is silent or switched off. No observation was created.",
  CLIPPED: "The recording is distorted because the sound was too loud for the microphone. Move the phone away and try again. No observation was created.",
  MALFORMED_AUDIO: "That audio could not be read. No observation was created.",
  UNSUPPORTED_FORMAT: "That audio format is not supported. Use a 16-bit PCM or float WAV file. No observation was created.",
  NO_MODEL: "No classifier is available, so nothing can be analysed. No observation was created.",
};

const fail = (code: ObservationFailure["code"]): { ok: false; failure: ObservationFailure } => ({ ok: false, failure: { code, message: FAILURE_TEXT[code] } });

export function decodeAudioFile(bytes: Uint8Array): { ok: true; samples: Float64Array; sampleRate: number } | { ok: false; failure: ObservationFailure } {
  try {
    const d = decodeWav(bytes);
    return { ok: true, samples: d.samples, sampleRate: d.sampleRate };
  } catch (e) {
    if (e instanceof ValidationError && e.code === "UNSUPPORTED_WAV") return fail("UNSUPPORTED_FORMAT");
    return fail("MALFORMED_AUDIO");
  }
}

export interface ProcessArgs {
  samples: Float64Array;
  sampleRate: number;
  bundle: ModelBundle | undefined;
  siteId: Hex32;
  day: number;
  startSecOfDay: number;
  attesterId: string;
  source: Source;
  createdAt: number;
}

export type ProcessResult = { ok: true; windows: LocalWindowRecord[] } | { ok: false; failure: ObservationFailure };

export function windowId(siteId: string, day: number, startSec: number, attesterId: string, source: Source): Hex32 {
  return textId(`${siteId}|${day}|${startSec.toFixed(3)}|${attesterId}|${source}`);
}

export function processAudio(a: ProcessArgs): ProcessResult {
  if (!a.bundle) return fail("NO_MODEL");
  if (a.samples.length === 0 || !Number.isFinite(a.sampleRate) || a.sampleRate < 1000) return fail("MALFORMED_AUDIO");
  for (let i = 0; i < a.samples.length; i += 1) {
    if (!Number.isFinite(a.samples[i] as number)) return fail("MALFORMED_AUDIO");
  }
  const pcm = resample(a.samples, a.sampleRate, DEFAULT_SENSING.sampleRate);
  const windows = splitWindows(pcm);
  if (windows.length === 0) return fail("TOO_SHORT");

  let silent = 0;
  let clipped = 0;
  for (const w of windows) {
    const q = extractWindowFeatures(w.samples).quality;
    if (q.digitalSilence) silent++;
    if (q.clippedFraction >= 0.05) clipped++;
  }
  if (silent === windows.length || dbfs(rms(pcm)) < -95) return fail("DEAD_MICROPHONE");
  if (clipped * 2 >= windows.length) return fail("CLIPPED");

  const out: LocalWindowRecord[] = [];
  for (const w of windows) {
    const abs = a.startSecOfDay + w.startSec;
    const day = a.day + Math.floor(abs / 86_400);
    const startSec = abs - Math.floor(abs / 86_400) * 86_400;
    const c = classifyWindow(a.bundle.model, w.samples, startSec);
    out.push({
      ...c,
      id: windowId(a.siteId, day, startSec, a.attesterId, a.source),
      siteId: a.siteId,
      day,
      attesterId: a.attesterId,
      modelVersion: a.bundle.version,
      modelSynthetic: a.bundle.synthetic,
      source: a.source,
      createdAt: a.createdAt,
    });
  }
  return { ok: true, windows: out };
}

export function describeMicError(name: string): { code: "PERMISSION_DENIED" | "NO_DEVICE" | "DEVICE_UNAVAILABLE" | "UNSUPPORTED" | "INSECURE_CONTEXT" | "UNKNOWN"; message: string } {
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
    case "PermissionDeniedError":
      return { code: "PERMISSION_DENIED", message: "Microphone access was blocked. Allow the microphone for this site in your browser settings, then try again. No observation was created." };
    case "NotFoundError":
    case "OverconstrainedError":
    case "DevicesNotFoundError":
      return { code: "NO_DEVICE", message: "No microphone was found on this device. No observation was created." };
    case "NotReadableError":
    case "AbortError":
    case "TrackStartError":
      return { code: "DEVICE_UNAVAILABLE", message: "The microphone is in use by another app or could not be started. Close other apps using it and try again. No observation was created." };
    case "NotSupportedError":
      return { code: "UNKNOWN", message: "The browser refused to start the microphone. Check that microphone access is allowed for this site in your browser settings. No observation was created." };
    case "INSECURE_CONTEXT":
      return { code: "INSECURE_CONTEXT", message: "The microphone only works on a secure (https or localhost) page. No observation was created." };
    case "UNSUPPORTED":
      return { code: "UNSUPPORTED", message: "This browser cannot record audio. Try a current version of Chrome. No observation was created." };
    default:
      return { code: "UNKNOWN", message: "We couldn't start the microphone. No observation was created." };
  }
}
