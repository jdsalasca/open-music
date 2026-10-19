#!/usr/bin/env node
/**
 * cli.js — command line interface for open-music.
 *
 * Exit codes: 0 success, 1 runtime failure, 2 usage error.
 */

import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { encodeMp3 } from './synth.js';
import { Score } from './midi.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRESET_DIR = path.join(HERE, 'presets');

const MIN_SAMPLE_RATE = 22050;
const MAX_SAMPLE_RATE = 48000;
const MIN_DURATION = 4;
const MAX_DURATION = 1800;

class UsageError extends Error {}

/** Flags that take a value. */
const VALUE_FLAGS = new Set(['preset', 'out', 'duration', 'seconds', 'seed', 'sample-rate', 'midi']);
/** Flags that are switches. */
const BOOL_FLAGS = new Set(['stems', 'quiet', 'json', 'help', 'list']);

/**
 * Strict argument parser: unknown flags and malformed values are hard errors
 * instead of being silently ignored.
 * @param {string[]} argv
 * @returns {{ command: string, options: Record<string, any>, flags: Set<string> }}
 */
export function parseArgs(argv) {
  const flags = new Set();
  const raw = new Map();
  let command = 'help';
  let index = 0;
  if (argv.length > 0 && !argv[0].startsWith('-')) {
    command = argv[0];
    index = 1;
  }
  for (; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('-')) throw new UsageError(`Unexpected argument "${arg}"`);
    let key = arg.replace(/^--?/, '');
    let value;
    const eq = key.indexOf('=');
    if (eq !== -1) {
      value = key.slice(eq + 1);
      key = key.slice(0, eq);
    }
    if (key === 'h') key = 'help';
    if (key === 'v') key = 'version';
    if (key === 'version') {
      flags.add('version');
      continue;
    }
    if (BOOL_FLAGS.has(key)) {
      if (value !== undefined) throw new UsageError(`Flag --${key} does not take a value`);
      flags.add(key);
      continue;
    }
    if (!VALUE_FLAGS.has(key)) throw new UsageError(`Unknown flag "${arg}". Run "open-music help" for usage.`);
    if (value === undefined) {
      value = argv[index + 1];
      if (value === undefined || (value.startsWith('-') && !/^-\d/.test(value))) {
        throw new UsageError(`Flag --${key} needs a value`);
      }
      index += 1;
    }
    raw.set(key, value);
  }

  const options = {
    preset: 'galactic',
    out: null,
    duration: null,
    seed: 7,
    sampleRate: 44100,
  };

  if (raw.has('preset')) options.preset = String(raw.get('preset'));
  if (raw.has('out')) options.out = String(raw.get('out'));
  const durationRaw = raw.get('duration') ?? raw.get('seconds');
  if (durationRaw !== undefined) options.duration = parseNumber(durationRaw, 'duration', MIN_DURATION, MAX_DURATION);
  if (raw.has('seed')) options.seed = Math.trunc(parseNumber(raw.get('seed'), 'seed', 1, 4294967295));
  if (raw.has('sample-rate')) {
    options.sampleRate = Math.trunc(parseNumber(raw.get('sample-rate'), 'sample-rate', MIN_SAMPLE_RATE, MAX_SAMPLE_RATE));
  }
  if (raw.has('midi')) options.midi = String(raw.get('midi'));
  return { command, options, flags };
}

/**
 * @param {string} value @param {string} name @param {number} min @param {number} max
 * @returns {number}
 */
function parseNumber(value, name, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new UsageError(`--${name} must be a number, got "${value}"`);
  if (n < min || n > max) throw new UsageError(`--${name} must be between ${min} and ${max}, got ${n}`);
  return n;
}

/**
 * Discovers preset modules in `src/presets/`, so adding a file is enough to
 * add a preset.
 * @returns {Promise<Map<string, { meta: object, render: Function, file: string }>>}
 */
