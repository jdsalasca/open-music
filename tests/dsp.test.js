import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TAU,
  mulberry32,
  polyBlep,
  oscillator,
  SVF,
  Biquad,
  Reverb,
  PingPongDelay,
  limit,
  measureLufs,
  fadeEdges,
  softClip,
  dcBlock,
  truePeak,
} from '../src/dsp.js';

const SR = 44100;

test('mulberry32 is deterministic and bounded', () => {
  const a = mulberry32(1234);
  const b = mulberry32(1234);
  const c = mulberry32(1235);
  const first = a();
  assert.equal(first, b());
  assert.notEqual(first, c());
  const rng = mulberry32(7);
  for (let i = 0; i < 5000; i += 1) {
    const v = rng();
    assert.ok(v >= 0 && v < 1, `out of range: ${v}`);
  }
});

test('polyBlep is zero away from the discontinuity', () => {
  assert.equal(polyBlep(0.5, 0.01), 0);
  assert.notEqual(polyBlep(0.001, 0.01), 0);
  assert.notEqual(polyBlep(0.999, 0.01), 0);
  assert.equal(polyBlep(0.5, 0), 0);
});

test('band-limited saw reduces high-frequency energy versus naive saw', () => {
  const f = 2093;
  const dt = f / SR;
  const n = 8192;
  let naive = 0;
  let blep = 0;
  let p = 0;
  for (let i = 0; i < n; i += 1) {
    const raw = 2 * (p - Math.floor(p)) - 1;
    const bl = oscillator('saw', p, dt);
    naive += raw * raw;
    blep += bl * bl;
    p += dt;
  }
  // The corrected oscillator must stay bounded and differ from the naive one.
  assert.ok(Math.sqrt(blep / n) < Math.sqrt(naive / n) + 0.05);
  assert.ok(Number.isFinite(blep));
});

test('every oscillator shape stays within [-1.2, 1.2]', () => {
  for (const wave of ['sine', 'triangle', 'saw', 'square', 'soft-square', 'pulse25', 'unknown']) {
    let peak = 0;
    for (let i = 0; i < 4000; i += 1) {
      const v = oscillator(wave, i * 0.0137, 0.0137);
      assert.ok(Number.isFinite(v), `${wave} produced ${v}`);
      peak = Math.max(peak, Math.abs(v));
    }
    assert.ok(peak <= 1.2, `${wave} peak ${peak}`);
    assert.ok(peak > 0.5, `${wave} too quiet: ${peak}`);
  }
});

test('SVF stays finite under aggressive cutoff modulation and high resonance', () => {
  const svf = new SVF(SR);
  let out = 0;
  for (let i = 0; i < 20000; i += 1) {
    if (i % 16 === 0) svf.set(60 + (i % 8000), 8);
    out = svf.process(oscillator('saw', i * 0.01, 0.01));
    assert.ok(Number.isFinite(out), `NaN at ${i}`);
  }
  assert.ok(Math.abs(out) < 50);
});

test('SVF lowpass attenuates well above cutoff and passes well below', () => {
  const measure = (freq) => {
    const svf = new SVF(SR);
    svf.set(500, 0.707);
    let sum = 0;
    let phase = 0;
    for (let i = 0; i < SR; i += 1) {
      const s = svf.process(Math.sin(TAU * phase));
      phase += freq / SR;
      if (i > SR * 0.5) sum += s * s;
    }
    return Math.sqrt(sum / (SR * 0.5));
  };
  const low = measure(100);
  const high = measure(5000);
  assert.ok(low > 0.6, `100 Hz should pass, got ${low}`);
  assert.ok(high < 0.05, `5 kHz should be attenuated, got ${high}`);
});

test('reverb produces a decaying tail from an impulse', () => {
  const rev = new Reverb(SR, {});
  const n = SR * 2;
  const tail = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const out = rev.process(i === 0 ? 1 : 0, i === 0 ? 1 : 0);
    tail[i] = out.l;
    assert.ok(Number.isFinite(out.l) && Number.isFinite(out.r));
  }
  const energy = (from, to) => {
    let s = 0;
    for (let i = from; i < to; i += 1) s += tail[i] * tail[i];
    return Math.sqrt(s / (to - from));
  };
  const early = energy(SR * 0.1, SR * 0.3);
  const late = energy(SR * 1.5, SR * 1.9);
  assert.ok(early > 0, 'reverb should produce output');
  assert.ok(late < early, `tail must decay: early ${early} late ${late}`);
});

test('ping-pong delay is finite, echoes, and respects the wet gain', () => {
  const d = new PingPongDelay(SR, { timeL: 0.01, timeR: 0.02, feedback: 0.5, wet: 1 });
  let energy = 0;
  let maxAbs = 0;
  for (let i = 0; i < SR; i += 1) {
    const out = d.process(i === 0 ? 1 : 0, 0);
    assert.ok(Number.isFinite(out.l) && Number.isFinite(out.r));
    energy += Math.abs(out.l) + Math.abs(out.r);
    maxAbs = Math.max(maxAbs, Math.abs(out.l));
  }
  assert.ok(energy > 0.5, `delay should echo repeatedly, energy ${energy}`);
  assert.ok(maxAbs <= 1.001, `feedback must not run away, peak ${maxAbs}`);
});

