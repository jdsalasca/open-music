import test from 'node:test';
import assert from 'node:assert/strict';
import { render, meta } from '../src/presets/soviet-march.js';
import { Score } from '../src/midi.js';

test('the march is a 92-bar piece in D minor', () => {
  assert.equal(meta.bars, 92);
  assert.ok(Math.abs(meta.naturalSeconds() - 212.31) < 0.01);
  assert.equal(meta.key, 'D minor');
  assert.equal(meta.form(), 'llamada:8 marcha:24 himno:16 desarrollo:16 asalto:16 coda:12');
});

test('the march keeps its material moving across sections', () => {
  const score = new Score({ bpm: meta.bpm, name: meta.name });
  for (const track of meta.tracks) score.addTrack(track.name, { program: track.program, drum: track.drum });
  const studio = render({ seconds: 120, seed: 7, sampleRate: 22050, score });
  assert.ok(studio.stats.notes > 600, `only ${studio.stats.notes} notes`);
  const trumpet = score.tracks.find((track) => track.name === 'trumpet');
  assert.ok(trumpet.notes.length > 16);
  const opening = trumpet.notes.slice(0, 8).map((note) => note.midi);
  const closing = trumpet.notes.slice(-8).map((note) => note.midi);
  assert.notDeepEqual(opening, closing, 'the trumpet plays the same eight notes at the end');
});

test('a very short render still produces audio and several buses', () => {
  const studio = render({ seconds: 6, seed: 3, sampleRate: 22050, stems: true });
  assert.ok(studio.stats.notes > 0);
  assert.ok(studio.buses.size >= 3, `only ${studio.buses.size} buses`);
  let peak = 0;
  for (let i = 0; i < studio.master.left.length; i += 1) {
    assert.ok(Number.isFinite(studio.master.left[i]));
    peak = Math.max(peak, Math.abs(studio.master.left[i]));
  }
  assert.ok(peak > 0.01, `short render was silent (peak ${peak})`);
});
