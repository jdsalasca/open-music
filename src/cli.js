#!/usr/bin/env node
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { encodeMp3 } from './synth.js';
import { GALACTIC_META, renderGalactic } from './presets/galactic.js';

const PRESETS = {
  galactic: { ...GALACTIC_META, render: renderGalactic },
};

function parseArgs(argv) {
  const command = argv[0] ?? 'help';
  const options = { preset: 'galactic', out: 'examples/ram-orbital-suite.mp3', duration: 160, seed: 7, sampleRate: 44100 };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) continue;
    i += 1;
    if (key === 'preset') options.preset = value;
    else if (key === 'out') options.out = value;
    else if (key === 'duration') options.duration = Math.max(8, Number(value));
    else if (key === 'seed') options.seed = Math.max(1, Math.trunc(Number(value)));
    else if (key === 'sample-rate') options.sampleRate = Math.max(22050, Math.trunc(Number(value)));
  }
  return { command, options };
}

function help() {
  console.log(`open-music — deterministic procedural music

Usage:
  open-music presets
  open-music generate --preset galactic --out track.mp3 [--duration 160] [--seed 7]

Presets:
  ${Object.keys(PRESETS).join(', ')}

The output is original synthesis. No samples, no APIs, no copyright.
`);
}

function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === 'presets') {
    for (const [slug, preset] of Object.entries(PRESETS)) {
      console.log(`${slug.padEnd(12)} ${preset.bpm} BPM · ${preset.key} · ${preset.description}`);
    }
    return;
  }
  if (command !== 'generate') {
    help();
    process.exitCode = command === 'help' ? 0 : 1;
    return;
  }
  const preset = PRESETS[options.preset];
  if (!preset) {
    console.error(`Unknown preset "${options.preset}". Use: ${Object.keys(PRESETS).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const out = path.resolve(options.out);
  mkdirSync(path.dirname(out), { recursive: true });
  const isMp3 = out.toLowerCase().endsWith('.mp3');
  const tmp = mkdtempSync(path.join(tmpdir(), 'open-music-'));
  const wav = path.join(tmp, 'track.wav');
  const started = performance.now();
  console.log(`Rendering ${preset.name} · ${options.duration}s · ${options.sampleRate} Hz · seed ${options.seed}…`);
  const studio = preset.render({ seconds: options.duration, seed: options.seed, sampleRate: options.sampleRate });
  studio.writeWav(wav);
  if (isMp3) encodeMp3(wav, out);
  else copyFileSync(wav, out);
  rmSync(tmp, { recursive: true, force: true });
  const elapsed = ((performance.now() - started) / 1000).toFixed(1);
  const kb = Math.round(statSync(out).size / 1024);
  console.log(`Wrote ${out} · ${kb} KB · ${elapsed}s`);
  console.log(`Preset: ${preset.name} · ${preset.bpm} BPM · ${preset.key}`);
}

main();
