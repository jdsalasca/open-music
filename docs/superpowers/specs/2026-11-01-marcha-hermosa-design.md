# Marcha del Frente v2 — design

Date: 2026-11-01
Status: draft for approval

## Intent

The rendered music does not convince its author. The goal is an instrumental piece
that a listener would call *beautiful* — starting with the Soviet march already in
the repo — and, behind it, a repeatable way for an agent to compose new pieces at
that level.

The user's words: "crea una canción soviética inspirada en la Internacional y que
salga una canción de alta calidad, hermosa"; instrumental for now, vocals later.

## Why the current piece falls short

Read from `src/presets/soviet-march.js`:

- 48 bars over one four-chord loop (`i–♭VII–♭VI–V`, two bars each): six identical turns.
- The trumpet plays the same eight-note cell in every bar, regardless of the chord.
- The bass only states the root on beats 1 and 3; it never walks.
- `intensity` changes gains, but there is no real tension arc.
- Every bus is summed flat: no per-family EQ, no compression, no depth.

Most of the problem is composition and orchestration, not DSP. That is the cheap
place to fix it.

## Goals

1. Rewrite `soviet-march` as a 3–4 minute concert march: real form, two themes,
   countermelody, walking bass, functional harmony with movement, dynamic arc.
2. Add the two engine capabilities the piece needs: velocity → timbre, and legato
   phrasing for sustained instruments.
3. Keep the project's identity: no samples, no network, zero dependencies,
   deterministic per seed.
4. Leave a craft guide (`docs/composing.md`) and a ready prompt
   (`docs/agent-prompt.md`) so another agent can compose a new piece at this level.
5. Tests green, README updated, example MP3 + MIDI regenerated.
6. Push the result to `origin/main` and report back.

## Non-goals

- Vocals or lyrics.
- A soundfont/fluidsynth renderer.
- A GUI or DAW-style editor.
- A prompt→music API or service.
- Reworking the other four presets beyond what shared engine changes require.

## Anti-goals

- A piece that loops the same progression and the same motif (the current failure).
- Breaking the "no samples, no third-party rights" promise.
- Adding a dependency.
- "Improving" the mix with dynamic normalisation or resampling.

## Constraints

- Node ≥ 22, zero dependencies, same seed → same bytes on the same machine.
- 44.1 kHz default; render time must stay in the same order as today.
- The 140 existing tests must pass; new behaviour needs its own tests.
- Quality is judged by the user's ear through A/B listening, not by metrics alone.
- The CLI contract and duration fitting must not change.
- The game *Free the Nation!* ships a static `music/marcha.mp3`, not a live render.
  Replacing the preset does not touch that file; re-rendering the game's copy is out
  of scope for this round.

## Approaches considered

**A. Recompose the piece, improve only what it needs (chosen).** Rewrite the preset
with a real form and orchestration; add velocity→timbre and legato because the music
cannot breathe without them. Fastest path to something the user can hear and judge.

**B. Rebuild the expressive engine first.** Velocity→timbre, articulations, per-bus
EQ and compression, section reverbs. Benefits every preset, but nothing is audible
until the end and the whole voice layer has to be revalidated.

**C. Render through a soundfont.** Big realism jump for little code, but breaks the
project's stated identity and adds a dependency plus licensing questions.
`fluidsynth` is not installed.

A was chosen because "beautiful" is decided in composition and orchestration, and
those are the cheapest to change. B is a sensible follow-up round, not this one.

## The composition (decisions)

D minor, 4/4, 104 BPM. About 3:30.

| Section | Bars | What happens |
| --- | --- | --- |
| `llamada` | 8 | Snare roll out of silence, tuba pedal, distant trumpet call. |
| `marcha` | 24 | Theme A, 8-bar period stated three times with growing orchestration. |
| `himno` | 16 | Theme B in F major (♭III): choir and strings, horn countermelody, walking bass. |
| `desarrollo` | 16 | Motif fragmented and sequenced through Gm–B♭–A; Neapolitan ♭II before V; snare/timpani crescendo. |
| `asalto` | 16 | Theme A augmented over a tonic pedal, full brass, choir, timpani. |
| `coda` | 12 | V–i, plagal ♭VI–i(add9), timpani roll, tam-tam; the minor brightens at the last chord. |

