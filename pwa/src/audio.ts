import { describeMicError } from "./observe";


export class MicFailure extends Error {
  constructor(
    readonly code: ReturnType<typeof describeMicError>["code"],
    message: string,
  ) {
    super(message);
    this.name = "MicFailure";
  }
}

export interface CaptureHandle {
  stop(): void;
  done: Promise<{ samples: Float64Array; sampleRate: number }>;
}

export function startCapture(seconds: number, onProgress: (secondsLeft: number, peak: number) => void, onStarted: () => void = () => undefined): CaptureHandle {
  let stopRequested = false;
  const done = (async () => {
    if (!window.isSecureContext) throw toFailure("INSECURE_CONTEXT");
    if (!navigator.mediaDevices?.getUserMedia || !(window.AudioContext || (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext)) {
      throw toFailure("UNSUPPORTED");
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
    } catch (e) {
      throw toFailure((e as { name?: string })?.name ?? "UNKNOWN");
    }
    onStarted(); // permission granted: from here on the microphone really is recording
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    try {
      if (ctx.state === "suspended") await ctx.resume();
      const src = ctx.createMediaStreamSource(stream);
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      const mute = ctx.createGain();
      mute.gain.value = 0;
      const chunks: Float32Array[] = [];
      let total = 0;
      const target = Math.round(seconds * ctx.sampleRate);
      const result = await new Promise<void>((resolve) => {
        proc.onaudioprocess = (ev) => {
          const d = ev.inputBuffer.getChannelData(0);
          chunks.push(Float32Array.from(d));
          total += d.length;
          let peak = 0;
          for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i] as number));
          onProgress(Math.max(0, Math.ceil((target - total) / ctx.sampleRate)), peak);
          if (total >= target || stopRequested) resolve();
        };
        src.connect(proc);
        proc.connect(mute);
        mute.connect(ctx.destination);
        setTimeout(() => resolve(), (seconds + 5) * 1000);
      });
      void result;
      proc.disconnect();
      src.disconnect();
      const samples = new Float64Array(total);
      let o = 0;
      for (const c of chunks) {
        for (let i = 0; i < c.length; i++) samples[o + i] = c[i] as number;
        o += c.length;
      }
      return { samples, sampleRate: ctx.sampleRate };
    } finally {
      stream.getTracks().forEach((t) => t.stop());
      await ctx.close().catch(() => undefined);
    }
  })();
  return { stop: () => (stopRequested = true), done };
}

function toFailure(name: string): MicFailure {
  const d = describeMicError(name);
  return new MicFailure(d.code, d.message);
}
