# Plan

## Round 1 — a piece worth hearing (done)

- Opt-in velocity → timbre (`Studio({ expressive: true })`).
- `Studio.phrase()` for legato lines with portamento.
- `soviet-march` recomposed as a 92-bar concert march: two themes, functional
  harmony, walking bass, six sections, Picardy third.
- `docs/composing.md` and `docs/agent-prompt.md` so an agent can compose a new
  piece at this level.

Criterion: `npm test` green, the march renders 3:32 at ≈ −14 LUFS with true peak
below −1 dBFS, and the user can hum theme A after one listen.

## Round 2 — the engine breathes everywhere

- Turn `expressive` on for every preset and re-render its example.
- Per-bus EQ and compression in `finish()`, with a small channel-strip API.
- More bass voices: upright, picked, 808 with glide.
- A mix stage that can balance buses by section, not only per voice.

Criterion: every example re-rendered, A/B shows a measurable improvement in
stem balance and dynamics, tests green.

## Round 3 — voice (optional)

- A singing voice: formant synthesis or a licensed external voice.
- Lyrics and prosody.
- The same guide extended with a melody-and-text section.

Criterion: a sung line is intelligible in Spanish and the rights are clear.

The agent layer is the guide plus the prompt. Do not add a composition DSL until
the guide demonstrably fails to produce a good piece.
