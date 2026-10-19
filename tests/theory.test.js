import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NOTE_NAMES,
  noteToMidi,
  midiToNote,
  midiToFreq,
  SCALES,
  CHORDS,
  scale,
  chord,
  parseDegree,
  invert,
  nearestMidi,
  voiceLead,
  humanizeTime,
} from '../src/theory.js';

test('note names cover the chromatic scale', () => {
  assert.equal(NOTE_NAMES.length, 12);
  assert.equal(NOTE_NAMES[0], 'C');
});

test('noteToMidi uses scientific pitch with middle C = 60', () => {
  assert.equal(noteToMidi('C4'), 60);
  assert.equal(noteToMidi('C#4'), 61);
  assert.equal(noteToMidi('Db4'), 61);
  assert.equal(noteToMidi('Bb3'), 58);
  assert.equal(noteToMidi('A4'), 69);
  assert.equal(noteToMidi('C0'), 12);
  assert.equal(noteToMidi('D3'), 50);
  assert.equal(noteToMidi('F3'), 53);
});

test('noteToMidi rejects garbage', () => {
  for (const bad of ['', 'H4', 'C', 'Cx4', '4C', 'C#', null, undefined]) {
    assert.throws(() => noteToMidi(bad), Error, `expected throw for ${JSON.stringify(bad)}`);
  }
});

test('midiToNote round-trips', () => {
  for (let midi = 12; midi <= 108; midi += 1) {
    assert.equal(noteToMidi(midiToNote(midi)), midi);
  }
  assert.equal(midiToNote(60), 'C4');
});

test('midiToFreq uses A440 equal temperament', () => {
  assert.equal(midiToFreq(69), 440);
  assert.ok(Math.abs(midiToFreq(57) - 220) < 1e-9);
  assert.ok(Math.abs(midiToFreq(60) - 261.6255653) < 1e-6);
});

test('scales are ascending and start on the root', () => {
  for (const [name, steps] of Object.entries(SCALES)) {
    assert.equal(steps[0], 0, `${name} must start at 0`);
    for (let i = 1; i < steps.length; i += 1) {
      assert.ok(steps[i] > steps[i - 1], `${name} must ascend`);
    }
    const notes = scale(50, name);
    assert.equal(notes.length, steps.length);
    assert.equal(notes[0], 50);
  }
});

test('chords contain the expected intervals', () => {
  assert.deepEqual(chord(60, 'maj'), [60, 64, 67]);
  assert.deepEqual(chord(60, 'min'), [60, 63, 67]);
  assert.deepEqual(chord(60, 'min7'), [60, 63, 67, 70]);
  assert.deepEqual(chord(60, 'maj7'), [60, 64, 67, 71]);
  assert.ok(Object.keys(CHORDS).length >= 18);
});

test('unknown scale and chord names throw', () => {
  assert.throws(() => scale(60, 'bogus'), Error);
  assert.throws(() => chord(60, 'bogus'), Error);
});

test('parseDegree selects the root from the scale and the quality from the numeral', () => {
  assert.deepEqual(parseDegree('i', 50, 'dorian').notes, [50, 53, 57]);
  assert.deepEqual(parseDegree('i9', 50, 'dorian').notes, [50, 53, 57, 60, 64]);
  assert.deepEqual(parseDegree('bVI', 50, 'dorian').notes, [58, 62, 65]);
  assert.deepEqual(parseDegree('VImaj7', 50, 'dorian').notes, [59, 63, 66, 70]);
  assert.deepEqual(parseDegree('iv7', 50, 'dorian').notes, [55, 58, 62, 65]);
  assert.deepEqual(parseDegree('Vsus4', 50, 'dorian').notes, [57, 62, 64]);
  assert.deepEqual(parseDegree('V7', 50, 'dorian').notes, [57, 61, 64, 67]);
  assert.deepEqual(parseDegree('VII', 50, 'dorian').notes, [60, 64, 67]);
  assert.deepEqual(parseDegree('bVII', 50, 'dorian').notes, [59, 63, 66]);
});

test('parseDegree gives a major dominant in a minor key', () => {
  assert.deepEqual(parseDegree('V', 53, 'naturalMinor').notes, [60, 64, 67]);
  assert.deepEqual(parseDegree('iv', 53, 'naturalMinor').notes, [58, 61, 65]);
  assert.deepEqual(parseDegree('i', 53, 'naturalMinor').notes, [53, 56, 60]);
  assert.deepEqual(parseDegree('V7', 53, 'naturalMinor').notes, [60, 64, 67, 70]);
});

