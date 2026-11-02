/**
 * soviet-march.js — "Marcha del Frente", a concert march in D minor.
 *
 * 92 bars at 104 BPM (3:32) in six sections: a call, the march theme, a hymn in
 * F major, a development through G minor and the Neapolitan, an assault with the
 * theme in augmentation, and a coda that turns to D major.
 *
 * The material is original: a rising-fourth theme developed by sequence,
 * inversion and augmentation. It quotes no anthem, no song and no recording.
 */

import { Studio } from '../synth.js';
import { Arrangement, describeForm } from '../arrangement.js';
import { SCALES, parseDegree, voiceLead, noteToMidi } from '../theory.js';
import { mulberry32 } from '../dsp.js';

const BPM = 104;
const BEATS_PER_BAR = 4;
const KEY = noteToMidi('D3'); // 50
const SCALE = 'naturalMinor';
const F_MAJOR = noteToMidi('F3'); // 53
const G_MINOR = noteToMidi('G3'); // 55
const NATURAL_BARS = 92;

/** @type {import('../arrangement.js').Section[]} */
const SECTIONS = [
  { name: 'llamada', bars: 8, intensity: 0.18, layers: ['roll', 'tuba', 'call', 'tam'] },
  { name: 'marcha', bars: 24, intensity: 0.62, layers: ['snare', 'tuba', 'bones', 'trumpet', 'timpani'] },
  { name: 'himno', bars: 16, intensity: 0.48, layers: ['snare', 'bass', 'bones', 'horns', 'choir', 'strings'] },
  { name: 'desarrollo', bars: 16, intensity: 0.7, layers: ['snare', 'bass', 'winds', 'strings', 'timpani'] },
  { name: 'asalto', bars: 16, intensity: 0.98, layers: ['snare', 'tuba', 'bones', 'trumpet', 'horns', 'choir', 'timpani', 'tam'] },
  { name: 'coda', bars: 12, intensity: 0.82, layers: ['snare', 'tuba', 'bones', 'trumpet', 'horns', 'choir', 'strings', 'timpani', 'tam'] },
];

const TRACKS = [
  { name: 'tuba', program: 58 },
  { name: 'bones', program: 57 },
  { name: 'trumpet', program: 56 },
  { name: 'horns', program: 60 },
  { name: 'choir', program: 52 },
  { name: 'strings', program: 48 },
  { name: 'winds', program: 73 },
  { name: 'drums', program: 0, drum: true },
];

/**
 * Theme A: an eight-bar period. The antecedent ends on the dominant; the
 * consequent ends on the tonic. One rising fourth, then stepwise answers.
 * [scale degree, beats]
 */
const THEME_A = [
  [4, 1.5], [5, 0.5], [6, 1], [7, 1],
  [7, 2], [6, 1], [5, 1],
  [4, 1.5], [3, 0.5], [2, 1], [1, 1],
  [1, 2], [4, 2],
  [4, 1.5], [5, 0.5], [6, 1], [7, 1],
  [7, 2], [8, 1], [7, 1],
  [6, 1.5], [5, 0.5], [4, 1], [3, 1],
  [2, 2], [0, 2],
];

/** Theme B: a lyrical eight-bar period in F major. */
const THEME_B = [
  [4, 2], [5, 1], [4, 1],
  [3, 2], [4, 1], [3, 1],
  [5, 2], [4, 1], [3, 1],
  [2, 3], [0, 1],
  [3, 2], [2, 1], [1, 1],
  [0, 2], [1, 1], [2, 1],
  [3, 2], [2, 1], [1, 1],
  [0, 4],
];

/** The second period ends on the dominant seventh, so the last note is G. */
const THEME_B_END = THEME_B.slice(0, -1).concat([[1, 4]]);

const LLAMADA_HARMONY = ['i', 'i', 'i', 'i', 'V7', 'V7', 'i', 'i'];

const MARCHA_HARMONY = [
  ...['i', 'bVI', 'bIII', 'V7', 'i', 'bVI', 'iv', 'i'].map((symbol) => ({ symbol, root: KEY })),
  ...['i', 'bVI', 'bIII', 'V7', 'i', 'bVI', 'iv', 'V7'].map((symbol) => ({ symbol, root: KEY })),
  ...['i', 'bVI', 'bIII', 'V7', 'i', 'bVI', 'iv'].map((symbol) => ({ symbol, root: G_MINOR })),
  { symbol: 'V7', root: KEY },
];

