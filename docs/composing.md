# Composing a piece

The engine is a synthesizer and a scheduler, not an automatic composer. A preset
is a module in `src/presets/` that exports `meta` and `render`; everything else
is craft. This guide is the craft that makes a render sound like music instead
of a sequence of notes.

`soviet-march.js` is the worked example. Read it next to this guide.

## 1. Decide the shape before the notes

Pick the key, the tempo, the length and the emotional arc. Then write the form
as sections in bars:

```js
const SECTIONS = [
  { name: 'call', bars: 8, intensity: 0.18, layers: ['roll', 'pedal'] },
  { name: 'themeA', bars: 24, intensity: 0.62, layers: ['snare', 'brass'] },
  // ...
];
```

A finished piece needs contrast: a quiet opening, a first theme, a lyrical
second theme, a development, a climax and a coda. Eight bars of one idea is a
loop, not a piece.

`Arrangement.fit(seconds)` rescales the sections. Write the music so that it
survives being shortened: phrase lengths should be clamped to the section, as
`themeEvents(..., { until })` does in the reference.

## 2. Write a theme you could sing

An eight-bar period is the backbone. Four bars ask a question (the antecedent),
four bars answer it (the consequent).

- The antecedent ends on the dominant (scale degree 2 or 5). The consequent
  ends on the tonic.
- One leap, a fourth or a fifth, and the rest stepwise.
- For a march, a dotted rhythm on the first beat gives the lift.
- Keep it inside a ninth so a section can play it without crossing registers.

Write themes as scale degrees and beat lengths, never as absolute MIDI:

```js
const THEME = [[4, 1.5], [5, 0.5], [6, 1], [7, 1], /* ... */];
```

`degreeMidi(index, root, scaleName, octaveShift)` turns a degree into a note, so
the same theme can be transposed to the relative major or up a fourth.

## 3. Develop the motif

Repeating the same eight notes every bar is the fastest way to sound fake. Pick
one transformation per section:

- **Sequence**: restate the motif a fourth or a second higher.
- **Inversion**: mirror the contour around an axis.
- **Augmentation**: double every duration; the theme becomes a climax.
- **Fragmentation**: keep only the first three or four notes and pass them
  between instruments.
- **Reharmonization**: keep the melody, change the chords underneath.

The reference uses four of them: theme A in D minor, the same theme sequenced
into G minor, a fragment in the development, the augmented theme in the assault,
and theme B in F major as the contrasting second subject.

## 4. Give the harmony somewhere to go

A four-chord loop for three minutes is the main failure of the previous version
of the march. Use functional movement:

- Minor key: `i – iv – ♭VII – ♭III – ♭VI – ii° – V7 – i`.
- Secondary dominants: `V7/iv` in D minor is A7, which pulls to Gm.
- Modal mixture: `♭II` (the Neapolitan) before `V7`, `♭VI` as a deceptive
  resolution, a Picardy third at the end.
- Pedal points: hold the tonic or dominant while the chords change above it.
- Change the harmonic rhythm by section: one chord per bar in the march, two
  bars per chord in the hymn, faster in the development.

Use `parseDegree(symbol, root, scale)` and resolve `chord.root` and
`chord.notes`; do not index `chord.notes[0]` as the root, because inverted
voicings do not put the root first.

## 5. Orchestrate by register

Keep one family per register. If everything sits between C4 and C5, the mix is
mud no matter how good the notes are.

| Family | Comfortable range | Role |
| --- | --- | --- |
| Tuba | D2–A2 | Bass root and fifth |
| Cello | D3–D4 | Bass line, tenor |
| Bassoon | D3–D4 | Bass, tenor |
| Trombone | A3–E4 | Harmonic pad, "pah" |
| Horn | D4–A4 | Theme B, countermelody |
| Choir | D4–F5 | Sustained pad, wordless |
| Trumpet | A4–A5 | Theme A, fanfare |
| Strings | D4–D6 | Sustained pad, tremolo |
| Flute / oboe | D5–D6 | Fragments, color |
| Clarinet | D4–D6 | Mid color |
| Timpani | D2–A3 | Accents, rolls |

