import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Studio } from '../src/synth.js';
import { truePeak } from '../src/dsp.js';
import { loadPresets } from '../src/cli.js';

const tmp = mkdtempSync(path.join(tmpdir(), 'open-music-render-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const presets = await loadPresets();

/** @param {Float32Array} a @param {Float32Array} b */
function sameSamples(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/** @param {Float32Array} buffer */
function peakOf(buffer) {
  let peak = 0;
  for (let i = 0; i < buffer.length; i += 1) peak = Math.max(peak, Math.abs(buffer[i]));
  return peak;
}

/** @param {Float32Array} buffer */
function rmsOf(buffer) {
  let sum = 0;
  for (let i = 0; i < buffer.length; i += 1) sum += buffer[i] * buffer[i];
  return Math.sqrt(sum / Math.max(1, buffer.length));
}

test('loadPresets discovers every preset with a valid contract', () => {
  assert.ok(presets.size >= 2, `expected at least 2 presets, found ${presets.size}`);
  for (const [slug, preset] of presets) {
    assert.equal(preset.meta.slug, slug);
    assert.equal(typeof preset.render, 'function');
    assert.ok(typeof preset.meta.name === 'string' && preset.meta.name.length > 0);
    assert.ok(Number.isFinite(preset.meta.bpm) && preset.meta.bpm > 20 && preset.meta.bpm < 300);
    assert.ok(typeof preset.meta.key === 'string' && preset.meta.key.length > 0);
    assert.ok(typeof preset.meta.description === 'string');
    assert.ok(typeof preset.meta.naturalSeconds() === 'number');
    assert.ok(Array.isArray(preset.meta.tracks), `${slug} must declare score tracks`);
    for (const track of preset.meta.tracks) {
      assert.ok(typeof track.name === 'string');
      assert.ok(Number.isInteger(track.program) && track.program >= 0 && track.program <= 127);
    }
  }
});

test('the galactic preset is still 160 seconds at its natural length', () => {
  assert.ok(Math.abs(presets.get('galactic').meta.naturalSeconds() - 160) < 0.01);
});

for (const [slug, preset] of presets) {
  test(`${slug}: renders deterministically for a given seed`, () => {
    const a = preset.render({ seconds: 8, seed: 11, sampleRate: 22050 });
    const b = preset.render({ seconds: 8, seed: 11, sampleRate: 22050 });
    assert.ok(sameSamples(a.master.left, b.master.left), 'left channel differs between identical renders');
    assert.ok(sameSamples(a.master.right, b.master.right), 'right channel differs between identical renders');
  });

  test(`${slug}: the seed changes the performance`, () => {
    const a = preset.render({ seconds: 8, seed: 1, sampleRate: 22050 });
    const b = preset.render({ seconds: 8, seed: 2, sampleRate: 22050 });
    assert.ok(!sameSamples(a.master.left, b.master.left), 'different seeds produced identical audio');
  });

  test(`${slug}: output is finite, audible and inside the ceiling`, () => {
    const studio = preset.render({ seconds: 10, seed: 5, sampleRate: 22050 });
    const { left, right } = studio.master;
    assert.equal(left.length, right.length);
    assert.ok(left.length > 0);
    for (let i = 0; i < left.length; i += 97) {
      assert.ok(Number.isFinite(left[i]), `NaN in left at ${i}`);
      assert.ok(Number.isFinite(right[i]), `NaN in right at ${i}`);
    }
    const peak = Math.max(peakOf(left), peakOf(right));
    assert.ok(peak <= 0.8911, `peak ${peak} exceeded the limiter ceiling`);
    // The reconstructed waveform must stay under 0 dBFS too, not just the samples.
    const interSample = truePeak(left, right);
    assert.ok(interSample <= 1, `true peak ${interSample} would clip on playback`);
    assert.ok(rmsOf(left) > 0.005, `track is effectively silent (rms ${rmsOf(left)})`);
    assert.ok(studio.stats.notes > 0, 'no notes were rendered');
  });

  test(`${slug}: fades to silence at both edges`, () => {
    const studio = preset.render({ seconds: 10, seed: 3, sampleRate: 22050 });
    const { left } = studio.master;
    assert.ok(Math.abs(left[0]) < 1e-6, `starts at ${left[0]}`);
    assert.ok(Math.abs(left[left.length - 1]) < 1e-6, `ends at ${left[left.length - 1]}`);
  });

  test(`${slug}: honours the requested duration within one bar`, () => {
    const studio = preset.render({ seconds: 12, seed: 3, sampleRate: 22050 });
    const seconds = studio.length / studio.sr;
    const bar = (preset.meta.beatsPerBar * 60) / preset.meta.bpm;
    assert.ok(Math.abs(seconds - 12) <= bar, `asked for 12s, got ${seconds}s`);
  });

  test(`${slug}: reaches the loudness target`, () => {
    const studio = preset.render({ seconds: 20, seed: 3, sampleRate: 22050 });
    assert.ok(Number.isFinite(studio.lufs), 'loudness was not measured');
    assert.ok(studio.lufs > -24 && studio.lufs < -8, `suspicious loudness ${studio.lufs} LUFS`);
  });

  test(`${slug}: writes a WAV and one stem per bus`, () => {
    const studio = preset.render({ seconds: 6, seed: 3, sampleRate: 22050, stems: true });
    const wav = path.join(tmp, `${slug}.wav`);
    studio.writeWav(wav);
    assert.ok(statSync(wav).size > 44, 'WAV has no audio data');
    const busDir = path.join(tmp, `${slug}-stems`);
    mkdirSync(busDir, { recursive: true });
    const written = studio.writeStems((name) => path.join(busDir, `${name}.wav`));
    assert.ok(written.length >= 2, `expected several buses, got ${written.length}`);
    for (const file of written) assert.ok(statSync(file).size > 44, `${file} has no audio data`);
  });

  test(`${slug}: keeps every section when the render is long enough`, () => {
    const form = preset.meta.form({ seconds: preset.meta.naturalSeconds() });
    const names = form.split(' ').map((entry) => entry.split(':')[0]);
    assert.ok(names.length >= 4, `form collapsed to ${form}`);
    for (const name of names) assert.ok(name.length > 0);
  });

  test(`${slug}: form bars always add up to the requested length`, () => {
    const bar = ((preset.meta.beatsPerBar ?? 4) * 60) / preset.meta.bpm;
    // A form whose sections share one tempo can be fitted to an exact bar
    // count. One that changes tempo per section can only land close, because
    // the same number of bars lasts a different number of seconds.
    const singleTempo = Math.abs((preset.meta.naturalSeconds?.() ?? 0) - preset.meta.bars * bar) < 0.5;
    for (const seconds of [15, 40, 90]) {
      const form = preset.meta.form({ seconds });
      const bars = form.split(' ').reduce((sum, entry) => sum + Number(entry.split(':')[1]), 0);
      const expected = Math.max(1, Math.round(seconds / bar));
      if (singleTempo) {
        assert.equal(bars, expected, `${slug} at ${seconds}s produced ${bars} bars, expected ${expected}`);
      } else {
        assert.ok(Math.abs(bars / expected - 1) < 0.2, `${slug} at ${seconds}s produced ${bars} bars, expected about ${expected}`);
      }
    }
  });
}

test('Studio keeps one shared bus unless stems are requested', () => {
  const shared = new Studio({ seconds: 1, sampleRate: 22050 });
  shared.kick(0, { bus: 'drums' });
  assert.equal(shared.buses.size, 1, 'should not allocate per-bus buffers by default');

  const split = new Studio({ seconds: 1, sampleRate: 22050, stems: true });
  split.kick(0, { bus: 'drums' });
  split.bass(0, 1, 55, { bus: 'bass' });
  assert.equal(split.buses.size, 3, 'main plus one bus per requested name');
});

test('Studio records the performance into an attached score', async () => {
  const { Score } = await import('../src/midi.js');
  const score = new Score({ bpm: 120, name: 'Recording test' });
  score.addTrack('lead', { program: 0 });
  score.addTrack('drums', { drum: true });
  const studio = new Studio({ seconds: 4, sampleRate: 22050, score });
  studio.lead(0, 1, 440, { midi: 69, track: 'lead' });
  studio.kick(0, { track: 'drums' });
  studio.kick(2, { track: 'drums' });
  assert.ok(score.duration > 0, 'score should have received notes');
  const buffer = score.toBuffer();
  assert.equal(buffer.toString('ascii', 0, 4), 'MThd');
});

test('the delay and reverb sends stay silent when no voice uses them', () => {
  const studio = new Studio({ seconds: 2, sampleRate: 22050 });
  studio.tone({ start: 0, duration: 0.5, freq: 440, gain: 0.2, reverb: 0, delay: 0 });
  studio.finish({ targetLufs: null, fadeOut: 0 });
  const { left } = studio.master;
  // After the note ends the buffer must be effectively silent, proving the
  // sends did not leak a tail. Not bit-exact zero: the DC blocker in the master
  // chain is an IIR filter, so its state decays exponentially rather than
  // vanishing.
  for (let i = Math.floor(0.8 * 22050); i < left.length; i += 13) {
    assert.ok(Math.abs(left[i]) < 1e-6, `residual ${left[i]} at ${i}`);
  }
});
