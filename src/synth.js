import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

export const TAU = Math.PI * 2;

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

export function midiToFreq(midi) {
  return 440 * 2 ** ((midi - 69) / 12);
}

function oscillator(wave, phase) {
  const p = phase - Math.floor(phase);
  if (wave === 'sine') return Math.sin(TAU * p);
  if (wave === 'triangle') return 1 - 4 * Math.abs(p - 0.5);
  if (wave === 'saw') return 2 * p - 1;
  if (wave === 'square') return p < 0.5 ? 1 : -1;
  if (wave === 'soft-square') return Math.tanh(3.2 * Math.sin(TAU * p));
  return Math.sin(TAU * p);
}

export class Studio {
  constructor({ sampleRate = 44100, seconds = 160, seed = 7 } = {}) {
    this.sr = sampleRate;
    this.seconds = seconds;
    this.length = Math.ceil(seconds * sampleRate);
    this.left = new Float32Array(this.length);
    this.right = new Float32Array(this.length);
    this.rng = mulberry32(seed);
    this.seed = seed;
  }

  add(index, value, pan = 0) {
    if (index < 0 || index >= this.length) return;
    const angle = ((pan + 1) * Math.PI) / 4;
    this.left[index] += value * Math.cos(angle);
    this.right[index] += value * Math.sin(angle);
  }

  noise() {
    return this.rng() * 2 - 1;
  }

  tone({
    start,
    duration,
    freq,
    wave = 'sine',
    gain = 0.1,
    attack = 0.01,
    release = 0.2,
    pan = 0,
    cutoff = 18000,
    detune = 0,
    vibrato = 0,
    vibratoRate = 5,
    phaseOffset = 0,
  }) {
    const begin = Math.max(0, Math.floor(start * this.sr));
    const end = Math.min(this.length, Math.floor((start + duration) * this.sr));
    if (end <= begin) return;
    const attackSamples = Math.max(1, attack * this.sr);
    const releaseSamples = Math.max(1, release * this.sr);
    const total = end - begin;
    const alpha = Math.min(1, TAU * cutoff / this.sr);
    let filtered = 0;
    let phase = phaseOffset;
    const phaseStep = (freq * (1 + detune)) / this.sr;
    for (let i = 0; i < total; i += 1) {
      const t = i / this.sr;
      const envIn = Math.min(1, i / attackSamples);
      const envOut = Math.min(1, (total - i) / releaseSamples);
      const env = Math.pow(Math.min(envIn, envOut), 1.15);
      const vib = vibrato ? Math.sin(TAU * vibratoRate * t) * vibrato : 0;
      const sample = oscillator(wave, phase + vib);
      phase += phaseStep;
      filtered += alpha * (sample - filtered);
      this.add(begin + i, filtered * env * gain, pan);
    }
  }

  kick(start, gain = 0.65, pan = 0) {
    const begin = Math.floor(start * this.sr);
    const duration = 0.44;
    const total = Math.floor(duration * this.sr);
    let phase = 0;
    for (let i = 0; i < total; i += 1) {
      const t = i / this.sr;
      const env = Math.exp(-t * 8.5);
      const freq = 45 + 110 * Math.exp(-t * 20);
      phase += freq / this.sr;
      const click = i < this.sr * 0.006 ? this.noise() * 0.18 * (1 - i / (this.sr * 0.006)) : 0;
      this.add(begin + i, (Math.sin(TAU * phase) * 0.9 + click) * env * gain, pan);
    }
  }

  snare(start, gain = 0.26, pan = 0) {
    const begin = Math.floor(start * this.sr);
    const total = Math.floor(0.24 * this.sr);
    let hp = 0;
    let last = 0;
    for (let i = 0; i < total; i += 1) {
      const t = i / this.sr;
      const env = Math.exp(-t * 17);
      const n = this.noise();
      hp = n - last + hp * 0.92;
      last = n;
      const body = Math.sin(TAU * 186 * t) * 0.35;
      this.add(begin + i, (hp * 0.7 + body) * env * gain, pan);
    }
  }

  clap(start, gain = 0.17) {
    for (let burst = 0; burst < 3; burst += 1) {
      const begin = Math.floor((start + burst * 0.018) * this.sr);
      const total = Math.floor(0.11 * this.sr);
      for (let i = 0; i < total; i += 1) {
        const t = i / this.sr;
        const env = Math.exp(-t * (28 + burst * 5));
        this.add(begin + i, this.noise() * env * gain * (burst === 2 ? 0.8 : 0.45), burst === 0 ? -0.3 : 0.3);
      }
    }
  }

  hat(start, gain = 0.045, open = false) {
    const begin = Math.floor(start * this.sr);
    const total = Math.floor((open ? 0.22 : 0.055) * this.sr);
    let last = 0;
    for (let i = 0; i < total; i += 1) {
      const t = i / this.sr;
      const env = Math.exp(-t * (open ? 12 : 55));
      const n = this.noise();
      const hp = n - last;
      last = n;
      this.add(begin + i, hp * env * gain, 0.35);
    }
  }

  crash(start, gain = 0.09) {
    const begin = Math.floor(start * this.sr);
    const total = Math.floor(1.4 * this.sr);
    let hp = 0;
    let last = 0;
    for (let i = 0; i < total; i += 1) {
      const t = i / this.sr;
      const env = Math.exp(-t * 3.1);
      const n = this.noise();
      hp = n - last + hp * 0.7;
      last = n;
      this.add(begin + i, hp * env * gain, 0.1);
    }
  }

