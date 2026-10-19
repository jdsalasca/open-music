/**
 * dsp.js — dependency-free DSP primitives for the open-music engine.
 *
 * Everything here is deterministic and synchronous. No `Math.random()` is used
 * anywhere: all stochastic material comes from a seeded `mulberry32` stream.
 */

export const TAU = Math.PI * 2;

/**
 * Deterministic 32-bit PRNG. The same seed always yields the same stream.
 * @param {number} seed
 * @returns {() => number} generator producing values in [0, 1)
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Polynomial band-limited step (PolyBLEP) correction.
 * Removes the worst of the aliasing from naive saw/square oscillators.
 * @param {number} t phase in [0, 1)
 * @param {number} dt phase increment per sample (freq / sampleRate)
 * @returns {number}
 */
export function polyBlep(t, dt) {
  if (dt <= 0) return 0;
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

/**
 * Band-limited oscillator lookup.
 * `saw` and `square` use PolyBLEP; `sine` and `triangle` are already clean.
 * @param {string} wave one of sine | triangle | saw | square | soft-square
 * @param {number} phase phase in cycles (any real number)
 * @param {number} dt phase increment per sample
 * @returns {number} sample in roughly [-1, 1]
 */
export function oscillator(wave, phase, dt) {
  const p = phase - Math.floor(phase);
  switch (wave) {
    case 'sine':
      return Math.sin(TAU * p);
    case 'triangle':
      return 1 - 4 * Math.abs(p - 0.5);
    case 'saw':
      return 2 * p - 1 - polyBlep(p, dt);
    case 'square': {
      let v = p < 0.5 ? 1 : -1;
      v += polyBlep(p, dt);
      v -= polyBlep(p < 0.5 ? p + 0.5 : p - 0.5, dt);
      return v;
    }
    case 'soft-square':
      return Math.tanh(3.2 * Math.sin(TAU * p));
    case 'pulse25': {
      const w = 0.25;
      let v = p < w ? 1 : -1;
      v += polyBlep(p, dt);
      v -= polyBlep(p < w ? p + (1 - w) : p - w, dt);
      return v;
    }
    default:
      return Math.sin(TAU * p);
  }
}

/**
 * Topology-preserving-transform state variable filter (Zavalishin).
 * Stable under fast cutoff modulation, which is what makes per-note filter
 * envelopes usable. Coefficients are only recomputed in `set()`, so call it
 * once per block rather than once per sample.
 */
export class SVF {
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.ic1 = 0;
    this.ic2 = 0;
    this.g = 0;
    this.k = 1;
    this.a1 = 0;
    this.a2 = 0;
    this.a3 = 0;
    this.set(1000, 0.707);
  }

  /**
   * @param {number} cutoff cutoff frequency in Hz (clamped to 10 Hz .. 0.45 * sr)
   * @param {number} q resonance; 0.707 is flat, higher is more resonant
   */
  set(cutoff, q = 0.707) {
    const fc = Math.min(Math.max(cutoff, 10), this.sr * 0.45);
    const r = Math.max(q, 0.05);
    this.g = Math.tan((Math.PI * fc) / this.sr);
    this.k = 1 / r;
    this.a1 = 1 / (1 + this.g * (this.g + this.k));
    this.a2 = this.g * this.a1;
    this.a3 = this.g * this.a2;
  }

  reset() {
    this.ic1 = 0;
    this.ic2 = 0;
  }

  /** @param {number} x @returns {number} lowpass output */
  process(x) {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    return v2;
  }

  /** @returns {number} bandpass output for the same input as the last `process` */
  band() {
    return this.ic1;
  }
}

/** Direct-form-I biquad, used for static EQ and the K-weighting filters. */
export class Biquad {
  constructor(b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0) {
    this.set(b0, b1, b2, a1, a2);
    this.x1 = 0;
    this.x2 = 0;
    this.y1 = 0;
    this.y2 = 0;
  }

