/**
 * dark-fantasy.js — orchestral preset.
 *
 * "Dark Fantasy Suite" is an original piece of cinematic orchestral soul:
 * grand piano, legato strings, brass fanfares, wordless choir, timpani and
 * half-time drums, built on chromatic-mediant harmony in F minor.
 *
 * It is inspired by the *production palette* of maximalist, opulent orchestral
 * hip-hop records — the aesthetic of weight, drama and sudden dynamic contrast.
 * It contains no samples, no quotations and no material from any existing
 * recording or composition: every note below is generated from the seed.
 */

import { Studio } from '../synth.js';
import { Arrangement, describeForm } from '../arrangement.js';
import { SCALES, parseDegree, voiceLead, noteToMidi } from '../theory.js';
import { mulberry32 } from '../dsp.js';

const BPM = 72;
const BEATS_PER_BAR = 4;
const KEY = noteToMidi('F3'); // 53
const SCALE = 'naturalMinor';
const STEPS = SCALES[SCALE];

/** Natural length of the form, in bars. */
const NATURAL_BARS = 80;

/**
 * Scale-degree helper: `deg(0)` is the tonic, `deg(7)` the tonic an octave up,
 * and negative indices walk downwards.
 * @param {number} index
 * @returns {number} MIDI note
 */
function deg(index) {
  const n = STEPS.length;
  const octave = Math.floor(index / n);
  const step = ((index % n) + n) % n;
  return KEY + STEPS[step] + 12 * octave;
}

/**
 * The main theme: an original sighing, descending figure in F minor.
 * Degrees are scale steps, not semitones, so it stays diatonic.
 */
const THEME = [9, 7, 8, 6, 4, 5, 3, 4, 2, 0, 2, 4, 3, 1, 0, -1];
/** A rising answer phrase for the horn. */
const ANSWER = [0, 2, 4, 5, 7, 4, 2, 0];

/**
 * Song form. `intensity` drives orchestration density, so a short render still
 * gets a real dramatic arc rather than a truncated loop.
 * @type {import('../arrangement.js').Section[]}
 */
const SECTIONS = [
  { name: 'overture', bars: 8, intensity: 0.12, progression: ['i', 'VI'], layers: ['piano', 'strings'] },
  { name: 'ascension', bars: 8, intensity: 0.34, progression: ['i', 'VI', 'III', 'VII'], layers: ['piano', 'strings', 'harp', 'timpani'] },
  { name: 'fanfare', bars: 16, intensity: 0.88, progression: ['VI', 'VII', 'i', 'i'], layers: ['brass', 'strings', 'choir', 'timpani', 'percussion'] },
  { name: 'procession', bars: 16, intensity: 0.62, progression: ['i', 'VII', 'VI', 'VII'], layers: ['piano', 'strings', 'cello', 'choir', 'horn', 'drums'] },
  { name: 'interlude', bars: 8, intensity: 0.2, progression: ['iv', 'i', 'VI', 'V'], layers: ['harp', 'choir', 'piano'] },
  { name: 'climax', bars: 16, intensity: 1, progression: ['VI', 'VII', 'i', 'iv'], layers: ['piano', 'strings', 'cello', 'choir', 'brass', 'timpani', 'drums', 'sub', 'percussion'] },
  { name: 'coda', bars: 8, intensity: 0.24, progression: ['i', 'VI'], layers: ['piano', 'strings'] },
];

/** GM programs per score track, so the MIDI export opens on sane instruments. */
const TRACKS = [
  { name: 'piano', program: 0 },
  { name: 'harp', program: 46 },
  { name: 'strings', program: 48 },
  { name: 'cello', program: 42 },
  { name: 'choir', program: 52 },
  { name: 'brass', program: 61 },
  { name: 'horn', program: 60 },
  { name: 'timpani', program: 47 },
  { name: 'sub', program: 38 },
  { name: 'percussion', program: 0, drum: true },
];

/** Two bars per chord. */
const BARS_PER_CHORD = 2;

/**
 * @param {string} symbol @returns {number[]}
 */
function chordFor(symbol) {
  return parseDegree(symbol, KEY, SCALE).notes;
}

/**
 * Renders the suite.
 * @param {{ seconds?: number, seed?: number, sampleRate?: number, stems?: boolean, score?: import('../midi.js').Score | null }} [opts]
 * @returns {Studio}
 */
