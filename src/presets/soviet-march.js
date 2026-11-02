/**
 * soviet-march.js — march preset.
 *
 * "Marcha del Frente" is an original stern march in D natural minor: snare,
 * tuba oom-pah, trombones on the offbeats, a trumpet fanfare and a wordless
 * choir. Written for the browser game Free the Nation!.
 *
 * The material is a deliberately simple motivic cell developed by transposition
 * and sequence. It quotes no anthem, no song and no recording.
 */

import { Studio } from '../synth.js';
import { Arrangement, describeForm } from '../arrangement.js';
import { SCALES, parseDegree, voiceLead, noteToMidi } from '../theory.js';
import { mulberry32 } from '../dsp.js';

const BPM = 108;
const BEATS_PER_BAR = 4;
const KEY = noteToMidi('D3');
const SCALE = 'naturalMinor';
const STEPS = SCALES[SCALE];
const NATURAL_BARS = 48;

/** i – bVII – bVI – V: the stern, epic turn, two bars per chord. */
const PROGRESSION = ['i', 'bVII', 'bVI', 'V'];
const BARS_PER_CHORD = 2;

/** @type {import('../arrangement.js').Section[]} */
const SECTIONS = [
  { name: 'llamada', bars: 4, intensity: 0.22, layers: ['roll', 'tuba', 'tam'] },
  { name: 'marcha', bars: 16, intensity: 0.62, layers: ['snare', 'tuba', 'bones', 'trumpet', 'timpani'] },
  { name: 'himno', bars: 16, intensity: 0.45, layers: ['snare', 'tuba', 'bones', 'choir', 'strings'] },
  { name: 'asalto', bars: 8, intensity: 0.96, layers: ['snare', 'tuba', 'bones', 'trumpet', 'choir', 'timpani', 'tam'] },
  { name: 'coda', bars: 4, intensity: 0.55, layers: ['tuba', 'bones', 'trumpet', 'timpani', 'tam'] },
];

const TRACKS = [
  { name: 'tuba', program: 58 },
  { name: 'bones', program: 57 },
  { name: 'trumpet', program: 56 },
  { name: 'choir', program: 52 },
  { name: 'strings', program: 48 },
  { name: 'drums', program: 0, drum: true },
];

/** @param {number} index @returns {number} MIDI note */
function deg(index) {
  const n = STEPS.length;
  const octave = Math.floor(index / n);
  const step = ((index % n) + n) % n;
  return KEY + STEPS[step] + 12 * octave;
}

/** Eight-note cell over two bars: A A F A C A F D. */
const MOTIF = [4, 4, 2, 4, 7, 4, 2, 0];
const OFFSETS = [0, 0.75, 1.1, 2, 2.5, 3, 4, 5];
const LENGTHS = [0.7, 0.28, 0.85, 0.45, 0.45, 0.9, 0.9, 2.6];

/** @param {string} symbol @returns {number[]} */
function chordFor(symbol) {
  return parseDegree(symbol, KEY, SCALE).notes;
}

/**
 * @param {{ seconds?: number, seed?: number, sampleRate?: number, stems?: boolean, score?: import('../midi.js').Score | null }} [opts]
 * @returns {Studio}
 */