test('parseDegree returns a sorted integer array every time', () => {
  const numerals = ['i', 'I', 'ii', 'III', 'iv', 'V', 'VI', 'VII', 'bVII', 'bVI', '#iv', 'i7', 'V9', 'iv11', 'vi13', 'vii°', 'II+', 'Isus2'];
  for (const numeral of numerals) {
    const result = parseDegree(numeral, 53, 'naturalMinor');
    assert.ok(result.notes.length >= 3, `${numeral} produced ${result.notes.length} notes`);
    for (const n of result.notes) assert.ok(Number.isInteger(n), `${numeral} produced ${n}`);
    const sorted = [...result.notes].sort((a, b) => a - b);
    assert.deepEqual(result.notes, sorted, `${numeral} is not sorted`);
  }
});

test('parseDegree rejects unparseable numerals', () => {
  for (const bad of ['', 'X', 'VIII', 'hello', 'i-maj7']) {
    assert.throws(() => parseDegree(bad, 60, 'major'), Error, `expected throw for ${JSON.stringify(bad)}`);
  }
});

test('invert moves voices by an octave and keeps order', () => {
  const notes = [60, 64, 67];
  assert.deepEqual(invert(notes, 1), [64, 67, 72]);
  assert.deepEqual(invert(notes, -1), [55, 60, 64]);
  assert.deepEqual(invert(notes, 0), [60, 64, 67]);
  const many = invert(notes, 3);
  assert.equal(many.length, 3);
  const sorted = [...many].sort((a, b) => a - b);
  assert.deepEqual(many, sorted);
});

test('nearestMidi finds the closest note of a pitch class', () => {
  assert.equal(nearestMidi(0, 60), 60);
  assert.equal(nearestMidi(0, 61), 60);
  assert.equal(nearestMidi(0, 67), 72);
  assert.equal(nearestMidi(11, 60), 59);
  assert.equal(nearestMidi(0, 66) % 12, 0, 'ties must still land on the right pitch class');
  for (let near = 40; near < 80; near += 1) {
    const found = nearestMidi(7, near);
    assert.equal(((found % 12) + 12) % 12, 7, `nearestMidi(7, ${near}) returned ${found}`);
    assert.ok(Math.abs(found - near) <= 6, `nearestMidi(7, ${near}) returned ${found}`);
  }
});

test('voiceLead returns the next chord untouched when there is no previous one', () => {
  assert.deepEqual(voiceLead(null, [50, 53, 57, 60]), [50, 53, 57, 60]);
  assert.deepEqual(voiceLead([], [50, 53, 57]), [50, 53, 57]);
  assert.deepEqual(voiceLead(undefined, [60, 64, 67], { min: 24, max: 108 }), [60, 64, 67]);
});

test('voiceLead minimises movement', () => {
  const previous = [62, 65, 69];
  const next = [50, 53, 57, 60];
  const led = voiceLead(previous, next, { min: 45, max: 84 });
  assert.equal(led.length, next.length);
  const movement = (candidate) =>
    candidate.reduce((sum, note) => sum + Math.min(...previous.map((p) => Math.abs(p - note))), 0);
  assert.ok(movement(led) <= movement(next), `led ${led} moved more than raw ${next}`);
  for (const note of led) {
    assert.ok(note >= 45 && note <= 84, `note ${note} left the range`);
    const closest = Math.min(...previous.map((p) => Math.abs(p - note)));
    assert.ok(closest <= 12, `note ${note} is more than an octave from any previous note`);
  }
  const sorted = [...led].sort((a, b) => a - b);
  assert.deepEqual(led, sorted);
});

test('voiceLead keeps a contiguous progression smooth', () => {
  const progression = [
    [50, 53, 57, 62],
    [58, 62, 65, 69],
    [55, 58, 62, 65],
    [57, 62, 64],
  ];
  let previous = null;
  let totalMovement = 0;
  for (const chordNotes of progression) {
    const led = voiceLead(previous, chordNotes, { min: 48, max: 84 });
    if (previous) {
      totalMovement += led.reduce(
        (sum, note) => sum + Math.min(...previous.map((p) => Math.abs(p - note))),
        0,
      );
    }
    previous = led;
  }
  assert.ok(totalMovement < 60, `progression was not smooth: ${totalMovement}`);
});

test('humanizeTime jitters deterministically and never goes negative', () => {
  const rng = () => 0.5;
  assert.equal(humanizeTime(1, 0.1, rng), 1);
  const low = humanizeTime(0.05, 0.2, () => 0);
  assert.ok(low >= 0, `negative time ${low}`);
  const values = new Set();
  let seed = 1;
  const local = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let i = 0; i < 50; i += 1) values.add(humanizeTime(1, 0.05, local));
  assert.ok(values.size > 10, 'jitter should vary');
});