92 bars at 104 BPM ≈ 3:32.

- **Theme A** is an 8-bar period: a rising fourth, a dotted-rhythm answer, and a
  cadence that lands on the dominant the first time and the tonic the second. It is
  stated by trumpet, then horns, then full brass.
- **Theme B** is lyrical, 8+8, in F major, with the horns answering the choir.
- **The old eight-note cell survives** only as a transformed echo in the development.
- **Harmony** uses functional movement, secondary dominants (`V/iv`, `V/V`), modal
  mixture (♭II, ♭VI), and pedal points. Harmonic rhythm changes by section: one chord
  per bar in the march, two bars per chord in the hymn, faster in the development.
- **Bass** walks: root, fifth, octave, and chromatic approach notes; it never just
  repeats the root.
- **Registers** are separated on purpose: tuba D2–A2, trombones A3–E4, horns D4–A4,
  trumpets D5–A5, choir D4–F5, strings D4–D6, timpani D2/A2.
- **Dynamics** run from pp to ff, with the texture dropping to snare and tuba before
  the climax. Velocity controls both loudness and brightness.
- **Ending**: the last chord is major (Picardy third), a deliberate turn from stern
  to hopeful.

## Engine changes

1. **Velocity → timbre in `tone`.** Cutoff and filter envelope scale with velocity
   instead of gain alone, so a soft note is darker and a hard note bites. Additive
   voices (flute, oboe, clarinet, bassoon) scale their upper partials with velocity.
   It is **opt-in** through a `Studio({ expressive: true })` flag: the other four
   presets pass `velocity < 1` and would otherwise change timbre and bytes. Round A
   turns it on only for the new march; round B flips it globally and re-renders the
   examples.
2. **`Studio.phrase(notes, opts)`.** One continuous legato line: a single attack,
   per-note pitch targets with a short portamento, shaped release, and each note
   recorded in the score. Used by strings, horns and trumpet for melodic lines.
   Articulation stays available through the existing per-note voices.

No per-bus EQ or compression in this round. The orchestration separates the
registers; a mixing console is round B if the ear still asks for it.

## The agent layer

- `docs/composing.md`: the craft guide — form, theme writing, orchestration ranges,
  harmonic toolkit, dynamic plan, and a checklist of what makes a piece sound fake
  (static loop, same motif every bar, root-only bass, everything in one octave).
- `docs/agent-prompt.md`: a copy-paste prompt for a fresh agent. It points at the
  guide, names the reference preset, and defines acceptance: tests pass, form
  renders, 30-second sample, loudness target, and a listening check.
- No new DSL. A preset is code; the guide teaches the shape and the reference
  implementation shows it. An abstraction nobody asked for would only hide the music.

## Verification

- `npm test` green.
- `node src/cli.js generate --preset soviet-march --out ... --midi ...` writes
  ≈ 3:30 of audio, ≈ −14 LUFS, true peak below −1 dBFS.
- `node src/cli.js form --preset soviet-march` matches the table above.
- A/B: the user hears the full new render plus a 60-second excerpt of both versions,
  cut from the natural renders. `--duration 60` is not used for judging: it compresses
  the 92 bars to about 26 and breaks the eight-bar periods.
- The 30-second sample in `docs/agent-prompt.md` means an excerpt of the full render,
  not a shortened `fit()`.
- The real gate is the user saying it sounds beautiful. If not, iterate on the
  composition, not on the DSP.
- Push to `origin/main` when green, as the user requested. No force-push.

## Left to the builder

- The exact melodic material; the document only constrains its shape.
- How much of the old motif to keep as the development echo.
- Whether the hymn modulates to F major or only borrows its colour.
- The final chord voicing.