const HIMNO_HARMONY = ['I', 'IV', 'V', 'I', 'vi', 'IV', 'V', 'I', 'IV', 'V', 'I', 'vi', 'IV', 'ii', 'V7', 'III7'];

const DESARROLLO_HARMONY = ['iv', 'iv', 'bVI', 'bVI', 'bII', 'bII', 'V7', 'V7', 'i', 'bVI', 'iv', 'V7', 'i', 'bII', 'V7', 'V7'];

const ASALTO_HARMONY = ['i', 'i', 'bVI', 'bVI', 'bIII', 'bIII', 'V7', 'V7', 'i', 'i', 'bVI', 'bVI', 'iv', 'iv', 'i', 'V7'];

const CODA_HARMONY = ['i', 'bVI', 'iv', 'V7', 'i', 'bVI', 'iv', 'V7', 'i', 'bVI', 'V7', 'I'];

/** Trumpet timbre for the legato phrase voice. */
const TRUMPET = {
  wave: 'saw',
  gain: 0.068,
  attack: 0.03,
  decay: 0.16,
  sustain: 0.78,
  release: 0.3,
  cutoff: 2100,
  res: 1.7,
  filterEnv: 2.8,
  filterDecay: 0.22,
  unison: 2,
  spread: 0.045,
  unisonPan: 0.2,
  vibrato: 0.03,
  vibratoRate: 5.1,
  vibratoDelay: 0.3,
  reverb: 0.34,
};

/** Horn timbre: soft square, slower attack, darker. */
const HORN = {
  wave: 'soft-square',
  gain: 0.055,
  attack: 0.16,
  decay: 0.25,
  sustain: 0.85,
  release: 0.5,
  cutoff: 1300,
  res: 0.8,
  filterEnv: 0.8,
  filterDecay: 0.5,
  unison: 2,
  spread: 0.05,
  unisonPan: 0.2,
  vibrato: 0.03,
  vibratoRate: 5,
  vibratoDelay: 0.35,
  reverb: 0.45,
};

/** @param {number} index @param {number} root @param {string} scaleName @param {number} octaveShift */
function degreeMidi(index, root, scaleName = SCALE, octaveShift = 0) {
  const steps = SCALES[scaleName];
  const n = steps.length;
  const step = ((index % n) + n) % n;
  const octave = Math.floor(index / n);
  return root + steps[step] + 12 * (octave + octaveShift);
}

/** @param {string} symbol @param {number} root @param {string} scaleName */
function chordFor(symbol, root = KEY, scaleName = SCALE) {
  return parseDegree(symbol, root, scaleName);
}

/** @returns {Array<{ start: number, duration: number, midi: number }>} */
function themeEvents(theme, { start, beat, root, scaleName = SCALE, octaveShift = 0, stretch = 1, until = Infinity }) {
  const events = [];
  let time = start;
  for (const [degree, duration] of theme) {
    const length = duration * beat * stretch;
    if (time >= until) break;
    const end = Math.min(time + length, until);
    events.push({ start: time, duration: end - time, midi: degreeMidi(degree, root, scaleName, octaveShift) });
    time += length;
  }
  return events;
}

