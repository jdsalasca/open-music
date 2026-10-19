/**
 * bound-soul.js — chopped-soul preset.
 *
 * "Bound Soul" is original soul in B-flat major: a chopped Rhodes figure, a
 * round electric bass, a doo-wop vocal loop, string swells and laid-back
 * boom-bap drums, built on the classic I-vi-ii-V / I-vi-IV-V turnarounds.
 *
 * The production aesthetic it evokes is the chopped-soul, gospel-tinged,
 * sample-based hip-hop of the early 2010s — the register of a record like
 * Kanye West's "Bound 2". Every note here is generated from the seed: there
 * are no samples, no interpolations and no quotations of any existing
 * recording or composition.
 */

import { Studio } from '../synth.js';
import { Arrangement, describeForm } from '../arrangement.js';
import { SCALES, parseDegree, voiceLead, noteToMidi, midiToFreq } from '../theory.js';
import { mulberry32 } from '../dsp.js';

const BPM = 94;
const BEATS_PER_BAR = 4;
const KEY = noteToMidi('Bb3'); // 58
const SCALE = 'major';
const STEPS = SCALES[SCALE];
const NATURAL_BARS = 80;

/**
 * Two eight-bar loops. The verse uses the ii chord, the hook borrows the IV —
 * the move that makes a soul progression lift.
 */
const LOOP_VERSE = ['Imaj7', 'vi7', 'ii7', 'V7'];
const LOOP_HOOK = ['Imaj7', 'vi7', 'IVmaj7', 'V7'];
const BARS_PER_CHORD = 2;

/** @type {import('../arrangement.js').Section[]} */
const SECTIONS = [
  { name: 'intro', bars: 8, intensity: 0.22, layers: ['keys', 'vinyl'] },
  { name: 'verse', bars: 16, intensity: 0.55, layers: ['keys', 'bass', 'drums', 'chop', 'vinyl'] },
  { name: 'hook', bars: 16, intensity: 0.85, layers: ['keys', 'bass', 'drums', 'chop', 'vox', 'strings', 'tamb', 'vinyl'] },
  { name: 'break', bars: 8, intensity: 0.32, layers: ['keys', 'bass', 'vinyl'] },
  { name: 'hook2', bars: 16, intensity: 0.95, layers: ['keys', 'bass', 'drums', 'chop', 'vox', 'strings', 'tamb', 'vinyl'] },
  { name: 'outro', bars: 16, intensity: 0.28, layers: ['keys', 'vinyl'] },
];

const TRACKS = [
  { name: 'keys', program: 4 },
  { name: 'bass', program: 33 },
  { name: 'vox', program: 53 },
  { name: 'strings', program: 48 },
  { name: 'guitar', program: 27 },
  { name: 'drums', program: 0, drum: true },
];

/**
 * @param {number} index scale step, may be negative or beyond one octave
 * @returns {number} MIDI note
 */
function deg(index) {
  const n = STEPS.length;
  const octave = Math.floor(index / n);
  const step = ((index % n) + n) % n;
  return KEY + STEPS[step] + 12 * octave;
}

/** Rhodes comp: `[beat, length in beats]`. Staccato on purpose — it is a chop. */
const KEY_CHOPS = [
  [0, 0.55],
  [1.5, 0.3],
  [2.5, 0.45],
  [3.25, 0.28],
];
/** Sparser figure for the intro and outro. */
const KEY_SPARSE = [
  [0, 0.8],
  [2.5, 0.6],
];

/** The vocal loop: short "uh-huh" dyads on the offbeats. */
const VOX_CHOPS = [1.75, 3.5];

/** Sung hook phrase: `[beat, length in beats, scale degree]`. */
const HOOK_PHRASE = [
  [0.5, 0.9, 4],
  [1.75, 0.55, 5],
  [2.5, 1.5, 7],
];

/** `[beat, length in beats, semitones above the chord root]`. */
const BASS_PATTERN = [
  [0, 0.9, 0],
  [1.5, 0.32, 7],
  [2.5, 0.55, 0],
  [3.5, 0.28, 12],
];
const BASS_BREAK = [
  [0, 1.6, 0],
  [2.5, 0.9, 0],
];

/**
 * Maps a MIDI pitch class into the bass register (C2..B2), so the bass stays
 * in one octave even though scale degrees wrap.
 * @param {number} midi @returns {number}
 */
function bassRoot(midi) {
  return 41 + (((((midi % 12) + 12) % 12) - 5 + 12) % 12);
}

/**
 * @param {{ seconds?: number, seed?: number, sampleRate?: number, stems?: boolean, score?: import('../midi.js').Score | null }} [opts]
 * @returns {Studio}
 */