export async function loadPresets() {
  const presets = new Map();
  const files = readdirSync(PRESET_DIR)
    .filter((f) => f.endsWith('.js'))
    .sort();
  for (const file of files) {
    const full = path.join(PRESET_DIR, file);
    const mod = await import(pathToFileURL(full).href);
    if (typeof mod.render !== 'function') throw new Error(`Preset "${file}" does not export a render() function`);
    if (!mod.meta || typeof mod.meta !== 'object') throw new Error(`Preset "${file}" does not export a meta object`);
    const slug = mod.meta.slug ?? path.basename(file, '.js');
    if (!/^[a-z0-9-]+$/.test(slug)) throw new Error(`Preset "${file}" has an invalid slug "${slug}"`);
    if (presets.has(slug)) throw new Error(`Duplicate preset slug "${slug}"`);
    presets.set(slug, { ...mod, meta: { ...mod.meta, slug }, file });
  }
  return presets;
}

function help() {
  const lines = [
    'open-music — deterministic procedural music',
    '',
    'Usage:',
    '  open-music presets [--json]',
    '  open-music form --preset <slug> [--duration <seconds>]',
    '  open-music generate --preset <slug> [options]',
    '',
    'Generate options:',
    '  --preset <slug>       preset to render (default: galactic)',
    '  --out <file>          output path; .mp3 encodes with ffmpeg, .wav writes PCM',
    '  --duration <seconds>  target length, 4..1800 (alias: --seconds)',
    '  --seed <integer>      changes the performance, not the style',
    `  --sample-rate <hz>    ${MIN_SAMPLE_RATE}..${MAX_SAMPLE_RATE} (default: 44100)`,
    '  --midi <file>         also write a Standard MIDI File of the performance',
    '  --stems               also write one WAV per instrument bus',
    '  --json                print a machine-readable summary',
    '  --quiet               suppress progress output',
    '',
    'The output is original synthesis. No samples, no APIs, no copyright.',
  ];
  console.log(lines.join('\n'));
}

/**
 * @param {Map<string, any>} presets
 * @param {Record<string, any>} options
 * @returns {string}
 */
function resolveOut(presets, options) {
  if (options.out) return path.resolve(options.out);
  return path.resolve(`${options.preset}.mp3`);
}

/**
 * @param {object} args
 * @returns {Promise<number>} exit code
 */