  set(b0, b1, b2, a1, a2) {
    this.b0 = b0;
    this.b1 = b1;
    this.b2 = b2;
    this.a1 = a1;
    this.a2 = a2;
    return this;
  }

  /** RBJ high-shelf. @param {number} sr @param {number} f0 @param {number} q @param {number} dbGain */
  highShelf(sr, f0, q, dbGain) {
    const A = 10 ** (dbGain / 40);
    const w0 = TAU * (f0 / sr);
    const cw = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * q);
    const ap1 = A + 1;
    const am1 = A - 1;
    const beta = 2 * Math.sqrt(A) * alpha;
    const a0 = ap1 - am1 * cw + beta;
    return this.set(
      (A * (ap1 + am1 * cw + beta)) / a0,
      (-2 * A * (am1 + ap1 * cw)) / a0,
      (A * (ap1 + am1 * cw - beta)) / a0,
      (2 * (am1 - ap1 * cw)) / a0,
      (ap1 - am1 * cw - beta) / a0,
    );
  }

  /** RBJ high-pass. @param {number} sr @param {number} f0 @param {number} q */
  highPass(sr, f0, q) {
    const w0 = TAU * (f0 / sr);
    const cw = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * q);
    const a0 = 1 + alpha;
    return this.set(
      ((1 + cw) / 2) / a0,
      (-(1 + cw)) / a0,
      ((1 + cw) / 2) / a0,
      (-2 * cw) / a0,
      (1 - alpha) / a0,
    );
  }

  /** @param {number} x @returns {number} */
  process(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/**
 * Schroeder/Freeverb-style stereo reverb: 8 damped combs and 4 allpasses per
 * channel. Cheap, dense enough for a hall, and fully deterministic.
 */
export class Reverb {
  /**
   * @param {number} sampleRate
   * @param {{ roomSize?: number, damping?: number, width?: number, wet?: number }} [opts]
   */
  constructor(sampleRate, { roomSize = 0.84, damping = 0.28, width = 1, wet = 0.32 } = {}) {
    const scale = sampleRate / 44100;
    const combTune = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
    const allpassTune = [556, 441, 341, 225];
    const spread = 23;
    this.combL = [];
    this.combR = [];
    this.apL = [];
    this.apR = [];
    for (const t of combTune) {
      this.combL.push(new CombLine(Math.max(4, Math.round(t * scale))));
      this.combR.push(new CombLine(Math.max(4, Math.round((t + spread) * scale))));
    }
    for (const t of allpassTune) {
      this.apL.push(new AllpassLine(Math.max(4, Math.round(t * scale))));
      this.apR.push(new AllpassLine(Math.max(4, Math.round((t + spread) * scale))));
    }
    this.setRoom(roomSize);
    this.damping = damping;
    this.damp1 = damping * 0.4;
    this.damp2 = 1 - this.damp1;
    this.width = width;
    this.wet = wet;
    this.gain = 0.015;
  }

  /** @param {number} roomSize 0..1, higher is a bigger hall */
  setRoom(roomSize) {
    this.feedback = 0.7 + Math.min(Math.max(roomSize, 0), 1) * 0.28;
    return this;
  }

  /**
   * Processes one sample pair in place.
   * @param {number} inputL @param {number} inputR
   * @returns {{ l: number, r: number }}
   */
  process(inputL, inputR) {
    const input = (inputL + inputR) * this.gain;
    let outL = 0;
    let outR = 0;
    for (let i = 0; i < this.combL.length; i += 1) {
      outL += this.combL[i].process(input, this.feedback, this.damp1, this.damp2);
      outR += this.combR[i].process(input, this.feedback, this.damp1, this.damp2);
    }
    for (let i = 0; i < this.apL.length; i += 1) {
      outL = this.apL[i].process(outL, 0.5);
      outR = this.apR[i].process(outR, 0.5);
    }
    const wet1 = this.wet * (this.width / 2 + 0.5);
    const wet2 = this.wet * ((1 - this.width) / 2);
    return { l: outL * wet1 + outR * wet2, r: outR * wet1 + outL * wet2 };
  }
}

class CombLine {
  constructor(size) {
    this.buf = new Float32Array(size);
    this.idx = 0;
    this.store = 0;
  }

  process(x, feedback, damp1, damp2) {
    const out = this.buf[this.idx];
    this.store = out * damp2 + this.store * damp1;
    this.buf[this.idx] = x + this.store * feedback;
    this.idx += 1;
    if (this.idx >= this.buf.length) this.idx = 0;
    return out;
  }
}

class AllpassLine {
  constructor(size) {
    this.buf = new Float32Array(size);
    this.idx = 0;
  }

  process(x, feedback) {
    const buffered = this.buf[this.idx];
    this.buf[this.idx] = x + buffered * feedback;
    this.idx += 1;
    if (this.idx >= this.buf.length) this.idx = 0;
    return -x + buffered;
  }
}

/**
 * Ping-pong delay whose repeats are tempo-synced, damped and high-passed so
 * bass material does not smear the low end.
 */
export class PingPongDelay {
  /**
   * @param {number} sampleRate
   * @param {{ timeL?: number, timeR?: number, feedback?: number, damp?: number, highpass?: number, wet?: number }} [opts]
   *        `timeL`/`timeR` are in seconds and must already be tempo-derived.
   */
  constructor(sampleRate, { timeL = 0.375, timeR = 0.5625, feedback = 0.38, damp = 0.42, highpass = 220, wet = 0.5 } = {}) {
    this.sr = sampleRate;
    this.bufL = new Float32Array(Math.max(4, Math.round(timeL * sampleRate)));
    this.bufR = new Float32Array(Math.max(4, Math.round(timeR * sampleRate)));
    this.idxL = 0;
    this.idxR = 0;
    this.feedback = feedback;
    this.damp = damp;
    this.lpL = 0;
    this.lpR = 0;
    this.hpL = new Biquad().highPass(sampleRate, highpass, 0.707);
    this.hpR = new Biquad().highPass(sampleRate, highpass, 0.707);
    this.wet = wet;
    this.prevL = 0;
  }

  /**
   * @param {number} inputL @param {number} inputR
   * @returns {{ l: number, r: number }} wet-only output
   */
  process(inputL, inputR) {
    const tapL = this.bufL[this.idxL];
    const tapR = this.bufR[this.idxR];
    this.lpL += this.damp * (tapL - this.lpL);
    this.lpR += this.damp * (tapR - this.lpR);
    const fbL = this.hpL.process(this.lpL);
    const fbR = this.hpR.process(this.lpR);
    // Cross-feed the two lines to produce the bouncing ping-pong image.
    this.bufL[this.idxL] = inputL + fbR * this.feedback;
    this.bufR[this.idxR] = inputR + fbL * this.feedback;
    this.idxL = (this.idxL + 1) % this.bufL.length;
    this.idxR = (this.idxR + 1) % this.bufR.length;
    return { l: tapL * this.wet, r: tapR * this.wet };
  }
}

/**
 * Catmull-Rom interpolation of `x` at fractional position `i + t`.
 * Used to estimate the analogue waveform *between* samples.
 * @param {Float32Array} x @param {number} i @param {number} t in [0, 1)
 * @returns {number}
 */
function interpolate(x, i, t) {
  const last = x.length - 1;
  const p0 = x[i > 0 ? i - 1 : 0];
  const p1 = x[i];
  const p2 = x[i + 1 <= last ? i + 1 : last];
  const p3 = x[i + 2 <= last ? i + 2 : last];
  const a = -0.5 * p0 + 1.5 * p1 - 1.5 * p2 + 0.5 * p3;
  const b = p0 - 2.5 * p1 + 2 * p2 - 0.5 * p3;
  const c = -0.5 * p0 + 0.5 * p2;
  return ((a * t + b) * t + c) * t + p1;
}

/**
 * Inter-sample (true) peak of a stereo pair, in linear units.
 *
 * A limiter that only inspects sample values still lets the reconstructed
 * waveform overshoot 0 dBFS between samples, which clips on playback and gets
 * worse through a lossy encoder. This is what `limit()` uses instead.
 *
 * @param {Float32Array} left @param {Float32Array} right @param {number} [subdivisions]
 * @returns {number}
 */
export function truePeak(left, right, subdivisions = 8) {
  let peak = 0;
  const n = Math.min(left.length, right.length);
  for (let i = 0; i < n; i += 1) {
    peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
    for (let s = 1; s < subdivisions; s += 1) {
      const t = s / subdivisions;
      peak = Math.max(peak, Math.abs(interpolate(left, i, t)), Math.abs(interpolate(right, i, t)));
    }
  }
  return peak;
}

/**
 * Offline look-ahead true-peak limiter.
 *
 * Because the whole buffer is available, the gain envelope is computed with a
 * true look-ahead window: no delay compensation is needed and transients are
 * caught before they overshoot. Peak detection is interpolated, so the result
 * stays below the ceiling once reconstructed, not merely below it at the sample
 * points. This is what lets the engine keep musical dynamics instead of
 * peak-normalising the entire track.
 *
 * @param {Float32Array} left @param {Float32Array} right @param {number} sampleRate
 * @param {{ ceiling?: number, lookaheadMs?: number, releaseMs?: number, subdivisions?: number }} [opts]
 */
export function limit(left, right, sampleRate, { ceiling = 0.851, lookaheadMs = 4, releaseMs = 130, subdivisions = 8 } = {}) {
  const n = left.length;
  if (n === 0) return { reduction: 1 };
  const look = Math.max(1, Math.round((sampleRate * lookaheadMs) / 1000));
  const release = Math.exp(-1 / ((sampleRate * releaseMs) / 1000));

  const target = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    let peak = Math.max(Math.abs(left[i]), Math.abs(right[i]));
    for (let s = 1; s < subdivisions; s += 1) {
      const t = s / subdivisions;
      peak = Math.max(peak, Math.abs(interpolate(left, i, t)), Math.abs(interpolate(right, i, t)));
    }
    target[i] = peak > ceiling ? ceiling / peak : 1;
  }

  // Sliding-window minimum via a monotonic deque, so the gain dips *before*
  // the transient arrives.
  const env = new Float32Array(n);
  const deque = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < n; i += 1) {
    while (tail > head && target[deque[tail - 1]] >= target[i]) tail -= 1;
    deque[tail] = i;
    tail += 1;
    while (deque[head] < i - look) head += 1;
    env[i] = target[deque[head]];
  }

  let gain = 1;
  let minGain = 1;
  const step = 1 - release;
  for (let i = 0; i < n; i += 1) {
    const want = env[i];
    if (want < gain) gain = want;
    else gain += (want - gain) * step;
    if (gain < minGain) minGain = gain;
    left[i] *= gain;
    right[i] *= gain;
  }
  // Safety net: floating point can still leave a hair above the ceiling.
  for (let i = 0; i < n; i += 1) {
    if (left[i] > ceiling) left[i] = ceiling;
    else if (left[i] < -ceiling) left[i] = -ceiling;
    if (right[i] > ceiling) right[i] = ceiling;
    else if (right[i] < -ceiling) right[i] = -ceiling;
  }
  return { reduction: minGain };
}