  pad(start, duration, freqs, gain = 0.05) {
    for (const [index, freq] of freqs.entries()) {
      const pan = (index / Math.max(1, freqs.length - 1) - 0.5) * 0.75;
      this.tone({
        start,
        duration,
        freq,
        wave: 'saw',
        gain: gain / Math.sqrt(freqs.length),
        attack: Math.min(2.8, duration * 0.35),
        release: Math.min(3.4, duration * 0.4),
        pan,
        cutoff: 980,
        detune: -0.0035,
      });
      this.tone({
        start,
        duration,
        freq,
        wave: 'triangle',
        gain: (gain * 0.7) / Math.sqrt(freqs.length),
        attack: Math.min(2.2, duration * 0.3),
        release: Math.min(3.0, duration * 0.35),
        pan: -pan,
        cutoff: 1200,
        detune: 0.004,
      });
    }
  }

  strings(start, duration, freqs, gain = 0.035) {
    for (const [index, freq] of freqs.entries()) {
      const pan = (index / Math.max(1, freqs.length - 1) - 0.5) * 0.9;
      this.tone({
        start,
        duration,
        freq,
        wave: 'saw',
        gain: gain / Math.sqrt(freqs.length),
        attack: 0.55,
        release: 1.1,
        pan,
        cutoff: 2200,
        detune: index % 2 ? -0.003 : 0.003,
      });
    }
  }

  bass(start, duration, freq, gain = 0.18) {
    this.tone({ start, duration, freq, wave: 'sine', gain, attack: 0.008, release: 0.06, cutoff: 420 });
    this.tone({ start, duration, freq: freq * 2, wave: 'triangle', gain: gain * 0.24, attack: 0.006, release: 0.05, cutoff: 900 });
  }

  pluck(start, duration, freq, gain = 0.055, pan = 0) {
    this.tone({ start, duration, freq, wave: 'soft-square', gain, attack: 0.004, release: 0.08, pan, cutoff: 2600 });
    this.tone({ start, duration: duration * 0.7, freq: freq * 2.005, wave: 'sine', gain: gain * 0.35, attack: 0.002, release: 0.05, pan: -pan, cutoff: 4200 });
  }

  lead(start, duration, freq, gain = 0.09) {
    this.tone({ start, duration, freq, wave: 'sine', gain, attack: 0.04, release: 0.25, cutoff: 3400, vibrato: 0.004, vibratoRate: 5.1 });
    this.tone({ start, duration, freq: freq * 0.5, wave: 'triangle', gain: gain * 0.35, attack: 0.02, release: 0.2, cutoff: 1800 });
    this.tone({ start, duration, freq: freq * 2, wave: 'sine', gain: gain * 0.12, attack: 0.03, release: 0.2, cutoff: 5000, pan: -0.2 });
  }

  vinyl(start, duration, gain = 0.012) {
    const begin = Math.floor(start * this.sr);
    const end = Math.min(this.length, Math.floor((start + duration) * this.sr));
    for (let i = begin; i < end; i += 1) {
      if (this.rng() < 0.0009) {
        const amp = (this.rng() * 2 - 1) * gain * 6;
        this.add(i, amp, this.rng() * 2 - 1);
      } else if (this.rng() < 0.02) {
        this.add(i, (this.rng() * 2 - 1) * gain * 0.25, 0.2);
      }
    }
  }

  sweep(start, duration, gain = 0.06) {
    const begin = Math.floor(start * this.sr);
    const total = Math.min(this.length - begin, Math.floor(duration * this.sr));
    let filtered = 0;
    for (let i = 0; i < total; i += 1) {
      const t = i / this.sr;
      const env = Math.sin(Math.PI * Math.min(1, i / total));
      const cutoff = 180 + 3200 * (i / total);
      const alpha = Math.min(1, (TAU * cutoff) / this.sr);
      filtered += alpha * (this.noise() - filtered);
      this.add(begin + i, filtered * env * gain, Math.sin(t * 2.2) * 0.7);
    }
  }

  finish() {
    const delayA = Math.floor(this.sr * 0.375);
    const delayB = Math.floor(this.sr * 0.5625);
    for (let i = delayA; i < this.length; i += 1) {
      this.left[i] += this.right[i - delayA] * 0.24;
      this.right[i] += this.left[i - delayB] * 0.2;
    }
    let peak = 0;
    for (let i = 0; i < this.length; i += 1) {
      this.left[i] = Math.tanh(this.left[i] * 1.15);
      this.right[i] = Math.tanh(this.right[i] * 1.15);
      peak = Math.max(peak, Math.abs(this.left[i]), Math.abs(this.right[i]));
    }
    const scale = peak > 0 ? 0.92 / peak : 1;
    for (let i = 0; i < this.length; i += 1) {
      this.left[i] *= scale;
      this.right[i] *= scale;
    }
    return this;
  }

  writeWav(file) {
    const channels = 2;
    const bits = 16;
    const bytesPerSample = bits / 8;
    const dataSize = this.length * channels * bytesPerSample;
    const buffer = Buffer.alloc(44 + dataSize);
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(channels, 22);
    buffer.writeUInt32LE(this.sr, 24);
    buffer.writeUInt32LE(this.sr * channels * bytesPerSample, 28);
    buffer.writeUInt16LE(channels * bytesPerSample, 32);
    buffer.writeUInt16LE(bits, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataSize, 40);
    let offset = 44;
    for (let i = 0; i < this.length; i += 1) {
      buffer.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(this.left[i] * 32767))), offset);
      buffer.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(this.right[i] * 32767))), offset + 2);
      offset += 4;
    }
    writeFileSync(file, buffer);
    return file;
  }
}

export function encodeMp3(wavFile, mp3File, bitrate = '192k') {
  const result = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', wavFile, '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11', '-codec:a', 'libmp3lame', '-b:a', bitrate, mp3File], {
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error(`ffmpeg failed with code ${result.status}`);
  return mp3File;
}
