# Marcha del Frente v2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `soviet-march` a 3:32 instrumental concert march that sounds beautiful, adding velocity→timbre and legato phrasing to the engine, and leave a guide plus a prompt so another agent can compose at that level.

**Architecture:** Two small, opt-in engine additions (`Studio({ expressive })` and `Studio.phrase`), then a full recomposition of the preset around a real form, two themes, functional harmony and a walking bass. Docs and a reference prompt follow, then examples and README.

**Tech Stack:** Node ≥ 22, ES modules, zero dependencies, `node --test`, ffmpeg for MP3 only.

**Spec:** `docs/superpowers/specs/2026-11-01-marcha-hermosa-design.md`

## Global Constraints

- Node ≥ 22, zero dependencies, no network, no samples.
- Same seed → byte-identical audio on the same machine and Node version.
- 44.1 kHz default; the mix targets −14 LUFS and stays below −1 dBFS true peak.
- The existing 140 tests must pass; new behaviour gets new tests.
- Do not change the CLI contract, the preset discovery, or `duration` fitting.
- `expressive` defaults to `false`; other presets must render exactly as before.
- Docs and code identifiers in English, matching the repo. User-facing chat in Spanish.
- Commit per task. Push to `origin/main` only in the final task, as the user asked.

## Review Focus

- **A render shorter than the form** (`--duration 8`, the generic tests): sections get dropped by `fitBars`; the remaining section must still produce audio and at least two buses. Test in `tests/soviet-march.test.js`.
- **Score/MIDI duplication from `phrase`**: each note recorded exactly once, no phantom note from the wrapper `tone` call. Test in Task 2.
- **Determinism with a pitch function**: two renders with the same seed must be byte-identical. Generic test plus a phrase-specific test.
- **Stems with the new bus names** (`horns`, `winds`): one WAV per bus, no send leakage. Generic test.
- **Loudness with a denser arrangement**: no clipping, LUFS inside −24…−8. Generic test plus the example check.

---

### Task 1: Expressive velocity → timbre

**Files:**
- Modify: `src/synth.js` (constructor near line 95; `tone` near line 214; `_additive` near line 739)
- Test: `tests/synth.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `new Studio({ expressive?: boolean })`, default `false`. When `true`, `tone` scales its effective cutoff and `_additive` scales upper partials with `velocity`. At `velocity = 1` or `expressive = false` the output is bit-identical to today.

- [ ] **Step 1: Write the failing test**

Add to `tests/synth.test.js`:

```js
/** Energy of the first difference: a cheap brightness proxy. */
function brightness(samples) {
  let diff = 0;
  for (let i = 1; i < samples.length; i += 1) diff += (samples[i] - samples[i - 1]) ** 2;
  return diff / Math.max(1, energy(samples));
}

test('expressive velocity darkens a soft note', () => {
  const render = (velocity) => {
    const studio = new Studio({ sampleRate: SR, seconds: 2, seed: 4, expressive: true });
    studio.tone({ start: 0.05, duration: 0.6, freq: 220, wave: 'saw', gain: 0.5, cutoff: 3000, velocity, attack: 0.005, release: 0.1 });
    studio.finish({ targetLufs: null, fadeOut: 0 });
    return studio.master.left.slice(Math.round(0.1 * SR), Math.round(0.6 * SR));
  };
  assert.ok(brightness(render(1)) > brightness(render(0.25)) * 1.3);
});

