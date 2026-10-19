import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'src', 'cli.js');
const tmp = mkdtempSync(path.join(tmpdir(), 'open-music-cli-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

/**
 * @param {string[]} args
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function run(args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 180000 });
  if (result.error) throw result.error;
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** @returns {boolean} */
function hasFfmpeg() {
  const probe = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  return !probe.error && probe.status === 0;
}

test('no arguments prints help and succeeds', () => {
  const { status, stdout } = run([]);
  assert.equal(status, 0);
  assert.match(stdout, /Usage:/);
});

test('--help and -h succeed', () => {
  for (const flag of ['--help', '-h']) {
    const { status, stdout } = run([flag]);
    assert.equal(status, 0, `${flag} should exit 0`);
    assert.match(stdout, /generate/);
  }
});

test('unknown flags are a hard usage error instead of being ignored', () => {
  const { status, stderr } = run(['generate', '--duraton', '60']);
  assert.equal(status, 2, 'a typo must not silently render');
  assert.match(stderr, /Unknown flag/);
});

test('non-numeric values are rejected with a clear message instead of crashing', () => {
  for (const flag of ['--duration', '--seed', '--sample-rate']) {
    const { status, stderr } = run(['generate', flag, 'abc']);
    assert.equal(status, 2, `${flag} abc should be a usage error`);
    assert.match(stderr, /must be a number/, `${flag}: ${stderr}`);
    assert.doesNotMatch(stderr, /RangeError|at Studio|node:buffer/, `${flag} leaked a stack trace`);
  }
});

test('out-of-range numbers are rejected', () => {
  assert.equal(run(['generate', '--duration', '2']).status, 2);
  assert.equal(run(['generate', '--duration', '99999']).status, 2);
  assert.equal(run(['generate', '--sample-rate', '96000']).status, 2);
  assert.equal(run(['generate', '--sample-rate', '8000']).status, 2);
  assert.equal(run(['generate', '--seed', '0']).status, 2);
});

test('a flag that needs a value reports it', () => {
  const { status, stderr } = run(['generate', '--out']);
  assert.equal(status, 2);
  assert.match(stderr, /needs a value/);
});

test('an unknown preset lists the available ones', () => {
  const { status, stderr } = run(['generate', '--preset', 'nope']);
  assert.equal(status, 2);
  assert.match(stderr, /Unknown preset/);
  assert.match(stderr, /galactic/);
});

test('an unknown command is a usage error', () => {
  assert.equal(run(['explode']).status, 2);
});

test('presets lists every preset, in text and in JSON', () => {
  const text = run(['presets']);
  assert.equal(text.status, 0);
  assert.match(text.stdout, /galactic/);
  assert.match(text.stdout, /dark-fantasy/);

  const json = run(['presets', '--json']);
  assert.equal(json.status, 0);
  const parsed = JSON.parse(json.stdout);
  assert.ok(Array.isArray(parsed));
  const slugs = parsed.map((p) => p.slug);
  assert.ok(slugs.includes('galactic'));
  assert.ok(slugs.includes('dark-fantasy'));
  for (const preset of parsed) {
    assert.ok(Number.isFinite(preset.bpm));
    assert.ok(preset.seconds > 0);
  }
});

test('form prints the section layout for a duration', () => {
  const { status, stdout } = run(['form', '--preset', 'galactic', '--duration', '60']);
  assert.equal(status, 0);
  assert.match(stdout, /intro:\d+/);
  const json = run(['form', '--preset', 'galactic', '--duration', '60', '--json']);
  assert.equal(json.status, 0);
  const parsed = JSON.parse(json.stdout);
  const bars = parsed.form.split(' ').reduce((sum, entry) => sum + Number(entry.split(':')[1]), 0);
  assert.equal(bars, Math.round(60 / ((4 * 60) / 108)));
});

test('generate writes a WAV with the requested sample rate', () => {
  const out = path.join(tmp, 'short.wav');
  const { status, stdout } = run(['generate', '--preset', 'galactic', '--duration', '5', '--sample-rate', '22050', '--seed', '9', '--out', out]);
  assert.equal(status, 0, stdout);
  assert.ok(existsSync(out));
  const buffer = readFileSync(out);
  assert.equal(buffer.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buffer.toString('ascii', 8, 12), 'WAVE');
  assert.equal(buffer.readUInt32LE(24), 22050, 'WAV header sample rate');
  assert.ok(buffer.length > 44);
  assert.match(stdout, /Wrote/);
});

test('generate --json emits a machine-readable summary', () => {
  const out = path.join(tmp, 'json.wav');
  const { status, stdout } = run(['generate', '--preset', 'dark-fantasy', '--duration', '6', '--sample-rate', '22050', '--out', out, '--json']);
  assert.equal(status, 0, stdout);
  const summary = JSON.parse(stdout);
  assert.equal(summary.preset, 'dark-fantasy');
  assert.ok(summary.notes > 0);
  assert.ok(summary.seconds >= 6);
  assert.ok(Number.isFinite(summary.lufs));
  assert.match(summary.form, /:/);
});

test('generate --quiet prints nothing on success', () => {
  const out = path.join(tmp, 'quiet.wav');
  const { status, stdout } = run(['generate', '--preset', 'galactic', '--duration', '5', '--sample-rate', '22050', '--out', out, '--quiet']);
  assert.equal(status, 0);
  assert.equal(stdout.trim(), '');
});

test('generate --midi also writes a Standard MIDI File', () => {
  const out = path.join(tmp, 'song.wav');
  const midi = path.join(tmp, 'song.mid');
  const { status, stdout } = run(['generate', '--preset', 'galactic', '--duration', '8', '--sample-rate', '22050', '--out', out, '--midi', midi]);
  assert.equal(status, 0, stdout);
  assert.ok(existsSync(midi), 'MIDI file was not written');
  const buffer = readFileSync(midi);
  assert.equal(buffer.toString('ascii', 0, 4), 'MThd');
  assert.ok(buffer.length > 30);
});

test('the exported MIDI gives every melodic track its own channel', () => {
  const out = path.join(tmp, 'channels.wav');
  const midi = path.join(tmp, 'channels.mid');
  const { status, stdout } = run(['generate', '--preset', 'galactic', '--duration', '6', '--sample-rate', '22050', '--out', out, '--midi', midi]);
  assert.equal(status, 0, stdout);
  const buffer = readFileSync(midi);
  const declared = buffer.readUInt16BE(10);
  let offset = 14;
  const channels = [];
  for (let t = 0; t < declared; t += 1) {
    const length = buffer.readUInt32BE(offset + 4);
    const track = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 8 + length;
    let index = 0;
    let running = null;
    let name = '';
    let channel = null;
    while (index < track.length) {
      let byte = 0;
      do {
        byte = track[index];
        index += 1;
      } while (byte & 0x80);
      let statusByte = track[index];
      if (statusByte & 0x80) {
        index += 1;
        running = statusByte;
      } else {
        statusByte = running;
      }
      if (statusByte === 0xff) {
        const type = track[index];
        index += 1;
        let metaLength = 0;
        do {
          byte = track[index];
          metaLength = (metaLength << 7) | (byte & 0x7f);
          index += 1;
        } while (byte & 0x80);
        if (type === 0x03) name = track.subarray(index, index + metaLength).toString('latin1');
        index += metaLength;
      } else {
        const kind = statusByte & 0xf0;
        channel = statusByte & 0x0f;
        index += kind === 0xc0 || kind === 0xd0 ? 1 : 2;
      }
    }
    if (name) channels.push({ name, channel });
  }
  assert.ok(channels.length >= 3, `expected several named tracks, got ${channels.length}`);
  const melodic = channels.filter((c) => c.name !== 'drums');
  const used = melodic.map((c) => c.channel);
  assert.equal(new Set(used).size, used.length, `melodic tracks share a channel: ${JSON.stringify(melodic)}`);
  for (const track of channels) {
    if (track.name === 'drums') assert.equal(track.channel, 9, 'drums must be on channel 9');
  }
});

test('generate --stems writes one WAV per instrument bus', () => {
  const out = path.join(tmp, 'stems', 'song.wav');
  mkdirSync(path.dirname(out), { recursive: true });
  const { status, stdout } = run(['generate', '--preset', 'galactic', '--duration', '6', '--sample-rate', '22050', '--out', out, '--stems']);
  assert.equal(status, 0, stdout);
  assert.ok(existsSync(path.join(tmp, 'stems', 'song.bass.wav')), 'bass stem missing');
  assert.ok(existsSync(path.join(tmp, 'stems', 'song.drums.wav')), 'drum stem missing');
  assert.ok(existsSync(path.join(tmp, 'stems', 'song.pads.wav')), 'pad stem missing');
});

test('the default output path lands in the working directory, not inside the package', () => {
  const dir = path.join(tmp, 'cwd');
  mkdirSync(dir, { recursive: true });
  const result = spawnSync(process.execPath, [CLI, 'generate', '--preset', 'galactic', '--duration', '5', '--sample-rate', '22050', '--quiet'], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 180000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(existsSync(path.join(dir, 'galactic.mp3')) || existsSync(path.join(dir, 'galactic.wav')));
});

test('mp3 output keeps the requested sample rate', { skip: !hasFfmpeg() }, () => {
  const out = path.join(tmp, 'rate.mp3');
  const { status, stdout } = run(['generate', '--preset', 'galactic', '--duration', '5', '--sample-rate', '44100', '--out', out]);
  assert.equal(status, 0, stdout);
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=sample_rate', '-of', 'default=noprint_wrappers=1:nokey=1', out], { encoding: 'utf8' });
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.stdout.trim(), '44100', 'loudnorm used to resample this to 48000');
});
