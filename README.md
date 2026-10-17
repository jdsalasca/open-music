# open-music

A tiny, deterministic music engine for the MUSEM rooms. It turns a seed into an original track: no samples, no APIs, no third-party rights.

```bash
node src/cli.js presets
node src/cli.js generate --preset galactic --out examples/ram-orbital-suite.mp3
```

## The first preset: `galactic`

`Orbital Suite` is original space-disco in D minor / dorian, 108 BPM, 160 seconds. Warm analog pads, syncopated bass, glass arpeggios and a wordless lead. It powers the **Random Access Memories** room at [musem.eridu.top/#dafk-punk-random-access-memory](https://musem.eridu.top/#dafk-punk-random-access-memory).

The track is generated from scratch. It contains no samples, no recordings and no compositions from *Random Access Memories*. It is an original atmosphere inspired by the record's palette, not a copy.

## How it works

- `src/synth.js` — oscillators, envelopes, one-pole filters, drums, vinyl, ping-pong delay, soft clip, WAV writer, ffmpeg MP3 encode.
- `src/presets/galactic.js` — 72 bars: intro, groove, break, final drop, outro.
- `src/cli.js` — `presets` and `generate`.

The render is synchronous and deterministic: the same seed produces the same audio. A 160-second stereo track renders in ~6 seconds on a laptop.

## CLI

```bash
open-music presets
open-music generate --preset galactic --out track.mp3
open-music generate --preset galactic --duration 60 --seed 42 --out sketch.mp3
```

Options:

| Flag | Default | Notes |
| --- | --- | --- |
| `--preset` | `galactic` | Only `galactic` for now. |
| `--out` | `examples/ram-orbital-suite.mp3` | `.mp3` encodes with loudnorm; `.wav` writes PCM 16-bit stereo. |
| `--duration` | `160` | Seconds. |
| `--seed` | `7` | Changes the performance without changing the style. |
| `--sample-rate` | `44100` | 22050–48000. |

Requires Node ≥ 22 and `ffmpeg` on `PATH` for MP3.

## Files

```text
open-music/
├── src/
│   ├── cli.js
│   ├── synth.js
│   └── presets/galactic.js
├── examples/
│   ├── ram-orbital-suite.mp3
│   ├── qa-spectrum.png
│   └── qa-wave.png
└── README.md
```

## License

MIT. The generated audio is yours to use, remix and publish. No attribution required, but a link back is nice.
