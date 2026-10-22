export function isPowerOfTwo(n: number): boolean {
  return Number.isInteger(n) && n > 1 && (n & (n - 1)) === 0;
}

export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (im.length !== n || !isPowerOfTwo(n)) throw new RangeError("fft needs equal power-of-two lengths");
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i] as number;
      re[i] = re[j] as number;
      re[j] = tr;
      const ti = im[i] as number;
      im[i] = im[j] as number;
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const xr = (re[b] as number) * cr - (im[b] as number) * ci;
        const xi = (re[b] as number) * ci + (im[b] as number) * cr;
        re[b] = (re[a] as number) - xr;
        im[b] = (im[a] as number) - xi;
        re[a] = (re[a] as number) + xr;
        im[a] = (im[a] as number) + xi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

export function hann(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

export function powerSpectrum(frame: ArrayLike<number>, window: Float64Array): Float64Array {
  const n = window.length;
  if (frame.length !== n) throw new RangeError("frame and window length differ");
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = (frame[i] as number) * (window[i] as number);
  fft(re, im);
  const out = new Float64Array(n / 2 + 1);
  for (let k = 0; k <= n / 2; k++) out[k] = (re[k] as number) ** 2 + (im[k] as number) ** 2;
  return out;
}

export function rms(x: ArrayLike<number>): number {
  if (x.length === 0) return 0;
  let s = 0;
  for (let i = 0; i < x.length; i++) s += (x[i] as number) ** 2;
  return Math.sqrt(s / x.length);
}

export function dbfs(amplitude: number): number {
  return 20 * Math.log10(Math.max(amplitude, 1e-9));
}