test('expressive leaves a full-velocity note unchanged', () => {
  const render = (expressive) => {
    const studio = new Studio({ sampleRate: SR, seconds: 2, seed: 4, expressive });
    studio.tone({ start: 0.05, duration: 0.6, freq: 220, wave: 'saw', gain: 0.5, cutoff: 3000, velocity: 1 });
    studio.finish({ targetLufs: null, fadeOut: 0 });
    return studio.master.left;
  };
  assert.deepEqual(render(true), render(false));
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test tests/synth.test.js`
Expected: FAIL — `brightness(render(1))` is not greater than `brightness(render(0.25)) * 1.3` because the flag does nothing.

- [ ] **Step 3: Implement the flag**

In the `Studio` constructor, add `expressive = false` to the options and `this.expressive = expressive;`.

In `tone`, after `const amount = gain * velocity;`, add:

```js
const bright = this.expressive ? 0.55 + 0.45 * velocity : 1;
```

Use `cutoff * bright` for `baseCut` and `cutoff * bright * (1 + filterEnv)` for `peakCut`.

In `_additive`, replace `const out = gain * velocity;` with:

```js
const bright = this.expressive ? 0.5 + 0.5 * velocity : 1;
const out = gain * velocity;
```

In the partial sum, weight each partial: `partials[p] * (p === 0 ? 1 : bright ** p)`.

- [ ] **Step 4: Run the tests**

Run: `node --test tests/synth.test.js`
Expected: PASS, including both new tests.

- [ ] **Step 5: Confirm nothing else moved**

Run: `npm test`
Expected: all 140+ tests pass. The other presets do not pass `expressive`, so their renders are unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/synth.js tests/synth.test.js
git commit -m "feat: add opt-in velocity-to-timbre dynamics"
```

---

### Task 2: Legato phrases

**Files:**
- Modify: `src/synth.js` (`tone` signature and loop; new `phrase` method after `tone`)
- Test: `tests/synth.test.js`

**Interfaces:**
- Consumes: `Studio({ score })`, `midiToFreq`, `SVF`.
- Produces: `tone` accepts `freq: number | ((t: number) => number)`; `Studio.phrase(events, opts)` where `events: Array<{ start: number, duration: number, midi: number }>`. `opts` takes the `tone` envelope/timbre options plus `glide` (seconds, default `0.05`), `bus`, `track` and `velocity`. The phrase records one score note per event and increments `stats.notes` once per event.

- [ ] **Step 1: Write the failing tests**

Add to `tests/synth.test.js`:

```js
test('phrase records every note exactly once', async () => {
  const { Score } = await import('../src/midi.js');
  const score = new Score({ bpm: 120, name: 'Phrase test' });
  score.addTrack('lead', { program: 0 });
  const studio = new Studio({ sampleRate: SR, seconds: 3, seed: 6, score });
  studio.phrase(
    [
      { start: 0.1, duration: 0.3, midi: 60 },
      { start: 0.4, duration: 0.3, midi: 67 },
      { start: 0.7, duration: 0.4, midi: 72 },
    ],
    { track: 'lead', gain: 0.3, wave: 'sine', unison: 1, cutoff: 18000, vibrato: 0, release: 0.2 },
  );
  assert.equal(studio.stats.notes, 3);
  assert.equal(score.tracks.find((track) => track.name === 'lead').notes.length, 3);
});

test('phrase glides upward and stays finite', () => {
  const studio = new Studio({ sampleRate: SR, seconds: 2, seed: 6 });
  studio.phrase(
    [
      { start: 0.05, duration: 0.4, midi: 60 },
      { start: 0.45, duration: 0.4, midi: 72 },
    ],
    { gain: 0.3, wave: 'sine', unison: 1, cutoff: 18000, vibrato: 0, glide: 0.02, release: 0.1 },
  );
  studio.finish({ targetLufs: null, fadeOut: 0 });
  const { left } = studio.master;
  const zcr = (from, to) => {
    let crossings = 0;
    for (let i = from + 1; i < to; i += 1) if (Math.sign(left[i]) !== Math.sign(left[i - 1])) crossings += 1;
    return crossings;
  };
  const first = zcr(Math.round(0.1 * SR), Math.round(0.35 * SR));
  const last = zcr(Math.round(0.55 * SR), Math.round(0.8 * SR));
  assert.ok(last > first * 1.5, `expected a rise in pitch (${first} -> ${last} crossings)`);
  for (let i = 0; i < left.length; i += 1) assert.ok(Number.isFinite(left[i]));
});

test('phrase renders deterministically for a given seed', () => {
  const once = (seed) => {
    const studio = new Studio({ sampleRate: SR, seconds: 2, seed });
    studio.phrase(
      [
        { start: 0.05, duration: 0.4, midi: 60 },
        { start: 0.45, duration: 0.4, midi: 67 },
      ],
      { gain: 0.3, wave: 'saw', release: 0.1 },
    );
    studio.finish({ targetLufs: null, fadeOut: 0 });
    return studio.master.left;
  };
  assert.deepEqual(once(8), once(8));
  assert.notDeepEqual(once(8), once(9));
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test tests/synth.test.js`
Expected: FAIL — `studio.phrase is not a function`.

- [ ] **Step 3: Let `tone` take a pitch function**

In `tone`, keep the current numeric path. Add:

```js
const freqIsFn = typeof freq === 'function';
const freqAt = (t) => (freqIsFn ? freq(t) : freq) * (1 + detune) * 2 ** ((offset * spread) / 12);
const phaseStep = freqIsFn ? 0 : freqAt(0) / sr;
```

Inside the sample loop, replace the single `oscillator(wave, p, phaseStep)` / `phase += phaseStep` with a per-sample step that uses `freqAt(t)` when `freqIsFn`, and the precomputed `phaseStep` otherwise. Pass that step to `oscillator` so PolyBLEP sees the right `dt`.

- [ ] **Step 4: Implement `phrase`**

Place it after `tone`. It filters zero-length events, sorts by `start`, builds a piecewise pitch function with a linear glide of `glide` seconds at each join, and calls `tone` once with the full span, `midi: null` and `track: null`. Then it bumps `this.stats.notes` by `events.length - 1` and calls `this.record(...)` for each event. Document that events are expected not to overlap and that one velocity covers the whole phrase.

- [ ] **Step 5: Run the tests**

Run: `node --test tests/synth.test.js`
Expected: PASS.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: all pass. `tone`'s numeric path is untouched.

- [ ] **Step 7: Commit**

```bash
git add src/synth.js tests/synth.test.js
git commit -m "feat: add legato phrase voice with portamento"
```

---

### Task 3: Recompose the march

**Files:**
- Modify: `src/presets/soviet-march.js` (full rewrite)
- Create: `tests/soviet-march.test.js`

**Interfaces:**
- Consumes: `Studio({ expressive: true })`, `studio.phrase(events, opts)`, `parseDegree`, `voiceLead`, `Arrangement`.
- Produces: the same public contract (`render`, `meta` with `slug`, `name`, `bpm`, `key`, `bars`, `beatsPerBar`, `description`, `tracks`, `naturalSeconds`, `form`).

**Form (92 bars, 4/4, 104 BPM ≈ 212.3 s):**

| Section | Bars | Harmony (one per bar unless noted) |
| --- | --- | --- |
| `llamada` | 8 | `i i i i V7 V7 i i` |
| `marcha` | 24 | 8 bars `i bVI bIII V7 i bVI iv i`; 8 bars the same but ending `V7`; 8 bars in G minor `i bVI bIII V7 i bVI iv V7` (the last `V7` parsed in D minor, so it is A7) |
| `himno` | 16 | F major: `I IV V I vi IV V I` then `IV V I vi IV ii V7 III7` |
| `desarrollo` | 16 | `iv iv bVI bVI bII bII V7 V7 i bVI iv V7 i bII V7 V7` |
| `asalto` | 16 | 2 bars each: `i bVI bIII V7 i bVI iv i`, with the final bar `V7` |
| `coda` | 12 | `i bVI IV V7 i bVI IV V7 i bVI V7 I(major)` |

**Theme A** (`[scale degree, beats]`, D natural minor, degrees 0-based):

```js
const THEME_A = [
  [4, 1.5], [5, 0.5], [6, 1], [7, 1],
  [7, 2], [6, 1], [5, 1],
  [4, 1.5], [3, 0.5], [2, 1], [1, 1],
  [1, 2], [4, 2],
  [4, 1.5], [5, 0.5], [6, 1], [7, 1],
  [7, 2], [8, 1], [7, 1],
  [6, 1.5], [5, 0.5], [4, 1], [3, 1],
  [2, 2], [0, 2],
];
```

Trumpet at `+12` (A4–E5), horn at `0` (A3–E4). The first four bars end on the dominant, the last four on the tonic.

**Theme B** (`[scale degree, beats]`, F major):

```js
const THEME_B = [
  [4, 2], [5, 1], [4, 1],
  [3, 2], [4, 1], [3, 1],
  [5, 2], [4, 1], [3, 1],
  [2, 3], [0, 1],
  [3, 2], [2, 1], [1, 1],
  [0, 2], [1, 1], [2, 1],
  [3, 2], [2, 1], [1, 1],
  [0, 4],
];
```

Horns carry theme B; the choir and strings sustain the harmony. This is a deliberate change from the design's one-line "choir melody": the horn is the instrument that can sing it.

**Orchestration:**

- `llamada`: timpani roll out of silence, tuba pedal on D2, a distant trumpet call (first two notes of theme A, low velocity, high reverb), tam-tam on bar 1.
- `marcha`: statement 1 = trumpet theme, trombone "pah" on beats 2 and 4, tuba root/fifth on 1 and 3, snare eighths with accents, timpani on tonic/dominant. Statement 2 adds horns doubling the theme an octave down, sustained strings, fuller snare. Statement 3 is the G-minor sequence, trumpet + horns, brass fanfare, timpani.
- `himno`: horn theme B, choir chord pad, strings, walking bass in quarters, soft snare, no trumpet.
- `desarrollo`: tremolo strings, flute/oboe fragments of the first four notes of theme A, bassoon, snare crescendo, timpani roll, brass stabs; the last two bars drop to snare + tuba.
- `asalto`: theme A in augmentation (each duration doubled, 16 bars), trumpet + horns, trombones, choir, timpani, snare, tam-tam.
- `coda`: full orchestra, theme A fragment in augmentation, final cadence, Picardy third on D major.

**Bass:**

- `marcha`/`asalto`: root on beat 1, fifth on beat 3, tuba at `chord.root - 12`; cello doubles an octave up on beat 1.
- `himno`/`desarrollo`/`coda`: walking quarters `[root, fifth, octave, chromatic approach to the next root]`, tuba plus cello.

**Dynamics:** scale gains with `section.intensity`; add a linear crescendo through `desarrollo`; drop to snare + tuba in its last two bars; velocity rises with the arc and drives brightness because the studio is created with `expressive: true`.

- [ ] **Step 1: Save the old render for the A/B**

Before editing, run:

```bash
node src/cli.js generate --preset soviet-march --out "$env:TEMP/opencode/march-old.mp3" --quiet
```

Keep the file for the final listening comparison.

- [ ] **Step 2: Write the failing test**

Create `tests/soviet-march.test.js`:

```js
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
```

- [ ] **Step 3: Run it and watch it fail**

Run: `node --test tests/soviet-march.test.js`
Expected: FAIL — `meta.bars` is 48 and the form is the old one.

- [ ] **Step 4: Rewrite the preset**

Replace the file. Keep the existing imports and the `meta` contract. Build the form from the table, the harmony from `parseDegree(symbol, root, scale)` (using `chord.root`, not `chord[0]`), and the melodies from the two theme arrays. Use `studio.phrase` for the trumpet/horn themes and the walking bass; use the existing one-shot voices for chords and percussion. Keep seeded jitter and velocity variation with `mulberry32(seed)`, as today: the generic suite requires two seeds to sound different. Name the buses `bajo`, `bones`, `trumpet`, `horns`, `choir`, `strings`, `winds`, `drums`, and declare matching score tracks (add `horns` program 60 and `winds` program 73).

- [ ] **Step 5: Render a first check**

Run:

```bash
node src/cli.js form --preset soviet-march
node src/cli.js generate --preset soviet-march --duration 40 --out "$env:TEMP/opencode/march-40.mp3" --quiet
```

Expected: the form matches the table and the render finishes with no error. Listen to the 40 seconds; if the theme does not read as a march, fix the rhythm before adding more layers.

- [ ] **Step 6: Finish the orchestration and the mix**

Add the hymn, development, assault and coda layers, then `studio.finish({ targetLufs: -14, reverbRoom: 0.78, reverbDamp: 0.35, delayWet: 0.1, fadeOut: 3 })`.

- [ ] **Step 7: Run the tests**

Run: `node --test tests/soviet-march.test.js` then `npm test`.
Expected: PASS. The generic render suite exercises the new preset at 6–20 s.

- [ ] **Step 8: Render the full piece and check the numbers**

Run:

```bash
node src/cli.js generate --preset soviet-march --out "$env:TEMP/opencode/march-new.mp3" --midi "$env:TEMP/opencode/march-new.mid"
ffmpeg -hide_banner -nostats -i "$env:TEMP/opencode/march-new.mp3" -af ebur128=peak=true -f null -
```

Expected: ≈ 212 s, ≈ −14 LUFS, true peak below −1 dBFS.

- [ ] **Step 9: Commit**

```bash
git add src/presets/soviet-march.js tests/soviet-march.test.js
git commit -m "feat: recompose the march as a concert piece"
```

---

### Task 4: Composing guide and agent prompt

**Files:**
- Create: `docs/composing.md`
- Create: `docs/agent-prompt.md`
- Create: `docs/plan.md`

- [ ] **Step 1: Write `docs/composing.md`**

Cover, in this order: the pipeline (key → tempo → form → themes → harmony → orchestration → dynamics → mix); how to write an eight-bar period (antecedent on the dominant, consequent on the tonic, one leap and the rest stepwise); how to vary a motif (sequence, inversion, augmentation, fragmentation); the register table from the spec; the harmonic toolkit (functional map, secondary dominants, modal mixture, pedal points); the dynamic arc; the failure checklist (static loop, same motif every bar, root-only bass, everything in one octave, no space before the climax); and how to verify (`npm test`, `form`, an 8-second render, a full render, LUFS).

- [ ] **Step 2: Write `docs/agent-prompt.md`**

A copy-paste prompt for a fresh agent. It must: point at `README.md`, `docs/composing.md` and `src/presets/soviet-march.js` as the reference; ask for a new preset in `src/presets/`; forbid samples, network and dependencies; require `npm test` green, a matching `form()`, a 30-second excerpt of the natural render, −14 LUFS ±1 and true peak below −1 dBFS; and end with a listening checklist. Include a fill-in brief at the top (mood, key, tempo, instrumentation, length, form).

- [ ] **Step 3: Write `docs/plan.md`**

The project's round plan, in the repo's language: round 1 (this work), round 2 (global expressive dynamics, per-bus EQ/compression, more bass voices), round 3 (vocals, if ever). One verifiable criterion per round.

- [ ] **Step 4: Verify the docs' commands**

Run every command the guide tells a reader to run, including `node src/cli.js form --preset soviet-march` and `npm test`. Check that every path the docs mention exists.

- [ ] **Step 5: Commit**

```bash
git add docs/composing.md docs/agent-prompt.md docs/plan.md
git commit -m "docs: add composing guide and agent prompt"
```

---

### Task 5: Examples, README, verification and push

**Files:**
- Modify: `README.md`
- Create: `examples/soviet-march.mp3`, `examples/soviet-march.mid`

- [ ] **Step 1: Render the examples**

```bash
node src/cli.js generate --preset soviet-march --out examples/soviet-march.mp3 --midi examples/soviet-march.mid
```

- [ ] **Step 2: Verify the artifacts**

```bash
ffmpeg -hide_banner -nostats -i examples/soviet-march.mp3 -af ebur128=peak=true -f null -
```

Expected: ≈ 212 s, ≈ −14 LUFS, true peak below −1 dBFS. The MIDI file must be non-empty and importable (the MIDI writer tests already cover the format).

- [ ] **Step 3: Update the README**

Change the preset length from 107 s to 212 s and the `form` example to the new string. Describe the new form and themes in the existing prose style. Add a short "Composing a new piece" section linking `docs/composing.md` and `docs/agent-prompt.md`. Keep the "no samples" promise untouched.

- [ ] **Step 4: Run the full verification**

```bash
npm test
npm run smoke
```

Expected: all tests pass, the 20-second smoke render completes.

- [ ] **Step 5: Prepare the A/B**

Cut 60 seconds from the old render starting at 9 s (the old march theme) and 60 seconds from the new render starting at 18 s (the new march theme):

```bash
ffmpeg -y -i "$env:TEMP/opencode/march-old.mp3" -ss 9 -t 60 "$env:TEMP/opencode/march-old-60.mp3"
ffmpeg -y -i "$env:TEMP/opencode/march-new.mp3" -ss 18 -t 60 "$env:TEMP/opencode/march-new-60.mp3"
```

- [ ] **Step 6: Commit and push**

```bash
git add README.md examples/soviet-march.mp3 examples/soviet-march.mid
git commit -m "docs: document the concert march and ship its example"
git push origin main
```

- [ ] **Step 7: Report to the user**

In Spanish: what changed, the paths to the full render and the A/B excerpts, the test count, and the reminder that the final judge is their ear. Offer round 2 (global dynamics, per-bus mix, more bass voices) and hand over `docs/agent-prompt.md` for the agent test.
