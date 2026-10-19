import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Score, writeMidi, TICKS_PER_QUARTER, encodeVlq } from '../src/midi.js';

const tmp = mkdtempSync(path.join(tmpdir(), 'open-music-midi-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

/**
 * Walks the chunk structure of an SMF buffer and returns each track payload.
 * @param {Buffer} buffer
 */
function parseChunks(buffer) {
  assert.equal(buffer.toString('ascii', 0, 4), 'MThd');
  const headerLength = buffer.readUInt32BE(4);
  assert.equal(headerLength, 6);
  const format = buffer.readUInt16BE(8);
  const declaredTracks = buffer.readUInt16BE(10);
  const division = buffer.readUInt16BE(12);
  const tracks = [];
  let offset = 8 + headerLength;
  while (offset < buffer.length) {
    assert.equal(buffer.toString('ascii', offset, offset + 4), 'MTrk', `bad chunk at ${offset}`);
    const length = buffer.readUInt32BE(offset + 4);
    const start = offset + 8;
    const end = start + length;
    assert.ok(end <= buffer.length, 'chunk length overruns the file');
    tracks.push(buffer.subarray(start, end));
    offset = end;
  }
  assert.equal(offset, buffer.length, 'chunk walk did not land exactly on EOF');
  return { format, declaredTracks, division, tracks };
}

test('encodeVlq matches the MIDI variable-length table', () => {
  assert.deepEqual([...encodeVlq(0)], [0x00]);
  assert.deepEqual([...encodeVlq(127)], [0x7f]);
  assert.deepEqual([...encodeVlq(128)], [0x81, 0x00]);
  assert.deepEqual([...encodeVlq(0x3fff)], [0xff, 0x7f]);
  assert.deepEqual([...encodeVlq(0x4000)], [0x81, 0x80, 0x00]);
});

test('an empty score still produces a valid one-track file', () => {
  const score = new Score({ bpm: 120 });
  const parsed = parseChunks(score.toBuffer());
  assert.equal(parsed.format, 1);
  assert.equal(parsed.division, TICKS_PER_QUARTER);
  assert.equal(parsed.tracks.length, 1);
  assert.equal(parsed.declaredTracks, 1);
});

test('addTrack is idempotent by name and indexes count the conductor', () => {
  const score = new Score({ bpm: 100 });
  const a = score.addTrack('piano', { program: 0 });
  const b = score.addTrack('piano', { program: 5 });
  assert.equal(a, b, 'the same name must return the same index');
  assert.equal(a, 1, 'the conductor occupies index 0');
  assert.equal(score.tracks.length, 1, 'the tracks getter excludes the conductor');
  assert.equal(score.addTrack('bass', { program: 38 }), 2);
  assert.equal(score.tracks.length, 2);
});

test('note() throws for an unknown track', () => {
  const score = new Score({ bpm: 120 });
  assert.throws(() => score.note('nope', { start: 0, duration: 1, midi: 60 }), /unknown track/i);
});

test('a score with notes round-trips as a well-formed file', () => {
  const score = new Score({ bpm: 120, name: 'Test' });
  score.addTrack('lead', { program: 81, channel: 0 });
  score.addTrack('drums', { drum: true });
  score.note('lead', { start: 0, duration: 0.5, midi: 60, velocity: 1 });
  score.note('lead', { start: 0.5, duration: 0.5, midi: 64, velocity: 0.5 });
  score.note('lead', { start: 1, duration: 0.5, midi: 67, velocity: 0.8 });
  score.note('drums', { start: 0, duration: 0.1, midi: 36, velocity: 0.9 });
  score.note('drums', { start: 1, duration: 0.1, midi: 38, velocity: 0.9 });

  const buffer = score.toBuffer();
  const parsed = parseChunks(buffer);
  assert.equal(parsed.format, 1);
  assert.equal(parsed.declaredTracks, parsed.tracks.length);
  assert.equal(parsed.tracks.length, 3);

  // Every track payload must end with an end-of-track meta event.
  for (const track of parsed.tracks) {
    assert.equal(track.readUInt8(track.length - 3), 0xff);
    assert.equal(track.readUInt8(track.length - 2), 0x2f);
    assert.equal(track.readUInt8(track.length - 1), 0x00);
  }

  // The conductor track must carry a tempo meta event of 500000us for 120bpm.
  const conductor = parsed.tracks[0];
  assert.ok(conductor.includes(Buffer.from([0xff, 0x51, 0x03, 0x07, 0xa1, 0x20])), 'tempo meta missing');

  // Drum track must be on channel 9 and must not carry a program change.
  const drumTrack = parsed.tracks[2];
  assert.ok(drumTrack.includes(Buffer.from([0xff, 0x03])), 'track name meta missing');
  const channelEvents = [];
  for (let i = 0; i < drumTrack.length - 2; i += 1) {
    if (drumTrack[i] === 0x99 || drumTrack[i] === 0x89) channelEvents.push(drumTrack[i]);
  }
  assert.equal(channelEvents.length, 4, 'expected 2 note-ons and 2 note-offs on channel 9');
});

/**
 * Parses one SMF track payload into ordered events, handling running status.
 * @param {Buffer} track
 * @returns {Array<{ tick: number, type: string, channel?: number, midi?: number, velocity?: number, meta?: number }>}
 */
function parseTrackEvents(track) {
  const events = [];
  let index = 0;
  let tick = 0;
  let running = null;
  while (index < track.length) {
    let value = 0;
    let byte = 0;
    do {
      byte = track[index];
      value = (value << 7) | (byte & 0x7f);
      index += 1;
    } while (byte & 0x80);
    tick += value;
    let status = track[index];
    if (status & 0x80) {
      index += 1;
      running = status;
    } else {
      status = running;
    }
    if (status === 0xff) {
      const meta = track[index];
      index += 1;
      let length = 0;
      do {
        byte = track[index];
        length = (length << 7) | (byte & 0x7f);
        index += 1;
      } while (byte & 0x80);
      index += length;
      events.push({ tick, type: 'meta', meta });
      if (meta === 0x2f) break;
    } else {
      const kind = status & 0xf0;
      const channel = status & 0x0f;
      if (kind === 0xc0 || kind === 0xd0) {
        events.push({ tick, type: kind === 0xc0 ? 'program' : 'aftertouch', channel });
        index += 1;
      } else {
        const type = kind === 0x90 ? 'on' : kind === 0x80 ? 'off' : 'other';
        events.push({ tick, type, channel, midi: track[index], velocity: track[index + 1] });
        index += 2;
      }
    }
  }
  return events;
}

test('note-offs are ordered before note-ons at the same tick', () => {
  const score = new Score({ bpm: 120 });
  score.addTrack('lead', { program: 0 });
  score.note('lead', { start: 0, duration: 1, midi: 60 });
  score.note('lead', { start: 1, duration: 1, midi: 60 });
  const events = parseTrackEvents(parseChunks(score.toBuffer()).tracks[1]);
  const atTick = events.filter((e) => e.tick === 960 && (e.type === 'on' || e.type === 'off'));
  assert.deepEqual(
    atTick.map((e) => e.type),
    ['off', 'on'],
    'the retrigger must come after the release at the same tick',
  );
  assert.equal(events.filter((e) => e.type === 'on').length, 2);
  assert.equal(events.filter((e) => e.type === 'off').length, 2);
  assert.equal(events.at(-1).type, 'meta');
  assert.equal(events.at(-1).meta, 0x2f, 'track must end with end-of-track');
});

test('drum tracks carry no program change and use channel 9', () => {
  const score = new Score({ bpm: 120 });
  score.addTrack('kit', { drum: true, program: 5 });
  score.note('kit', { start: 0, duration: 0.1, midi: 36 });
  const events = parseTrackEvents(parseChunks(score.toBuffer()).tracks[1]);
  assert.equal(events.filter((e) => e.type === 'program').length, 0);
  for (const event of events.filter((e) => e.type === 'on' || e.type === 'off')) {
    assert.equal(event.channel, 9);
  }
});

test('ticks scale with the tempo', () => {
  const at120 = new Score({ bpm: 120 });
  at120.addTrack('lead', { program: 0 });
  at120.note('lead', { start: 1, duration: 0.001, midi: 60 });
  const at60 = new Score({ bpm: 60 });
  at60.addTrack('lead', { program: 0 });
  at60.note('lead', { start: 1, duration: 0.001, midi: 60 });
  assert.ok(scoreTickGap(at120) > scoreTickGap(at60), 'faster tempo must produce more ticks per second');
});

/** @param {Score} score @returns {number} */
function scoreTickGap(score) {
  const track = parseChunks(score.toBuffer()).tracks[1];
  let index = 0;
  const deltas = [];
  while (index < track.length) {
    let value = 0;
    let byte = 0;
    do {
      byte = track[index];
      value = (value << 7) | (byte & 0x7f);
      index += 1;
    } while (byte & 0x80);
    deltas.push(value);
    if (index >= track.length) break;
    const status = track[index];
    if (status === 0xff) {
      index += 1;
      const type = track[index];
      index += 1;
      if (type === 0x2f) break;
      let length = 0;
      let b = 0;
      do {
        b = track[index];
        length = (length << 7) | (b & 0x7f);
        index += 1;
      } while (b & 0x80);
      index += length;
    } else {
      index += 1;
      const type = status & 0xf0;
      if (type === 0xc0 || type === 0xd0) index += 1;
      else index += 2;
    }
  }
  return deltas.reduce((a, b) => a + b, 0);
}

test('velocity is scaled to 1..127 and never zero', () => {
  const score = new Score({ bpm: 120 });
  score.addTrack('lead', { program: 0 });
  score.note('lead', { start: 0, duration: 0.1, midi: 60, velocity: 0 });
  score.note('lead', { start: 0.2, duration: 0.1, midi: 62, velocity: 1 });
  const track = parseChunks(score.toBuffer()).tracks[1];
  let index = track.indexOf(0x90);
  const velocities = [];
  while (index !== -1 && index < track.length) {
    velocities.push(track[index + 2]);
    index = track.indexOf(0x90, index + 3);
  }
  assert.ok(velocities.includes(1), 'velocity 0 must clamp up to 1');
  assert.ok(velocities.includes(127), 'velocity 1 must clamp to 127');
});

test('duration reports the end of the last note', () => {
  const score = new Score({ bpm: 120 });
  score.addTrack('lead', { program: 0 });
  assert.equal(score.duration, 0);
  score.note('lead', { start: 2, duration: 1.5, midi: 60 });
  assert.equal(score.duration, 3.5);
});

test('write() persists a readable file', () => {
  const score = new Score({ bpm: 90, name: 'File test' });
  score.addTrack('lead', { program: 0 });
  score.note('lead', { start: 0, duration: 1, midi: 60 });
  const file = path.join(tmp, 'out.mid');
  assert.equal(score.write(file), file);
  const buffer = readFileSync(file);
  assert.equal(buffer.toString('ascii', 0, 4), 'MThd');
  assert.equal(parseChunks(buffer).tracks.length, 2);
});

test('writeMidi() builds and writes a file from plain track descriptors', () => {
  const file = path.join(tmp, 'direct.mid');
  const written = writeMidi(file, {
    bpm: 100,
    name: 'Direct',
    tracks: [{ name: 'lead', program: 0, notes: [{ start: 0, duration: 1, midi: 60 }] }],
  });
  assert.equal(written, file);
  assert.equal(parseChunks(readFileSync(file)).declaredTracks, 2);
});