export function render({ seconds = undefined, seed = 7, sampleRate = 44100, stems = false, score = null } = {}) {
  const arrangement = new Arrangement({ bpm: BPM, beatsPerBar: BEATS_PER_BAR, sections: SECTIONS });
  if (seconds != null) arrangement.fit(seconds);
  const total = arrangement.seconds;

  const studio = new Studio({ sampleRate, seconds: total, seed, stems, score });
  const rng = mulberry32(seed);
  const jitter = (amount = 0.012) => (rng() * 2 - 1) * amount;
  const vel = (base) => Math.max(0.08, Math.min(1, base * (0.84 + rng() * 0.32)));
  const chance = (p) => rng() < p;

  let prevKeys = null;
  let prevVox = null;
  let prevStrings = null;

  studio.vinyl(0, total, 0.003);

  arrangement.forEachBar((ctx) => {
    const { bar, start, section, barInSection, barsInSection, intensity, at } = ctx;
    const layers = section.layers;
    const isHook = section.name === 'hook' || section.name === 'hook2';
    const isSparse = section.name === 'intro' || section.name === 'outro';
    const isBreak = section.name === 'break';
    const isSectionStart = barInSection === 0;
    const loop = isHook ? LOOP_HOOK : LOOP_VERSE;
    const symbol = loop[Math.floor(bar / BARS_PER_CHORD) % loop.length];
    const chord = parseDegree(symbol, KEY, SCALE).notes;
    const isChordChange = bar % BARS_PER_CHORD === 0;
    const holdBars = Math.min(BARS_PER_CHORD, barsInSection - barInSection);
    const holdSeconds = holdBars * arrangement.bar;
    const root = bassRoot(chord[0]);

    // -- Rhodes --------------------------------------------------------------
    if (layers.includes('keys')) {
      const voicing = voiceLead(prevKeys, chord, { min: 53, max: 74 });
      prevKeys = voicing;
      const figure = isSparse ? KEY_SPARSE : KEY_CHOPS;
      for (const [offset, length] of figure) {
        // A chop that lands late by a hair reads as "played", not programmed.
        const when = at(offset + jitter(isSparse ? 0.008 : 0.011));
        voicing.forEach((midi, index) => {
          studio.electricPiano(when + index * 0.004, length * arrangement.beat, midi, {
            gain: (isSparse ? 0.12 : 0.092) * (0.55 + intensity * 0.6),
            pan: (index / Math.max(1, voicing.length - 1) - 0.5) * 0.5,
            reverb: 0.34,
            delay: 0.07,
            tremolo: 5.1,
            cents: jitter(4),
            ring: isSparse ? 1.4 : 0.55,
            release: isSparse ? 0.9 : 0.3,
            track: 'keys',
            velocity: vel(offset === 0 ? 0.85 : 0.62),
          });
        });
      }
      // A soft acoustic piano doubles the first chop of each chord: its
      // additive partials fill the 1-3 kHz presence the Rhodes leaves hollow.
      if (isChordChange) {
        studio.piano(start + jitter(0.006), arrangement.bar * 0.45, chord[chord.length - 1] + 12, {
          gain: 0.042,
          reverb: 0.28,
          delay: 0.04,
          track: 'keys',
          velocity: vel(0.6),
        });
      }
    }

    // -- Bass ----------------------------------------------------------------
    if (layers.includes('bass')) {
      const pattern = isBreak ? BASS_BREAK : BASS_PATTERN;
      for (const [offset, length, interval] of pattern) {
        const midi = root + interval;
        studio.bass(at(offset + jitter(0.008)), length * arrangement.beat, midiToFreq(midi), {
          gain: (isBreak ? 0.11 : 0.135) * (0.5 + intensity * 0.55),
          track: 'bass',
          midi,
        });
      }
    }

    // -- Drums ---------------------------------------------------------------
    if (layers.includes('drums')) {
      studio.kick(at(jitter(0.004)), { gain: 0.46, track: 'drums' });
      studio.kick(at(2.5 + jitter(0.004)), { gain: 0.34, track: 'drums' });
      if (chance(0.45)) studio.kick(at(3.75 + jitter(0.005)), { gain: 0.18, track: 'drums' });
      studio.snare(at(1 + jitter(0.006)), { gain: 0.27, pan: -0.06, track: 'drums', velocity: vel(0.75) });
      studio.snare(at(3 + jitter(0.006)), { gain: 0.27, pan: 0.06, track: 'drums', velocity: vel(0.75) });
      if (chance(0.3)) studio.snare(at(2.25 + jitter(0.008)), { gain: 0.07, pan: 0.1, track: 'drums' });
      if (isHook) {
        studio.clap(at(1 + jitter(0.005)), { gain: 0.09, track: 'drums' });
        studio.clap(at(3 + jitter(0.005)), { gain: 0.09, track: 'drums' });
      }
      // Swung eighths: the second half of each beat lands a little late.
      for (let eighth = 0; eighth < 8; eighth += 1) {
        const swing = eighth % 2 === 1 ? 0.035 : 0;
        studio.hat(at(eighth * 0.5 + swing + jitter(0.006)), {
          gain: (eighth % 2 === 0 ? 0.036 : 0.024) * (0.85 + rng() * 0.3),
          open: eighth === 7 && chance(0.25),
          pan: eighth % 2 === 0 ? 0.26 : 0.34,
          track: 'drums',
        });
      }
    }

    // -- Tambourine ----------------------------------------------------------
    if (layers.includes('tamb')) {
      for (let beat = 0; beat < 4; beat += 1) {
        studio.hat(at(beat + 0.5 + jitter(0.004)), { gain: 0.02, pan: -0.34, track: 'drums' });
      }
    }

    if (isSectionStart && (isHook || isBreak)) {
      studio.crash(start, { gain: 0.06, track: 'drums' });
    }

    // -- Vocal loop ("uh-huh") -----------------------------------------------
    if (layers.includes('chop')) {
      const dyad = voiceLead(prevVox, chord.slice(-2).map((n) => n + 12), { min: 62, max: 81 });
      prevVox = dyad;
      for (const offset of VOX_CHOPS) {
        studio.choir(at(offset + jitter(0.01)), 0.16, dyad, {
          gain: 0.082 * (0.6 + intensity * 0.5),
          attack: 0.03,
          release: 0.35,
          cutoff: 2300,
          reverb: 0.5,
          track: 'vox',
          velocity: vel(0.7),
        });
      }
      // The guitar answers the voice, like a sample traded between bars.
      if (isHook && barInSection % 2 === 1) {
        studio.pluck(at(2.75 + jitter(0.008)), 0.24, midiToFreq(dyad[0]), {
          gain: 0.028,
          pan: -0.22,
          track: 'guitar',
          midi: dyad[0],
          velocity: vel(0.6),
        });
      }
    }

    // -- Doo-wop bed and sung hook -------------------------------------------
    if (layers.includes('vox') && isChordChange) {
      const bed = voiceLead(prevStrings, chord.slice(0, 3), { min: 55, max: 72 });
      prevStrings = bed;
      studio.choir(start, Math.min(holdSeconds * 0.95, total - start), bed, {
        gain: 0.052,
        attack: 0.55,
        release: 1.1,
        cutoff: 1600,
        reverb: 0.66,
        track: 'vox',
        velocity: vel(0.55),
      });
    }

    if (layers.includes('vox') && isHook) {
      for (const [offset, length, step] of HOOK_PHRASE) {
        const midi = deg(step);
        studio.choir(at(offset + jitter(0.012)), length * arrangement.beat, [midi], {
          gain: 0.082 * (0.7 + intensity * 0.4),
          attack: 0.16,
          release: 0.7,
          cutoff: 2400,
          reverb: 0.64,
          track: 'vox',
          velocity: vel(0.8),
        });
      }
    }

    // -- Strings -------------------------------------------------------------
    if (layers.includes('strings') && isChordChange) {
      const swell = chord.map((n) => n + 12);
      studio.strings(start, Math.min(holdSeconds + 0.5, total - start), swell, {
        gain: 0.036,
        attack: 0.8,
        release: 1.4,
        cutoff: 2100,
        reverb: 0.62,
        track: 'strings',
        velocity: vel(0.5),
      });
    }
  });

  studio.finish({
    targetLufs: -14,
    fadeIn: 0.02,
    fadeOut: Math.min(5, total * 0.06),
    reverbRoom: 0.86,
    reverbDamp: 0.52,
    delayTimeL: (60 / BPM) * 0.5,
    delayTimeR: (60 / BPM) * 0.75,
    delayFeedback: 0.3,
    delayWet: 0.26,
  });
  return studio;
}

export const meta = {
  slug: 'bound-soul',
  name: 'Bound Soul',
  bpm: BPM,
  key: 'B-flat major',
  bars: NATURAL_BARS,
  beatsPerBar: BEATS_PER_BAR,
  description: 'Chopped soul: Rhodes comp, doo-wop vocal loop, round bass and laid-back boom-bap.',
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
