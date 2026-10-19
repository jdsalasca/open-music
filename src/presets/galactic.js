/**
 * galactic.js — space-disco preset.
 *
 * "Orbital Suite" is original space-disco in D dorian: warm analog pads,
 * syncopated bass, glass arpeggios and a wordless lead.
 *
 * It is an original atmosphere inspired by the palette of late-70s/early-80s
 * cosmic disco and the record it evokes. It contains no samples, no quotations
 * and no material from any existing recording or composition.
 */

import { Studio } from '../synth.js';
import { Arrangement, describeForm } from '../arrangement.js';
import { SCALES, parseDegree, voiceLead, noteToMidi, midiToFreq } from '../theory.js';
import { mulberry32 } from '../dsp.js';

const BPM = 108;
const BEATS_PER_BAR = 4;
const KEY = noteToMidi('D3'); // 50
const SCALE = 'dorian';
const STEPS = SCALES[SCALE];
const NATURAL_BARS = 72;

/** Chord cycle: two bars each, so the progression is eight bars long. */
const PROGRESSION = ['i9', 'bVImaj7', 'iv7', 'Vsus4'];
const BARS_PER_CHORD = 2;

/** @type {import('../arrangement.js').Section[]} */
const SECTIONS = [
  { name: 'intro', bars: 8, intensity: 0.18, layers: ['pad', 'vinyl', 'sweep'] },
  { name: 'groove', bars: 24, intensity: 0.55, layers: ['pad', 'drums', 'bass', 'arp', 'vinyl'] },
  { name: 'break', bars: 16, intensity: 0.42, layers: ['pad', 'strings', 'bass', 'arp', 'lead', 'vinyl'] },
  { name: 'drop', bars: 16, intensity: 0.92, layers: ['pad', 'strings', 'drums', 'bass', 'arp', 'lead', 'clap'] },
  { name: 'outro', bars: 8, intensity: 0.2, layers: ['pad', 'bass', 'vinyl'] },
];

