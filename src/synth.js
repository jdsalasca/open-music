/**
 * synth.js — the open-music engine.
 *
 * A `Studio` is a stereo (or multi-bus) buffer that voices are rendered into.
 * Voices are plain synchronous methods; nothing here knows about song form or
 * music theory, which keeps the DSP layer reusable by any preset.
 *
 * Signal flow:
 *   voices -> dry bus(es) + reverb send + delay send
 *          -> reverb / tempo-synced ping-pong delay
 *          -> static loudness gain -> look-ahead limiter -> edge fades
 */

import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  TAU,
  mulberry32,
  oscillator,
  SVF,
  Reverb,
  PingPongDelay,
  limit,
  measureLufs,
  fadeEdges,
  dcBlock,
} from './dsp.js';
import { midiToFreq } from './theory.js';

export { TAU, midiToFreq };

/** Filter coefficient refresh interval, in samples. */
const FILTER_BLOCK = 16;

/**
 * Writes a stereo PCM 16-bit WAV file.
 * @param {string} file
 * @param {Float32Array} left
 * @param {Float32Array} right
 * @param {number} sampleRate
 * @returns {string} the file path
 */
export function writeWavFile(file, left, right, sampleRate) {
  const channels = 2;
  const bytesPerSample = 2;
  const frames = Math.min(left.length, right.length);
  const dataSize = frames * channels * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  buffer.writeUInt16LE(channels * bytesPerSample, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  let offset = 44;
  for (let i = 0; i < frames; i += 1) {
    const l = Math.max(-1, Math.min(1, left[i]));
    const r = Math.max(-1, Math.min(1, right[i]));
    buffer.writeInt16LE(Math.round(l * 32767), offset);
    buffer.writeInt16LE(Math.round(r * 32767), offset + 2);
    offset += 4;
  }
  writeFileSync(file, buffer);
  return file;
}

/**
 * One rendered stereo bus.
 */
class Bus {
  /** @param {number} length @param {string} name */
  constructor(length, name) {
    this.name = name;
    this.left = new Float32Array(length);
    this.right = new Float32Array(length);
  }
}

/**
 * A deterministic multi-bus synthesis studio.
 */
export class Studio {
  /**
   * @param {{ sampleRate?: number, seconds?: number, seed?: number, stems?: boolean, score?: import('./midi.js').Score | null }} [opts]
   *        `stems: true` keeps every named bus separate (for stem export) at the
   *        cost of one stereo buffer per bus instead of a single shared one.
   */
  constructor({ sampleRate = 44100, seconds = 160, seed = 7, stems = false, score = null } = {}) {
    this.sr = sampleRate;
    this.seconds = seconds;
    this.length = Math.max(1, Math.ceil(seconds * sampleRate));
    this.seed = seed;
    this.rng = mulberry32(seed);
    this.stems = stems;
    this.score = score;
    this.buses = new Map();
    this.main = new Bus(this.length, 'main');
    this.buses.set('main', this.main);
    this.revL = new Float32Array(this.length);
    this.revR = new Float32Array(this.length);
    this.delL = new Float32Array(this.length);
    this.delR = new Float32Array(this.length);
    this.panCache = new Map();
    this.stats = { notes: 0 };
  }

  /**
   * Resolves the bus a voice writes to. An explicit `bus` wins; otherwise the
   * score `track` name is reused, so `--stems` separates instruments without
   * every preset having to name its buses twice.
   *
   * @param {string | null} [bus] @param {string | null} [track] @returns {Bus}
   */
  busFor(bus, track) {
    const name = bus ?? track ?? 'main';
    if (!this.stems) return this.main;
    let resolved = this.buses.get(name);
    if (!resolved) {
      resolved = new Bus(this.length, name);
      this.buses.set(name, resolved);
    }
    return resolved;
  }

  /** @param {number} pan @returns {{ l: number, r: number }} */
  panGains(pan) {
    const clamped = Math.max(-1, Math.min(1, pan));
    const key = Math.round(clamped * 200);
    let gains = this.panCache.get(key);
    if (!gains) {
      const angle = ((key / 200 + 1) * Math.PI) / 4;
      gains = { l: Math.cos(angle), r: Math.sin(angle) };
      this.panCache.set(key, gains);
    }
    return gains;
  }

  /** @returns {number} uniform white noise in [-1, 1) */
  noise() {
    return this.rng() * 2 - 1;
  }

  /**
   * Records a note into the attached score, if any.
   * @param {{ track?: string | null, start: number, duration: number, midi?: number | null, velocity?: number }} evt
   */
  record({ track, start, duration, midi, velocity = 0.8 }) {
    if (!this.score || !track || midi == null) return;
    this.score.note(track, { start, duration, midi, velocity });
  }

  /**
   * Adds one sample to the mix at absolute index `index`.
   * Pan and send gains are precomputed by callers in hot loops; this helper is
   * for the cold paths (drums, one-shots).
   *
   * @param {number} index
   * @param {number} value
   * @param {{ pan?: number, reverb?: number, delay?: number, bus?: string }} [opts]
   */
  add(index, value, { pan = 0, reverb = 0, delay = 0, bus = null, track = null } = {}) {
    if (index < 0 || index >= this.length) return;
    const b = this.busFor(bus, track);
    const g = this.panGains(pan);
    b.left[index] += value * g.l;
    b.right[index] += value * g.r;
    if (reverb > 0) {
      this.revL[index] += value * g.l * reverb;
      this.revR[index] += value * g.r * reverb;
    }
    if (delay > 0) {
      this.delL[index] += value * g.l * delay;
      this.delR[index] += value * g.r * delay;
    }
  }

  /**
   * General-purpose subtractive voice: band-limited oscillator (optionally a
   * unison stack) through a resonant filter with its own envelope, driven by an
   * ADSR amplitude envelope whose release tail extends past `duration`.
   *
   * @param {object} o
   * @param {number} o.start seconds
   * @param {number} o.duration seconds of the sustained portion
   * @param {number} o.freq Hz
   * @param {string} [o.wave]
   * @param {number} [o.gain]
   * @param {number} [o.attack] @param {number} [o.decay] @param {number} [o.sustain] @param {number} [o.release]
   * @param {number} [o.pan]
   * @param {number} [o.cutoff] filter cutoff in Hz
   * @param {number} [o.res] filter resonance
   * @param {number} [o.filterEnv] extra cutoff applied at note start, as a ratio (1 = one octave up)
   * @param {number} [o.filterDecay] seconds for the filter envelope to settle
   * @param {number} [o.detune] fractional detune, e.g. -0.003
   * @param {number} [o.unison] number of stacked voices (>= 1)
   * @param {number} [o.spread] unison detune in semitones
   * @param {number} [o.unisonPan] stereo spread of the unison stack
   * @param {number} [o.vibrato] vibrato depth in semitones
   * @param {number} [o.vibratoRate] Hz
   * @param {number} [o.vibratoDelay] seconds before vibrato fades in
   * @param {number} [o.reverb] @param {number} [o.delay] send amounts 0..1
   * @param {string} [o.bus]
   * @param {number} [o.velocity]
   * @param {number | null} [o.midi] when set and a score is attached, the note is recorded
   * @param {string | null} [o.track]
   */
  tone({
    start,
    duration,
    freq,
    wave = 'sine',
    gain = 0.1,
    attack = 0.01,
    decay = 0.05,
    sustain = 1,
    release = 0.2,
    pan = 0,
    cutoff = 18000,
    res = 0.707,
    filterEnv = 0,
    filterDecay = 0.25,
    detune = 0,
    unison = 1,
    spread = 0,
    unisonPan = 0,
    vibrato = 0,
    vibratoRate = 5,
    vibratoDelay = 0,
    reverb = 0.2,
    delay = 0,
    bus = null,
    velocity = 1,
    midi = null,
    track = null,
  }) {
    const sr = this.sr;
    const begin = Math.max(0, Math.floor(start * sr));
    const total = Math.floor((duration + release) * sr);
    const end = Math.min(this.length, begin + total);
    if (end <= begin || duration <= 0) return;
    const busRef = this.busFor(bus, track);
    const dryL = busRef.left;
    const dryR = busRef.right;
    const revL = this.revL;
    const revR = this.revR;
    const delL = this.delL;
    const delR = this.delR;

    const aS = Math.max(1, attack * sr);
    const dS = Math.max(1, decay * sr);
    const rS = Math.max(1, release * sr);
    const durS = Math.max(1, duration * sr);
    const sd = Math.max(0, Math.min(1, sustain));
    const vS = vibratoDelay > 0 ? Math.max(1, vibratoDelay * sr) : 0;

    const voiceCount = Math.max(1, Math.round(unison));
    const useFilter = cutoff < sr * 0.45;
    const amount = gain * velocity;
    this.stats.notes += 1;
    this.record({ track, start, duration, midi, velocity });

    for (let v = 0; v < voiceCount; v += 1) {
      const offset = voiceCount === 1 ? 0 : (v / (voiceCount - 1) - 0.5) * 2;
      const freqV = freq * (1 + detune) * 2 ** ((offset * spread) / 12);
      const panV = Math.max(-1, Math.min(1, pan + offset * unisonPan));
      const pg = this.panGains(panV);
      const gl = pg.l;
      const gr = pg.r;
      const rl = gl * reverb;
      const rr = gr * reverb;
      const dl = gl * delay;
      const dr = gr * delay;
      const phaseStep = freqV / sr;
      const baseCut = cutoff;
      const peakCut = useFilter ? Math.min(cutoff * (1 + filterEnv), sr * 0.45) : 0;
      const svf = useFilter ? new SVF(sr) : null;
      let phase = voiceCount === 1 ? 0 : this.rng();
      let frames = 0;
      for (let i = 0; i < end - begin; i += 1) {
        const t = i / sr;
        let env;
        if (i < aS) env = i / aS;
        else if (i < aS + dS) env = 1 - (1 - sd) * ((i - aS) / dS);
        else if (i < durS) env = sd;
        else env = sd * Math.max(0, 1 - (i - durS) / rS);
        if (env <= 0) break;

        let p = phase;
        if (vibrato) {
          const depth = vibratoDelay > 0 ? Math.min(1, i / vS) : 1;
          p += (Math.sin(TAU * vibratoRate * t) * vibrato * depth) / 12;
        }
        let sample = oscillator(wave, p, phaseStep);
        phase += phaseStep;

        if (useFilter) {
          if (frames === 0) {
            const fc = peakCut + (baseCut - peakCut) * Math.exp(-t / filterDecay);
            svf.set(fc, res);
          }
          frames += 1;
          if (frames >= FILTER_BLOCK) frames = 0;
          sample = svf.process(sample);
        }

        const out = sample * env * amount;
        const idx = begin + i;
        dryL[idx] += out * gl;
        dryR[idx] += out * gr;
        if (reverb > 0) {
          revL[idx] += out * rl;
          revR[idx] += out * rr;
        }
        if (delay > 0) {
          delL[idx] += out * dl;
          delR[idx] += out * dr;
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Percussion
  // ---------------------------------------------------------------------------

  /**
   * Kick drum: pitched sine sweep with a click transient.
   * @param {number} start @param {{ gain?: number, pan?: number, pitch?: number, decay?: number, reverb?: number, bus?: string, track?: string | null, midi?: number }} [opts]
   */
  kick(start, { gain = 0.7, pan = 0, pitch = 48, decay = 8.5, reverb = 0.03, bus = null, track = null, midi = 36 } = {}) {
    const sr = this.sr;
    const begin = Math.max(0, Math.floor(start * sr));
    const total = Math.floor(0.5 * sr);
    const end = Math.min(this.length, begin + total);
    const b = this.busFor(bus, track);
    const pg = this.panGains(pan);
    const rev = reverb;
    const clickLen = Math.max(1, Math.floor(sr * 0.006));
    let phase = 0;
    this.stats.notes += 1;
    this.record({ track, start, duration: 0.5, midi, velocity: gain });
    for (let i = 0; i < end - begin; i += 1) {
      const t = i / sr;
      const env = Math.exp(-t * decay);
      const freq = pitch + 110 * Math.exp(-t * 20);
      phase += freq / sr;
      const click = i < clickLen ? this.noise() * 0.2 * (1 - i / clickLen) : 0;
      const out = (Math.sin(TAU * phase) * 0.9 + click) * env * gain;
      const idx = begin + i;
      b.left[idx] += out * pg.l;
      b.right[idx] += out * pg.r;
      if (rev > 0) {
        this.revL[idx] += out * pg.l * rev;
        this.revR[idx] += out * pg.r * rev;
      }
    }
  }

  /**
   * Orchestral bass drum: low, wide, with a long decay.
   * @param {number} start @param {{ gain?: number, pan?: number, reverb?: number, bus?: string, track?: string | null, midi?: number }} [opts]
   */
  bassDrum(start, { gain = 0.75, pan = 0, reverb = 0.32, bus = null, track = null, midi = 35 } = {}) {
    const sr = this.sr;
    const begin = Math.max(0, Math.floor(start * sr));
    const total = Math.floor(1.6 * sr);
    const end = Math.min(this.length, begin + total);
    const b = this.busFor(bus, track);
    const pg = this.panGains(pan);
    let phase = 0;
    let lp = 0;
    this.stats.notes += 1;
    this.record({ track, start, duration: 1.6, midi, velocity: gain });
    for (let i = 0; i < end - begin; i += 1) {
      const t = i / sr;
      const env = Math.exp(-t * 3.2);
      const freq = 42 + 70 * Math.exp(-t * 26);
      phase += freq / sr;
      const body = Math.sin(TAU * phase);
      const skin = this.noise() * Math.exp(-t * 40) * 0.5;
      lp += 0.08 * (body + skin - lp);
      const out = lp * env * gain;
      const idx = begin + i;
      b.left[idx] += out * pg.l;
      b.right[idx] += out * pg.r;
      if (reverb > 0) {
        this.revL[idx] += out * pg.l * reverb;
        this.revR[idx] += out * pg.r * reverb;
      }
    }
  }

  /** @param {number} start @param {{ gain?: number, pan?: number, reverb?: number, bus?: string, track?: string | null, midi?: number }} [opts] */
  snare(start, { gain = 0.3, pan = 0, reverb = 0.18, bus = null, track = null, midi = 38 } = {}) {
    const sr = this.sr;
    const begin = Math.max(0, Math.floor(start * sr));
    const total = Math.floor(0.3 * sr);
    const end = Math.min(this.length, begin + total);
    const b = this.busFor(bus, track);
    const pg = this.panGains(pan);
    let hp = 0;
    let last = 0;
    this.stats.notes += 1;
    this.record({ track, start, duration: 0.3, midi, velocity: gain });
    for (let i = 0; i < end - begin; i += 1) {
      const t = i / sr;
      const env = Math.exp(-t * 16);
      const n = this.noise();
      hp = n - last + hp * 0.92;
      last = n;
      const body = Math.sin(TAU * 186 * t) * 0.35 + Math.sin(TAU * 278 * t) * 0.18;
      const out = (hp * 0.7 + body) * env * gain;
      const idx = begin + i;
      b.left[idx] += out * pg.l;
      b.right[idx] += out * pg.r;
      if (reverb > 0) {
        this.revL[idx] += out * pg.l * reverb;
        this.revR[idx] += out * pg.r * reverb;
      }
    }
  }

  /** @param {number} start @param {{ gain?: number, pan?: number, reverb?: number, bus?: string, track?: string | null, midi?: number }} [opts] */
  clap(start, { gain = 0.18, reverb = 0.22, bus = null, track = null, midi = 39 } = {}) {
    const sr = this.sr;
    const b = this.busFor(bus, track);
    this.stats.notes += 1;
    this.record({ track, start, duration: 0.2, midi, velocity: gain });
    for (let burst = 0; burst < 3; burst += 1) {
      const begin = Math.max(0, Math.floor((start + burst * 0.018) * sr));
      const total = Math.floor(0.13 * sr);
      const end = Math.min(this.length, begin + total);
      const pan = burst === 0 ? -0.35 : 0.35;
      const pg = this.panGains(pan);
      for (let i = 0; i < end - begin; i += 1) {
        const t = i / sr;
        const env = Math.exp(-t * (28 + burst * 5));
        const out = this.noise() * env * gain * (burst === 2 ? 0.85 : 0.5);
        const idx = begin + i;
        b.left[idx] += out * pg.l;
        b.right[idx] += out * pg.r;
        if (reverb > 0) {
          this.revL[idx] += out * pg.l * reverb;
          this.revR[idx] += out * pg.r * reverb;
        }
      }
    }
  }

  /** @param {number} start @param {{ gain?: number, open?: boolean, pan?: number, reverb?: number, bus?: string, track?: string | null, midi?: number }} [opts] */
  hat(start, { gain = 0.05, open = false, pan = 0.3, reverb = 0.08, bus = null, track = null, midi = null } = {}) {
    const sr = this.sr;
    const begin = Math.max(0, Math.floor(start * sr));
    const total = Math.floor((open ? 0.26 : 0.06) * sr);
    const end = Math.min(this.length, begin + total);
    const b = this.busFor(bus, track);
    const pg = this.panGains(pan);
    const decay = open ? 11 : 55;
    let last = 0;
    this.stats.notes += 1;
    this.record({ track, start, duration: open ? 0.26 : 0.06, midi, velocity: gain });
    for (let i = 0; i < end - begin; i += 1) {
      const t = i / sr;
      const env = Math.exp(-t * decay);
      const n = this.noise();
      const hp = n - last;
      last = n;
      const out = hp * env * gain;
      const idx = begin + i;
      b.left[idx] += out * pg.l;
      b.right[idx] += out * pg.r;
      if (reverb > 0) {
        this.revL[idx] += out * pg.l * reverb;
        this.revR[idx] += out * pg.r * reverb;
      }
    }
  }

  /** @param {number} start @param {{ gain?: number, pan?: number, reverb?: number, decay?: number, bus?: string, track?: string | null, midi?: number }} [opts] */
  crash(start, { gain = 0.1, pan = 0.1, reverb = 0.3, decay = 3.1, bus = null, track = null, midi = 49 } = {}) {
    const sr = this.sr;
    const begin = Math.max(0, Math.floor(start * sr));
    const total = Math.floor(1.6 * sr);
    const end = Math.min(this.length, begin + total);
    const b = this.busFor(bus, track);
    const pg = this.panGains(pan);
    let hp = 0;
    let last = 0;
    this.stats.notes += 1;
    this.record({ track, start, duration: 1.6, midi, velocity: gain });
    for (let i = 0; i < end - begin; i += 1) {
      const t = i / sr;
      const env = Math.exp(-t * decay);
      const n = this.noise();
      hp = n - last + hp * 0.7;
      last = n;
      const out = hp * env * gain;
      const idx = begin + i;
      b.left[idx] += out * pg.l;
      b.right[idx] += out * pg.r;
      if (reverb > 0) {
        this.revL[idx] += out * pg.l * reverb;
        this.revR[idx] += out * pg.r * reverb;
      }
    }
  }

  /**
   * Large tam-tam / gong: inharmonic metallic wash for dramatic hits.
   * @param {number} start @param {{ gain?: number, pan?: number, reverb?: number, bus?: string, track?: string | null, midi?: number }} [opts]
   */
  tamTam(start, { gain = 0.12, pan = 0, reverb = 0.5, bus = null, track = null, midi = 52 } = {}) {
    const sr = this.sr;
    const begin = Math.max(0, Math.floor(start * sr));
    const total = Math.floor(4.5 * sr);
    const end = Math.min(this.length, begin + total);
    const b = this.busFor(bus, track);
    const pg = this.panGains(pan);
    const partials = [1, 1.41, 1.93, 2.57, 3.11, 3.94, 4.83, 5.91];
    const decays = [1.0, 1.35, 1.9, 2.6, 3.4, 4.2, 5.0, 5.8];
    const base = 62;
    this.stats.notes += 1;
    this.record({ track, start, duration: 4.5, midi, velocity: gain });
    let shimmer = 0;
    let last = 0;
    for (let i = 0; i < end - begin; i += 1) {
      const t = i / sr;
      let acc = 0;
      for (let p = 0; p < partials.length; p += 1) {
        acc += Math.sin(TAU * base * partials[p] * t) * Math.exp(-t * decays[p]) * (1 / (1 + p));
      }
      const n = this.noise();
      shimmer = n - last + shimmer * 0.55;
      last = n;
      const out = (acc * 0.4 + shimmer * 0.25 * Math.exp(-t * 6)) * gain;
      const idx = begin + i;
      b.left[idx] += out * pg.l;
      b.right[idx] += out * pg.r;
      if (reverb > 0) {
        this.revL[idx] += out * pg.l * reverb;
        this.revR[idx] += out * pg.r * reverb;
      }
    }
  }

  /**
   * Tuned timpani: two partials with a pitch drop and a soft mallet transient.
   * @param {number} start @param {{ gain?: number, midi?: number, pan?: number, reverb?: number, bus?: string, track?: string | null }} [opts]
   */
  timpani(start, { gain = 0.5, midi = 45, pan = 0, reverb = 0.4, bus = null, track = null } = {}) {
    const sr = this.sr;
    const freq = midiToFreq(midi);
    const begin = Math.max(0, Math.floor(start * sr));
    const total = Math.floor(2.2 * sr);
    const end = Math.min(this.length, begin + total);
    const b = this.busFor(bus, track);
    const pg = this.panGains(pan);
    let p1 = 0;
    let p2 = 0;
    let thump = 0;
    this.stats.notes += 1;
    this.record({ track, start, duration: 2.2, midi, velocity: gain });
    for (let i = 0; i < end - begin; i += 1) {
      const t = i / sr;
      const env = Math.exp(-t * 2.0);
      const bend = 1 + 0.06 * Math.exp(-t * 22);
      p1 += (freq * bend) / sr;
      p2 += (freq * 1.504 * bend) / sr;
      const body = Math.sin(TAU * p1) * 0.8 + Math.sin(TAU * p2) * 0.28;
      thump += 0.05 * (this.noise() * Math.exp(-t * 55) - thump);
      const out = (body + thump * 2.2) * env * gain;
      const idx = begin + i;
      b.left[idx] += out * pg.l;
      b.right[idx] += out * pg.r;
      if (reverb > 0) {
        this.revL[idx] += out * pg.l * reverb;
        this.revR[idx] += out * pg.r * reverb;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Orchestral and melodic voices
  // ---------------------------------------------------------------------------

  /**
   * String section. Each note becomes a small detuned unison stack with
   * delayed vibrato; the section is spread across the stereo field.
   * @param {number} start @param {number} duration
   * @param {number[]} midis @param {{ gain?: number, pan?: number, cutoff?: number, attack?: number, release?: number, vibrato?: number, reverb?: number, delay?: number, bus?: string, track?: string | null, velocity?: number, unison?: number }} [opts]
   */
  strings(start, duration, midis, {
    gain = 0.06,
    pan = 0,
    cutoff = 2600,
    attack = 0.35,
    release = 1.4,
    vibrato = 0.06,
    reverb = 0.5,
    delay = 0.05,
    bus = null,
    track = null,
    velocity = 1,
    unison = 2,
  } = {}) {
    const n = Math.max(1, midis.length);
    midis.forEach((midi, index) => {
      const spread = n === 1 ? 0 : (index / (n - 1) - 0.5) * 1.2;
      this.tone({
        start,
        duration,
        freq: midiToFreq(midi),
        wave: 'saw',
        gain: gain / Math.sqrt(n),
        attack,
        decay: 0.4,
        sustain: 0.85,
        release,
        pan: pan + spread,
        cutoff,
        res: 0.9,
        filterEnv: 0.45,
        filterDecay: 1.6,
        unison,
        spread: 0.09,
        unisonPan: 0.28,
        vibrato,
        vibratoRate: 5.2,
        vibratoDelay: 0.35,
        reverb,
        delay,
        bus,
        velocity,
        midi,
        track,
      });
    });
  }

  /**
   * Solo cello / low strings: darker, more vibrato, tighter unison.
   * @param {number} start @param {number} duration @param {number} midi
   * @param {{ gain?: number, pan?: number, reverb?: number, bus?: string, track?: string | null, velocity?: number }} [opts]
   */
  cello(start, duration, midi, { gain = 0.075, pan = -0.15, reverb = 0.42, bus = null, track = null, velocity = 1 } = {}) {
    this.tone({
      start,
      duration,
      freq: midiToFreq(midi),
      wave: 'saw',
      gain,
      attack: 0.12,
      decay: 0.3,
      sustain: 0.9,
      release: 0.5,
      pan,
      cutoff: 1500,
      res: 1.1,
      filterEnv: 1.2,
      filterDecay: 0.5,
      unison: 2,
      spread: 0.06,
      unisonPan: 0.15,
      vibrato: 0.1,
      vibratoRate: 5.6,
      vibratoDelay: 0.25,
      reverb,
      delay: 0.04,
      bus,
      velocity,
      midi,
      track,
    });
  }

  /**
   * Brass section stab or swell: fast attack, filter envelope opening upward.
   * @param {number} start @param {number} duration @param {number | number[]} midi
   * @param {{ gain?: number, pan?: number, attack?: number, reverb?: number, bus?: string, track?: string | null, velocity?: number }} [opts]
   */
  brass(start, duration, midi, { gain = 0.07, pan = 0, attack = 0.05, reverb = 0.35, bus = null, track = null, velocity = 1 } = {}) {
    const list = Array.isArray(midi) ? midi : [midi];
    const n = list.length;
    list.forEach((m, index) => {
      const spread = n === 1 ? 0 : (index / (n - 1) - 0.5) * 0.7;
      this.tone({
        start,
        duration,
        freq: midiToFreq(m),
        wave: 'saw',
        gain: gain / Math.sqrt(n),
        attack,
        decay: 0.18,
        sustain: 0.78,
        release: 0.28,
        pan: pan + spread,
        cutoff: 1200,
        res: 1.4,
        filterEnv: 2.2,
        filterDecay: 0.35,
        unison: 2,
        spread: 0.05,
        unisonPan: 0.2,
        vibrato: 0.03,
        vibratoRate: 5,
        reverb,
        delay: 0.06,
        bus,
        velocity,
        midi: m,
        track,
      });
    });
  }

  /**
   * French horn: rounder and softer than the brass section.
   * @param {number} start @param {number} duration @param {number} midi
   * @param {{ gain?: number, pan?: number, reverb?: number, bus?: string, track?: string | null, velocity?: number }} [opts]
   */
  horn(start, duration, midi, { gain = 0.06, pan = 0.1, reverb = 0.45, bus = null, track = null, velocity = 1 } = {}) {
    this.tone({
      start,
      duration,
      freq: midiToFreq(midi),
      wave: 'soft-square',
      gain,
      attack: 0.16,
      decay: 0.25,
      sustain: 0.85,
      release: 0.5,
      pan,
      cutoff: 1300,
      res: 0.8,
      filterEnv: 0.8,
      filterDecay: 0.7,
      unison: 2,
      spread: 0.04,
      unisonPan: 0.12,
      vibrato: 0.04,
      vibratoRate: 4.6,
      vibratoDelay: 0.4,
      reverb,
      delay: 0.05,
      bus,
      velocity,
      midi,
      track,
    });
  }

  /**
   * Wordless choir: detuned saws plus a breath-noise layer, sung with a slow
   * swell and heavy reverb.
   * @param {number} start @param {number} duration @param {number[]} midis
   * @param {{ gain?: number, pan?: number, attack?: number, release?: number, cutoff?: number, res?: number, reverb?: number, bus?: string, track?: string | null, velocity?: number }} [opts]
   */
  choir(start, duration, midis, { gain = 0.055, attack = 0.9, release = 1.8, cutoff = 1150, res = 0.75, reverb = 0.62, bus = null, track = null, velocity = 1 } = {}) {
    const n = Math.max(1, midis.length);
    midis.forEach((midi, index) => {
      const spread = n === 1 ? 0 : (index / (n - 1) - 0.5) * 1.1;
      this.tone({
        start,
        duration,
        freq: midiToFreq(midi),
        wave: 'saw',
        gain: gain / Math.sqrt(n),
        attack,
        decay: 0.6,
        sustain: 0.8,
        release,
        pan: spread,
        cutoff,
        res,
        filterEnv: 0.5,
        filterDecay: 2,
        unison: 3,
        spread: 0.14,
        unisonPan: 0.4,
        vibrato: 0.09,
        vibratoRate: 4.8,
        vibratoDelay: 0.6,
        reverb,
        delay: 0.04,
        bus,
        velocity,
        midi,
        track,
      });
    });
  }

  /**
   * Felt/concert piano: additive synthesis with inharmonic partials, where
   * higher partials decay faster, plus a short hammer-noise transient.
   * @param {number} start @param {number} duration @param {number} midi
   * @param {{ gain?: number, pan?: number, reverb?: number, delay?: number, bus?: string, track?: string | null, velocity?: number }} [opts]
   */
  piano(start, duration, midi, { gain = 0.16, pan = 0, reverb = 0.36, delay = 0.05, bus = null, track = null, velocity = 1 } = {}) {
    const sr = this.sr;
    const freq = midiToFreq(midi);
    const begin = Math.max(0, Math.floor(start * sr));
    const ring = Math.max(duration, 1.2) + 1.1;
    const end = Math.min(this.length, begin + Math.floor(ring * sr));
    if (end <= begin) return;
    const b = this.busFor(bus, track);
    const pg = this.panGains(pan);
    const scale = Math.min(1, 620 / freq);
    const partialAmp = [1, 0.46, 0.26, 0.15, 0.085, 0.05, 0.03];
    const partialRatio = [1, 2.003, 3.008, 4.017, 5.028, 6.042, 7.06];
    const partialDecay = [1.1, 1.9, 2.9, 4.1, 5.6, 7.2, 9];
    const out = gain * velocity * scale;
    this.stats.notes += 1;
    this.record({ track, start, duration: ring, midi, velocity });
    const releaseStart = Math.max(0.2, duration);
    for (let i = 0; i < end - begin; i += 1) {
      const t = i / sr;
      let acc = 0;
      for (let p = 0; p < partialAmp.length; p += 1) {
        acc += Math.sin(TAU * freq * partialRatio[p] * t) * partialAmp[p] * Math.exp(-t * partialDecay[p]);
      }
      const attack = Math.min(1, i / Math.max(1, sr * 0.004));
      const tail = t > releaseStart ? Math.max(0, 1 - (t - releaseStart) / 1.1) : 1;
      const hammer = i < sr * 0.01 ? this.noise() * 0.05 * (1 - i / (sr * 0.01)) : 0;
      const s = (acc * 0.32 + hammer) * attack * tail * out;
      const idx = begin + i;
      b.left[idx] += s * pg.l;
      b.right[idx] += s * pg.r;
      if (reverb > 0) {
        this.revL[idx] += s * pg.l * reverb;
        this.revR[idx] += s * pg.r * reverb;
      }
      if (delay > 0) {
        this.delL[idx] += s * pg.l * delay;
        this.delR[idx] += s * pg.r * delay;
      }
    }
  }

  /**
   * Rhodes-style electric piano.
   *
   * Two-operator FM: a modulation index that decays fast gives the bell-like
   * tine attack over a mellow body, which is what makes the sound read as a
   * Rhodes rather than a sine. The slow amplitude wobble is the suitcase
   * tremolo. A real Rhodes sample would be a sample; this is synthesis.
   *
   * @param {number} start @param {number} duration @param {number} midi
   * @param {{ gain?: number, pan?: number, reverb?: number, delay?: number, tremolo?: number, cents?: number, ring?: number, release?: number, bus?: string, track?: string | null, velocity?: number }} [opts]
   */
  electricPiano(start, duration, midi, { gain = 0.13, pan = 0, reverb = 0.3, delay = 0.06, tremolo = 5.1, cents = 0, ring = 0.8, release = 0.45, bus = null, track = null, velocity = 1 } = {}) {
    const sr = this.sr;
    const freq = midiToFreq(midi) * 2 ** (cents / 1200);
    const begin = Math.max(0, Math.floor(start * sr));
    const hold = Math.max(duration, 0.2);
    const tail = hold + Math.max(0.05, ring) + Math.max(0.05, release);
    const end = Math.min(this.length, begin + Math.floor(tail * sr));
    if (end <= begin) return;
    const b = this.busFor(bus, track);
    const pg = this.panGains(pan);
    const scale = Math.min(1, 700 / freq);
    const out = gain * velocity * scale;
    const index0 = 1.6 + velocity * 1.2;
    this.stats.notes += 1;
    this.record({ track, start, duration: hold, midi, velocity });
    for (let i = 0; i < end - begin; i += 1) {
      const t = i / sr;
      const angle = TAU * freq * t;
      const index = index0 * Math.exp(-t * 5.5);
      const carrier = Math.sin(angle + Math.sin(angle) * index);
      const tine = Math.sin(angle * 2) * 0.11 * Math.exp(-t * 4.5);
      const body = Math.exp(-t * 1.25);
      const attack = Math.min(1, i / Math.max(1, sr * 0.003));
      const wobble = 1 + 0.11 * Math.sin(TAU * tremolo * t) * Math.min(1, t * 1.6);
      const decay = t > hold ? Math.max(0, 1 - (t - hold) / Math.max(0.05, release)) : 1;
      const s = (carrier + tine) * body * attack * wobble * decay * out;
      const k = begin + i;
      b.left[k] += s * pg.l;
      b.right[k] += s * pg.r;
      if (reverb > 0) {
        this.revL[k] += s * pg.l * reverb;
        this.revR[k] += s * pg.r * reverb;
      }
      if (delay > 0) {
        this.delL[k] += s * pg.l * delay;
        this.delR[k] += s * pg.r * delay;
      }
    }
  }

  /**
   * Harp / glass pluck.
   * @param {number} start @param {number} duration @param {number} midi
   * @param {{ gain?: number, pan?: number, reverb?: number, delay?: number, bus?: string, track?: string | null, velocity?: number }} [opts]
   */
  harp(start, duration, midi, { gain = 0.07, pan = 0, reverb = 0.48, delay = 0.14, bus = null, track = null, velocity = 1 } = {}) {
    this.tone({
      start,
      duration,
      freq: midiToFreq(midi),
      wave: 'triangle',
      gain,
      attack: 0.003,
      decay: 0.5,
      sustain: 0.25,
      release: 0.9,
      pan,
      cutoff: 5200,
      res: 0.7,
      filterEnv: 1.4,
      filterDecay: 0.5,
      reverb,
      delay,
      bus,
      velocity,
      midi,
      track,
    });
    this.tone({
      start,
      duration: duration * 0.6,
      freq: midiToFreq(midi) * 2.002,
      wave: 'sine',
      gain: gain * 0.3,
      attack: 0.002,
      decay: 0.3,
      sustain: 0.2,
      release: 0.5,
      pan: -pan,
      cutoff: 7000,
      reverb: reverb * 0.8,
      delay,
      bus,
      velocity,
    });
  }

  /**
   * Legato synth/string pad, kept from the original engine but now with a
   * proper filter envelope and sends.
   * @param {number} start @param {number} duration @param {number[]} freqs
   * @param {{ gain?: number, reverb?: number, delay?: number, bus?: string, track?: string | null, midis?: number[] | null }} [opts]
   */
  pad(start, duration, freqs, { gain = 0.05, reverb = 0.45, delay = 0.08, bus = null, track = null, midis = null } = {}) {
    const n = Math.max(1, freqs.length);
    freqs.forEach((freq, index) => {
      const spread = (index / Math.max(1, n - 1) - 0.5) * 0.75;
      this.tone({
        start,
        duration,
        freq,
        wave: 'saw',
        gain: gain / Math.sqrt(n),
        attack: Math.min(2.8, duration * 0.35),
        decay: 0.8,
        sustain: 0.82,
        release: Math.min(3.4, duration * 0.4),
        pan: spread,
        cutoff: 980,
        res: 0.9,
        filterEnv: 0.35,
        filterDecay: 2.2,
        detune: -0.0035,
        unison: 2,
        spread: 0.07,
        unisonPan: 0.3,
        reverb,
        delay,
        bus,
        midi: midis ? midis[index] : null,
        track,
      });
      this.tone({
        start,
        duration,
        freq,
        wave: 'triangle',
        gain: (gain * 0.7) / Math.sqrt(n),
        attack: Math.min(2.2, duration * 0.3),
        decay: 0.7,
        sustain: 0.8,
        release: Math.min(3.0, duration * 0.35),
        pan: -spread,
        cutoff: 1200,
        detune: 0.004,
        reverb,
        delay,
        bus,
      });
    });
  }

  /**
   * Electric-style bass: sine fundamental plus a triangle overtone.
   * @param {number} start @param {number} duration @param {number} freq
   * @param {{ gain?: number, bus?: string, track?: string | null, midi?: number | null }} [opts]
   */
  bass(start, duration, freq, { gain = 0.2, bus = null, track = null, midi = null } = {}) {
    this.tone({
      start,
      duration,
      freq,
      wave: 'sine',
      gain,
      attack: 0.008,
      decay: 0.1,
      sustain: 0.85,
      release: 0.08,
      cutoff: 420,
      reverb: 0.02,
      bus,
      midi,
      track,
    });
    this.tone({
      start,
      duration,
      freq: freq * 2,
      wave: 'triangle',
      gain: gain * 0.24,
      attack: 0.006,
      decay: 0.08,
      sustain: 0.8,
      release: 0.06,
      cutoff: 900,
      bus,
    });
  }

  /**
   * Sub bass for cinematic weight; almost pure sine.
   * @param {number} start @param {number} duration @param {number} midi
   * @param {{ gain?: number, bus?: string, track?: string | null }} [opts]
   */
  subBass(start, duration, midi, { gain = 0.22, bus = null, track = null } = {}) {
    this.tone({
      start,
      duration,
      freq: midiToFreq(midi),
      wave: 'sine',
      gain,
      attack: 0.02,
      decay: 0.15,
      sustain: 0.9,
      release: 0.25,
      cutoff: 200,
      bus,
      midi,
      track,
    });
  }

  /**
   * Glassy synth pluck, kept from the original engine.
   * @param {number} start @param {number} duration @param {number} freq
   * @param {{ gain?: number, pan?: number, bus?: string, track?: string | null, midi?: number | null, reverb?: number, delay?: number }} [opts]
   */
  pluck(start, duration, freq, { gain = 0.055, pan = 0, bus = null, track = null, midi = null, reverb = 0.35, delay = 0.18 } = {}) {
    this.tone({
      start,
      duration,
      freq,
      wave: 'soft-square',
      gain,
      attack: 0.004,
      decay: 0.12,
      sustain: 0.3,
      release: 0.12,
      pan,
      cutoff: 2800,
      res: 1.1,
      filterEnv: 1.3,
      filterDecay: 0.2,
      reverb,
      delay,
      bus,
      midi,
      track,
    });
    this.tone({
      start,
      duration: duration * 0.7,
      freq: freq * 2.005,
      wave: 'sine',
      gain: gain * 0.35,
      attack: 0.002,
      decay: 0.1,
      sustain: 0.25,
      release: 0.08,
      pan: -pan,
      cutoff: 4200,
      reverb,
      delay,
      bus,
    });
  }

  /**
   * Wordless lead, kept from the original engine.
   * @param {number} start @param {number} duration @param {number} freq
   * @param {{ gain?: number, bus?: string, track?: string | null, midi?: number | null }} [opts]
   */
  lead(start, duration, freq, { gain = 0.09, bus = null, track = null, midi = null } = {}) {
    this.tone({
      start,
      duration,
      freq,
      wave: 'sine',
      gain,
      attack: 0.04,
      decay: 0.2,
      sustain: 0.82,
      release: 0.25,
      cutoff: 3400,
      vibrato: 0.05,
      vibratoRate: 5.1,
      vibratoDelay: 0.3,
      reverb: 0.4,
      delay: 0.26,
      bus,
      midi,
      track,
    });
    this.tone({
      start,
      duration,
      freq: freq * 0.5,
      wave: 'triangle',
      gain: gain * 0.35,
      attack: 0.02,
      decay: 0.15,
      sustain: 0.8,
      release: 0.2,
      cutoff: 1800,
      reverb: 0.3,
      delay: 0.26,
      bus,
    });
    this.tone({
      start,
      duration,
      freq: freq * 2,
      wave: 'sine',
      gain: gain * 0.12,
      attack: 0.03,
      decay: 0.15,
      sustain: 0.7,
      release: 0.2,
      pan: -0.2,
      cutoff: 5000,
      reverb: 0.4,
      delay: 0.2,
      bus,
    });
  }

  // ---------------------------------------------------------------------------
  // Texture
  // ---------------------------------------------------------------------------

  /** @param {number} start @param {number} duration @param {number} [gain] */
  vinyl(start, duration, gain = 0.012) {
    const begin = Math.max(0, Math.floor(start * this.sr));
    const end = Math.min(this.length, Math.floor((start + duration) * this.sr));
    for (let i = begin; i < end; i += 1) {
      if (this.rng() < 0.0009) {
        const amp = this.noise() * gain * 6;
        this.add(i, amp, { pan: this.noise() });
      } else if (this.rng() < 0.02) {
        this.add(i, this.noise() * gain * 0.25, { pan: 0.2 });
      }
    }
  }

  /** Filtered noise sweep used as a transition. @param {number} start @param {number} duration @param {number} [gain] */
  sweep(start, duration, gain = 0.06) {
    const begin = Math.max(0, Math.floor(start * this.sr));
    const total = Math.max(0, Math.min(this.length - begin, Math.floor(duration * this.sr)));
    let filtered = 0;
    for (let i = 0; i < total; i += 1) {
      const t = i / this.sr;
      const env = Math.sin(Math.PI * Math.min(1, i / total));
      const cutoff = 180 + 3200 * (i / total);
      const alpha = Math.min(1, (TAU * cutoff) / this.sr);
      filtered += alpha * (this.noise() - filtered);
      this.add(begin + i, filtered * env * gain, { pan: Math.sin(t * 2.2) * 0.7, reverb: 0.3 });
    }
  }

  /**
   * Rising tension riser: noise and pitch sweep aimed at a downbeat.
   * @param {number} start @param {number} duration
   * @param {{ gain?: number, bus?: string }} [opts]
   */
  riser(start, duration, { gain = 0.05, bus = null, track = null } = {}) {
    const sr = this.sr;
    const begin = Math.max(0, Math.floor(start * sr));
    const total = Math.max(0, Math.min(this.length - begin, Math.floor(duration * sr)));
    if (total <= 0) return;
    const b = this.busFor(bus, track);
    let lp = 0;
    let phase = 0;
    for (let i = 0; i < total; i += 1) {
      const p = i / total;
      const env = p ** 2;
      const cutoff = 200 + 6500 * p ** 3;
      const alpha = Math.min(1, (TAU * cutoff) / sr);
      lp += alpha * (this.noise() - lp);
      phase += (110 * 2 ** (p * 3)) / sr;
      const tonePart = Math.sin(TAU * phase) * 0.25 * p;
      const out = (lp * 0.8 + tonePart) * env * gain;
      const idx = begin + i;
      b.left[idx] += out * 0.7;
      b.right[idx] += out * 0.7;
      this.revL[idx] += out * 0.3;
      this.revR[idx] += out * 0.3;
    }
  }

  /**
   * Cinematic impact: low sine drop plus a noise burst, for section downbeats.
   * @param {number} start @param {{ gain?: number, reverb?: number, bus?: string }} [opts]
   */
  impact(start, { gain = 0.3, reverb = 0.55, bus = null, track = null } = {}) {
    const sr = this.sr;
    const begin = Math.max(0, Math.floor(start * sr));
    const total = Math.floor(2.4 * sr);
    const end = Math.min(this.length, begin + total);
    const b = this.busFor(bus, track);
    let phase = 0;
    let lp = 0;
    for (let i = 0; i < end - begin; i += 1) {
      const t = i / sr;
      const env = Math.exp(-t * 1.6);
      phase += (90 * Math.exp(-t * 3) + 28) / sr;
      const sub = Math.sin(TAU * phase);
      lp += 0.12 * (this.noise() - lp);
      const out = (sub * 0.8 + lp * 0.5 * Math.exp(-t * 9)) * env * gain;
      const idx = begin + i;
      b.left[idx] += out * 0.707;
      b.right[idx] += out * 0.707;
      this.revL[idx] += out * 0.707 * reverb;
      this.revR[idx] += out * 0.707 * reverb;
    }
  }

  // ---------------------------------------------------------------------------
  // Mixdown
  // ---------------------------------------------------------------------------

  /**
   * Sums every bus, applies the reverb and delay returns, then the static
   * loudness gain, the look-ahead limiter and the edge fades.
   *
   * @param {object} [opts]
   * @param {number} [opts.targetLufs] integrated loudness target; pass null to skip
   * @param {number} [opts.ceiling] true-peak ceiling, linear (0.891 = -1 dBTP)
   * @param {number} [opts.reverbRoom] @param {number} [opts.reverbDamp] @param {number} [opts.reverbWidth]
   * @param {number} [opts.delayTimeL] @param {number} [opts.delayTimeR] tempo-derived delay times in seconds
   * @param {number} [opts.delayFeedback] @param {number} [opts.delayWet]
   * @param {number} [opts.fadeIn] @param {number} [opts.fadeOut]
   * @returns {this}
   */
  finish({
    targetLufs = -14,
    ceiling = 0.851,
    reverbRoom = 0.86,
    reverbDamp = 0.3,
    reverbWidth = 1,
    delayTimeL = 0.375,
    delayTimeR = 0.5625,
    delayFeedback = 0.36,
    delayWet = 0.5,
    fadeIn = 0.02,
    fadeOut = 2.5,
  } = {}) {
    const n = this.length;
    const left = new Float32Array(n);
    const right = new Float32Array(n);
    for (const bus of this.buses.values()) {
      const bl = bus.left;
      const br = bus.right;
      for (let i = 0; i < n; i += 1) {
        left[i] += bl[i];
        right[i] += br[i];
      }
    }

    const reverb = new Reverb(this.sr, { roomSize: reverbRoom, damping: reverbDamp, width: reverbWidth, wet: 1 });
    const delay = new PingPongDelay(this.sr, {
      timeL: delayTimeL,
      timeR: delayTimeR,
      feedback: delayFeedback,
      wet: delayWet,
    });
    for (let i = 0; i < n; i += 1) {
      const rev = reverb.process(this.revL[i], this.revR[i]);
      const del = delay.process(this.delL[i], this.delR[i]);
      left[i] += rev.l + del.l;
      right[i] += rev.r + del.r;
    }
    // Send buffers are no longer needed; free them before the limiter allocates.
    this.revL = null;
    this.revR = null;
    this.delL = null;
    this.delR = null;

    dcBlock(left, right, this.sr, 20);

    if (targetLufs != null) {
      const measured = measureLufs(left, right, this.sr);
      if (Number.isFinite(measured)) {
        const gain = 10 ** ((targetLufs - measured) / 20);
        for (let i = 0; i < n; i += 1) {
          left[i] *= gain;
          right[i] *= gain;
        }
        this.loudness = { measured, gain, target: targetLufs };
      }
    }

    const limited = limit(left, right, this.sr, { ceiling });
    fadeEdges(left, right, this.sr, { fadeIn, fadeOut });

    this.master = { left, right };
    this.peakReduction = limited.reduction;
    this.lufs = measureLufs(left, right, this.sr);
    return this;
  }

  /** @param {string} file @returns {string} */
  writeWav(file) {
    if (!this.master) this.finish();
    return writeWavFile(file, this.master.left, this.master.right, this.sr);
  }

  /**
   * Writes one WAV per bus, after the loudness gain but before the shared
   * reverb/delay returns, so the parts stay re-combinable.
   * @param {(name: string) => string} pathFor
   * @returns {string[]} written paths
   */
  writeStems(pathFor) {
    if (!this.master) this.finish();
    const written = [];
    for (const bus of this.buses.values()) {
      written.push(writeWavFile(pathFor(bus.name), bus.left, bus.right, this.sr));
    }
    return written;
  }
}

/**
 * Encodes a WAV file to MP3 with ffmpeg.
 *
 * No loudness filter is applied: the engine already targets an integrated
 * loudness with a single static gain, so dynamic normalisation here would only
 * pump and resample. The sample rate is pinned so the MP3 matches the render.
 *
 * @param {string} wavFile @param {string} mp3File
 * @param {{ bitrate?: string, sampleRate?: number, title?: string, artist?: string, album?: string, comment?: string }} [opts]
 * @returns {string} the mp3 path
 */
export function encodeMp3(wavFile, mp3File, { bitrate = '192k', sampleRate, title, artist, album, comment } = {}) {
  const bin = process.env.FFMPEG_PATH || 'ffmpeg';
  const args = ['-y', '-loglevel', 'error', '-i', wavFile];
  if (sampleRate) args.push('-ar', String(sampleRate));
  args.push('-codec:a', 'libmp3lame', '-b:a', bitrate);
  const tags = [
    ['title', title],
    ['artist', artist],
    ['album', album],
    ['comment', comment],
  ];
  for (const [key, value] of tags) {
    if (value) args.push('-metadata', `${key}=${value}`);
  }
  args.push(mp3File);
  const result = spawnSync(bin, args, { stdio: 'inherit' });
  if (result.error) {
    if (result.error.code === 'ENOENT') {
      throw new Error(`ffmpeg not found (looked for "${bin}"). Install ffmpeg or render a .wav instead.`);
    }
    throw result.error;
  }
  if (result.status !== 0) throw new Error(`ffmpeg exited with code ${result.status}`);
  return mp3File;
}