export function render({ seconds = undefined, seed = 7, sampleRate = 44100, stems = false, score = null } = {}) {
  const arrangement = new Arrangement({ bpm: BPM, beatsPerBar: BEATS_PER_BAR, sections: SECTIONS });
  if (seconds != null) arrangement.fit(seconds);
  const total = arrangement.seconds;
  const beat = arrangement.beat;

  const studio = new Studio({ sampleRate, seconds: total, seed, stems, score });
  const rng = mulberry32(seed);
  const jitter = (amount = 0.008) => (rng() * 2 - 1) * amount;
  const vel = (base) => Math.max(0.1, Math.min(1, base * (0.86 + rng() * 0.28)));

  let prevBones = null;

  studio.vinyl(0, total, 0.0025);

  arrangement.forEachBar((ctx) => {
    const { bar, start, section, barInSection, barsInSection, intensity, at } = ctx;
    const L = section.layers;
    const symbol = PROGRESSION[Math.floor(bar / BARS_PER_CHORD) % PROGRESSION.length];
    const chord = chordFor(symbol);
    const root = chord[0];
    const isSectionStart = barInSection === 0;
    const isLastBar = barInSection === barsInSection - 1;
    const isAssault = section.name === 'asalto';
    const isHymn = section.name === 'himno';

    // -- Tuba: el paso, en 1 y 3 ---------------------------------------------
    if (L.includes('tuba')) {
      for (const b of [0, 2]) {
        studio.tuba(at(b + jitter(0.004)), beat * 0.8, root - 24, {
          gain: b === 0 ? 0.115 : 0.09,
          velocity: vel(0.8),
          bus: 'bajo',
          track: 'tuba',
          midi: root - 24,
        });
      }
    }

    // -- Trombones: el "pah" en 2 y 4 ----------------------------------------
    if (L.includes('bones')) {
      const voicing = voiceLead(prevBones, chord.map((n) => n - 12), { min: 42, max: 62 });
      prevBones = voicing;
      for (const b of [1, 3]) {
        for (const n of voicing) {
          studio.trombone(at(b + jitter(0.004)), beat * 0.42, n, {
            gain: 0.052,
            velocity: vel(b === 1 ? 0.72 : 0.6),
            bus: 'bones',
            track: 'bones',
            midi: n,
          });
        }
      }
    }

    // -- Tarola: marcha en corcheas con acentos -------------------------------
    if (L.includes('snare')) {
      for (let e = 0; e < 8; e += 1) {
        const accent = e % 4 === 0 ? 0.3 : 0.13;
        studio.snare(at(e * 0.5 + jitter(0.005)), {
          gain: accent * (0.7 + intensity * 0.6),
          pan: e % 2 ? 0.12 : -0.12,
          velocity: vel(0.65),
          bus: 'drums',
          track: 'drums',
        });
      }
      if (isLastBar && !isHymn) {
        studio.snare(at(3.5), { gain: 0.26, bus: 'drums', track: 'drums' });
        studio.snare(at(3.75), { gain: 0.3, bus: 'drums', track: 'drums' });
      }
    }

    // -- Redoble de entrada ---------------------------------------------------
    if ((L.includes('roll') || isAssault || section.name === 'coda') && isSectionStart) {
      studio.timpaniRoll(start, arrangement.bar * 1.6, root - 24, {
        gain: 0.16,
        rate: 13,
        crescendo: 0.8,
        bus: 'drums',
        track: 'drums',
      });
    }

    // -- Trompeta: la fanfarria ----------------------------------------------
    if (L.includes('trumpet')) {
      const lift = isAssault ? 12 : 0;
      for (let i = 0; i < MOTIF.length; i += 1) {
        const note = deg(MOTIF[i]) + 12 + lift;
        studio.trumpet(at(OFFSETS[i] + jitter(0.006)), beat * LENGTHS[i], note, {
          gain: (isAssault ? 0.072 : 0.056) * (0.65 + intensity * 0.5),
          velocity: vel(i === 0 || i === 7 ? 0.9 : 0.7),
          bus: 'trumpet',
          track: 'trumpet',
          midi: note,
        });
      }
    }

    // -- Coro: el himno -------------------------------------------------------
    if (L.includes('choir')) {
      const voicing = voiceLead(null, chord, { min: 52, max: 72 });
      studio.choir(start, Math.min(beat * 7.4, total - start), voicing, {
        gain: isAssault ? 0.05 : 0.04,
        attack: isAssault ? 0.35 : 0.9,
        release: 1.6,
        bus: 'choir',
        track: 'choir',
      });
      if (isHymn) {
        studio.strings(start, beat * 3.8, voicing.map((n) => n + 12), {
          gain: 0.022,
          attack: 0.6,
          release: 1.1,
          bus: 'strings',
          track: 'strings',
        });
      }
    }

    // -- Timbales: tónica y dominante ---------------------------------------
    if (L.includes('timpani')) {
      if (isSectionStart || bar % 2 === 0) {
        studio.timpani(at(0), { gain: 0.3, midi: root - 24, bus: 'drums', track: 'drums' });
      }
      if (isLastBar && !isAssault) {
        studio.timpani(at(0), { gain: 0.26, midi: root - 17, bus: 'drums', track: 'drums' });
      }
    }

    // -- Tam-tam en los grandes cortes ---------------------------------------
    if (L.includes('tam') && isSectionStart) {
      studio.tamTam(start, { gain: 0.1, bus: 'drums', track: 'drums' });
    }

    // -- Cadencia final ------------------------------------------------------
    if (section.name === 'coda' && isLastBar) {
      studio.impact(start + beat * 2, { gain: 0.32 });
      studio.timpaniRoll(start + beat * 2, beat * 1.8, KEY - 24, { gain: 0.22, rate: 12, crescendo: 0.5 });
      for (const n of chordFor('i')) {
        studio.trumpet(start + beat * 2, beat * 2.4, n + 12, { gain: 0.06, velocity: 0.85 });
        studio.trombone(start + beat * 2, beat * 2.4, n - 12, { gain: 0.055, velocity: 0.8 });
      }
      studio.tuba(start + beat * 2, beat * 2.2, KEY - 24, { gain: 0.11 });
    }
  });

  studio.finish({
    targetLufs: -14,
    fadeIn: 0.05,
    fadeOut: Math.min(2.5, total * 0.05),
    reverbRoom: 0.72,
    reverbDamp: 0.4,
    delayWet: 0.12,
  });
  return studio;
}

/** Short roll that fits the space left in the bar. */
export const meta = {
  slug: 'soviet-march',
  name: 'Marcha del Frente',
  bpm: BPM,
  key: 'D minor',
  bars: NATURAL_BARS,
  beatsPerBar: BEATS_PER_BAR,
  description: 'Stern military march: snare, tuba and trombones, trumpet fanfare and wordless choir.',
  tracks: TRACKS,
  /** @returns {number} */
  naturalSeconds() {
    return NATURAL_BARS * BEATS_PER_BAR * (60 / BPM);
  },
  /** @param {{ seconds?: number }} opts @returns {string} */
  form(opts = {}) {
    const arrangement = new Arrangement({ bpm: BPM, beatsPerBar: BEATS_PER_BAR, sections: SECTIONS });
    if (opts.seconds != null) arrangement.fit(opts.seconds);
    return describeForm(arrangement);
  },
};
