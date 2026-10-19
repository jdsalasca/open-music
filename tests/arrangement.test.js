import test from 'node:test';
import assert from 'node:assert/strict';
import { Arrangement, fitBars, describeForm } from '../src/arrangement.js';

const SECTIONS = [
  { name: 'intro', bars: 8, intensity: 0.1 },
  { name: 'groove', bars: 24, intensity: 0.5 },
  { name: 'break', bars: 16, intensity: 0.4 },
  { name: 'drop', bars: 16, intensity: 1 },
  { name: 'outro', bars: 8, intensity: 0.2 },
];

test('fitBars always sums to the target', () => {
  for (let target = 1; target <= 80; target += 1) {
    const fitted = fitBars(SECTIONS, target);
    const total = fitted.reduce((sum, s) => sum + s.bars, 0);
    assert.equal(total, target, `target ${target} produced ${total}`);
    for (const section of fitted) assert.ok(section.bars >= 1, `section ${section.name} collapsed`);
  }
});

test('fitBars preserves every section when there is room', () => {
  const fitted = fitBars(SECTIONS, 36);
  assert.equal(fitted.length, SECTIONS.length);
  assert.deepEqual(
    fitted.map((s) => s.name),
    SECTIONS.map((s) => s.name),
  );
});

test('fitBars scales proportionally', () => {
  const fitted = fitBars(SECTIONS, 36);
  const byName = Object.fromEntries(fitted.map((s) => [s.name, s.bars]));
  // 24 of 72 bars is a third, so groove should get about 12 of 36.
  assert.ok(Math.abs(byName.groove - 12) <= 1, `groove was ${byName.groove}`);
  assert.ok(byName.drop >= byName.intro || byName.drop >= 4);
});

test('fitBars drops non-essential sections when the target is tiny', () => {
  const fitted = fitBars(SECTIONS, 2);
  assert.ok(fitted.length <= 2);
  assert.equal(
    fitted.reduce((sum, s) => sum + s.bars, 0),
    2,
  );
});

test('fitBars respects essential sections', () => {
  const sections = [
    { name: 'a', bars: 10, essential: true },
    { name: 'b', bars: 10 },
    { name: 'c', bars: 10 },
    { name: 'd', bars: 10, essential: true },
  ];
  const fitted = fitBars(sections, 2);
  assert.equal(fitted.length, 2);
  assert.deepEqual(
    fitted.map((s) => s.name),
    ['a', 'd'],
  );
});

test('Arrangement exposes beat and bar durations from the tempo', () => {
  const arrangement = new Arrangement({ bpm: 120, beatsPerBar: 4, sections: SECTIONS });
  assert.equal(arrangement.beat, 0.5);
  assert.equal(arrangement.bar, 2);
  assert.equal(arrangement.bars, 72);
  assert.equal(arrangement.seconds, 144);
});

test('Arrangement.fit rescales to the requested duration', () => {
  const arrangement = new Arrangement({ bpm: 108, beatsPerBar: 4, sections: SECTIONS });
  assert.equal(arrangement.naturalBars, 72);
  const natural = arrangement.seconds;
  assert.ok(Math.abs(natural - 160) < 0.01, `natural length ${natural}`);
  arrangement.fit(60);
  // Section boundaries never land exactly on 60s, but the form must be close.
  assert.ok(Math.abs(arrangement.seconds - 60) < arrangement.bar, `fitted to ${arrangement.seconds}`);
  assert.ok(arrangement.fitted);
  const names = arrangement.layout().map((s) => s.name);
  assert.deepEqual(names, SECTIONS.map((s) => s.name), 'every section must survive a 60s fit');
});

test('fit is stable when called repeatedly and never accumulates drift', () => {
  const arrangement = new Arrangement({ bpm: 108, beatsPerBar: 4, sections: SECTIONS });
  const first = arrangement.fit(45).seconds;
  const second = arrangement.fit(45).seconds;
  assert.equal(first, second, 'repeated fits drifted');
  assert.equal(arrangement.naturalBars, 72, 'the natural length must not change');
  const back = arrangement.fit(160).seconds;
  assert.ok(Math.abs(back - 160) < 1e-9, `fitting back to natural gave ${back}`);
});

test('fit rejects nonsense durations', () => {
  const arrangement = new Arrangement({ bpm: 120, beatsPerBar: 4, sections: SECTIONS });
  assert.throws(() => arrangement.fit(0), /positive duration/);
  assert.throws(() => arrangement.fit(Number.NaN), /positive duration/);
});

test('sectionAt resolves boundaries to the later section', () => {
  const arrangement = new Arrangement({ bpm: 120, beatsPerBar: 4, sections: SECTIONS });
  assert.equal(arrangement.sectionAt(0).name, 'intro');
  assert.equal(arrangement.sectionAt(2 * 8 - 0.001).name, 'intro');
  assert.equal(arrangement.sectionAt(2 * 8).name, 'groove');
  const last = arrangement.layout().at(-1);
  assert.equal(arrangement.sectionAt(1e9).name, last.name);
});

test('forEachBar visits every bar exactly once, in order', () => {
  const arrangement = new Arrangement({ bpm: 120, beatsPerBar: 4, sections: SECTIONS });
  let expected = 0;
  let count = 0;
  arrangement.forEachBar((ctx) => {
    assert.equal(ctx.bar, expected);
    assert.ok(Math.abs(ctx.start - expected * arrangement.bar) < 1e-9);
    assert.ok(ctx.at(0) === ctx.start);
    assert.ok(Math.abs(ctx.at(1) - (ctx.start + arrangement.beat)) < 1e-9);
    assert.ok(ctx.intensity > 0);
    expected += 1;
    count += 1;
  });
  assert.equal(count, arrangement.bars);
});

test('forEachBar reports local section progress', () => {
  const arrangement = new Arrangement({ bpm: 120, beatsPerBar: 4, sections: SECTIONS });
  arrangement.forEachBar((ctx) => {
    if (ctx.section.name !== 'intro') return;
    assert.equal(ctx.barsInSection, 8);
    assert.ok(ctx.barInSection >= 0 && ctx.barInSection < 8);
    assert.ok(ctx.sectionProgress >= 0 && ctx.sectionProgress <= 1);
  });
});

test('describeForm lists sections with bar counts', () => {
  const arrangement = new Arrangement({ bpm: 120, beatsPerBar: 4, sections: SECTIONS });
  assert.equal(describeForm(arrangement), 'intro:8 groove:24 break:16 drop:16 outro:8');
});

test('Arrangement rejects an empty section list', () => {
  assert.throws(() => new Arrangement({ sections: [] }), /at least one section/);
});