/** Root-fifth-octave-approach line; the bass never repeats the root. */
function walkingBass(studio, { at, beat, chord, nextChord, level, vel, bus, track }) {
  const root = chord.root - 12;
  const next = nextChord.root - 12;
  const approach = next + (next > root ? -1 : 1);
  const line = [root, root + 7, root + 12, approach];
  line.forEach((midi, i) => {
    studio.tuba(at(i), beat * 0.85, midi, {
      gain: 0.1 * level * (i === 0 ? 1 : 0.85),
      velocity: vel(i === 0 ? 0.75 : 0.6),
      bus,
      track,
      midi,
    });
  });
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

  const studio = new Studio({ sampleRate, seconds: total, seed, stems, score, expressive: true });
  const rng = mulberry32(seed);
  const jitter = (amount = 0.008) => (rng() * 2 - 1) * amount;
  const vel = (base) => Math.max(0.08, Math.min(1, base * (0.86 + rng() * 0.28)));

  let prevBones = null;
  let prevChoir = null;

  arrangement.forEachBar((ctx) => {
    const { start, section, barInSection, barsInSection, intensity, at } = ctx;
    const name = section.name;
    const lastBar = barsInSection - 1;
    const level = Math.min(1, 0.45 + 0.55 * intensity);
    const barSeconds = 4 * beat;

    const index = barInSection % (name === 'marcha' ? 24 : name === 'himno' ? 16 : name === 'llamada' ? 8 : name === 'desarrollo' ? 16 : name === 'asalto' ? 16 : 12);
    let chord;
    let nextChord;

    if (name === 'marcha') {
      const entry = MARCHA_HARMONY[index];
      const following = MARCHA_HARMONY[(index + 1) % MARCHA_HARMONY.length];
      chord = chordFor(entry.symbol, entry.root);
      nextChord = chordFor(following.symbol, following.root);
    } else if (name === 'himno') {
      chord = chordFor(HIMNO_HARMONY[index], F_MAJOR, 'major');
      nextChord = chordFor(HIMNO_HARMONY[(index + 1) % HIMNO_HARMONY.length], F_MAJOR, 'major');
    } else if (name === 'desarrollo') {
      chord = chordFor(DESARROLLO_HARMONY[index], KEY);
      nextChord = chordFor(DESARROLLO_HARMONY[(index + 1) % DESARROLLO_HARMONY.length], KEY);
    } else if (name === 'asalto') {
      chord = chordFor(ASALTO_HARMONY[index], KEY);
      nextChord = chordFor(ASALTO_HARMONY[(index + 1) % ASALTO_HARMONY.length], KEY);
    } else if (name === 'coda') {
      const symbol = CODA_HARMONY[index];
      const following = CODA_HARMONY[(index + 1) % CODA_HARMONY.length];
      chord = chordFor(symbol, KEY, symbol === 'I' ? 'major' : SCALE);
      nextChord = chordFor(following, KEY, following === 'I' ? 'major' : SCALE);
    } else {
      const symbol = LLAMADA_HARMONY[index];
      chord = chordFor(symbol, KEY);
      nextChord = chordFor(LLAMADA_HARMONY[(index + 1) % LLAMADA_HARMONY.length], KEY);
    }

    const root = chord.root;

    // -- Llamada -------------------------------------------------------------
    if (name === 'llamada') {
      if (barInSection === 0) {
        studio.timpaniRoll(start, barSeconds * 1.8, root - 12, { gain: 0.1, rate: 9, crescendo: 0.7, bus: 'drums', track: 'drums' });
        studio.tamTam(start, { gain: 0.07, bus: 'drums', track: 'drums' });
      }
      studio.tuba(at(0), barSeconds * 0.92, root - 12, {
        gain: 0.1 * level,
        velocity: vel(0.45),
        bus: 'bajo',
        track: 'tuba',
        midi: root - 12,
      });
      if (barInSection === 4) {
        const call = [[1, 1.5], [4, 0.5], [7, 2]];
        let time = 0;
        for (const [degree, length] of call) {
          const midi = degreeMidi(degree, KEY, SCALE, 1);
          studio.trumpet(at(time), beat * length, midi, {
            gain: 0.025,
            velocity: 0.35,
            reverb: 0.8,
            bus: 'trumpet',
            track: 'trumpet',
            midi,
          });
          time += length;
        }
        studio.timpani(at(0), { gain: 0.14, midi: root - 12, bus: 'drums', track: 'drums' });
      }
    }

    // -- Marcha --------------------------------------------------------------
    if (name === 'marcha') {
      const statement = index < 8 ? 1 : index < 16 ? 2 : 3;
      const themeRoot = statement === 3 ? G_MINOR : KEY;

      if (index % 8 === 0) {
        const until = start + Math.min(8, barsInSection - index) * barSeconds;
        studio.phrase(themeEvents(THEME_A, { start, beat, root: themeRoot, octaveShift: 1, until }), {
          ...TRUMPET,
          gain: TRUMPET.gain * (0.7 + 0.3 * level),
          velocity: vel(0.8),
          bus: 'trumpet',
          track: 'trumpet',
        });
        if (statement >= 2) {
          studio.phrase(themeEvents(THEME_A, { start, beat, root: themeRoot, octaveShift: 0, until }), {
            ...HORN,
            gain: HORN.gain * (0.7 + 0.3 * level),
            velocity: vel(0.65),
            bus: 'horns',
            track: 'horns',
          });
        }
      }

      for (const b of [0, 2]) {
        const midi = root - 12 + (b === 2 ? 7 : 0);
        studio.tuba(at(b + jitter(0.003)), beat * 0.9, midi, {
          gain: (b === 0 ? 0.11 : 0.085) * level,
          velocity: vel(0.75),
          bus: 'bajo',
          track: 'tuba',
          midi,
        });
      }

      const bones = voiceLead(prevBones, chord.notes, { min: 45, max: 62 });
      prevBones = bones;
      for (const b of [1, 3]) {
        for (const midi of bones) {
          studio.trombone(at(b + jitter(0.003)), beat * 0.42, midi, {
            gain: 0.05 * level,
            velocity: vel(b === 1 ? 0.65 : 0.55),
            bus: 'bones',
            track: 'bones',
            midi,
          });
        }
      }

      for (let e = 0; e < 8; e += 1) {
        studio.snare(at(e * 0.5 + jitter(0.004)), {
          gain: (e % 4 === 0 ? 0.19 : 0.085) * level,
          pan: e % 2 ? 0.12 : -0.12,
          velocity: vel(0.6),
          bus: 'drums',
          track: 'drums',
        });
      }
      if (index % 8 === 7) {
        studio.snare(at(3.5), { gain: 0.16 * level, bus: 'drums', track: 'drums' });
        studio.snare(at(3.75), { gain: 0.19 * level, bus: 'drums', track: 'drums' });
      }

      if (index % 2 === 0) {
        studio.timpani(at(0), { gain: 0.21 * level, midi: root - 12, bus: 'drums', track: 'drums' });
      }
      if (index % 8 === 7) {
        studio.timpani(at(2), { gain: 0.22 * level, midi: root - 5, bus: 'drums', track: 'drums' });
      }

      if (index === 16) {
        [4, 6, 7, 9].forEach((degree, i) => {
          const midi = degreeMidi(degree, G_MINOR, SCALE, 1);
          studio.trumpet(at(i * 0.5), beat * 0.4, midi, {
            gain: 0.05,
            velocity: 0.8,
            bus: 'trumpet',
            track: 'trumpet',
            midi,
          });
        });
      }
    }

    // -- Himno ---------------------------------------------------------------
    if (name === 'himno') {
      if (index % 8 === 0) {
        const theme = index === 0 ? THEME_B : THEME_B_END;
        const until = start + Math.min(8, barsInSection - index) * barSeconds;
        studio.phrase(themeEvents(theme, { start, beat, root: F_MAJOR, scaleName: 'major', octaveShift: 1, until }), {
          ...HORN,
          gain: HORN.gain * 1.15,
          velocity: vel(0.7),
          bus: 'horns',
          track: 'horns',
        });
      }

      const choir = voiceLead(prevChoir, chord.notes, { min: 52, max: 72 });
      prevChoir = choir;
      studio.choir(start + jitter(0.004), barSeconds * 0.96, choir, {
        gain: 0.06 * level,
        attack: 0.5,
        release: 1.2,
        cutoff: 1100,
        res: 0.7,
        bus: 'choir',
        track: 'choir',
        velocity: vel(0.6),
      });
      studio.strings(start, barSeconds * 0.96, choir.map((midi) => midi + 12), {
        gain: 0.04 * level,
        attack: 0.4,
        release: 0.9,
        cutoff: 2200,
        bus: 'strings',
        track: 'strings',
        velocity: vel(0.55),
      });

      const bassNext = index === HIMNO_HARMONY.length - 1 ? chordFor('i', G_MINOR) : nextChord;
      walkingBass(studio, { at, beat, chord, nextChord: bassNext, level, vel, bus: 'bajo', track: 'tuba' });

      const bones = voiceLead(prevBones, chord.notes, { min: 45, max: 60 });
      prevBones = bones;
      for (const midi of bones) {
        studio.trombone(at(2), beat * 0.5, midi, {
          gain: 0.04 * level,
          velocity: vel(0.45),
          bus: 'bones',
          track: 'bones',
          midi,
        });
      }

      for (const b of [0, 2]) {
        studio.snare(at(b), { gain: 0.055 * level, velocity: vel(0.4), bus: 'drums', track: 'drums' });
      }
      if (index % 8 === 0) {
        studio.timpani(at(0), { gain: 0.18 * level, midi: root - 12, bus: 'drums', track: 'drums' });
      }
    }

    // -- Desarrollo ----------------------------------------------------------
    if (name === 'desarrollo') {
      const growth = barsInSection <= 1 ? 1 : barInSection / (barsInSection - 1);
      const local = Math.min(1, 0.35 + 0.65 * growth);
      const quiet = barInSection >= barsInSection - 2;

      studio.tuba(at(0), barSeconds * 0.9, root - 12, {
        gain: 0.09 * (quiet ? 0.5 : local),
        velocity: vel(0.6),
        bus: 'bajo',
        track: 'tuba',
        midi: root - 12,
      });

      if (!quiet) {
        const voices = voiceLead(prevChoir, chord.notes, { min: 48, max: 72 });
        prevChoir = voices;
        studio.tremoloStrings(start, barSeconds * 0.95, voices, {
          gain: 0.05 * local,
          rate: 13,
          bus: 'strings',
          track: 'strings',
          velocity: vel(0.55),
        });

        const fragment = [[4, 0], [5, 0.5], [6, 1], [7, 1.5]];
        const instrument = index % 2 === 0 ? 'flute' : 'oboe';
        for (const [degree, offset] of fragment) {
          const midi = degreeMidi(degree, KEY, SCALE, 1);
          studio[instrument](at(offset + 2), beat * 0.45, midi, {
            gain: 0.06 * local,
            velocity: vel(0.55),
            bus: 'winds',
            track: 'winds',
            midi,
          });
        }

        if (index >= 8) {
          const bones = voiceLead(prevBones, chord.notes, { min: 45, max: 60 });
          prevBones = bones;
          for (const b of [0, 2]) {
            for (const midi of bones) {
              studio.trombone(at(b), beat * 0.3, midi, {
                gain: 0.05 * local,
                velocity: vel(0.65),
                bus: 'bones',
                track: 'bones',
                midi,
              });
            }
          }
        }
      }

      const snareGain = quiet ? 0.03 : 0.07 + 0.1 * growth;
      for (let e = 0; e < 8; e += 1) {
        studio.snare(at(e * 0.5), {
          gain: snareGain * (e % 4 === 0 ? 1.2 : 0.7),
          bus: 'drums',
          track: 'drums',
        });
      }
      if (index === 0 || index === 12) {
        studio.timpaniRoll(start, barSeconds * 1.6, root - 12, {
          gain: 0.12,
          rate: 11,
          crescendo: index === 12 ? 0.9 : 0.5,
          bus: 'drums',
          track: 'drums',
        });
      }
    }

    // -- Asalto --------------------------------------------------------------
    if (name === 'asalto') {
      if (index === 0) {
        const until = start + Math.min(16, barsInSection) * barSeconds;
        studio.phrase(themeEvents(THEME_A, { start, beat, root: KEY, octaveShift: 1, stretch: 2, until }), {
          ...TRUMPET,
          gain: TRUMPET.gain * 1.3,
          velocity: vel(0.95),
          bus: 'trumpet',
          track: 'trumpet',
        });
        studio.phrase(themeEvents(THEME_A, { start, beat, root: KEY, octaveShift: 0, stretch: 2, until }), {
          ...HORN,
          gain: HORN.gain * 1.05,
          velocity: vel(0.9),
          bus: 'horns',
          track: 'horns',
        });
      }

      const bones = voiceLead(prevBones, chord.notes, { min: 43, max: 58 });
      prevBones = bones;
      for (const b of [0, 2]) {
        for (const midi of bones) {
          studio.trombone(at(b), beat * 0.5, midi, {
            gain: 0.055,
            velocity: vel(0.85),
            bus: 'bones',
            track: 'bones',
            midi,
          });
        }
      }

      const choir = voiceLead(prevChoir, chord.notes, { min: 52, max: 74 });
      prevChoir = choir;
      studio.choir(start, barSeconds * 0.95, choir, {
        gain: 0.05,
        attack: 0.3,
        release: 0.8,
        bus: 'choir',
        track: 'choir',
        velocity: vel(0.8),
      });

      studio.tuba(at(0), beat * 1.6, root - 12, { gain: 0.12, velocity: vel(0.9), bus: 'bajo', track: 'tuba', midi: root - 12 });
      studio.tuba(at(2), beat * 1.2, root - 5, { gain: 0.1, velocity: vel(0.8), bus: 'bajo', track: 'tuba', midi: root - 5 });

      for (let e = 0; e < 8; e += 1) {
        studio.snare(at(e * 0.5), {
          gain: (e % 4 === 0 ? 0.26 : 0.13),
          pan: e % 2 ? 0.12 : -0.12,
          bus: 'drums',
          track: 'drums',
        });
      }
      if (index % 2 === 0) {
        studio.timpani(at(0), { gain: 0.25, midi: root - 12, bus: 'drums', track: 'drums' });
      }
      if (index === 0 || index === 8) {
        studio.tamTam(start, { gain: 0.1, bus: 'drums', track: 'drums' });
      }
      if (index >= 8 && index % 2 === 0) {
        [4, 6, 7, 9].forEach((degree, i) => {
          const midi = degreeMidi(degree, KEY, SCALE, 1);
          studio.trumpet(at(i * 0.5), beat * 0.35, midi, {
            gain: 0.06,
            velocity: 0.85,
            bus: 'trumpet',
            track: 'trumpet',
            midi,
          });
        });
      }
    }

    // -- Coda ----------------------------------------------------------------
    if (name === 'coda') {
      if (barInSection === lastBar) {
        const major = [62, 66, 69, 74];
        for (const midi of major) {
          studio.trumpet(at(0), beat * 3, midi, { gain: 0.068, velocity: 0.9, bus: 'trumpet', track: 'trumpet', midi });
          studio.trombone(at(0), beat * 3, midi - 12, { gain: 0.06, velocity: 0.85, bus: 'bones', track: 'bones', midi: midi - 12 });
        }
        studio.choir(start, barSeconds * 0.9, [50, 54, 57], { gain: 0.05, attack: 0.2, release: 0.6, bus: 'choir', track: 'choir' });
        studio.tuba(at(0), beat * 3, 38, { gain: 0.13, velocity: 0.9, bus: 'bajo', track: 'tuba', midi: 38 });
        studio.timpani(at(0), { gain: 0.35, midi: 38, bus: 'drums', track: 'drums' });
        studio.tamTam(start, { gain: 0.14, bus: 'drums', track: 'drums' });
        studio.impact(start, { gain: 0.25 });
      } else {
        if (index === 0) {
          const fragment = THEME_A.slice(0, 8);
          const until = start + Math.min(8, barsInSection - index) * barSeconds;
          studio.phrase(themeEvents(fragment, { start, beat, root: KEY, octaveShift: 1, stretch: 2, until }), {
            ...TRUMPET,
            gain: TRUMPET.gain * 1.1,
            velocity: vel(0.85),
            bus: 'trumpet',
            track: 'trumpet',
          });
          studio.phrase(themeEvents(fragment, { start, beat, root: KEY, octaveShift: 0, stretch: 2, until }), {
            ...HORN,
            gain: HORN.gain * 1.2,
            velocity: vel(0.8),
            bus: 'horns',
            track: 'horns',
          });
        }

        const choir = voiceLead(prevChoir, chord.notes, { min: 52, max: 74 });
        prevChoir = choir;
        studio.choir(start, barSeconds * 0.95, choir, {
          gain: 0.05,
          attack: 0.4,
          release: 0.9,
          bus: 'choir',
          track: 'choir',
          velocity: vel(0.7),
        });

        walkingBass(studio, { at, beat, chord, nextChord, level, vel, bus: 'bajo', track: 'tuba' });

        const bones = voiceLead(prevBones, chord.notes, { min: 43, max: 60 });
        prevBones = bones;
        for (const b of [0, 2]) {
          for (const midi of bones) {
            studio.trombone(at(b), beat * 0.55, midi, {
              gain: 0.05,
              velocity: vel(0.7),
              bus: 'bones',
              track: 'bones',
              midi,
            });
          }
        }

        for (let e = 0; e < 8; e += 1) {
          studio.snare(at(e * 0.5), {
            gain: e % 4 === 0 ? 0.22 : 0.1,
            bus: 'drums',
            track: 'drums',
          });
        }
      }
    }
  });

  studio.finish({
    targetLufs: -14,
    ceiling: 0.77,
    fadeIn: 0.05,
    fadeOut: Math.min(1.2, total * 0.02),
    reverbRoom: 0.78,
    reverbDamp: 0.35,
    delayWet: 0.1,
    delayFeedback: 0.28,
  });
  return studio;
}

export const meta = {
  slug: 'soviet-march',
  name: 'Marcha del Frente',
  bpm: BPM,
  key: 'D minor',
  bars: NATURAL_BARS,
  beatsPerBar: BEATS_PER_BAR,
  description: 'Concert march in D minor: two themes, walking bass and full orchestra.',
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