const TRACKS = [
  { name: 'bass', program: 38 },
  { name: 'pads', program: 89 },
  { name: 'strings', program: 48 },
  { name: 'arp', program: 11 },
  { name: 'lead', program: 81 },
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

/** Theme: an original rising-then-falling figure in D dorian. */
const MOTIF = [7, 9, 11, 9, 7, 4, 7, 9, 11, 14, 12, 11, 9, 7, 4, 2];

/** Sixteenth-note bass figure: [beat offset, length in beats, semitone offset]. */
const BASS_PATTERN = [
  [0, 0.4, 0],
  [0.75, 0.22, 0],
  [1.5, 0.32, 12],
  [2.25, 0.2, 0],
  [2.75, 0.38, 7],
  [3.5, 0.18, 12],
];
const BASS_BREAK = [
  [0, 0.5, 0],
  [2.5, 0.35, 0],
];

/**
 * @param {string} symbol @returns {number[]}
 */
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

  const studio = new Studio({ sampleRate, seconds: total, seed, stems, score });
  const rng = mulberry32(seed);
  const jitter = (amount = 0.012) => (rng() * 2 - 1) * amount;
  const vel = (base) => Math.max(0.08, Math.min(1, base * (0.84 + rng() * 0.32)));
  const chance = (p) => rng() < p;

  let prevPad = null;
  let prevStrings = null;

  studio.vinyl(0, total, 0.0035);
  studio.sweep(0, 9, 0.028);
  if (total > 12) studio.sweep(total - 8, 8, 0.022);

  arrangement.forEachBar((ctx) => {
    const { bar, start, section, barInSection, barsInSection, intensity, at } = ctx;
    const layers = section.layers;
    const symbol = PROGRESSION[Math.floor(bar / BARS_PER_CHORD) % PROGRESSION.length];
    const chord = chordFor(symbol);
    const isChordChange = bar % BARS_PER_CHORD === 0;
    const isIntro = section.name === 'intro';
    const isBreak = section.name === 'break';
    const isDrop = section.name === 'drop';
    const isOutro = section.name === 'outro';
    const isSectionStart = barInSection === 0;
    const holdBars = Math.min(BARS_PER_CHORD, barsInSection - barInSection);
    const holdSeconds = holdBars * arrangement.bar;

    // -- Pads ----------------------------------------------------------------
    if (layers.includes('pad') && isChordChange) {
      const voicing = voiceLead(prevPad, chord, { min: 50, max: 74 });
      prevPad = voicing;
      studio.pad(start, Math.min(holdSeconds + 0.4, total - start), voicing.map((n) => midiToFreq(n)), {
        gain: isIntro ? 0.05 : 0.04,
        reverb: 0.5,
        delay: 0.1,
        bus: 'pads',
        track: 'pads',
        midis: voicing,
      });
      if (!isIntro) {
        const color = chord.slice(1, 3).map((n) => n + 12);
        studio.pad(start, Math.min(holdSeconds + 0.2, total - start), color.map((n) => midiToFreq(n)), {
          gain: 0.014,
          reverb: 0.55,
          delay: 0.12,
          bus: 'pads',
        });
      }
    }

    // -- Strings -------------------------------------------------------------
    if (layers.includes('strings') && isChordChange) {
      const voicing = voiceLead(prevStrings, chord.map((n) => n + 12), { min: 55, max: 79 });
      prevStrings = voicing;
      studio.strings(start, holdSeconds * 0.98, voicing, {
        gain: isDrop ? 0.042 : 0.03,
        attack: isDrop ? 0.4 : 0.7,
        release: 1.2,
        cutoff: 2400,
        reverb: 0.5,
        bus: 'strings',
        track: 'strings',
        velocity: vel(0.6),
      });
    }

    // -- Drums ---------------------------------------------------------------
    if (layers.includes('drums')) {
      const fourOnFloor = isDrop;
      for (let beat = 0; beat < 4; beat += 1) {
        if (beat % 2 === 0 || fourOnFloor) {
          studio.kick(at(beat + jitter(0.004)), {
            gain: beat === 0 ? 0.62 : 0.46,
            bus: 'drums',
            track: 'drums',
          });
        }
      }
      if (!isIntro) {
        studio.kick(at(2.75 + jitter(0.004)), { gain: 0.26, bus: 'drums', track: 'drums' });
      }
      studio.snare(at(1 + jitter(0.006)), { gain: 0.24, pan: -0.08, bus: 'drums', track: 'drums', velocity: vel(0.7) });
      studio.snare(at(3 + jitter(0.006)), { gain: 0.24, pan: 0.08, bus: 'drums', track: 'drums', velocity: vel(0.7) });
      for (let eighth = 0; eighth < 8; eighth += 1) {
        studio.hat(at(eighth * 0.5 + jitter(0.005)), {
          gain: (eighth % 2 === 0 ? 0.03 : 0.018) * (0.85 + rng() * 0.3),
          open: eighth === 7 && chance(0.3),
          pan: eighth % 2 === 0 ? 0.28 : 0.36,
          bus: 'drums',
          track: 'drums',
        });
      }
      if (layers.includes('clap') && (barInSection % 4 === 0 || barInSection % 4 === 2)) {
        studio.clap(at(1), { gain: 0.12, bus: 'drums', track: 'drums' });
      }
      if (isDrop && barInSection % 4 === 3) {
        for (let s = 0; s < 4; s += 1) {
          studio.snare(at(3 + s * 0.25 + jitter(0.004)), { gain: 0.09 + s * 0.04, pan: 0.12, bus: 'drums', track: 'drums' });
        }
      }
    }

    if (isSectionStart && (isBreak || isDrop)) {
      studio.crash(start, { gain: 0.07, bus: 'drums', track: 'drums' });
    }

    // -- Bass ----------------------------------------------------------------
    if (layers.includes('bass')) {
      const pattern = isBreak ? BASS_BREAK : BASS_PATTERN;
      for (const [offset, length, octave] of pattern) {
        studio.bass(
          at(offset + jitter(0.008)),
          length * arrangement.beat,
          midiToFreq(chord[0] + octave),
          {
            gain: (isBreak ? 0.13 : 0.17) * (0.4 + intensity),
            bus: 'bass',
            track: 'bass',
            midi: chord[0] + octave,
          },
        );
      }
    }

    // -- Arpeggio ------------------------------------------------------------
    if (layers.includes('arp')) {
      const tones = [...chord, ...chord.map((n) => n + 12)];
      const steps = isBreak ? 8 : 16;
      const rotate = chance(0.5) ? bar : 0;
      for (let step = 0; step < steps; step += 1) {
        const idx = (step + rotate) % tones.length;
        const lift = step % 8 >= 6 ? 12 : 0;
        studio.pluck(
          at((step * 4) / steps + jitter(0.006)),
          isBreak ? 0.22 : 0.13,
          midiToFreq(tones[idx] + lift),
          {
            gain: (isBreak ? 0.026 : 0.038) * (0.6 + intensity),
            pan: step % 2 ? 0.28 : -0.28,
            bus: 'arp',
            track: 'arp',
            midi: tones[idx] + lift,
            velocity: vel(step % 4 === 0 ? 0.8 : 0.55),
          },
        );
      }
    }

    // -- Lead ----------------------------------------------------------------
    if (layers.includes('lead')) {
      const density = isBreak ? 4 : 2;
      for (let step = 0; step < 16; step += density) {
        const note = deg(MOTIF[(step + bar * 2) % MOTIF.length]);
        const octave = isDrop && step > 10 ? 12 : 0;
        studio.lead(
          at(step * 0.25 + jitter(0.01)),
          arrangement.beat * (isBreak ? 0.9 : 0.55),
          midiToFreq(note + octave),
          {
            gain: (isBreak ? 0.075 : 0.058) * (0.6 + intensity),
            bus: 'lead',
            track: 'lead',
            midi: note + octave,
            velocity: vel(0.75),
          },
        );
      }
      if (isBreak && barInSection % 4 === 0) {
        const pedal = deg([4, 7, 9, 11][bar % 4]);
        studio.lead(start, arrangement.beat * 6, midiToFreq(pedal), {
          gain: 0.045,
          bus: 'lead',
          track: 'lead',
          midi: pedal,
          velocity: vel(0.6),
        });
      }
    }

    // -- Outro ---------------------------------------------------------------
    if (isOutro) {
      studio.bass(start, arrangement.bar, midiToFreq(chord[0]), {
        gain: 0.1,
        bus: 'bass',
        track: 'bass',
        midi: chord[0],
      });
      if (barInSection % 4 === 0) studio.crash(start, { gain: 0.035, bus: 'drums', track: 'drums' });
    }
  });

  studio.finish({
    targetLufs: -14,
    fadeIn: 0.03,
    fadeOut: Math.min(4, total * 0.06),
    reverbRoom: 0.8,
    reverbDamp: 0.34,
    delayTimeL: (60 / BPM) * 0.75,
    delayTimeR: (60 / BPM) * 1.5,
    delayFeedback: 0.4,
    delayWet: 0.45,
  });
  return studio;
}

export const meta = {
  slug: 'galactic',
  name: 'Orbital Suite',
  bpm: BPM,
  key: 'D minor / dorian',
  bars: NATURAL_BARS,
  beatsPerBar: BEATS_PER_BAR,
  description: 'Slow cosmic disco: warm analog pads, syncopated bass, glass arpeggios and a wordless lead.',
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
