import { writeFileSync } from 'node:fs';

/**
 * Standard MIDI File (SMF) writer.
 *
 * Emits format 1 files (one conductor track plus one track per instrument) at
 * 480 ticks per quarter note, which is the de-facto resolution used by every
 * sequencer. No dependencies: raw bytes are assembled with `Buffer` and all
 * multi-byte fields are written big-endian as the specification requires.
 *
 * Typical use:
 *
 *   const score = new Score({ bpm: 108, name: 'Ram Orbital Suite' });
 *   score.addTrack('bass', { program: 38 });
 *   score.addTrack('drums', { drum: true });
 *   score.note('bass', { start: 0, duration: 0.5, midi: 38, velocity: 0.9 });
 *   score.write('out.mid');
 */

/** Ticks per quarter note used for every file this module writes. */
export const TICKS_PER_QUARTER = 480;

/** Delta-time tick ceiling (SMF deltas are variable-length 32-bit values). */
const MAX_TICK = 0x0fffffff;

/** The General MIDI percussion channel (zero-based). */
const DRUM_CHANNEL = 9;

const META = {
  trackName: 0x03,
  endOfTrack: 0x2f,
  tempo: 0x51,
  timeSignature: 0x58,
};

const HEADER_CHUNK = 'MThd';
const TRACK_CHUNK = 'MTrk';

/**
 * Encode a number as a MIDI variable-length quantity: seven bits per byte,
 * high bit set on every byte except the last.
 *
 * @param {number} value Non-negative integer.
 * @returns {number[]} Encoded bytes, one to four of them.
 */
