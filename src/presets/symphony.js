/**
 * symphony.js — Symphony in C minor.
 *
 * A single symphonic movement in sonata form, in the Viennese Classical
 * language: a slow grave introduction, an allegro exposition with a first theme
 * in C minor and a lyrical second theme in the relative major, a development
 * that fragments and sequences the opening motif, a recapitulation that brings
 * the second theme home to the tonic, and a coda closing on a Picardy third.
 *
 * Everything is original: the thematic material below is a deliberately simple
 * motivic cell developed by transposition, inversion and sequence — the
 * technique of the period — not a quotation of any existing work. Like the rest
 * of the package it contains no samples and no material from any recording.
 *
 * The orchestra is five string sections, double woodwind, three brass, timpani,
 * and it is synthesised from scratch: saw stacks through resonant filters for
 * the strings, additive harmonic series for the winds, filter-swept unison saws
 * for the brass. No soundfonts.
 */

import { Studio } from '../synth.js';
import { Arrangement, describeForm } from '../arrangement.js';
import { parseDegree, noteToMidi, midiToNote } from '../theory.js';
import { mulberry32 } from '../dsp.js';

const BPM = 132;
const GRAVE_BPM = 60;
const BEATS_PER_BAR = 4;
const KEY = noteToMidi('C3'); // 48
const MINOR = 'harmonicMinor';
const MAJOR = 'major';

/** Natural length of each section, in bars. */
const SECTIONS = [
  { name: 'grave', bars: 16, bpm: GRAVE_BPM, intensity: 0.5 },
  { name: 'exposition', bars: 48, intensity: 0.8 },
  { name: 'development', bars: 40, intensity: 0.9 },
  { name: 'recapitulation', bars: 48, intensity: 0.85 },
  { name: 'coda', bars: 24, intensity: 1 },
];

/** GM programs, so the exported score opens on the right instruments. */
const TRACKS = [
  { name: 'vln1', program: 40 },
  { name: 'vln2', program: 40 },
  { name: 'vla', program: 41 },
  { name: 'vc', program: 42 },
  { name: 'cb', program: 43 },
  { name: 'fl', program: 73 },
  { name: 'ob', program: 68 },
  { name: 'cl', program: 71 },
  { name: 'bsn', program: 70 },
  { name: 'hn', program: 60 },
  { name: 'tpt', program: 56 },
  { name: 'tbn', program: 57 },
  { name: 'tba', program: 58 },
  { name: 'timp', program: 47 },
];

/** Dynamic markings, as multipliers on each voice's baseline gain. */
const DYN = { pp: 0.3, p: 0.46, mp: 0.62, mf: 0.78, f: 0.92, ff: 1 };

/**
 * A scale degree in an arbitrary key and scale, where 0 is the tonic and 7 is
 * the tonic an octave above.
 * @param {number} root @param {string} scaleName @param {number} index
 * @returns {number} MIDI note
 */
function degree(root, scaleName, index) {
  const steps = /** @type {Record<string, number[]>} */ (/** @type {unknown} */ (STEPS_CACHE))[scaleName];
  const n = steps.length;
  const octave = Math.floor(index / n);
  const step = ((index % n) + n) % n;
  return root + steps[step] + 12 * octave;
}

/** @type {Record<string, number[]>} */
const STEPS_CACHE = {
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  naturalMinor: [0, 2, 3, 5, 7, 8, 10],
  major: [0, 2, 4, 5, 7, 9, 11],
};

/** @param {number[]} pcs @param {number} low @param {number} high @returns {number[]} */
function tonesBetween(pcs, low, high) {
  const out = [];
  for (let m = low; m <= high; m += 1) {
    if (pcs.includes(((m % 12) + 12) % 12)) out.push(m);
  }
  return out;
}

/** @param {number[]} notes @returns {number[]} sorted pitch classes */
function pcsOf(notes) {
  return [...new Set(notes.map((n) => ((n % 12) + 12) % 12))].sort((a, b) => a - b);
}

/**
 * The opening motif: a rising C-minor arpeggio through the leading tone and
 * back down. Degrees are scale steps; the rhythm is long-short-short-long.
 * @type {Array<[number, number]>}
 */
const MOTIF = [
  [0, 1],
  [2, 0.5],
  [4, 0.5],
  [6, 1],
  [4, 0.5],
  [2, 0.5],
];

/** The answering tail of the first theme. */
const MOTIF_TAIL = [
  [4, 1],
  [2, 0.5],
  [1, 0.5],
  [0, 2],
];

