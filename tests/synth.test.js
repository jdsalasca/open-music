import test from 'node:test';
import assert from 'node:assert/strict';

import { Studio } from '../src/synth.js';

const SR = 22050;

/** @param {Float32Array} samples @returns {number} */
function energy(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
  return sum;
}

/** @param {Float32Array} samples @param {number} from @param {number} to */
function energyBetween(samples, from, to) {
  let sum = 0;
  for (let i = Math.max(0, from); i < Math.min(samples.length, to); i += 1) sum += samples[i] * samples[i];
  return sum;
}

test('electricPiano renders a decaying note and then silence', () => {
  const studio = new Studio({ sampleRate: SR, seconds: 3, seed: 3 });
  studio.electricPiano(0.1, 0.4, 60, { gain: 0.4, ring: 0.5, release: 0.3 });
  studio.finish({ targetLufs: null });
  const { left, right } = studio.master;
  assert.equal(left.length, right.length);
  assert.equal(left.length, Math.round(3 * SR));

  let peak = 0;
  for (let i = 0; i < left.length; i += 1) {
    assert.ok(Number.isFinite(left[i]) && Number.isFinite(right[i]), `non-finite sample at ${i}`);
    peak = Math.max(peak, Math.abs(left[i]));
  }
  assert.ok(peak > 0.001, 'the note produced no audio');

  const attack = energyBetween(left, Math.round(0.1 * SR), Math.round(0.25 * SR));
  const tail = energyBetween(left, Math.round(1.6 * SR), Math.round(2.9 * SR));
  assert.ok(attack > 0, 'no energy during the note');
  assert.ok(tail < attack * 0.01, `the note should have died away (tail ${tail} vs attack ${attack})`);
});

test('electricPiano honours the cents detune', () => {
  const plain = new Studio({ sampleRate: SR, seconds: 2, seed: 5 });
  plain.electricPiano(0.05, 1.4, 69, { gain: 0.4, ring: 0.3, release: 0.3, tremolo: 0 });
  plain.finish({ targetLufs: null });

  const shifted = new Studio({ sampleRate: SR, seconds: 2, seed: 5 });
  shifted.electricPiano(0.05, 1.4, 69, { gain: 0.4, ring: 0.3, release: 0.3, tremolo: 0, cents: 60 });
  shifted.finish({ targetLufs: null });

  const a = plain.master.left;
  const b = shifted.master.left;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference += (a[i] - b[i]) ** 2;
  // A semitone of drift over more than a second must decorrelate the two takes.
  assert.ok(difference > energy(a) * 0.05, 'cents had no audible effect');
});

test('the tremolo modulates the electric piano amplitude', () => {
  const studio = new Studio({ sampleRate: SR, seconds: 3, seed: 9 });
  studio.electricPiano(0.05, 2, 64, { gain: 0.4, ring: 0.2, release: 0.2, tremolo: 6 });
  studio.finish({ targetLufs: null });
  const { left } = studio.master;
  // Envelope in 20 ms windows should not be monotonic once the tremolo kicks in.
  const window = Math.round(0.02 * SR);
  const envelope = [];
  for (let i = Math.round(0.6 * SR); i + window < Math.round(1.6 * SR); i += window) {
    envelope.push(Math.sqrt(energyBetween(left, i, i + window) / window));
  }
  let rises = 0;
  for (let i = 1; i < envelope.length; i += 1) if (envelope[i] > envelope[i - 1]) rises += 1;
  assert.ok(rises > 5, `expected the envelope to rise and fall, got ${rises} rises over ${envelope.length} windows`);
});