function kWeightingFilters(sampleRate) {
  const shelf = new Biquad().highShelf(sampleRate, 1681.974450955533, 0.7071752369554196, 3.999843853973347);
  const highpass = new Biquad().highPass(sampleRate, 38.13547087602444, 0.5003270373238773);
  return { shelf, highpass };
}

/**
 * Integrated loudness per ITU-R BS.1770-4 (K-weighting, 400 ms gated blocks).
 * Used to hit a target loudness with a single static gain, which preserves the
 * arrangement's internal dynamics far better than dynamic normalisation.
 *
 * @param {Float32Array} left @param {Float32Array} right @param {number} sampleRate
 * @returns {number} loudness in LUFS, or -Infinity for silence
 */
export function measureLufs(left, right, sampleRate) {
  const n = left.length;
  if (n === 0) return -Infinity;
  const fl = kWeightingFilters(sampleRate);
  const fr = kWeightingFilters(sampleRate);
  const blockSize = Math.max(1, Math.round(sampleRate * 0.4));
  const hop = Math.max(1, Math.round(sampleRate * 0.1));
  const blocks = [];
  let sumL = 0;
  let sumR = 0;
  const ringL = new Float64Array(blockSize);
  const ringR = new Float64Array(blockSize);
  let seen = 0;
  let writeIdx = 0;
  for (let i = 0; i < n; i += 1) {
    const l = fl.highpass.process(fl.shelf.process(left[i]));
    const r = fr.highpass.process(fr.shelf.process(right[i]));
    const oldL = ringL[writeIdx];
    const oldR = ringR[writeIdx];
    ringL[writeIdx] = l;
    ringR[writeIdx] = r;
    writeIdx = (writeIdx + 1) % blockSize;
    sumL += l * l - oldL * oldL;
    sumR += r * r - oldR * oldR;
    seen += 1;
    if (seen >= blockSize && (seen - blockSize) % hop === 0) {
      const meanL = sumL / blockSize;
      const meanR = sumR / blockSize;
      const z = meanL + meanR;
      if (z > 0) blocks.push(z);
    }
  }
  if (blocks.length === 0) return -Infinity;
  const loudnessOf = (z) => -0.691 + 10 * Math.log10(z);
  const withAbsolute = blocks.filter((z) => loudnessOf(z) > -70);
  if (withAbsolute.length === 0) return -Infinity;
  const meanAbsolute = withAbsolute.reduce((a, b) => a + b, 0) / withAbsolute.length;
  const relativeThreshold = loudnessOf(meanAbsolute) - 10;
  const gated = withAbsolute.filter((z) => loudnessOf(z) > relativeThreshold);
  if (gated.length === 0) return -Infinity;
  const meanGated = gated.reduce((a, b) => a + b, 0) / gated.length;
  return loudnessOf(meanGated);
}

