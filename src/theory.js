/**
 * Music theory for the open-music engine: note names, scales, chords, roman-numeral
 * degree parsing, voicing helpers and timing humanisation.
 *
 * Conventions:
 * - Pitches are MIDI note numbers; middle C is 60 and is written `C4`
 *   (scientific pitch notation). `C-1` is 0 and `G9` is 127.
 * - Frequencies are in Hz using 12-tone equal temperament with A4 = 440 Hz.
 * - Scales and chords are arrays of semitone offsets from the root, ascending and
 *   starting at 0.
 *
 * This module is pure and dependency-free: it imports nothing, has no side effects,
 * never mutates its arguments and never calls `Math.random()`. Callers that need
 * randomness supply their own deterministic `rng()` (see {@link humanizeTime}).
 * Exported constants are shared; treat them as read-only.
 */

/**
 * The twelve pitch-class names, indexed by pitch class (0 = C).
 * Sharps are used for the black keys.
 * @type {readonly string[]}
 */
export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/**
 * Scale name -> ascending semitone offsets from the root, starting at 0.
 * @type {Record<string, number[]>}
 */
export const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  naturalMinor: [0, 2, 3, 5, 7, 8, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  melodicMinor: [0, 2, 3, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  pentatonicMajor: [0, 2, 4, 7, 9],
  pentatonicMinor: [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
  wholeTone: [0, 2, 4, 6, 8, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

/**
 * Chord quality name -> ascending semitone offsets from the chord root.
 * @type {Record<string, number[]>}
 */
export const CHORDS = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  maj7: [0, 4, 7, 11],
  min7: [0, 3, 7, 10],
  dom7: [0, 4, 7, 10],
  min7b5: [0, 3, 6, 10],
  dim7: [0, 3, 6, 9],
  maj9: [0, 4, 7, 11, 14],
  min9: [0, 3, 7, 10, 14],
  dom9: [0, 4, 7, 10, 14],
  add9: [0, 4, 7, 14],
  min6: [0, 3, 7, 9],
  maj6: [0, 4, 7, 9],
  min11: [0, 3, 7, 10, 14, 17],
  dom13: [0, 4, 7, 10, 14, 17, 21],
};

const LETTER_TO_PITCH_CLASS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const NOTE_PATTERN = /^([A-Ga-g])([#b]*)(-?\d+)$/;
const DEGREE_PATTERN = /^([b#]*)([ivIV]+)(.*)$/;
const SUFFIX_PATTERN = /^(°|o|dim|\+|aug|sus4|sus2|maj)?(\d+)?$/;
const ROMAN_TO_DEGREE = new Map([
  ['i', 1],
  ['ii', 2],
  ['iii', 3],
  ['iv', 4],
  ['v', 5],
  ['vi', 6],
  ['vii', 7],
]);
/**
 * Chord-quality families used by {@link parseDegree}: the triad intervals plus the
 * semitone of the added seventh. `dom` is a major triad written with an upper-case
 * roman numeral, whose bare `7` is a minor (dominant) seventh; `maj` is the explicit
 * `maj` spelling, whose seventh is major.
 */
const EXTENSION_FAMILIES = {
  dom: { triad: [0, 4, 7], seventh: 10 },
  maj: { triad: [0, 4, 7], seventh: 11 },
  min: { triad: [0, 3, 7], seventh: 10 },
  dim: { triad: [0, 3, 6], seventh: 9 },
  aug: { triad: [0, 4, 8], seventh: 10 },
  sus4: { triad: [0, 5, 7], seventh: 10 },
  sus2: { triad: [0, 2, 7], seventh: 10 },
};
/** Extension digits accepted in a roman numeral, mapped to themselves. */
const EXTENSION_DIGITS = { 7: 7, 9: 9, 11: 11, 13: 13 };
/** Quality family -> chord name used when a stack matches no {@link CHORDS} entry. */
const FAMILY_NAMES = { dom: 'maj', maj: 'maj', min: 'min', dim: 'dim', aug: 'aug', sus4: 'sus4', sus2: 'sus2' };

/**
 * Short human-readable description of a value, for error messages.
 * @param {unknown} value - Value to describe.
 * @returns {string} Description such as `"C4"`, `12` or `an object`.
 */
function describe(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return `"${value}"`;
  if (typeof value === 'number') return Number.isNaN(value) ? 'NaN' : String(value);
  if (Array.isArray(value)) return `an array of length ${value.length}`;
  if (typeof value === 'function') return 'a function';
  return `a ${typeof value}`;
}

/**
 * Assert that a value is a MIDI note number usable as a written note.
 * @param {unknown} midi - Candidate MIDI note number.
 * @param {string} fnName - Function name used in the error message.
 * @param {string} paramName - Parameter name used in the error message.
 * @returns {number} The validated MIDI note number.
 * @throws {Error} If the value is not an integer in the range 0-127.
 */
function assertMidi(midi, fnName, paramName) {
  if (!Number.isInteger(midi) || midi < 0 || midi > 127) {
    throw new Error(`${fnName}: ${paramName} must be an integer MIDI note in 0-127, received ${describe(midi)}`);
  }
  return midi;
}

/**
 * Assert that a value is a finite number.
 * @param {unknown} value - Candidate number.
 * @param {string} fnName - Function name used in the error message.
 * @param {string} paramName - Parameter name used in the error message.
 * @returns {number} The validated number.
 * @throws {Error} If the value is not a finite number.
 */
function assertFiniteNumber(value, fnName, paramName) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${fnName}: ${paramName} must be a finite number, received ${describe(value)}`);
  }
  return value;
}

/**
 * Assert that a value is an array of integer MIDI note numbers.
 * @param {unknown} notes - Candidate note array.
 * @param {string} fnName - Function name used in the error message.
 * @param {string} paramName - Parameter name used in the error message.
 * @returns {number[]} The validated array (the original reference).
 * @throws {Error} If the value is not an array of integers.
 */
function assertNoteArray(notes, fnName, paramName) {
  if (!Array.isArray(notes)) {
    throw new Error(`${fnName}: ${paramName} must be an array of MIDI note numbers, received ${describe(notes)}`);
  }
  for (let i = 0; i < notes.length; i += 1) {
    if (!Number.isInteger(notes[i])) {
      throw new Error(`${fnName}: ${paramName}[${i}] must be an integer MIDI note number, received ${describe(notes[i])}`);
    }
  }
  return notes;
}

/**
 * Look up a scale by name.
 * @param {unknown} scaleName - Name of a key in {@link SCALES}.
 * @param {string} fnName - Function name used in the error message.
 * @returns {number[]} The scale's semitone offsets.
 * @throws {Error} If the name is not a string or is not a known scale.
 */
function getScaleOffsets(scaleName, fnName) {
  if (typeof scaleName !== 'string' || !Object.hasOwn(SCALES, scaleName)) {
    throw new Error(`${fnName}: unknown scale ${describe(scaleName)} (available: ${Object.keys(SCALES).join(', ')})`);
  }
  return SCALES[scaleName];
}

/**
 * Name a chord from its intervals above the root by matching {@link CHORDS}.
 * @param {number[]} intervals - Ascending semitone offsets from the chord root.
 * @returns {string|null} The matching CHORDS key, or `null` if nothing matches exactly.
 */
function matchChordQuality(intervals) {
  for (const [name, offsets] of Object.entries(CHORDS)) {
    if (offsets.length === intervals.length && offsets.every((offset, index) => offset === intervals[index])) {
      return name;
    }
  }
  return null;
}

/**
 * Interval stack of a quality family widened by an extension digit.
 * `9` adds the 9th, `11` adds the 9th and 11th, and `13` adds the 9th and 13th
 * (the 11th is left out of a 13th chord, as is conventional).
 * @param {string} family - Key of EXTENSION_FAMILIES.
 * @param {number} digit - 0 (no extension), 7, 9, 11 or 13.
 * @returns {number[]} Ascending semitone intervals from the chord root.
 */
function extensionIntervals(family, digit) {
  const { triad, seventh } = EXTENSION_FAMILIES[family];
  if (digit === 0) return [...triad];
  const intervals = [...triad, seventh];
  if (digit === 9) intervals.push(14);
  else if (digit === 11) intervals.push(14, 17);
  else if (digit === 13) intervals.push(14, 21);
  return intervals;
}

/**
 * Name a chord whose stack matches no {@link CHORDS} entry, e.g. `('aug', 7)` -> `"aug7"`.
 * @param {string} family - Key of EXTENSION_FAMILIES.
 * @param {number} digit - 0 (no extension), 7, 9, 11 or 13.
 * @returns {string} A descriptive (not necessarily a CHORDS key) quality label.
 */
function qualityLabel(family, digit) {
  if (digit === 0) return FAMILY_NAMES[family];
  if (family === 'sus4' || family === 'sus2') return `${digit}${family}`;
  return `${family}${digit}`;
}

/**
 * Convert a note name in scientific pitch notation to a MIDI note number.
 * Accepts sharps and flats, and the Unicode `♯` / `♭` characters.
 * @param {string} name - Note name such as `'C4'`, `'C#4'`, `'Db4'`, `'C0'` or `'C-1'`.
 * @returns {number} MIDI note number (middle C = `'C4'` = 60).
 * @throws {Error} If the name cannot be parsed or falls outside MIDI 0-127.
 * @example
 * noteToMidi('C4'); // 60
 * noteToMidi('Db4'); // 61
 * noteToMidi('C0'); // 12
 */
export function noteToMidi(name) {
  if (typeof name !== 'string') {
    throw new Error(`noteToMidi: expected a note name string such as "C4", received ${describe(name)}`);
  }
  const text = name.trim().replace(/♯/g, '#').replace(/♭/g, 'b').replace(/[−–—]/g, '-');
  const match = NOTE_PATTERN.exec(text);
  if (!match) {
    if (/^[A-Ga-g][#b]*$/.test(text)) {
      throw new Error(`noteToMidi: missing octave in "${name}" (expected scientific pitch notation such as "C4")`);
    }
    throw new Error(`noteToMidi: cannot parse "${name}" (expected scientific pitch notation such as "C4", "C#4" or "Db4")`);
  }
  const [, letter, accidentals, octaveText] = match;
  let offset = 0;
  for (const accidental of accidentals) offset += accidental === '#' ? 1 : -1;
  const midi = (Number(octaveText) + 1) * 12 + LETTER_TO_PITCH_CLASS[letter.toUpperCase()] + offset;
  if (midi < 0 || midi > 127) {
    throw new Error(`noteToMidi: "${name}" is outside the MIDI range (0-127), computed ${midi}`);
  }
  return midi;
}

/**
 * Convert a MIDI note number to a note name in scientific pitch notation.
 * Sharps are used for the black keys.
 * @param {number} midi - Integer MIDI note in 0-127.
 * @returns {string} Note name such as `'C4'`.
 * @throws {Error} If `midi` is not an integer in 0-127.
 * @example
 * midiToNote(60); // 'C4'
 */
export function midiToNote(midi) {
  assertMidi(midi, 'midiToNote', 'midi');
  return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

/**
 * Convert a MIDI note number to a frequency in Hz (12-tone equal temperament, A4 = 440).
 * Fractional MIDI values are allowed, so this also serves as a pitch-bend helper.
 * @param {number} midi - MIDI note number (may be fractional).
 * @returns {number} Frequency in Hz.
 * @throws {Error} If `midi` is not a finite number.
 * @example
 * midiToFreq(69); // 440
 * midiToFreq(60); // 261.6255653005986
 */
export function midiToFreq(midi) {
  assertFiniteNumber(midi, 'midiToFreq', 'midi');
  return 440 * 2 ** ((midi - 69) / 12);
}

/**
 * Build the notes of a scale in one octave.
 * The root is included once, at the start; the return value has exactly
 * `SCALES[scaleName].length` entries and no octave-displaced root at the end.
 * @param {number} rootMidi - Integer MIDI note for the scale root.
 * @param {string} scaleName - Key of {@link SCALES}, e.g. `'major'`, `'dorian'`.
 * @returns {number[]} Ascending MIDI notes, one per scale degree.
 * @throws {Error} If `rootMidi` is not an integer in 0-127 or `scaleName` is unknown.
 * @example
 * scale(60, 'major'); // [60, 62, 64, 65, 67, 69, 71]
 */
export function scale(rootMidi, scaleName) {
  assertMidi(rootMidi, 'scale', 'rootMidi');
  const offsets = getScaleOffsets(scaleName, 'scale');
  return offsets.map((offset) => rootMidi + offset);
}

/**
 * Build the notes of a chord from a quality name.
 * Notes are the chord root plus the quality's offsets, so the length always equals
 * `CHORDS[quality].length`. No MIDI range clamping happens here; use
 * {@link voiceLead} or {@link invert} to place a voicing.
 * @param {number} rootMidi - Integer MIDI note for the chord root.
 * @param {string} quality - Key of {@link CHORDS}, e.g. `'min7'`, `'dom13'`.
 * @returns {number[]} Ascending MIDI notes of the chord.
 * @throws {Error} If `rootMidi` is not an integer in 0-127 or `quality` is unknown.
 * @example
 * chord(60, 'maj7'); // [60, 64, 67, 71]
 */
export function chord(rootMidi, quality) {
  assertMidi(rootMidi, 'chord', 'rootMidi');
  if (typeof quality !== 'string' || !Object.hasOwn(CHORDS, quality)) {
    throw new Error(`chord: unknown quality ${describe(quality)} (available: ${Object.keys(CHORDS).join(', ')})`);
  }
  return CHORDS[quality].map((offset) => rootMidi + offset);
}

/**
 * Parse a roman-numeral chord symbol against a key and return its notes.
 *
 * Syntax: `[b|#]* <I-VII> (<quality>)? (<digit>)?` — for example `V7`, `iv`, `bVII`,
 * `#iv`, `viio`, `vii°7`, `VImaj7`, `Vsus4`, `i9`.
 *
 * The symbol is read chord-first: the roman numeral only chooses the ROOT, the quality
 * comes from the suffix or from the case. Precisely:
 * 1. The numeral selects degree 1-7 of `scaleName` (1-based); a degree beyond the
 *    scale's length throws. The optional leading accidentals (`b` = -1 semitone,
 *    `#` = +1, repeats allowed) are applied to that root afterwards, so
 *    `bVII` in D dorian is a B major triad (B-D#-F#) and never an odd stack.
 * 2. Quality resolution, in priority order: `°` / `o` / `dim` -> dim, `+` / `aug` ->
 *    aug, `sus4` -> sus4, `sus2` -> sus2, `maj` -> major (see step 3), otherwise an
 *    all-uppercase numeral -> major and an all-lowercase numeral -> minor. Mixed case
 *    (`Iv`) is ambiguous and throws.
 * 3. An extension digit widens that quality: the added seventh is a minor (dominant)
 *    seventh, except for `dim` (diminished 7th) and the explicit `maj` spelling
 *    (major 7th). `9` adds the 9th, `11` adds the 9th and 11th, `13` adds the 9th and
 *    13th (the 11th is conventionally left out of a 13th chord):
 *      maj (e.g. `V7`)  [0,4,7,10] [0,4,7,10,14] [0,4,7,10,14,17] [0,4,7,10,14,21]
 *      min              [0,3,7,10] [0,3,7,10,14] [0,3,7,10,14,17] [0,3,7,10,14,21]
 *      dim              [0,3,6,9]  [0,3,6,9,14]  [0,3,6,9,14,17]  [0,3,6,9,14,21]
 *      aug              [0,4,8,10] [0,4,8,10,14] [0,4,8,10,14,17] [0,4,8,10,14,21]
 *      sus4             [0,5,7,10] ...            sus2            [0,2,7,10] ...
 *      maj (explicit)   [0,4,7,11] [0,4,7,11,14] [0,4,7,11,14,17] [0,4,7,11,14,21]
 *    A bare digit keeps the numeral's case, so `V7` in C natural minor is a dominant
 *    7th (major triad + minor 7th), while `VImaj7` is a major 7th chord.
 * 4. `notes` are exactly those intervals added to `root`, sorted ascending.
 *
 * @param {string} numeral - Roman-numeral symbol such as `'V7'`, `'iv'`, `'bVII'`, `'VImaj7'`.
 * @param {number} keyRootMidi - Integer MIDI note of the key root (the scale's tonic).
 * @param {string} scaleName - Key of {@link SCALES} describing the key.
 * @returns {{root: number, quality: string, notes: number[]}} Chord root, quality name
 *   and ascending MIDI notes. `quality` is the matching {@link CHORDS} key when the
 *   stack matches one exactly (`'maj'`, `'min7'`, `'dom7'`, `'dim7'`, ...), otherwise a
 *   descriptive label such as `'maj13'`, `'aug7'` or `'7sus4'`.
 * @throws {Error} If the numeral is unparseable, the scale is unknown, or the degree
 *   or extension is out of range.
 * @example
 * parseDegree('V7', 60, 'major').notes; // [67, 71, 74, 77]
 * parseDegree('iv7', 60, 'naturalMinor').notes; // [65, 68, 72, 75]
 * parseDegree('bVII', 50, 'dorian').notes; // [59, 63, 66] - B major, not augmented
 */
export function parseDegree(numeral, keyRootMidi, scaleName) {
  if (typeof numeral !== 'string' || numeral.trim() === '') {
    throw new Error(`parseDegree: numeral must be a non-empty string such as "V7", received ${describe(numeral)}`);
  }
  assertMidi(keyRootMidi, 'parseDegree', 'keyRootMidi');
  const offsets = getScaleOffsets(scaleName, 'parseDegree');

  const text = numeral.trim();
  const match = DEGREE_PATTERN.exec(text);
  if (!match) {
    throw new Error(`parseDegree: cannot parse "${numeral}" (expected a roman numeral I-VII with optional accidentals, quality and extension, such as "V7", "bVII" or "VImaj7")`);
  }
  const [, accidentalText, roman, rawSuffix] = match;
  const suffixMatch = SUFFIX_PATTERN.exec(rawSuffix.toLowerCase());
  if (!suffixMatch) {
    throw new Error(`parseDegree: unsupported suffix "${rawSuffix}" in "${numeral}" (supported: °, o, dim, +, aug, sus2, sus4, maj and extensions 7, 9, 11, 13)`);
  }
  const [, qualityToken = '', extensionText = ''] = suffixMatch;

  const isUpper = roman === roman.toUpperCase();
  const isLower = roman === roman.toLowerCase();
  if (isUpper === isLower) {
    throw new Error(`parseDegree: mixed-case roman numeral "${roman}" in "${numeral}" is ambiguous; write it all-uppercase (major) or all-lowercase (minor)`);
  }

  const degreeNumber = ROMAN_TO_DEGREE.get(roman.toLowerCase());
  if (degreeNumber === undefined) {
    throw new Error(`parseDegree: "${roman}" is not a roman numeral degree (use I-VII)`);
  }
  const degreeIndex = degreeNumber - 1;
  if (degreeIndex >= offsets.length) {
    throw new Error(`parseDegree: degree ${roman} is out of range for scale "${scaleName}", which has only ${offsets.length} degrees`);
  }

  let digit = 0;
  if (extensionText !== '') {
    if (!Object.hasOwn(EXTENSION_DIGITS, extensionText)) {
      throw new Error(`parseDegree: unsupported extension "${extensionText}" in "${numeral}" (supported: 7, 9, 11, 13)`);
    }
    digit = EXTENSION_DIGITS[extensionText];
  }

  // The numeral picks the scale degree; the accidentals then shift that root.
  let accidentalOffset = 0;
  for (const accidental of accidentalText) accidentalOffset += accidental === '#' ? 1 : -1;
  const root = keyRootMidi + offsets[degreeIndex] + accidentalOffset;

  let family;
  if (qualityToken === '°' || qualityToken === 'o' || qualityToken === 'dim') family = 'dim';
  else if (qualityToken === '+' || qualityToken === 'aug') family = 'aug';
  else if (qualityToken === '') family = isUpper ? 'dom' : 'min';
  else family = qualityToken; // 'sus4' | 'sus2' | 'maj'

  const intervals = extensionIntervals(family, digit);
  const notes = intervals.map((interval) => root + interval).sort((a, b) => a - b);
  const quality = matchChordQuality(intervals) ?? qualityLabel(family, digit);
  return { root, quality, notes };
}

/**
 * Invert a chord voicing by moving its lowest `n` notes up an octave.
 * @param {number[]} notes - MIDI notes to invert; not mutated.
 * @param {number} n - Number of notes to move. Positive moves the lowest `n` notes up
 *   an octave, negative moves the highest `|n|` notes down an octave, 0 returns a copy.
 * @returns {number[]} A new ascending array of MIDI notes.
 * @throws {Error} If `notes` is not an array of integers or `|n|` is larger than the
 *   number of notes or `n` is not an integer.
 * @example
 * invert([60, 64, 67], 1); // [64, 67, 72]
 * invert([60, 64, 67], -1); // [55, 60, 64]
 */
export function invert(notes, n) {
  assertNoteArray(notes, 'invert', 'notes');
  if (!Number.isInteger(n)) {
    throw new Error(`invert: n must be an integer, received ${describe(n)}`);
  }
  const count = Math.abs(n);
  if (count > notes.length) {
    throw new Error(`invert: |n| (${count}) is larger than the number of notes (${notes.length})`);
  }
  const sorted = [...notes].sort((a, b) => a - b);
  if (n >= 0) {
    for (let i = 0; i < count; i += 1) sorted[i] += 12;
  } else {
    for (let i = 0; i < count; i += 1) sorted[sorted.length - 1 - i] -= 12;
  }
  return sorted.sort((a, b) => a - b);
}

/**
 * Find the MIDI note with a given pitch class closest to a reference pitch.
 * @param {number} pitchClass - Integer 0-11 (0 = C).
 * @param {number} nearMidi - Reference MIDI number to sit close to (may be fractional).
 * @returns {number} The nearest MIDI note with that pitch class. On an exact tie the
 *   lower note wins. Near the edges of the MIDI range the result may fall outside
 *   0-127, because the mathematically nearest note is returned unclamped.
 * @throws {Error} If `pitchClass` is not an integer 0-11 or `nearMidi` is not finite.
 * @example
 * nearestMidi(0, 60); // 60
 * nearestMidi(1, 60); // 61
 */
export function nearestMidi(pitchClass, nearMidi) {
  if (!Number.isInteger(pitchClass) || pitchClass < 0 || pitchClass > 11) {
    throw new Error(`nearestMidi: pitchClass must be an integer 0-11, received ${describe(pitchClass)}`);
  }
  assertFiniteNumber(nearMidi, 'nearestMidi', 'nearMidi');
  const base = Math.round((nearMidi - pitchClass) / 12) * 12 + pitchClass;
  const candidates = [base - 12, base, base + 12];
  let best = candidates[0];
  for (const candidate of candidates) {
    const distance = Math.abs(candidate - nearMidi);
    const bestDistance = Math.abs(best - nearMidi);
    if (distance < bestDistance || (distance === bestDistance && candidate < best)) best = candidate;
  }
  return best;
}

/**
 * Every octave transposition of `note` that stays inside `[min, max]`, ascending.
 * @param {number} note - Integer MIDI note.
 * @param {number} min - Lowest allowed MIDI note.
 * @param {number} max - Highest allowed MIDI note.
 * @returns {number[]} Ascending candidates, all inside the bounds.
 */
function octaveCandidates(note, min, max) {
  if (max - min < 11) {
    // Too narrow to hold every pitch class: fall back to the clamped note itself.
    return [Math.min(max, Math.max(min, note))];
  }
  const lowest = note + 12 * Math.ceil((min - note) / 12);
  const candidates = [];
  for (let candidate = lowest; candidate <= max; candidate += 12) candidates.push(candidate);
  return candidates;
}

/**
 * Distance from a candidate note to the nearest note of a sorted previous voicing.
 * @param {number} candidate - MIDI note being considered.
 * @param {number[]} targets - Sorted MIDI notes of the previous voicing.
 * @returns {number} Semitone distance to the closest previous note.
 */
function nearestDistance(candidate, targets) {
  let best = Infinity;
  for (const target of targets) best = Math.min(best, Math.abs(candidate - target));
  return best;
}

/**
 * Revoice `next` so that it moves as little as possible from `previous`.
 * Every note of `next` may be placed in any octave inside the `min`/`max` bounds, and
 * the placement minimising the total absolute semitone movement — the sum, over the
 * notes of `next`, of the distance to the nearest note of `previous` — is found exactly
 * over that octave lattice (dynamic programming over the notes in ascending order, each
 * candidate required to sit strictly above the previous one, which keeps the voicing
 * ascending and unison-free when the register allows it). Ties prefer the smallest total
 * transposition away from the input, then the lowest pitches. Pitch classes never change.
 * @param {number[]|null} previous - MIDI notes of the previous voicing. When it is
 *   `null`, `undefined` or empty, `next` is returned unchanged as a sorted copy — no
 *   transposition and no clamping to the bounds happen in that case.
 * @param {number[]} next - MIDI notes of the chord to revoice; not mutated.
 * @param {{min?: number, max?: number}} [opts] - MIDI bounds, defaulting to 24 and 108.
 * @returns {number[]} A new array with exactly `next.length` integer MIDI notes,
 *   sorted ascending, every note inside `[min, max]`.
 * @throws {Error} If an argument is not an array of integers, or the bounds are invalid.
 * @example
 * voiceLead([62, 65, 69], [50, 53, 57, 60]); // [62, 65, 69, 72] - 3 semitones total
 * voiceLead(null, [50, 53, 57]); // [50, 53, 57] - untouched
 */
export function voiceLead(previous, next, opts = {}) {
  assertNoteArray(next, 'voiceLead', 'next');
  const options = opts ?? {};
  if (typeof options !== 'object') {
    throw new Error(`voiceLead: opts must be an object such as { min: 24, max: 108 }, received ${describe(options)}`);
  }
  const min = options.min === undefined ? 24 : options.min;
  const max = options.max === undefined ? 108 : options.max;
  if (!Number.isInteger(min) || !Number.isInteger(max)) {
    throw new Error(`voiceLead: min and max must be integers, received min=${describe(min)} max=${describe(max)}`);
  }
  if (min > max) {
    throw new Error(`voiceLead: min (${min}) must not be greater than max (${max})`);
  }

  const sorted = [...next].sort((a, b) => a - b);
  if (sorted.length === 0) return sorted;
  if (previous === null || previous === undefined) return sorted;
  assertNoteArray(previous, 'voiceLead', 'previous');
  if (previous.length === 0) return sorted;

  const targets = [...previous].sort((a, b) => a - b);
  const layers = sorted.map((note) => octaveCandidates(note, min, max));
  const depth = layers.length;
  const cost = layers.map((candidates) => candidates.map(() => Infinity));
  const shift = layers.map((candidates) => candidates.map(() => Infinity));
  const cameFrom = layers.map((candidates) => candidates.map(() => -1));

  layers[0].forEach((candidate, index) => {
    cost[0][index] = nearestDistance(candidate, targets);
    shift[0][index] = Math.abs(candidate - sorted[0]);
  });
  for (let i = 1; i < depth; i += 1) {
    for (let index = 0; index < layers[i].length; index += 1) {
      const candidate = layers[i][index];
      const stepCost = nearestDistance(candidate, targets);
      const stepShift = Math.abs(candidate - sorted[i]);
      for (let k = 0; k < layers[i - 1].length; k += 1) {
        if (layers[i - 1][k] >= candidate) continue; // must stay strictly ascending
        const totalCost = cost[i - 1][k] + stepCost;
        const totalShift = shift[i - 1][k] + stepShift;
        if (totalCost < cost[i][index] || (totalCost === cost[i][index] && totalShift < shift[i][index])) {
          cost[i][index] = totalCost;
          shift[i][index] = totalShift;
          cameFrom[i][index] = k;
        }
      }
    }
  }

  let end = -1;
  for (let index = 0; index < layers[depth - 1].length; index += 1) {
    if (!Number.isFinite(cost[depth - 1][index])) continue;
    if (end === -1 || cost[depth - 1][index] < cost[depth - 1][end]
      || (cost[depth - 1][index] === cost[depth - 1][end] && shift[depth - 1][index] < shift[depth - 1][end])) {
      end = index;
    }
  }
  if (end === -1) {
    // The bounds are too narrow to hold a strictly ascending voicing (see
    // octaveCandidates): keep each note's only placement and the sorted order.
    return sorted.map((note) => octaveCandidates(note, min, max)[0]).sort((a, b) => a - b);
  }

  const result = new Array(depth);
  let index = end;
  for (let i = depth - 1; i >= 0; i -= 1) {
    result[i] = layers[i][index];
    index = cameFrom[i][index];
  }
  return result;
}

/**
 * Jitter a time value by up to ±`amount` seconds using a caller-supplied RNG.
 * Deterministic by construction: the result depends only on the arguments, so the
 * same seeded `rng` always produces the same timing.
 * @param {number} seconds - Base time in seconds.
 * @param {number} amount - Maximum jitter in seconds; must be finite and >= 0.
 *   Defaults to 0, in which case `rng` is not consulted and may be omitted.
 * @param {() => number} [rng] - Random source returning 0..1 (e.g. a seeded PRNG).
 *   Values outside 0..1 are clamped to preserve the ±`amount` guarantee.
 * @returns {number} `seconds` plus a jitter in `[-amount, +amount]`, never negative.
 * @throws {Error} If `seconds`/`amount` are not finite numbers, `amount` is negative,
 *   `rng` is missing or not a function when needed, or `rng()` does not return a number.
 * @example
 * humanizeTime(1, 0.05, () => 0); // 0.95
 * humanizeTime(1, 0.05, () => 1); // 1.05
 */
export function humanizeTime(seconds, amount, rng) {
  assertFiniteNumber(seconds, 'humanizeTime', 'seconds');
  const jitterAmount = amount === undefined ? 0 : amount;
  assertFiniteNumber(jitterAmount, 'humanizeTime', 'amount');
  if (jitterAmount < 0) {
    throw new Error(`humanizeTime: amount must be >= 0, received ${describe(jitterAmount)}`);
  }
  if (jitterAmount === 0) return Math.max(0, seconds);
  if (typeof rng !== 'function') {
    throw new Error(`humanizeTime: rng must be a function returning 0..1 when amount > 0, received ${describe(rng)}`);
  }
  const sample = rng();
  if (typeof sample !== 'number' || !Number.isFinite(sample)) {
    throw new Error(`humanizeTime: rng() must return a finite number in 0..1, received ${describe(sample)}`);
  }
  const unit = Math.min(1, Math.max(0, sample));
  return Math.max(0, seconds + (unit * 2 - 1) * jitterAmount);
}