test('a subtractive voice actually produces sound at every attack time', () => {
  // Regression: the envelope loop used to break on the first sample because an
  // attack ramp starts at exactly zero, which silenced every tone() voice.
  for (const attack of [0, 0.005, 0.05, 0.4]) {
    const studio = new Studio({ sampleRate: SR, seconds: 2, seed: 1 });
    studio.tone({ start: 0.05, duration: 0.8, freq: 261.63, wave: 'saw', gain: 0.4, attack });
    studio.finish({ targetLufs: null });
    let peak = 0;
    for (let i = 0; i < studio.master.left.length; i += 1) peak = Math.max(peak, Math.abs(studio.master.left[i]));
    assert.ok(peak > 0.01, `tone() with attack ${attack} was silent (peak ${peak})`);
  }
});

test('every melodic voice is audible on its own', () => {
  /** @type {Array<[string, (s: Studio) => void]>} */
  const voices = [
    ['bass', (s) => s.bass(0.05, 0.8, 110, { midi: 45 })],
    ['subBass', (s) => s.subBass(0.05, 0.8, 36)],
    ['pluck', (s) => s.pluck(0.05, 0.4, 440, { midi: 69 })],
    ['pad', (s) => s.pad(0.05, 0.8, [220, 277], { midis: [57, 61] })],
    ['choir', (s) => s.choir(0.05, 0.8, [60, 64])],
    ['strings', (s) => s.strings(0.05, 0.8, [60, 64, 67])],
    ['brass', (s) => s.brass(0.05, 0.6, [60, 64])],
    ['horn', (s) => s.horn(0.05, 0.8, 60)],
    ['lead', (s) => s.lead(0.05, 0.8, 440, { midi: 69 })],
    ['harp', (s) => s.harp(0.05, 0.6, 69)],
    ['flute', (s) => s.flute(0.05, 0.8, 72)],
    ['oboe', (s) => s.oboe(0.05, 0.8, 72)],
    ['clarinet', (s) => s.clarinet(0.05, 0.8, 60)],
    ['bassoon', (s) => s.bassoon(0.05, 0.8, 48)],
    ['trumpet', (s) => s.trumpet(0.05, 0.8, 60)],
    ['trombone', (s) => s.trombone(0.05, 0.8, 55)],
    ['tuba', (s) => s.tuba(0.05, 0.8, 40)],
    ['tremoloStrings', (s) => s.tremoloStrings(0.05, 0.8, [60, 64])],
    ['pizzicato', (s) => s.pizzicato(0.05, 0.3, [60, 64, 67])],
  ];
  for (const [name, play] of voices) {
    const studio = new Studio({ sampleRate: SR, seconds: 2, seed: 2 });
    play(studio);
    studio.finish({ targetLufs: null });
    let peak = 0;
    for (let i = 0; i < studio.master.left.length; i += 1) peak = Math.max(peak, Math.abs(studio.master.left[i]));
    assert.ok(peak > 0.002, `${name} produced no audio (peak ${peak})`);
  }
});

test('every voice survives a full render without producing NaN', () => {
  const studio = new Studio({ sampleRate: SR, seconds: 4, seed: 11 });
  studio.tone({ start: 0, duration: 0.5, freq: 220, wave: 'saw', gain: 0.05, cutoff: 2000 });
  studio.kick(0.5);
  studio.snare(0.8);
  studio.hat(1);
  studio.bass(1.2, 0.4, 110, { midi: 45 });
  studio.subBass(1.4, 0.5, 33);
  studio.electricPiano(1.6, 0.4, 60, { gain: 0.2 });
  studio.piano(2, 0.5, 64, { gain: 0.1 });
  studio.choir(2.4, 0.6, [60, 64, 67], { gain: 0.05 });
  studio.strings(2.6, 0.8, [60, 64], { gain: 0.05 });
  studio.finish({ targetLufs: -14 });
  for (let i = 0; i < studio.master.left.length; i += 37) {
    assert.ok(Number.isFinite(studio.master.left[i]), `left NaN at ${i}`);
    assert.ok(Number.isFinite(studio.master.right[i]), `right NaN at ${i}`);
  }
  assert.ok(Number.isFinite(studio.lufs), 'loudness was not measured');
});
