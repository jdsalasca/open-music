# open-music

A tiny, deterministic music engine. It turns a seed into an original track — **no samples, no APIs, no third-party rights**.

```bash
node src/cli.js presets
node src/cli.js generate --preset galactic --out orbital-suite.mp3
node src/cli.js generate --preset dark-fantasy --out dark-fantasy-suite.mp3 --midi suite.mid
node src/cli.js generate --preset symphony --out symphony-c-minor.mp3 --midi symphony.mid
```

Zero dependencies. Only Node and (optionally) `ffmpeg` for MP3.

## Presets

| Slug | Piece | Style | Length |
| --- | --- | --- | --- |
| `galactic` | Orbital Suite | Space disco in D dorian, 108 BPM | 160 s |
| `dark-fantasy` | Dark Fantasy Suite | Cinematic orchestral soul in F minor, 72 BPM | 267 s |
| `bound-soul` | Bound Soul | Chopped soul in B-flat major, 94 BPM | 204 s |
| `symphony` | Symphony in C minor | Sonata form for full orchestra, 60 → 132 BPM | 355 s |

### `galactic` — Orbital Suite

Warm analog pads, syncopated bass, glass arpeggios and a wordless lead. It powers the **Random Access Memories** room at [musem.eridu.top/#dafk-punk-random-access-memory](https://musem.eridu.top/#dafk-punk-random-access-memory).

An original atmosphere inspired by the palette of cosmic disco and that record. It contains no samples, no recordings and no compositions from *Random Access Memories*.

### `dark-fantasy` — Dark Fantasy Suite

Grand piano, legato strings, brass fanfares, wordless choir, timpani, tam-tam and half-time drums, built on chromatic-mediant harmony. Seven sections — overture, ascension, fanfare, procession, interlude, climax, coda — over 80 bars.

Inspired by the *production aesthetic* of maximalist, opulent orchestral hip-hop, the register of records like Kanye West's *My Beautiful Dark Twisted Fantasy*: weight, drama and sudden dynamic contrast. Every note is generated from the seed — there are no samples, no interpolations and no quotations of any existing recording or composition.

```bash
node src/cli.js form --preset dark-fantasy
# Dark Fantasy Suite: overture:8 ascension:8 fanfare:16 procession:16 interlude:8 climax:16 coda:8
```

### `bound-soul` — Bound Soul

Chopped soul: a staccato Rhodes comp, a round electric bass, a doo-wop vocal loop on the offbeats, a sung hook, string swells, tambourine and laid-back boom-bap drums with swung eighths. Eighty bars over two eight-bar turnarounds — I–vi–ii–V in the verses, I–vi–IV–V in the hooks, the borrowed IV being what makes a soul progression lift.

The Rhodes is real synthesis: two-operator FM with a modulation index that decays fast enough to give the bell-like tine attack before settling into a mellow body, plus the suitcase tremolo. Chops drift a few cents and land a hair off the grid on purpose.

Inspired by the production aesthetic of chopped-soul, gospel-tinged, sample-based hip-hop — the register of a record like Kanye West's "Bound 2". Every note is generated from the seed: no samples, no interpolations, no quotations.

```bash
node src/cli.js form --preset bound-soul
# Bound Soul: intro:8 verse:16 hook:16 break:8 hook2:16 outro:16
```

### `symphony` — Symphony in C minor

A single symphonic movement in sonata form, in the Viennese Classical language. Five string sections, double woodwind, three brass and timpani — fourteen parts, all synthesised.

| Section | What happens |
| --- | --- |
| **Grave** | C minor, 60 BPM. Tremolo violins over a tonic pedal, a horn call, a chromatic rise in the cellos, then a dominant pedal that swells and stops. |
| **Exposition** | 132 BPM. First theme (a rising arpeggio through the leading tone) in C minor; a transition that sequences it up a fourth; a lyrical second theme in E flat major for oboe and flute; a full-orchestra codetta. |
| **Development** | The motif in sequence through A flat, F minor and G minor, then a stretto where the violins and winds imitate each other while the brass joins, climaxing on a diminished seventh. |
| **Recapitulation** | Both themes return, the second one now in the tonic — the point of the form. |
| **Coda** | A final build, the cadence hammered home, and a Picardy third: the minor turns major for the last chord. |

The sections run at **different tempi** (60 for the grave, 132 for the allegro), which the arrangement supports per section, so the movement is 5:55 at its natural length.

An original composition in the Classical style: the thematic material is a deliberately simple motivic cell developed by transposition, inversion and sequence — the technique of the period, not a quotation of any existing work. No samples and no material from any recording.

```bash
node src/cli.js form --preset symphony
# Symphony in C minor: grave:16 exposition:48 development:40 recapitulation:48 coda:24
```

## CLI

```bash
open-music presets [--json]                 # list presets
open-music form --preset <slug> [--duration <s>]   # show the section layout
open-music generate --preset <slug> [options]
```

| Flag | Default | Notes |
| --- | --- | --- |
| `--preset` | `galactic` | Any file in `src/presets/`. |
| `--out` | `./<preset>.mp3` | `.mp3` encodes with ffmpeg; `.wav` writes PCM 16-bit stereo. |
| `--duration` | preset length | Seconds, 4–1800. Alias: `--seconds`. Sections are rescaled to fit. |
| `--seed` | `7` | Changes the performance — timing, dynamics, figures — not the style. |
| `--sample-rate` | `44100` | 22050–48000. The MP3 keeps this rate. |
| `--midi` | off | Also write a Standard MIDI File of the performance. |
| `--stems` | off | Also write one WAV per instrument bus. |
| `--json` | off | Machine-readable summary on stdout. |
| `--quiet` | off | Suppress progress output. |

Exit codes: `0` success, `1` runtime failure, `2` usage error.

The duration is honoured by **rescaling the form**, not by truncating it. `--duration 45` on the orchestral preset still gets an overture, a climax and a coda, proportionally shortened.

## How it works

```text
src/
├── dsp.js          PolyBLEP oscillators, TPT state-variable filter, reverb,
│                   tempo-synced ping-pong delay, true-peak limiter, LUFS
├── synth.js        Studio: buses, sends, ~26 voices, mixdown, WAV writer, ffmpeg
├── theory.js       Notes, scales, chords, roman numerals, voice leading
├── arrangement.js  Declarative song form that scales to any duration
├── midi.js         Score accumulator and Standard MIDI File writer
├── cli.js          Argument parsing, preset discovery, rendering pipeline
└── presets/
    ├── galactic.js
    ├── dark-fantasy.js
    ├── bound-soul.js
    └── symphony.js
```

Signal flow:

```text
voices ─┬─> dry bus(es) ─┐
        ├─> reverb send ─┼─> reverb ──┐
        └─> delay send ──┼─> delay ───┼─> static loudness gain
                         │            │   -> look-ahead limiter
                         └────────────┴─> edge fades -> WAV -> ffmpeg
```

Notable choices:

- **Band-limited oscillators.** Saw and square use PolyBLEP, so high arpeggios do not fold aliases back into the audible range.
- **Resonant filter with its own envelope.** Voices run through a TPT state-variable filter whose cutoff is modulated per note, which is where most of the character comes from.
- **Additive winds.** The flute, oboe, clarinet and bassoon are harmonic series summed through one phase accumulator, so the vibrato moves every partial together instead of beating between them. The clarinet gets odd partials only, because it is a closed pipe and that is why it sounds hollow. A breath-noise layer and a chiff give the flute its air.
- **FM electric piano.** The Rhodes is a two-operator FM voice with a decaying modulation index — the bell-like tine attack is the modulation decaying out, not a sample.
- **Brass by family.** Trumpet, trombone and tuba share one filter-swept unison-saw core and differ in bite (how fast the filter opens) and brightness, which is what actually separates them.
- **Per-section tempo.** A section may carry its own `bpm`, so a piece can change speed between movements instead of faking it by stretching note lengths. Timing, `at()` and the fitted duration all follow.
- **Single static loudness gain.** The mix is measured with ITU-R BS.1770 gated loudness and scaled *once* to −14 LUFS, then caught by a look-ahead limiter. No dynamic normalisation, so the arrangement keeps its internal dynamics and ffmpeg never resamples the file.
- **True-peak limiting.** The limiter evaluates the waveform *between* samples, not just the sample values, and masters to −1.4 dBFS so the reconstructed signal stays under 0 dBFS. A sample-only limiter lets a bright mix overshoot by more than a decibel, which clips on playback and gets worse through a lossy encoder.
- **Tempo-synced delay.** Delay times are derived from the preset BPM, so echoes sit on the grid.
- **Seeded humanisation.** Timing jitter and velocity variation come from the seed, so different seeds give genuinely different performances.

### Determinism

The same seed produces byte-identical audio on the same machine and Node version. Across platforms or V8 versions it is *not* guaranteed: `Math.sin`, `Math.exp` and `Math.tanh` are not bit-exact between implementations. The engine never calls `Math.random()`.

## Writing a preset

A preset is a module in `src/presets/` exporting `meta` and `render`. It is discovered automatically.

```js
import { Studio } from '../synth.js';
import { Arrangement } from '../arrangement.js';

const SECTIONS = [
  { name: 'intro', bars: 8, intensity: 0.2, layers: ['pad'] },
  { name: 'main', bars: 24, intensity: 0.8, layers: ['pad', 'drums'] },
];

export function render({ seconds, seed = 7, sampleRate = 44100, stems = false, score = null } = {}) {
  const arrangement = new Arrangement({ bpm: 120, sections: SECTIONS });
  if (seconds != null) arrangement.fit(seconds);
  const studio = new Studio({ sampleRate, seconds: arrangement.seconds, seed, stems, score });

  arrangement.forEachBar(({ start, section, at }) => {
    if (section.layers.includes('pad')) studio.pad(start, arrangement.bar, [220, 277.18], { midis: [57, 61], track: 'pads' });
    if (section.layers.includes('drums')) studio.kick(at(0), { track: 'drums' });
  });

  return studio.finish({ targetLufs: -14, delayTimeL: 0.375, delayTimeR: 0.75 });
}

export const meta = {
  slug: 'my-preset',
  name: 'My Preset',
  bpm: 120,
  key: 'A minor',
  description: 'One line shown by `open-music presets`.',
  tracks: [
    { name: 'pads', program: 89 },
    { name: 'drums', program: 0, drum: true },
  ],
  naturalSeconds: () => 64,
  form: ({ seconds } = {}) => '...',
};
```

Pass `midi` to a voice to record it into the score, and `track` to choose which MIDI track it lands on. `naturalSeconds()` and `form()` are optional but both the CLI and the tests use them.

## Library use

```js
import { Studio } from 'open-music/synth';
import { parseDegree, voiceLead } from 'open-music/theory';
```

## Development

```bash
npm test          # node --test tests/
npm run smoke     # 20 second render of the orchestral preset
```

The suite covers the DSP primitives, the form maths, the MIDI writer, every preset end to end, and the CLI contract (including that a mistyped flag is an error rather than a silent 160-second render).

## Requirements

Node ≥ 22. `ffmpeg` on `PATH` for MP3 output; WAV needs nothing.

## License

MIT. The generated audio is yours to use, remix and publish. No attribution required, but a link back is nice.