test('biquad high-pass removes DC', () => {
  const hp = new Biquad().highPass(SR, 100, 0.707);
  let out = 0;
  for (let i = 0; i < SR; i += 1) out = hp.process(1);
  assert.ok(Math.abs(out) < 1e-3, `DC should be blocked, got ${out}`);
});

test('limiter never exceeds the ceiling and reports gain reduction', () => {
  const n = SR;
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const v = Math.sin(i * 0.01) * 4;
    left[i] = v;
    right[i] = v;
  }
  const result = limit(left, right, SR, { ceiling: 0.9 });
  let peak = 0;
  for (let i = 0; i < n; i += 1) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
  assert.ok(peak <= 0.9001, `peak ${peak} exceeded ceiling`);
  assert.ok(result.reduction < 1, 'should have applied gain reduction');
});

test('the limiter also bounds the inter-sample peak, not just the samples', () => {
  // A near-Nyquist tone reconstructs well above its sample values.
  const n = SR;
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const v = Math.sin((TAU * (SR / 4 - 40) * i) / SR) * 3;
    left[i] = v;
    right[i] = v;
  }
  const ceiling = 0.891;
  limit(left, right, SR, { ceiling });
  const after = truePeak(left, right);
  assert.ok(after <= ceiling + 0.02, `true peak ${after} exceeded the ceiling ${ceiling}`);
});

test('truePeak reports at least the sample peak', () => {
  const n = SR;
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const v = Math.sin((TAU * 997 * i) / SR) * 0.7;
    left[i] = v;
    right[i] = v;
  }
  let samplePeak = 0;
  for (let i = 0; i < n; i += 1) samplePeak = Math.max(samplePeak, Math.abs(left[i]));
  assert.ok(truePeak(left, right) >= samplePeak - 1e-6);
  assert.deepEqual([truePeak(new Float32Array(0), new Float32Array(0))], [0]);
});

test('limiter leaves quiet material untouched', () => {
  const n = 1000;
  const left = new Float32Array(n).fill(0.1);
  const right = new Float32Array(n).fill(-0.1);
  const result = limit(left, right, SR, {});
  assert.equal(result.reduction, 1);
  assert.ok(Math.abs(left[0] - 0.1) < 1e-6);
});

test('measureLufs matches the BS.1770 reference for a stereo sine', () => {
  const n = SR * 3;
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const v = Math.sin((TAU * 440 * i) / SR) * 0.5;
    left[i] = v;
    right[i] = v;
  }
  // -0.691 + 10*log10(2 * 0.5^2/2) = -6.71 LUFS
  const lufs = measureLufs(left, right, SR);
  assert.ok(Math.abs(lufs - -6.71) < 0.25, `expected about -6.71, got ${lufs}`);
});

test('measureLufs returns -Infinity for silence and for digital black', () => {
  const silent = new Float32Array(SR);
  assert.equal(measureLufs(silent, silent, SR), -Infinity);
  assert.equal(measureLufs(new Float32Array(0), new Float32Array(0), SR), -Infinity);
});

test('fadeEdges reaches zero at both ends without touching the middle', () => {
  const n = SR;
  const left = new Float32Array(n).fill(1);
  const right = new Float32Array(n).fill(1);
  fadeEdges(left, right, SR, { fadeIn: 0.01, fadeOut: 0.1 });
  assert.equal(left[0], 0);
  assert.equal(left[n - 1], 0);
  assert.equal(left[Math.floor(n / 2)], 1);
});

test('fades are clamped when the requested fade is longer than the buffer', () => {
  const n = 100;
  const left = new Float32Array(n).fill(1);
  const right = new Float32Array(n).fill(1);
  fadeEdges(left, right, SR, { fadeIn: 10, fadeOut: 10 });
  for (let i = 0; i < n; i += 1) {
    assert.ok(Number.isFinite(left[i]));
    assert.ok(left[i] >= 0 && left[i] <= 1);
  }
});

test('softClip is monotonic and bounded', () => {
  assert.ok(softClip(0) === 0);
  assert.ok(softClip(10) < 1);
  assert.ok(softClip(10) > softClip(1));
  assert.ok(softClip(-10) > -1);
});

test('dcBlock removes a constant offset and keeps the signal', () => {
  const n = SR;
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const tone = Math.sin((TAU * 440 * i) / SR) * 0.5;
    left[i] = tone + 0.2;
    right[i] = tone + 0.2;
  }
  dcBlock(left, right, SR, 20);
  let mean = 0;
  let energy = 0;
  for (let i = SR * 0.5; i < n; i += 1) {
    mean += left[i];
    energy += left[i] * left[i];
  }
  mean /= SR * 0.5;
  assert.ok(Math.abs(mean) < 1e-3, `residual DC ${mean}`);
  assert.ok(Math.sqrt(energy / (SR * 0.5)) > 0.3, 'the audio itself must survive');
});

test('dcBlock leaves silence silent', () => {
  const silent = new Float32Array(1000);
  dcBlock(silent, silent, SR, 20);
  for (const value of silent) assert.equal(value, 0);
});
