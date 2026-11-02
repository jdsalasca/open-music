# Agent prompt: compose a new piece

Fill in the brief, then paste the prompt into a fresh agent with this repository
open. The agent should work in the repo, not in a chat window.

## Brief

- **Mood / occasion:**
- **Key and mode:**
- **Tempo:**
- **Target length:**
- **Instrumentation:**
- **Form:**
- **One thing the listener must remember:**

## Prompt

```text
You are composing a new preset for open-music, a deterministic procedural music
engine. Work in this repository.

Read, in this order:
1. README.md
2. docs/composing.md
3. src/presets/soviet-march.js (the reference implementation)
4. src/synth.js (the voices and their options)
5. src/theory.js and src/arrangement.js (the helpers you will use)

The brief:
- Mood / occasion: <fill in>
- Key and mode: <fill in>
- Tempo: <fill in>
- Target length: <fill in>
- Instrumentation: <fill in>
- Form: <fill in>
- One thing the listener must remember: <fill in>

Write a new preset at src/presets/<slug>.js with the same contract as the
reference (meta + render). Write tests/<slug>.test.js covering the form, the
note count, determinism for a seed and a very short render. Follow
docs/composing.md; do not copy the reference melody.

Hard constraints:
- Zero dependencies, no network, no samples, no external APIs.
- Same seed produces byte-identical audio on the same machine.
- Do not change the CLI, the preset discovery or the duration fitting.
- Do not add a four-chord loop for the whole piece.
- Do not repeat the same motif in every bar.
- The bass must walk; roots alone are not a bass line.
- Separate the registers; do not put every family in one octave.
- Leave space before the climax.

Deliver:
1. The preset and its tests.
2. `npm test` green.
3. `node src/cli.js form --preset <slug>` matching the declared form.
4. A full render and a 30-second excerpt cut from it, not a shortened
   `--duration` render.
5. A short report: form, note count, LUFS, true peak, what you chose and why.

Acceptance:
- `npm test` passes.
- The full render is within ±5% of the target length.
- ≈ −14 LUFS integrated (±1) and true peak below −1 dBFS.
- The 30-second excerpt contains the main theme.
- The listening checklist below passes.

Listening checklist:
- After one listen, can you hum the main theme?
- Does the piece have a quiet opening, a first theme, a contrasting second
  theme, a development, a climax and a coda?
- Does the bass move, or does it repeat the root?
- Can you hear the melody above the accompaniment in every section?
- Is there a moment where the texture drops before the climax?
- Does the ending cadence, instead of fading out?

If the answer to any of these is no, fix the composition before touching the
mix.
```

## After the agent finishes

Listen to the full render, then the 30-second excerpt. If it is close but not
beautiful, ask for one specific change per round — "the hymn needs a
countermelody", "the development is too long" — not "make it better". The
engine rewards concrete musical direction.