async function main() {
  const argv = process.argv.slice(2);
  const { command, options, flags } = parseArgs(argv);
  const asJson = flags.has('json');
  // JSON output must be parseable, so it implies quiet progress.
  const quiet = flags.has('quiet') || asJson;

  if (flags.has('version')) {
    console.log('open-music 0.2.0');
    return 0;
  }
  if (flags.has('help') || command === 'help') {
    help();
    return 0;
  }

  const presets = await loadPresets();

  if (command === 'presets' || command === 'list') {
    if (asJson) {
      console.log(
        JSON.stringify(
          [...presets.values()].map((p) => ({
            slug: p.meta.slug,
            name: p.meta.name,
            bpm: p.meta.bpm,
            key: p.meta.key,
            description: p.meta.description,
            seconds: p.meta.naturalSeconds?.() ?? null,
          })),
          null,
          2,
        ),
      );
    } else {
      for (const { meta } of presets.values()) {
        const seconds = meta.naturalSeconds?.();
        const length = seconds ? ` · ${Math.round(seconds)}s` : '';
        console.log(`${meta.slug.padEnd(14)} ${String(meta.bpm).padStart(3)} BPM · ${meta.key}${length}`);
        console.log(`${' '.repeat(14)} ${meta.description}`);
      }
    }
    return 0;
  }

  const preset = presets.get(options.preset);
  if (!preset) {
    throw new UsageError(`Unknown preset "${options.preset}". Available: ${[...presets.keys()].join(', ')}`);
  }

  if (command === 'form') {
    const description = preset.meta.form?.({ seconds: options.duration ?? undefined }) ?? 'not available';
    if (asJson) console.log(JSON.stringify({ preset: preset.meta.slug, form: description, seconds: options.duration ?? null }, null, 2));
    else console.log(`${preset.meta.name}: ${description}`);
    return 0;
  }

  if (command !== 'generate') {
    throw new UsageError(`Unknown command "${command}". Run "open-music help".`);
  }

  const out = resolveOut(presets, options);
  mkdirSync(path.dirname(out), { recursive: true });
  const isMp3 = out.toLowerCase().endsWith('.mp3');

  // Build the score up front so the render can record its own performance.
  const wantsMidi = Boolean(options.midi);
  let score = null;
  if (wantsMidi && Array.isArray(preset.meta.tracks)) {
    score = new Score({ bpm: preset.meta.bpm, name: preset.meta.name });
    // Every melodic track needs its own MIDI channel: sharing one would make
    // each program change override the previous instrument.
    let nextChannel = 0;
    for (const track of preset.meta.tracks) {
      const drum = track.drum ?? false;
      let channel = track.channel;
      if (channel == null) {
        if (drum) {
          channel = 9;
        } else {
          while (nextChannel === 9) nextChannel = (nextChannel + 1) % 16;
          channel = nextChannel;
          nextChannel = (nextChannel + 1) % 16;
        }
      }
      score.addTrack(track.name, { program: track.program ?? 0, channel, drum });
    }
  }

  const tmp = mkdtempSync(path.join(tmpdir(), 'open-music-'));
  const started = performance.now();
  try {
    if (!quiet) {
      const target = options.duration ? `${options.duration}s` : 'natural length';
      console.log(`Rendering ${preset.meta.name} · ${target} · ${options.sampleRate} Hz · seed ${options.seed}…`);
    }

    const studio = preset.render({
      seconds: options.duration ?? undefined,
      seed: options.seed,
      sampleRate: options.sampleRate,
      stems: flags.has('stems'),
      score,
    });

    const wav = path.join(tmp, 'track.wav');
    studio.writeWav(wav);

    if (isMp3) {
      encodeMp3(wav, out, {
        sampleRate: options.sampleRate,
        title: preset.meta.name,
        artist: 'open-music',
        album: 'open-music',
        comment: `preset=${preset.meta.slug} seed=${options.seed}`,
      });
    } else {
      copyFileSync(wav, out);
    }

    const stemPaths = [];
    if (flags.has('stems')) {
      const base = out.replace(/\.(mp3|wav)$/i, '');
      for (const file of studio.writeStems((name) => `${base}.${name}.wav`)) stemPaths.push(file);
    }

    let midiPath = null;
    if (wantsMidi) {
      if (!score) throw new UsageError(`Preset "${preset.meta.slug}" declares no tracks, so --midi is unavailable`);
      const target = options.midi === '' ? out.replace(/\.(mp3|wav)$/i, '.mid') : path.resolve(options.midi);
      midiPath = score.write(target);
    }

    const elapsed = (performance.now() - started) / 1000;
    const size = statSync(out).size;
    const summary = {
      preset: preset.meta.slug,
      name: preset.meta.name,
      out,
      midi: midiPath,
      stems: stemPaths,
      seconds: Number((studio.length / studio.sr).toFixed(3)),
      sampleRate: options.sampleRate,
      seed: options.seed,
      bpm: preset.meta.bpm,
      key: preset.meta.key,
      form: preset.meta.form?.({ seconds: options.duration ?? undefined }) ?? null,
      notes: studio.stats.notes,
      lufs: Number.isFinite(studio.lufs) ? Number(studio.lufs.toFixed(2)) : null,
      bytes: size,
      elapsed: Number(elapsed.toFixed(2)),
    };

    if (asJson) {
      console.log(JSON.stringify(summary, null, 2));
    } else if (!quiet) {
      console.log(`Wrote ${out} · ${Math.round(size / 1024)} KB · ${elapsed.toFixed(1)}s`);
      if (midiPath) console.log(`Wrote ${midiPath}`);
      for (const file of stemPaths) console.log(`Wrote ${file}`);
      console.log(`${summary.seconds}s · ${summary.notes} notes · ${summary.lufs} LUFS`);
      if (summary.form) console.log(`Form: ${summary.form}`);
    }
    return 0;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      if (error instanceof UsageError) {
        console.error(`error: ${error.message}`);
        process.exitCode = 2;
      } else {
        console.error(`error: ${error.message}`);
        process.exitCode = 1;
      }
    });
}
