import { mulberry32 } from "../fixtures";

export const RATE = 16_000;
export type SynthKind = "generator" | "grid_hum" | "silence" | "other";

export function synthClip(kind: SynthKind, seed: number, seconds: number): Float64Array {
  const rnd = mulberry32(seed * 7919 + 13);
  const gauss = (): number => {
    let s = 0;
    for (let i = 0; i < 6; i++) s += rnd();
    return (s - 3) / Math.sqrt(0.5);
  };
  const n = Math.floor(seconds * RATE);
  const x = new Float64Array(n);
  const tau = 2 * Math.PI;
  const lp = (a: number, state: { v: number }, input: number): number => (state.v = a * state.v + (1 - a) * input);

  if (kind === "generator") {
    const f0 = 24 + rnd() * 8;
    const amDepth = 0.05 + rnd() * 0.1;
    const amHz = 0.3 + rnd() * 0.5;
    const ph = rnd() * tau;
    const pink = { v: 0 };
    for (let i = 0; i < n; i++) {
      const t = i / RATE;
      let s = 0;
      for (let k = 1; k <= 40; k++) s += (Math.sin(tau * f0 * k * t + ph * k) / k ** 0.8) * 0.18;
      s *= 1 + amDepth * Math.sin(tau * amHz * t);
      s += 0.03 * Math.sin(tau * 50 * t) + lp(0.9, pink, gauss() * 0.04) * 2;
      x[i] = s;
    }
  } else if (kind === "grid_hum") {
    const amp = 0.012 + rnd() * 0.01;
    for (let i = 0; i < n; i++) {
      const t = i / RATE;
      x[i] = amp * (Math.sin(tau * 50 * t) + 0.5 * Math.sin(tau * 100 * t) + 0.3 * Math.sin(tau * 150 * t) + 0.15 * Math.sin(tau * 200 * t)) + gauss() * 0.0015;
    }
  } else if (kind === "silence") {
    for (let i = 0; i < n; i++) x[i] = gauss() * (0.0006 + rnd() * 0.0002);
  } else {
    const flavour = Math.floor(rnd() * 3);
    const pink = { v: 0 };
    const rumble = { v: 0 };
    for (let i = 0; i < n; i++) {
      const t = i / RATE;
      if (flavour === 0) {
        // speech-like: formant-ish noise with syllable-rate amplitude modulation and pauses
        const env = Math.max(0, Math.sin(tau * 3.5 * t + seed)) ** 2;
        x[i] = env * 0.12 * (Math.sin(tau * 700 * t) * 0.6 + Math.sin(tau * 1800 * t) * 0.4 + gauss() * 0.3);
      } else if (flavour === 1) {
        // fan-like broadband hiss
        x[i] = lp(0.5, pink, gauss()) * 0.06 + 0.01 * Math.sin(tau * 120 * t);
      } else {
        // traffic-like low rumble with occasional bursts
        const burst = Math.sin(tau * 0.2 * t + seed) > 0.85 ? 3 : 1;
        x[i] = lp(0.985, rumble, gauss()) * 0.5 * burst + gauss() * 0.004;
      }
    }
  }
  return x;
}