export function render({ seconds = undefined, seed = 7, sampleRate = 44100, stems = false, score = null } = {}) {
  const arrangement = new Arrangement({ bpm: BPM, beatsPerBar: BEATS_PER_BAR, sections: SECTIONS });
  if (seconds != null) arrangement.fit(seconds);
  const total = arrangement.seconds;

  const studio = new Studio({ sampleRate, seconds: total, seed, stems, score });
  const rng = mulberry32(seed);
  const jitter = () => (rng() * 2 - 1) * 0.014;
  const vel = (base) => Math.max(0.08, Math.min(1, base * (0.85 + rng() * 0.3)));
  const chance = (p) => rng() < p;

  let prevStrings = null;
  let prevChoir = null;
  let prevBrass = null;
  let prevPianoSparse = null;
  let prevPianoOstinato = null;
  let lastChordKey = null;

  studio.vinyl(0, total, 0.0032);

  arrangement.forEachBar((ctx) => {
    const { bar, start, section, barInSection, barsInSection, sectionProgress, intensity, at } = ctx;
    const symbol = section.progression[Math.floor(bar / BARS_PER_CHORD) % section.progression.length];
    const chord = chordFor(symbol);
    const chordKey = `${symbol}:${Math.floor(bar / BARS_PER_CHORD)}`;
    const isChordChange = chordKey !== lastChordKey;
    lastChordKey = chordKey;
    const isSectionStart = barInSection === 0;
    const isSectionEnd = barInSection === barsInSection - 1;
    const chordBars = Math.min(BARS_PER_CHORD, barsInSection - barInSection);

    // -- Transitions ---------------------------------------------------------
    if (isSectionStart && intensity >= 0.55) {
      studio.tamTam(start, { gain: 0.11 * intensity, reverb: 0.6, track: 'percussion' });
      studio.crash(start, { gain: 0.06, pan: -0.2, reverb: 0.45 });
    }
    if (isSectionStart && intensity >= 0.8) {
      studio.impact(start, { gain: 0.26, reverb: 0.55, track: 'percussion' });
    }
    const isFinalSection = section.name === 'coda';
    if (isSectionEnd && !isFinalSection && barsInSection >= 4 && intensity < 0.9) {
      // Two-bar build that lands exactly on the next section's downbeat.
      studio.riser(start - arrangement.bar, arrangement.bar * 2, { gain: 0.03 + intensity * 0.02, track: 'fx' });
    }

    // -- Piano ---------------------------------------------------------------
    if (section.layers.includes('piano')) {
      const figure = intensity > 0.5 ? 'ostinato' : 'sparse';
      if (figure === 'sparse') {
        const voice = voiceLead(prevPianoSparse, chord.map((n) => n + 24), { min: 55, max: 86 });
        prevPianoSparse = voice;
        studio.piano(start + jitter(), arrangement.bar * 0.9, voice[0], { gain: 0.13 * (0.5 + intensity), track: 'piano', velocity: vel(0.55), reverb: 0.42 });
        if (chance(0.7)) {
          const upper = voice.slice(1);
          upper.forEach((n, i) => {
            studio.piano(at(2 + i * 0.5), arrangement.bar * 0.5, n, { gain: 0.075 * (0.5 + intensity), track: 'piano', velocity: vel(0.4), reverb: 0.45 });
          });
        }
      } else {
        const voicing = voiceLead(prevPianoOstinato, chord.map((n) => n + 24), { min: 55, max: 86 });
        prevPianoOstinato = voicing;
        const steps = 8;
        for (let s = 0; s < steps; s += 1) {
          const idx = (s + bar) % voicing.length;
          const lift = s % 4 === 2 ? 12 : 0;
          const swing = s % 2 === 1 ? 0.02 : 0;
          studio.piano(at(s * 0.5 + swing), arrangement.beat * 0.75, voicing[idx] + lift, {
            gain: 0.062 * (0.6 + intensity),
            pan: (s % 2 ? 0.18 : -0.18),
            track: 'piano',
            velocity: vel(s % 2 ? 0.5 : 0.68),
            reverb: 0.38,
          });
        }
      }
    }

    // -- Strings -------------------------------------------------------------
    if (section.layers.includes('strings')) {
      const base = chord.map((n) => n + 12);
      const voicing = voiceLead(prevStrings, base, { min: 50, max: 84 });
      prevStrings = voicing;
      if (isChordChange || barInSection === 0) {
        const hold = chordBars * arrangement.bar;
        studio.strings(start + jitter(), hold * 0.94, voicing, {
          gain: 0.05 * (0.4 + intensity * 0.9),
          attack: intensity > 0.7 ? 0.5 : 1.1,
          release: 1.6,
          cutoff: 2100 + intensity * 1400,
          reverb: 0.55,
          track: 'strings',
          velocity: vel(0.65),
        });
        if (intensity > 0.75) {
          studio.strings(start + jitter(), hold * 0.94, voicing.map((n) => n + 12), {
            gain: 0.022,
            attack: 1.4,
            release: 1.8,
            cutoff: 3400,
            vibrato: 0.09,
            reverb: 0.6,
            track: 'strings',
            velocity: vel(0.5),
          });
        }
      }
    }

    // -- Cello ---------------------------------------------------------------
    if (section.layers.includes('cello') && isChordChange) {
      const root = chord[0] - 12;
      studio.cello(start + jitter(), chordBars * arrangement.bar * 0.9, root, {
        gain: 0.07 * (0.5 + intensity),
        track: 'cello',
        velocity: vel(0.6),
        reverb: 0.42,
      });
      if (chance(0.5)) {
        studio.cello(at(2), arrangement.beat * 1.6, root + 7, {
          gain: 0.045 * (0.5 + intensity),
          track: 'cello',
          velocity: vel(0.5),
          reverb: 0.42,
        });
      }
    }

    // -- Choir ---------------------------------------------------------------
    if (section.layers.includes('choir') && isChordChange) {
      const voicing = voiceLead(prevChoir, chord.map((n) => n + 12), { min: 55, max: 79 });
      prevChoir = voicing;
      studio.choir(start + jitter(), chordBars * arrangement.bar * 0.9, voicing, {
        gain: 0.05 * (0.4 + intensity),
        attack: intensity > 0.7 ? 0.7 : 1.3,
        track: 'choir',
        velocity: vel(0.55),
        reverb: 0.65,
      });
    }

    // -- Brass ---------------------------------------------------------------
    if (section.layers.includes('brass')) {
      const voicing = voiceLead(prevBrass, chord.map((n) => n + 12), { min: 52, max: 84 });
      prevBrass = voicing;
      const rhythm = [
        [0, 0.75],
        [1.5, 0.5],
        [2.5, 0.4],
        [3, 0.9],
      ];
      const dense = intensity > 0.85 || barInSection % 4 === 3;
      for (const [beat, length] of rhythm) {
        if (!dense && beat !== 0 && beat !== 3) continue;
        studio.brass(at(beat + jitter() * 0.4), length * arrangement.beat, voicing, {
          gain: 0.055 * intensity,
          attack: 0.045,
          track: 'brass',
          velocity: vel(beat === 0 ? 0.85 : 0.6),
          reverb: 0.38,
        });
      }
      if (barInSection % 8 === 7) {
        const top = voicing[voicing.length - 1] + 12;
        studio.brass(at(3.5), arrangement.beat * 1.4, top, {
          gain: 0.05 * intensity,
          track: 'brass',
          velocity: vel(0.8),
          reverb: 0.42,
        });
      }
    }

    // -- Horn counter-melody -------------------------------------------------
    if (section.layers.includes('horn')) {
      const phrase = ANSWER[(barInSection + bar) % ANSWER.length];
      const note = deg(phrase + 7);
      studio.horn(start + jitter(), arrangement.beat * 2.2, note, {
        gain: 0.055,
        pan: 0.18,
        track: 'horn',
        velocity: vel(0.6),
        reverb: 0.5,
      });
      if (barInSection % 4 === 2) {
        studio.horn(at(2), arrangement.beat * 1.8, note - 2, {
          gain: 0.045,
          pan: 0.22,
          track: 'horn',
          velocity: vel(0.5),
          reverb: 0.5,
        });
      }
    }

    // -- Theme (strings high, or horn in the interlude) ----------------------
    if (intensity > 0.28 && section.layers.includes('strings')) {
      const themeIndex = (barInSection * 2 + (bar % 2)) % THEME.length;
      const note = deg(THEME[themeIndex] + 12);
      if (chance(0.85)) {
        studio.strings(start + jitter(), arrangement.beat * 1.8, [note], {
          gain: 0.03 * (0.5 + intensity),
          attack: 0.25,
          release: 0.9,
          cutoff: 3200,
          vibrato: 0.1,
          reverb: 0.55,
          track: 'strings',
          velocity: vel(0.6),
        });
        if (chance(0.4)) {
          studio.strings(at(2) + jitter(), arrangement.beat * 1.4, [note - 2], {
            gain: 0.024 * (0.5 + intensity),
            attack: 0.3,
            release: 0.9,
            cutoff: 3000,
            vibrato: 0.1,
            reverb: 0.55,
            track: 'strings',
            velocity: vel(0.5),
          });
        }
      }
    }

    // -- Harp ----------------------------------------------------------------
    if (section.layers.includes('harp')) {
      if (isSectionStart || (isChordChange && chance(0.35))) {
        const descending = chance(0.5);
        const notes = chord.map((n) => n + 24);
        const run = [...notes, ...notes.map((n) => n + 4)].slice(0, 6);
        const ordered = descending ? run.slice().reverse() : run;
        ordered.forEach((n, i) => {
          studio.harp(at(i * 0.25), arrangement.beat * 1.1, n, {
            gain: 0.045,
            pan: (i / Math.max(1, ordered.length - 1) - 0.5) * 0.8,
            track: 'harp',
            velocity: vel(0.55),
          });
        });
      }
    }

    // -- Timpani -------------------------------------------------------------
    if (section.layers.includes('timpani')) {
      if (isChordChange) {
        studio.timpani(start + jitter() * 0.3, { gain: 0.34 * (0.5 + intensity), midi: chord[0] - 12, track: 'timpani' });
      }
      if (intensity > 0.5 && barInSection % 2 === 1) {
        studio.timpani(at(3.5), { gain: 0.24 * intensity, midi: chord[0] - 12, track: 'timpani' });
        studio.timpani(at(3.75), { gain: 0.2 * intensity, midi: chord[0] - 12, track: 'timpani' });
      }
      if (isSectionEnd && intensity > 0.5) {
        // Roll into the next section.
        const rollBeats = 4;
        const hits = 16;
        for (let h = 0; h < hits; h += 1) {
          const p = h / hits;
          studio.timpani(at(rollBeats * p), { gain: 0.1 + 0.3 * p ** 2, midi: chord[0] - 12, track: 'timpani', pan: -0.1 });
        }
      }
    }

    // -- Half-time drums -----------------------------------------------------
    if (section.layers.includes('drums')) {
      studio.bassDrum(start, { gain: 0.5 * (0.5 + intensity), track: 'percussion', reverb: 0.22 });
      studio.bassDrum(at(2.5), { gain: 0.32 * (0.5 + intensity), track: 'percussion', reverb: 0.22 });
      studio.snare(at(2), { gain: 0.3 * (0.5 + intensity), track: 'percussion', reverb: 0.3, pan: 0 });
      if (intensity > 0.8) {
        studio.clap(at(2), { gain: 0.16, track: 'percussion', reverb: 0.3 });
      }
      for (let eighth = 0; eighth < 8; eighth += 1) {
        studio.hat(at(eighth * 0.5), {
          gain: eighth % 2 === 0 ? 0.03 : 0.018,
          open: eighth === 6 && chance(0.4),
          pan: 0.32,
          track: 'percussion',
        });
      }
      if (barInSection % 4 === 3) {
        for (let s = 0; s < 4; s += 1) {
          studio.snare(at(3 + s * 0.25), { gain: 0.1 + s * 0.045, pan: 0.1, track: 'percussion', reverb: 0.3 });
        }
      }
    }

    // -- Sub bass ------------------------------------------------------------
    if (section.layers.includes('sub') && isChordChange) {
      studio.subBass(start, chordBars * arrangement.bar * 0.95, chord[0] - 24, { gain: 0.2, track: 'sub' });
    }

    // -- Percussion accents --------------------------------------------------
    if (section.layers.includes('percussion') && chance(0.25)) {
      studio.crash(at(chance(0.5) ? 0 : 2), { gain: 0.04 * intensity, pan: chance(0.5) ? 0.3 : -0.3, reverb: 0.5, track: 'percussion' });
    }
  });

  const lastSection = arrangement.layout()[arrangement.layout().length - 1];
  if (lastSection && lastSection.name === 'coda') {
    studio.crash(total - 0.5, { gain: 0.03, reverb: 0.5, track: 'percussion' });
  }

  studio.finish({
    targetLufs: -14,
    fadeIn: 0.05,
    fadeOut: Math.min(6, total * 0.08),
    reverbRoom: 0.9,
    reverbDamp: 0.26,
    reverbWidth: 1,
    delayTimeL: (60 / BPM) * 0.75,
    delayTimeR: (60 / BPM) * 1.5,
    delayFeedback: 0.32,
    delayWet: 0.42,
  });
  return studio;
}

export const meta = {
  slug: 'dark-fantasy',
  name: 'Dark Fantasy Suite',
  bpm: BPM,
  key: 'F minor',
  bars: NATURAL_BARS,
  beatsPerBar: BEATS_PER_BAR,
  description: 'Cinematic orchestral soul: grand piano, legato strings, brass fanfares, wordless choir and timpani.',
  tracks: TRACKS,
  /** @returns {number} natural length in seconds */
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