Rules that matter more than the table:

- The melody lives in one family; the countermelody in another; the pad below
  or above both.
- Do not fill every bar with every layer. Leave space before the climax.
- Double the theme at the octave or the fifth for weight, not at unison with a
  louder pad.
- Pan sections apart: low instruments center, mid instruments slightly left
  and right, high color wide.

## 6. Write a bass that walks

A root on every beat is a pedal, not a bass line.

- March: root on beat 1, fifth on beat 3, tuba and cello.
- Hymn, development and coda: four quarter notes, `root – fifth – octave –
  chromatic approach` to the next root.
- Keep the bass below the trombones and above the kick's fundamental. In this
  engine, `chord.root - 12` puts D and A in the tuba's low register; for higher
  chords, hand the upper notes of the line to the cello.

## 7. Make it breathe

- **Velocity is timbre.** Create the studio with `{ expressive: true }` so a
  soft note is darker and a hard note bites; otherwise velocity only changes
  volume and the performance stays flat.
- **Legato is a phrase, not a note.** Use `studio.phrase(events, opts)` for
  sustained lines. One envelope, one filter, pitch glides between notes. Use
  the per-note voices for staccato, accents and chords.
- **Plan the dynamic arc.** Start around 0.4, reach 0.7 in the first theme,
  drop to 0.5 before the climax, and hit 0.95 in the assault. The ear hears the
  contrast, not the absolute level.
- **Humanize with the seed.** Jitter timing by a few milliseconds and velocity
  by ±10%. The same seed must reproduce the same performance.

## 8. Mix

- Write every voice to a named bus (`bajo`, `bones`, `trumpet`, `horns`,
  `choir`, `strings`, `winds`, `drums`) so `--stems` separates the families.
- Balance by section, not only over the whole piece. A stem that is 15 dB below
  the melody is inaudible; 6–10 dB is a pad.
- Target −14 LUFS integrated and keep the true peak below −1 dBFS. If the MP3
  overshoots, lower `ceiling` in `finish()` (0.77 is a safe start) instead of
  adding dynamic normalization.
- Reverb sends of 0.3–0.5 are enough. A march does not need a long tail; a
  hymn does.
- Check the stems with `ffmpeg -af volumedetect`. The melody should be the
  loudest sustained bus in its section.

## 9. The failure checklist

If any of these is true, the piece will sound cheap:

- The same four chords loop for the whole piece.
- The same eight-note motif plays in every bar.
- The bass only states the root.
- Every instrument sits in the same octave.
- There is no dynamic arc, or the climax arrives with no space before it.
- The melody is buried under the snare and timpani.
- Every bar is full; nothing is allowed to rest.
- The theme cannot be sung back after one listen.
- The ending fades out instead of cadencing.

## 10. Verify

```bash
node src/cli.js form --preset <slug>
node --test
node src/cli.js generate --preset <slug> --duration 40 --out check.mp3
node src/cli.js generate --preset <slug> --out track.mp3 --midi track.mid --stems
ffmpeg -hide_banner -nostats -i track.mp3 -af ebur128=peak=true -f null -
```

- Listen to the 40-second check: can you hum the theme?
- Listen to the full render: does the arc hold, or does it plateau?
- Measure: ≈ −14 LUFS, true peak below −1 dBFS, LRA above 8 LU.
- Compare stems: is the melody on top of its section?

## 11. Reference

`src/presets/soviet-march.js` is 92 bars in six sections: a call, theme A, theme
B in F major, a development through G minor and the Neapolitan, an assault with
the theme in augmentation, and a coda with a Picardy third. It uses
`Studio({ expressive: true })`, `phrase()` for the themes, one-shot `tuba` notes
for the walking bass, and named buses for the stems.