/**
 * Applies a linear fade to the head and tail of a buffer pair. Removes the
 * click that a hard cut leaves when the last sample is non-zero.
 * @param {Float32Array} left @param {Float32Array} right @param {number} sampleRate
 * @param {{ fadeIn?: number, fadeOut?: number }} [opts] fade lengths in seconds
 */
export function fadeEdges(left, right, sampleRate, { fadeIn = 0.02, fadeOut = 2.5 } = {}) {
  const n = left.length;
  const inSamples = Math.min(n, Math.round(fadeIn * sampleRate));
  for (let i = 0; i < inSamples; i += 1) {
    const g = i / inSamples;
    left[i] *= g;
    right[i] *= g;
  }
  const outSamples = Math.min(n, Math.round(fadeOut * sampleRate));
  for (let i = 0; i < outSamples; i += 1) {
    const g = i / outSamples;
    const idx = n - 1 - i;
    left[idx] *= g;
    right[idx] *= g;
  }
}

/** @param {number} x @param {number} drive @returns {number} */
export function softClip(x, drive = 1) {
  return Math.tanh(x * drive);
}

/**
 * Removes subsonic content and any DC offset, in place. Asymmetric transients
 * (kick clicks, soft clipping) leave a small DC term that wastes headroom and
 * can make an encoder unhappy.
 *
 * @param {Float32Array} left @param {Float32Array} right @param {number} sampleRate
 * @param {number} [cutoff] corner frequency in Hz
 */
export function dcBlock(left, right, sampleRate, cutoff = 20) {
  const r = 1 - (TAU * cutoff) / sampleRate;
  let xl = 0;
  let yl = 0;
  let xr = 0;
  let yr = 0;
  for (let i = 0; i < left.length; i += 1) {
    const l = left[i];
    yl = l - xl + r * yl;
    xl = l;
    left[i] = yl;
    const rr = right[i];
    yr = rr - xr + r * yr;
    xr = rr;
    right[i] = yr;
  }
}