/**
 * The second theme: stepwise, longer note values, in the relative major.
 * @type {Array<[number, number]>}
 */
const SECOND_THEME = [
  [4, 1.5],
  [5, 0.5],
  [4, 1],
  [2, 1],
  [0, 1.5],
  [2, 0.5],
  [4, 1],
  [3, 1],
];

/** The horn call that opens the grave. */
const HORN_CALL = [
  [0, 1],
  [4, 1],
  [2, 2],
];

/**
 * Renders the symphony.
 * @param {{ seconds?: number, seed?: number, sampleRate?: number, stems?: boolean, score?: import('../midi.js').Score | null }} [opts]
 * @returns {Studio}
 */
export function render({ seconds = undefined, seed = 7, sampleRate = 44100, stems = false, score = null } = {}) {
  const arrangement = new Arrangement({ bpm: BPM, beatsPerBar: BEATS_PER_BAR, sections: SECTIONS });
  if (seconds != null) arrangement.fit(seconds);
  const total = arrangement.seconds;

  const studio = new Studio({ sampleRate, seconds: total, seed, stems, score });
  const rng = mulberry32(seed);
  const jitter = () => (rng() * 2 - 1) * 0.008;
  const human = (base) => Math.max(0.1, Math.min(1, base * (0.9 + rng() * 0.2)));

  /** Previous voicing per family, so repeated chords move by step instead of jumping. */
  const lastVoicing = new Map();

  /**
   * Plays a melodic line.
   * @param {number} start absolute seconds of the bar
   * @param {number} beat seconds per beat
   * @param {number} fromBeat first beat offset inside the bar
   * @param {Array<[number, number]>} spec degree/beat pairs
   * @param {(start: number, duration: number, midi: number, velocity: number) => void} emit
   */
  function line(start, beat, fromBeat, spec, emit) {
    let cursor = fromBeat;
    for (const [d, len] of spec) {
      emit(start + cursor * beat, len * beat, d, human(0.85 + (len > 1 ? 0.15 : 0)));
      cursor += len;
    }
  }

  /**
   * A string section chord. Cutoffs are high because a real section has energy
   * well past 5 kHz — the filter is there to soften the saw, not to muffle it.
   */
  function strings(start, duration, notes, { track, gain = 0.05, dynamic = 'mf', cutoff = 6000, res = 1.35, attack = 0.06, release = 0.3, pan = 0 } = {}) {
    if (notes.length === 0) return;
    const velocity = DYN[dynamic] ?? 0.7;
    studio.strings(start + jitter(), duration, notes, {
      gain: gain * velocity,
      pan,
      attack,
      release,
      cutoff,
      res,
      reverb: 0.62,
      track,
      velocity,
    });
  }

  /** A woodwind line, one player per part. */
  function wind(start, duration, midi, { instrument, track, dynamic = 'mf', pan = 0 }) {
    const velocity = DYN[dynamic] ?? 0.7;
    const opts = { gain: 0.9, pan, reverb: 0.55, track, velocity };
    studio[instrument](start + jitter(), duration, midi, opts);
  }

  /** A brass chord. */
  function brass(start, duration, notes, { instrument = 'trumpet', track, dynamic = 'f', gain = 1, pan = 0 }) {
    if (notes.length === 0) return;
    const velocity = DYN[dynamic] ?? 0.85;
    notes.forEach((midi, i) => {
      const spread = notes.length === 1 ? 0 : (i / (notes.length - 1) - 0.5) * 0.5;
      studio[instrument](start + jitter(), duration, midi, {
        gain: 0.055 * gain,
        pan: pan + spread,
        reverb: 0.6,
        track,
        velocity,
      });
    });
  }

  /** @param {number} pc @param {number} low @param {number} high @returns {number} */
  function rootIn(pc, low, high) {
    for (let m = low; m <= high; m += 1) if (((m % 12) + 12) % 12 === pc) return m;
    return low;
  }

  /**
   * Voices a chord across the five string sections. The bass always gets the
   * chord's root: an orchestra without the fundamental in the bass sounds like
   * a room full of instruments agreeing about nothing.
   * @param {number[]} notes chord tones in any octave
   */
  function tutti(start, duration, notes, { dynamic = 'f', withBass = true, tremolo = false, gainScale = 1 } = {}) {
    if (notes.length === 0) return;
    const pcs = pcsOf(notes);
    const rootPc = ((notes[0] % 12) + 12) % 12;

    // Spread every chord tone across the range, then hand each section the
    // slice it would actually play.
    const upper = tonesBetween(pcs, 72, 88);
    const mid = tonesBetween(pcs, 65, 79);
    const lower = tonesBetween(pcs, 57, 72);

    const vln1 = upper.length ? upper.slice(-3) : [rootIn(rootPc, 76, 84)];
    const vln2 = mid.length ? mid.slice(0, 3) : [rootIn(rootPc, 69, 79)];
    const vla = lower.length ? lower.slice(0, 3) : [rootIn(rootPc, 60, 67)];
    const velocity = DYN[dynamic] ?? 0.85;

    if (tremolo) {
      studio.tremoloStrings(start, duration, vln1, { gain: 0.05 * gainScale * velocity, cutoff: 5200, reverb: 0.6, track: 'vln1' });
      studio.tremoloStrings(start, duration, vln2, { gain: 0.04 * gainScale * velocity, cutoff: 5200, reverb: 0.6, track: 'vln2' });
    } else {
      strings(start, duration, vln1, { track: 'vln1', gain: 0.045 * gainScale, dynamic, cutoff: 6800 });
      strings(start, duration, vln2, { track: 'vln2', gain: 0.04 * gainScale, dynamic, cutoff: 6200 });
    }
    strings(start, duration, vla, { track: 'vla', gain: 0.038 * gainScale, dynamic, cutoff: 4000 });
    if (withBass) {
      studio.cello(start + jitter(), duration, rootIn(rootPc, 45, 58), {
        gain: 0.072 * gainScale * velocity, reverb: 0.55, track: 'vc', velocity,
      });
      studio.strings(start + jitter(), duration, [rootIn(rootPc, 33, 47)], {
        gain: 0.08 * gainScale * velocity,
        cutoff: 1500,
        attack: 0.05,
        release: 0.28,
        reverb: 0.45,
        track: 'cb',
        velocity,
      });
    }
  }

  arrangement.forEachBar((ctx) => {
    const { start, section, barInSection, barsInSection, beatSeconds, barSeconds } = ctx;
    const p = barsInSection <= 1 ? 0 : barInSection / (barsInSection - 1);
    const beat = beatSeconds;
    const bar = barSeconds;
    const at = (b) => start + b * beat;

    switch (section.name) {
      // ---------------------------------------------------------------------
      // Grave: a slow, ominous introduction on a tonic pedal.
      // ---------------------------------------------------------------------
      case 'grave': {
        const swell = 0.4 + 0.6 * p;
        // Tonic pedal, then the dominant for the last quarter.
        const dominant = p > 0.72;
        const pedal = dominant ? [43, 55] : [36, 48];
        strings(start, bar, pedal, { track: 'vc', gain: 0.055, dynamic: dominant ? 'f' : 'p', cutoff: 1400, attack: 0.2, release: 0.5 });
        studio.strings(start, bar, [pedal[1] + 12], {
          gain: 0.02 * swell,
          cutoff: 2600,
          attack: 0.3,
          release: 0.6,
          reverb: 0.7,
          track: 'vla',
          velocity: 0.5 + 0.4 * swell,
        });

        // Tremolo violins high above, growing.
        if (barInSection % 2 === 0) {
          studio.tremoloStrings(start, bar * 2, [72, 75], {
            gain: 0.016 * swell,
            rate: 9,
            cutoff: 5200,
            reverb: 0.72,
            track: 'vln1',
            velocity: 0.4 + 0.5 * swell,
          });
        }

        // The horn call, twice: piano first, then forte an octave up.
        if (barInSection % 8 === 4) {
          line(start, beat, 0, HORN_CALL, (s, d, deg, v) => {
            studio.horn(s, d, degree(KEY, MINOR, deg + 3), { gain: 0.06, reverb: 0.6, track: 'hn', velocity: v });
          });
          line(start, beat, 2.5, MOTIF_TAIL, (s, d, deg, v) => {
            wind(s, d, degree(KEY, MINOR, deg + 7), { instrument: 'oboe', track: 'ob', dynamic: 'p' });
            void v;
          });
        }

        // Chromatic rise in the cellos across the middle.
        if (p > 0.3 && p < 0.7) {
          const step = Math.round((p - 0.3) * 12);
          studio.cello(start, bar, 48 + step, { gain: 0.03, reverb: 0.5, track: 'vc', velocity: 0.6 });
        }

        // Timpani: a soft roll that grows into the dominant, then a single
        // lonely stroke on the last bar.
        if (p > 0.7 && p < 0.97) {
          studio.timpani(start, { gain: 0.12 + 0.2 * p, midi: dominant ? 43 : 36, reverb: 0.5, track: 'timp' });
        }
        if (barInSection === barsInSection - 1) {
          studio.timpani(start + 3 * beat, { gain: 0.42, midi: 43, reverb: 0.6, track: 'timp' });
        }

        // Full diminished chord at the climax of the introduction.
        if (barInSection % 8 === 6) {
          const dim = parseDegree('vii°7', KEY, MINOR).notes;
          tutti(start, bar, dim, { dynamic: 'f', gainScale: 0.85 });
          brass(start, bar, [degree(KEY, MINOR, 6) + 12], { instrument: 'trombone', track: 'tbn', dynamic: 'mf' });
        }
        break;
      }

      // ---------------------------------------------------------------------
      // Exposition: first theme in C minor, transition, second theme in E flat.
      // ---------------------------------------------------------------------
      case 'exposition': {
        const phase = p < 0.34 ? 'theme1' : p < 0.5 ? 'transition' : p < 0.85 ? 'theme2' : 'codetta';

        if (phase === 'theme1') {
          // Harmony: i - i - V - i, two bars each.
          const symbol = ['i', 'i', 'V', 'i'][Math.floor(barInSection / 2) % 4];
          const chord = parseDegree(symbol, KEY, MINOR).notes;
          const dyn = barInSection < 4 ? 'f' : 'mf';

          // The motif in the violins, answered by the winds.
          if (barInSection % 2 === 0) {
            line(start, beat, 0, MOTIF, (s, d, deg, v) => {
              studio.strings(s, d, [degree(KEY, MINOR, deg) + 12], {
                gain: 0.05, cutoff: 6800, attack: 0.02, release: 0.18, reverb: 0.55, track: 'vln1', velocity: v,
              });
            });
          } else {
            line(start, beat, 0, MOTIF_TAIL, (s, d, deg, v) => {
              studio.strings(s, d, [degree(KEY, MINOR, deg) + 12], {
                gain: 0.042, cutoff: 6200, attack: 0.03, release: 0.2, reverb: 0.55, track: 'vln1', velocity: v,
              });
            });
            line(start, beat, 0, MOTIF_TAIL, (s, d, deg) => {
              wind(s, d, degree(KEY, MINOR, deg + 7), { instrument: 'clarinet', track: 'cl', dynamic: 'mp' });
            });
          }

          // Off-beat string chords, then the driving bass.
          tutti(start, bar, chord, { dynamic: dyn, withBass: false, gainScale: 0.7 });
          const bassNotes = tonesBetween(pcsOf(chord), 36, 55);
          if (bassNotes.length) {
            for (let b = 0; b < BEATS_PER_BAR; b += 1) {
              studio.strings(at(b), beat * 0.8, [bassNotes[0]], {
                gain: 0.05, cutoff: 1500, attack: 0.01, release: 0.12, reverb: 0.35, track: 'cb', velocity: 0.9,
              });
            }
          }
          if (barInSection % 4 === 0) {
            studio.timpani(start, { gain: 0.3, midi: 36, reverb: 0.45, track: 'timp' });
          }
        } else if (phase === 'transition') {
          // Sequence the motif up a fourth (F minor), then a dominant pedal.
          const seq = Math.floor(barInSection / 2) % 2;
          const root = seq === 0 ? KEY + 5 : KEY; // F minor, then back
          const symbol = seq === 0 ? 'i' : 'V';
          const chord = parseDegree(symbol, root, MINOR).notes;
          tutti(start, bar, chord, { dynamic: 'mf', gainScale: 0.75 });
          if (barInSection % 2 === 0) {
            line(start, beat, 0, MOTIF, (s, d, deg, v) => {
              studio.strings(s, d, [degree(root, MINOR, deg) + 12], {
                gain: 0.042, cutoff: 6400, attack: 0.02, release: 0.18, reverb: 0.55, track: 'vln1', velocity: v,
              });
              wind(s, d, degree(root, MINOR, deg + 7), { instrument: 'flute', track: 'fl', dynamic: 'p' });
            });
          }
          brass(start, bar, tonesBetween(pcsOf(chord), 50, 62).slice(0, 2), { instrument: 'trombone', track: 'tbn', dynamic: 'mf' });
        } else if (phase === 'theme2') {
          // Second theme in E flat major: lyrical, winds first.
          const eb = noteToMidi('Eb3'); // 51
          const symbol = ['I', 'IV', 'V', 'I'][Math.floor(barInSection / 4) % 4];
          const chord = parseDegree(symbol, eb, MAJOR).notes;
          tutti(start, bar, chord, { dynamic: 'mp', withBass: true, gainScale: 0.6 });

          const slot = barInSection % 8;
          if (slot < 4) {
            const rest = slot % 4;
            const spec = rest === 0 ? SECOND_THEME.slice(0, 4) : rest === 1 ? SECOND_THEME.slice(4) : rest === 2 ? SECOND_THEME : SECOND_THEME.slice(2, 6);
            line(start, beat, 0, spec, (s, d, deg) => {
              wind(s, d, degree(eb, MAJOR, deg + 7), { instrument: rest < 2 ? 'oboe' : 'flute', track: rest < 2 ? 'ob' : 'fl', dynamic: 'mp' });
            });
          } else {
            line(start, beat, 0, HORN_CALL, (s, d, deg) => {
              studio.horn(s, d, degree(eb, MAJOR, deg + 3), { gain: 0.05, reverb: 0.6, track: 'hn', velocity: 0.7 });
            });
          }
        } else {
          // Codetta: cadential figures, full orchestra.
          const eb = noteToMidi('Eb3');
          const symbol = ['V', 'I', 'V7', 'I'][Math.floor(barInSection / 2) % 4];
          const chord = parseDegree(symbol, eb, MAJOR).notes;
          tutti(start, bar, chord, { dynamic: 'f', gainScale: 0.9 });
          brass(start, bar, tonesBetween(pcsOf(chord), 55, 67).slice(0, 3), { instrument: 'trumpet', track: 'tpt', dynamic: 'f' });
          if (barInSection % 2 === 0) studio.timpani(start, { gain: 0.34, midi: 43, reverb: 0.5, track: 'timp' });
          if (barInSection % 4 === 3) {
            studio.timpaniRoll(start, bar * 0.5, 43, { gain: 0.22, reverb: 0.5, track: 'timp' });
          }
        }
        break;
      }

      // ---------------------------------------------------------------------
      // Development: fragment the motif, sequence it through foreign keys.
      // ---------------------------------------------------------------------
      case 'development': {
        if (p < 0.42) {
          // Sequence through A flat major, F minor and G minor, two bars each,
          // thickening as it goes.
          const roots = [noteToMidi('Ab3'), noteToMidi('F3'), noteToMidi('G3')];
          const root = roots[Math.floor(barInSection / 2) % roots.length];
          const chord = parseDegree('i', root, MINOR).notes;
          const lift = p / 0.42;
          tutti(start, bar, chord, { dynamic: lift > 0.55 ? 'f' : 'mf', gainScale: 0.85 + lift * 0.35 });

          if (barInSection % 2 === 0) {
            line(start, beat, 0, MOTIF.slice(0, 3), (s, d, deg, v) => {
              studio.strings(s, d, [degree(root, MINOR, deg) + 12], {
                gain: 0.042, cutoff: 6800, attack: 0.02, release: 0.16, reverb: 0.55, track: 'vln1', velocity: v,
              });
              wind(s, d, degree(root, MINOR, deg + 7), { instrument: 'bassoon', track: 'bsn', dynamic: 'mf' });
            });
          } else {
            line(start, beat, 1, MOTIF.slice(2, 5), (s, d, deg, v) => {
              studio.strings(s, d, [degree(root, MINOR, deg) + 12], {
                gain: 0.038, cutoff: 6400, attack: 0.02, release: 0.16, reverb: 0.55, track: 'vln2', velocity: v,
              });
              wind(s, d, degree(root, MINOR, deg + 7), { instrument: 'oboe', track: 'ob', dynamic: 'mp' });
            });
          }

          // A sustained wind and horn pad, so the harmony is present even
          // between the motif entries.
          wind(start, bar, degree(root, MINOR, 4) + 7, { instrument: 'clarinet', track: 'cl', dynamic: 'mp' });
          if (barInSection % 2 === 1) {
            studio.horn(start, bar, degree(root, MINOR, 4) + 3, { gain: 0.042, reverb: 0.6, track: 'hn', velocity: 0.65 });
          }
          if (barInSection % 2 === 0) {
            studio.timpani(start, { gain: 0.26, midi: 36, reverb: 0.45, track: 'timp' });
          }
        } else if (p < 0.72) {
          // Stretto: the motif imitated across the sections while the brass
          // joins, so the pressure rises instead of thinning out.
          const grow = Math.min(1, (p - 0.42) / 0.3);
          const symbol = p < 0.58 ? 'iv' : 'V';
          const chord = parseDegree(symbol, KEY, MINOR).notes;
          tutti(start, bar, chord, { dynamic: grow > 0.55 ? 'f' : 'mf', gainScale: 0.8 + grow * 0.4 });

          const entry = barInSection % 3;
          if (entry === 0) line(start, beat, 0, MOTIF.slice(0, 3), (s, d, deg, v) => {
            studio.strings(s, d, [degree(KEY, MINOR, deg) + 12], { gain: 0.042, cutoff: 6800, attack: 0.015, release: 0.14, reverb: 0.55, track: 'vln1', velocity: v });
            wind(s, d, degree(KEY, MINOR, deg + 7), { instrument: 'clarinet', track: 'cl', dynamic: 'mf' });
          });
          if (entry === 1) line(start, beat, 2, MOTIF.slice(0, 3), (s, d, deg, v) => {
            studio.strings(s, d, [degree(KEY, MINOR, deg) + 19], { gain: 0.036, cutoff: 6800, attack: 0.015, release: 0.14, reverb: 0.55, track: 'vln2', velocity: v });
            wind(s, d, degree(KEY, MINOR, deg + 14), { instrument: 'flute', track: 'fl', dynamic: 'mp' });
          });
          if (entry === 2) line(start, beat, 1, MOTIF.slice(2, 5), (s, d, deg, v) => {
            studio.strings(s, d, [degree(KEY, MINOR, deg)], { gain: 0.046, cutoff: 4400, attack: 0.02, release: 0.16, reverb: 0.5, track: 'vla', velocity: v });
            wind(s, d, degree(KEY, MINOR, deg - 7), { instrument: 'bassoon', track: 'bsn', dynamic: 'mf' });
          });

          if (barInSection % 4 >= 2) {
            brass(start, bar, tonesBetween(pcsOf(chord), 55, 67).slice(0, 2), {
              instrument: grow > 0.6 ? 'trumpet' : 'horn',
              track: grow > 0.6 ? 'tpt' : 'hn',
              dynamic: grow > 0.6 ? 'f' : 'mf',
            });
          }
          if (grow > 0.45) {
            brass(start, bar, tonesBetween(pcsOf(chord), 40, 55).slice(0, 2), { instrument: 'trombone', track: 'tbn', dynamic: 'mf' });
          }
          if (barInSection % 2 === 0) {
            studio.timpani(start, { gain: 0.3 + grow * 0.1, midi: 36, reverb: 0.5, track: 'timp' });
          } else if (grow > 0.7) {
            studio.timpaniRoll(start, bar * 0.6, 36, { gain: 0.16, reverb: 0.5, track: 'timp' });
          }
        } else if (p < 0.9) {
          // Climax on a diminished seventh, full orchestra.
          const dim = parseDegree('vii°7', KEY, MINOR).notes;
          tutti(start, bar, dim, { dynamic: 'ff', tremolo: barInSection % 2 === 0, gainScale: 1 });
          brass(start, bar, tonesBetween(pcsOf(dim), 55, 70).slice(0, 3), { instrument: 'trumpet', track: 'tpt', dynamic: 'ff' });
          brass(start, bar, tonesBetween(pcsOf(dim), 43, 58).slice(0, 2), { instrument: 'trombone', track: 'tbn', dynamic: 'ff' });
          brass(start, bar, tonesBetween(pcsOf(dim), 33, 45).slice(0, 1), { instrument: 'tuba', track: 'tba', dynamic: 'ff' });
          if (barInSection % 2 === 0) studio.timpani(start, { gain: 0.4, midi: 36, reverb: 0.5, track: 'timp' });
          else studio.timpaniRoll(start, bar * 0.75, 36, { gain: 0.2, reverb: 0.5, track: 'timp' });
        } else {
          // Hush: dominant preparation, thinning out.
          const chord = parseDegree('V', KEY, MINOR).notes;
          tutti(start, bar, chord, { dynamic: 'pp', withBass: true, gainScale: 0.5 });
          wind(start, bar, degree(KEY, MINOR, 6) + 12, { instrument: 'flute', track: 'fl', dynamic: 'pp' });
          if (barInSection === barsInSection - 1) {
            studio.timpaniRoll(start, bar, 43, { gain: 0.3, crescendo: 0.9, reverb: 0.55, track: 'timp' });
          }
        }
        break;
      }

      // ---------------------------------------------------------------------
      // Recapitulation: the second theme comes home to C minor.
      // ---------------------------------------------------------------------
      case 'recapitulation': {
        const phase = p < 0.34 ? 'theme1' : p < 0.5 ? 'transition' : p < 0.85 ? 'theme2' : 'codetta';

        if (phase === 'theme1') {
          const symbol = ['i', 'i', 'V', 'i'][Math.floor(barInSection / 2) % 4];
          const chord = parseDegree(symbol, KEY, MINOR).notes;
          if (barInSection % 2 === 0) {
            line(start, beat, 0, MOTIF, (s, d, deg, v) => {
              studio.strings(s, d, [degree(KEY, MINOR, deg) + 12], { gain: 0.05, cutoff: 6800, attack: 0.02, release: 0.18, reverb: 0.55, track: 'vln1', velocity: v });
            });
          } else {
            line(start, beat, 0, MOTIF_TAIL, (s, d, deg, v) => {
              studio.strings(s, d, [degree(KEY, MINOR, deg) + 12], { gain: 0.045, cutoff: 6400, attack: 0.03, release: 0.2, reverb: 0.55, track: 'vln1', velocity: v });
            });
            line(start, beat, 0, MOTIF_TAIL, (s, d, deg) => {
              wind(s, d, degree(KEY, MINOR, deg + 7), { instrument: 'clarinet', track: 'cl', dynamic: 'mp' });
            });
          }
          tutti(start, bar, chord, { dynamic: 'f', withBass: false, gainScale: 0.75 });
          const bassNotes = tonesBetween(pcsOf(chord), 36, 55);
          if (bassNotes.length) {
            for (let b = 0; b < BEATS_PER_BAR; b += 1) {
              studio.strings(at(b), beat * 0.8, [bassNotes[0]], { gain: 0.05, cutoff: 1500, attack: 0.01, release: 0.12, reverb: 0.35, track: 'cb', velocity: 0.9 });
            }
          }
          if (barInSection % 4 === 0) studio.timpani(start, { gain: 0.3, midi: 36, reverb: 0.45, track: 'timp' });
        } else if (phase === 'transition') {
          const chord = parseDegree('V', KEY, MINOR).notes;
          tutti(start, bar, chord, { dynamic: 'mf', gainScale: 0.7 });
          if (barInSection % 2 === 0) {
            line(start, beat, 0, MOTIF, (s, d, deg, v) => {
              studio.strings(s, d, [degree(KEY, MINOR, deg) + 12], { gain: 0.042, cutoff: 6400, attack: 0.02, release: 0.18, reverb: 0.55, track: 'vln1', velocity: v });
              wind(s, d, degree(KEY, MINOR, deg + 7), { instrument: 'flute', track: 'fl', dynamic: 'p' });
            });
          }
        } else if (phase === 'theme2') {
          // The same theme, now in C minor: the point of the recapitulation.
          const symbol = ['i', 'iv', 'V', 'i'][Math.floor(barInSection / 4) % 4];
          const chord = parseDegree(symbol, KEY, MINOR).notes;
          tutti(start, bar, chord, { dynamic: 'mp', gainScale: 0.62 });
          const slot = barInSection % 8;
          if (slot < 4) {
            const rest = slot % 4;
            const spec = rest === 0 ? SECOND_THEME.slice(0, 4) : rest === 1 ? SECOND_THEME.slice(4) : rest === 2 ? SECOND_THEME : SECOND_THEME.slice(2, 6);
            line(start, beat, 0, spec, (s, d, deg) => {
              wind(s, d, degree(KEY, MINOR, deg + 7), { instrument: rest < 2 ? 'oboe' : 'clarinet', track: rest < 2 ? 'ob' : 'cl', dynamic: 'mp' });
            });
          } else {
            line(start, beat, 0, HORN_CALL, (s, d, deg) => {
              studio.horn(s, d, degree(KEY, MINOR, deg + 3), { gain: 0.05, reverb: 0.6, track: 'hn', velocity: 0.7 });
            });
          }
        } else {
          const symbol = ['V', 'i', 'V7', 'i'][Math.floor(barInSection / 2) % 4];
          const chord = parseDegree(symbol, KEY, MINOR).notes;
          tutti(start, bar, chord, { dynamic: 'f', gainScale: 0.95 });
          brass(start, bar, tonesBetween(pcsOf(chord), 55, 67).slice(0, 3), { instrument: 'trumpet', track: 'tpt', dynamic: 'f' });
          if (barInSection % 2 === 0) studio.timpani(start, { gain: 0.36, midi: 36, reverb: 0.5, track: 'timp' });
        }
        break;
      }

      // ---------------------------------------------------------------------
      // Coda: a final build, the cadence, and a Picardy third.
      // ---------------------------------------------------------------------
      case 'coda': {
        if (p < 0.45) {
          // Rhythmic drive on the tonic, motif in diminution.
          const symbol = ['i', 'VI', 'iv', 'V'][Math.floor(barInSection / 2) % 4];
          const chord = parseDegree(symbol, KEY, MINOR).notes;
          tutti(start, bar, chord, { dynamic: 'f', gainScale: 0.95 });
          for (let b = 0; b < BEATS_PER_BAR; b += 0.5) {
            const deg = [0, 2, 4, 2][Math.round(b) % 4];
            studio.strings(at(b), beat * 0.42, [degree(KEY, MINOR, deg) + 12], {
              gain: 0.028, cutoff: 6200, attack: 0.006, release: 0.08, reverb: 0.5, track: 'vln2', velocity: 0.8,
            });
          }
          if (barInSection % 2 === 0) studio.timpani(start, { gain: 0.38, midi: 36, reverb: 0.5, track: 'timp' });
        } else if (p < 0.75) {
          // The cadence, hammered home.
          const chord = parseDegree(p < 0.6 ? 'V7' : 'i', KEY, MINOR).notes;
          tutti(start, bar, chord, { dynamic: 'ff', gainScale: 1.1 });
          brass(start, bar, tonesBetween(pcsOf(chord), 55, 70).slice(0, 3), { instrument: 'trumpet', track: 'tpt', dynamic: 'ff' });
          brass(start, bar, tonesBetween(pcsOf(chord), 43, 58).slice(0, 2), { instrument: 'trombone', track: 'tbn', dynamic: 'ff' });
          brass(start, bar, tonesBetween(pcsOf(chord), 33, 45).slice(0, 1), { instrument: 'tuba', track: 'tba', dynamic: 'ff' });
          if (barInSection % 2 === 0) studio.timpani(start, { gain: 0.44, midi: 36, reverb: 0.55, track: 'timp' });
        } else {
          // Picardy third: the minor becomes major for the final chord.
          const chord = parseDegree('I', KEY, MAJOR).notes;
          const last = barInSection === barsInSection - 1;
          tutti(start, bar, chord, { dynamic: last ? 'pp' : 'f', gainScale: last ? 0.5 : 1 });
          if (!last) {
            brass(start, bar, tonesBetween(pcsOf(chord), 55, 70).slice(0, 3), { instrument: 'trumpet', track: 'tpt', dynamic: 'f' });
          }
          if (last) {
            studio.timpaniRoll(start, bar, 36, { gain: 0.3, reverb: 0.6, track: 'timp' });
            studio.timpani(start, { gain: 0.45, midi: 36, reverb: 0.6, track: 'timp' });
            // A final horn note over the fading chord.
            studio.horn(start, bar * 0.8, 48, { gain: 0.045, reverb: 0.7, track: 'hn', velocity: 0.6 });
          } else if (barInSection % 2 === 0) {
            studio.timpani(start, { gain: 0.4, midi: 36, reverb: 0.55, track: 'timp' });
          }
        }
        break;
      }

      default:
        break;
    }
  });

  studio.finish({
    reverbRoom: 0.9,
    reverbDamp: 0.34,
    reverbWidth: 1,
    delayBeats: 0,
    delayFeedback: 0,
    delayWet: 0,
    fadeIn: 0.05,
    fadeOut: Math.min(6, total * 0.05),
  });

  return studio;
}

export const meta = {
  slug: 'symphony',
  name: 'Symphony in C minor',
  bpm: BPM,
  key: 'C minor',
  bars: SECTIONS.reduce((sum, s) => sum + s.bars, 0),
  beatsPerBar: BEATS_PER_BAR,
  description: 'A sonata-form movement for full orchestra: grave introduction, allegro, development and a Picardy third.',
  tracks: TRACKS,
  /** @returns {number} natural length in seconds, across every tempo */
  naturalSeconds() {
    return SECTIONS.reduce((sum, s) => sum + s.bars * ((BEATS_PER_BAR * 60) / (s.bpm ?? BPM)), 0);
  },
  /** @param {{ seconds?: number }} opts @returns {string} */
  form(opts = {}) {
    const arrangement = new Arrangement({ bpm: BPM, beatsPerBar: BEATS_PER_BAR, sections: SECTIONS });
    if (opts.seconds != null) arrangement.fit(opts.seconds);
    return describeForm(arrangement);
  },
};

void midiToNote;
