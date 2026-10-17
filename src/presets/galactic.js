import { Studio, midiToFreq } from '../synth.js';

const BPM = 108;
const BEAT = 60 / BPM;
const BAR = BEAT * 4;
const TOTAL_BARS = 72;

const CHORDS = [
  { name: 'Dm9', root: 38, notes: [53, 57, 60, 64], color: [65, 69, 72] },
  { name: 'Bbmaj7', root: 34, notes: [50, 53, 57, 60], color: [62, 65, 69] },
  { name: 'Gm7', root: 31, notes: [46, 50, 53, 58], color: [58, 62, 65] },
  { name: 'A7sus4', root: 33, notes: [50, 52, 55, 57], color: [60, 64, 67] },
];

const PENTATONIC = [62, 65, 67, 69, 72, 74, 77, 79];
const MOTIF = [69, 72, 74, 72, 69, 67, 65, 69, 72, 74, 77, 74, 72, 69, 67, 65];

export function renderGalactic({ seconds = 160, seed = 7, sampleRate = 44100 } = {}) {
  const studio = new Studio({ sampleRate, seconds, seed });
  const bars = Math.min(TOTAL_BARS, Math.ceil(seconds / BAR));

  studio.vinyl(0, seconds, 0.0035);
  studio.sweep(0, 9, 0.028);
  studio.sweep(seconds - 8, 8, 0.022);

  for (let bar = 0; bar < bars; bar += 1) {
    const start = bar * BAR;
    if (start >= seconds) break;
    const chord = CHORDS[Math.floor(bar / 2) % CHORDS.length];
    const next = CHORDS[Math.floor((bar + 2) / 2) % CHORDS.length];
    const inIntro = bar < 8;
    const inBreak = bar >= 32 && bar < 48;
    const inDrop = bar >= 48 && bar < 64;
    const inOutro = bar >= 64;

    // Pad: every two bars, sustained across the chord change.
    if (bar % 2 === 0) {
      const duration = Math.min(BAR * 2 + 0.4, seconds - start);
      studio.pad(start, duration, chord.notes.map(midiToFreq), inIntro ? 0.048 : 0.038);
      if (!inIntro) studio.pad(start, duration, [next.notes[1], next.notes[2]].map(midiToFreq), 0.014);
    }

    if (inBreak || inDrop) {
      studio.strings(start, BAR + 0.2, chord.notes.map(midiToFreq), inDrop ? 0.04 : 0.028);
    }

    // Drums.
    if (!inBreak && !inOutro) {
      studio.kick(start + BEAT * 0, 0.62);
      studio.kick(start + BEAT * 2, 0.48);
      if (!inIntro) {
        studio.kick(start + BEAT * 2.75, 0.28);
        studio.snare(start + BEAT * 1, 0.24, -0.08);
        studio.snare(start + BEAT * 3, 0.24, 0.08);
        for (let eighth = 0; eighth < 8; eighth += 1) {
          studio.hat(start + eighth * BEAT * 0.5, eighth % 2 === 0 ? 0.028 : 0.018, eighth === 7);
        }
        if (inDrop && (bar % 4 === 0 || bar % 4 === 2)) studio.clap(start + BEAT * 1, 0.12);
        if (inDrop && bar % 4 === 2) studio.clap(start + BEAT * 3, 0.1);
      }
    }

    if (bar === 8 || bar === 32 || bar === 48 || bar === 64) studio.crash(start, 0.07);

    // Bass.
    if (!inIntro && !inOutro) {
      const root = chord.root;
      const pattern = inBreak
        ? [
            [0, 0.5, 0],
            [2.5, 0.35, 0],
          ]
        : [
            [0, 0.4, 0],
            [0.75, 0.22, 0],
            [1.5, 0.32, 12],
            [2.25, 0.2, 0],
            [2.75, 0.38, 7],
            [3.5, 0.18, 12],
          ];
      for (const [offset, length, octave] of pattern) {
        studio.bass(start + offset * BEAT, length * BEAT, midiToFreq(root + octave), inBreak ? 0.13 : 0.16);
      }
    }

    // Arpeggio.
    if (!inIntro && !inOutro) {
      const tones = [...chord.notes, ...chord.color].map((midi) => midi + 12);
      const steps = inBreak ? 8 : 16;
      for (let step = 0; step < steps; step += 1) {
        const idx = (step + bar) % tones.length;
        const octave = step % 8 >= 6 ? 12 : 0;
        studio.pluck(
          start + (step * BAR) / steps,
          inBreak ? 0.22 : 0.13,
          midiToFreq(tones[idx] + octave),
          inBreak ? 0.025 : 0.038,
          step % 2 ? 0.28 : -0.28,
        );
      }
    }

    // Lead motif in the break and final drop.
    if (inBreak || inDrop) {
      const density = inBreak ? 4 : 2;
      for (let step = 0; step < 16; step += density) {
        const note = MOTIF[(step + bar * 2) % MOTIF.length];
        const octave = inDrop && step > 10 ? 12 : 0;
        studio.lead(
          start + step * BEAT * 0.25,
          BEAT * (inBreak ? 0.9 : 0.55),
          midiToFreq(note + octave),
          inBreak ? 0.075 : 0.055,
        );
      }
      if (inBreak && bar % 4 === 0) {
        studio.lead(start, BEAT * 6, midiToFreq(PENTATONIC[bar % PENTATONIC.length]), 0.045);
      }
    }

    // Outro: a last low note and a soft high shimmer.
    if (inOutro) {
      studio.bass(start, BAR, midiToFreq(chord.root), 0.1);
      if (bar % 4 === 0) studio.crash(start, 0.035);
    }
  }

  return studio.finish();
}

export const GALACTIC_META = {
  name: 'Orbital Suite',
  bpm: BPM,
  key: 'D minor / dorian',
  description: 'Slow cosmic disco: warm analog pads, syncopated bass, glass arpeggios and a wordless lead. Original recording, no samples.',
};