export function encodeVlq(value) {
  const bytes = [value & 0x7f];
  let rest = Math.floor(value / 128);
  while (rest > 0) {
    bytes.unshift((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  return bytes;
}

/**
 * @param {number} value
 * @param {number} low
 * @param {number} high
 * @returns {number} `value` truncated and clamped into `[low, high]`.
 */
function clampInt(value, low, high) {
  const number = Math.trunc(Number(value));
  if (!Number.isFinite(number)) return low;
  return Math.min(high, Math.max(low, number));
}

/**
 * @param {number} value 0..1 expressive velocity.
 * @returns {number} MIDI velocity in 1..127. Never 0: that would be a note-off.
 */
function toVelocity(value) {
  const number = Number(value);
  const scaled = Number.isFinite(number) ? Math.round(number * 127) : 127;
  return Math.min(127, Math.max(1, scaled));
}

/**
 * @param {string} text
 * @returns {number[]} UTF-8 bytes of `text` truncated to the 127-byte meta limit.
 */
function textBytes(text) {
  return [...Buffer.from(String(text), 'utf8').subarray(0, 127)];
}

/**
 * Build meta-event payload bytes (everything after the `FF <type> <length>`).
 *
 * @param {number} type Meta event type byte.
 * @param {number[]} data Payload bytes.
 * @returns {number[]} Full meta event including its status byte.
 */
function metaEvent(type, data) {
  return [0xff, type, ...encodeVlq(data.length), ...data];
}

/**
 * Build a track-name meta event.
 *
 * @param {string} name
 * @returns {number[]} Meta event bytes.
 */
function trackNameEvent(name) {
  return metaEvent(META.trackName, textBytes(name));
}

/**
 * Build a `setTempo` meta event.
 *
 * @param {number} bpm Beats per minute.
 * @returns {number[]} Meta event bytes holding microseconds per quarter note.
 */
function tempoEvent(bpm) {
  const microseconds = Math.max(1, Math.round(60000000 / bpm));
  return metaEvent(META.tempo, [(microseconds >> 16) & 0xff, (microseconds >> 8) & 0xff, microseconds & 0xff]);
}

/**
 * Build a 4/4 time-signature meta event.
 *
 * @returns {number[]} Meta event bytes.
 */
function timeSignatureEvent() {
  // numerator 4, denominator 2^2 = 4, 24 MIDI clocks per metronome click,
  // 8 32nd-notes per quarter note.
  return metaEvent(META.timeSignature, [4, 2, 24, 8]);
}

/**
 * @returns {number[]} End-of-track meta event bytes.
 */
function endOfTrackEvent() {
  return metaEvent(META.endOfTrack, []);
}

/**
 * Serialize one flat event list into an `MTrk` chunk: sort by tick, delta-encode,
 * and prepend the chunk id and payload length.
 *
 * @param {Array<{ tick: number, order: number, bytes: number[] }>} events
 * @returns {Buffer} Complete track chunk.
 */
function buildTrackChunk(events) {
  events.sort((a, b) => (a.tick - b.tick) || (a.order - b.order));
  const payload = [];
  let previous = 0;
  for (const event of events) {
    const tick = Math.min(MAX_TICK, Math.max(0, Math.round(event.tick)));
    payload.push(...encodeVlq(tick - previous), ...event.bytes);
    previous = tick;
  }
  const chunk = Buffer.alloc(8 + payload.length);
  chunk.write(TRACK_CHUNK, 0, 'latin1');
  chunk.writeUInt32BE(payload.length, 4);
  Buffer.from(payload).copy(chunk, 8);
  return chunk;
}

/**
 * Accumulates notes against named tracks, then renders them to an SMF buffer.
 *
 * Events are collected unsorted and ordered at render time, so notes may be
 * added in any order and may overlap freely.
 */
export class Score {
  /**
   * @param {object} [options]
   * @param {number} [options.bpm=120] Tempo written to the conductor track.
   * @param {string} [options.name='Untitled'] Song name for the conductor track.
   */
  constructor({ bpm = 120, name = 'Untitled' } = {}) {
    const tempo = Number(bpm);
    /** @type {number} */
    this.bpm = Number.isFinite(tempo) && tempo > 0 ? tempo : 120;
    /** @type {string} */
    this.name = String(name);
    /** @type {Map<string, { name: string, program: number, channel: number, drum: boolean, notes: Array<object> }>} */
    this._tracks = new Map();
  }

  /**
   * Register a track, or return the existing one when the name is already used.
   *
   * @param {string} name Track name (also the handle used by {@link Score#note}).
   * @param {object} [options]
   * @param {number} [options.program=0] GM program number, clamped to 0-127.
   * @param {number} [options.channel=0] MIDI channel, clamped to 0-15.
   * @param {boolean} [options.drum=false] Percussion track: forced to channel 9
   *   and emitted without a program change.
   * @returns {number} Index of the track, counting the conductor track as 0.
   */
  addTrack(name, { program = 0, channel = 0, drum = false } = {}) {
    const key = String(name);
    const existing = this._tracks.get(key);
    if (existing) return this._indexOf(key);
    const percussion = Boolean(drum);
    this._tracks.set(key, {
      name: key,
      program: clampInt(program, 0, 127),
      channel: percussion ? DRUM_CHANNEL : clampInt(channel, 0, 15),
      drum: percussion,
      notes: [],
    });
    return this._tracks.size; // index 0 is the conductor track
  }

  /**
   * Append a note. `start` and `duration` are in seconds and are converted to
   * ticks with the score tempo.
   *
   * @param {string} trackName Name passed to {@link Score#addTrack}.
   * @param {object} note
   * @param {number} note.start Note-on time in seconds.
   * @param {number} note.duration Sounding length in seconds (must be > 0).
   * @param {number} note.midi Pitch, clamped to 0-127.
   * @param {number} [note.velocity=0.8] Expressive velocity 0..1, scaled to 1..127.
   * @returns {void}
   * @throws {Error} If `trackName` was never registered.
   */
  note(trackName, { start, duration, midi, velocity = 0.8 } = {}) {
    const track = this._tracks.get(String(trackName));
    if (!track) {
      throw new Error(
        `Score.note: unknown track "${trackName}". Add it first with addTrack(name, options).`,
      );
    }
    const from = Number(start);
    const length = Number(duration);
    const pitch = Number(midi);
    if (![from, length, pitch].every(Number.isFinite)) return;
    if (from < 0 || length <= 0) return;
    const startTick = this.secondsToTicks(from);
    track.notes.push({
      startTick,
      endTick: Math.max(startTick + 1, this.secondsToTicks(from + length)),
      midi: clampInt(pitch, 0, 127),
      velocity: toVelocity(velocity),
    });
  }

  /**
   * Track descriptors, conductor track excluded. The array is a fresh copy; the
   * descriptors it holds are the live ones.
   *
   * @returns {Array<{ name: string, program: number, channel: number, drum: boolean, notes: Array<{ start: number, duration: number, midi: number, velocity: number }> }>}
   */
  get tracks() {
    return [...this._tracks.values()].map((track) => ({
      name: track.name,
      program: track.program,
      channel: track.channel,
      drum: track.drum,
      notes: track.notes.map((note) => ({
        start: note.startTick / this._ticksPerSecond(),
        duration: (note.endTick - note.startTick) / this._ticksPerSecond(),
        midi: note.midi,
        velocity: note.velocity / 127,
      })),
    }));
  }

  /**
   * Total length in seconds: the latest note end across every track.
   *
   * @returns {number} Seconds, or 0 when no notes have been added.
   */
  get duration() {
    let latest = 0;
    for (const track of this._tracks.values()) {
      for (const note of track.notes) latest = Math.max(latest, note.endTick);
    }
    return latest / this._ticksPerSecond();
  }

  /**
   * @param {number} seconds
   * @returns {number} Tick position, rounded.
   */
  secondsToTicks(seconds) {
    return Math.round((seconds * this.bpm * TICKS_PER_QUARTER) / 60);
  }

  /**
   * @returns {number} Ticks per second at the score tempo.
   */
  _ticksPerSecond() {
    return (this.bpm * TICKS_PER_QUARTER) / 60;
  }

  /**
   * @param {string} name Track name.
   * @returns {number} Index of that track, conductor track counted as 0.
   */
  _indexOf(name) {
    let index = 1;
    for (const key of this._tracks.keys()) {
      if (key === name) return index;
      index += 1;
    }
    return -1;
  }

  /**
   * @returns {Buffer} Conductor track: name, tempo and 4/4 time signature.
   */
  _buildConductorTrack() {
    const events = [
      { tick: 0, order: 0, bytes: trackNameEvent(this.name) },
      { tick: 0, order: 0, bytes: tempoEvent(this.bpm) },
      { tick: 0, order: 0, bytes: timeSignatureEvent() },
      { tick: this.secondsToTicks(this.duration), order: 0, bytes: endOfTrackEvent() },
    ];
    return buildTrackChunk(events);
  }

  /**
   * @param {{ name: string, program: number, channel: number, drum: boolean, notes: Array<object> }} track
   * @returns {Buffer} One instrument track chunk.
   */
  _buildTrack(track) {
    const status = track.channel & 0x0f;
    const events = [{ tick: 0, order: 0, bytes: trackNameEvent(track.name) }];
    if (!track.drum) {
      events.push({ tick: 0, order: 0, bytes: [0xc0 | status, track.program & 0x7f] });
    }
    let lastTick = 0;
    for (const note of track.notes) {
      // Note-offs sort before note-ons at the same tick so a repeated pitch
      // retriggers instead of being cancelled by its own predecessor.
      events.push({ tick: note.startTick, order: 1, bytes: [0x90 | status, note.midi, note.velocity] });
      events.push({ tick: note.endTick, order: 0, bytes: [0x80 | status, note.midi, 0x40] });
      lastTick = Math.max(lastTick, note.endTick);
    }
    events.push({ tick: lastTick, order: 2, bytes: endOfTrackEvent() });
    return buildTrackChunk(events);
  }

  /**
   * Render the score as a format 1 Standard MIDI File.
   *
   * @returns {Buffer} Complete SMF: `MThd` header, conductor track, then one
   *   `MTrk` chunk per registered track. An empty score still yields a valid
   *   file containing only the conductor track.
   */
  toBuffer() {
    const chunks = [this._buildConductorTrack()];
    for (const track of this._tracks.values()) chunks.push(this._buildTrack(track));

    const header = Buffer.alloc(14);
    header.write(HEADER_CHUNK, 0, 'latin1');
    header.writeUInt32BE(6, 4); // header payload length is always 6
    header.writeUInt16BE(1, 8); // format 1: conductor + independent tracks
    header.writeUInt16BE(chunks.length, 10);
    header.writeUInt16BE(TICKS_PER_QUARTER, 12);

    return Buffer.concat([header, ...chunks]);
  }

  /**
   * Write the score to disk.
   *
   * @param {string} file Destination path.
   * @returns {string} The same path, for chaining.
   */
  write(file) {
    writeFileSync(file, this.toBuffer());
    return file;
  }
}

/**
 * Convenience writer: build a score from a plain track list and save it.
 *
 * Each track entry may be `{ name, program, channel, drum, notes }`, where
 * `notes` is an array of `{ start, duration, midi, velocity }` in seconds.
 * A `Score` instance may be passed instead of an options object, in which case
 * it is written as-is.
 *
 * @param {string} file Destination `.mid` path.
 * @param {object|Score} [options]
 * @param {number} [options.bpm=120] Tempo in beats per minute.
 * @param {string} [options.name='Untitled'] Song name.
 * @param {Array<object>} [options.tracks=[]] Track descriptors.
 * @returns {string} The file path written.
 */
export function writeMidi(file, { bpm = 120, name = 'Untitled', tracks = [] } = {}) {
  if (bpm instanceof Score) return bpm.write(file);
  const score = new Score({ bpm, name });
  for (const track of Array.isArray(tracks) ? tracks : []) {
    const trackName = track.name ?? `track ${score.tracks.length + 1}`;
    score.addTrack(trackName, { program: track.program, channel: track.channel, drum: track.drum });
    for (const note of track.notes ?? []) {
      score.note(trackName, {
        start: note.start ?? 0,
        duration: note.duration,
        midi: note.midi,
        velocity: note.velocity ?? 0.8,
      });
    }
  }
  return score.write(file);
}
