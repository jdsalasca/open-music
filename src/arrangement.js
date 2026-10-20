/**
 * arrangement.js — declarative song form.
 *
 * A preset declares sections in bars. The arrangement is then *fitted* to the
 * requested duration by scaling every section proportionally, so a 45 second
 * render still contains an intro, a break and an ending instead of being
 * truncated mid-groove.
 *
 * Sections may carry their own `bpm`, which is what lets a piece change tempo
 * between movements — a slow introduction into a fast allegro, say — without
 * faking it by stretching note lengths.
 */

/**
 * @typedef {object} Section
 * @property {string} name
 * @property {number} bars natural length in bars
 * @property {number} [bpm] tempo for this section; defaults to the arrangement's
 * @property {number} [minBars] never shrink below this (default 1)
 * @property {boolean} [essential] keep this section even when very short
 * @property {number} [intensity] arrangement energy, 0..1; presets use it to scale dynamics
 * @property {string[]} [layers] free-form tags the preset can switch on
 */

/**
 * Scales section lengths so they add up to exactly `targetBars`.
 *
 * Uses the largest-remainder method with per-section minimums, and drops
 * non-essential sections (from the end) when there is not even room for the
 * minimums.
 *
 * @param {Section[]} sections
 * @param {number} targetBars
 * @returns {Array<Section & { bars: number }>}
 */
export function fitBars(sections, targetBars) {
  const wanted = Math.max(1, Math.round(targetBars));
  let working = sections.map((s) => ({ ...s, minBars: Math.max(1, s.minBars ?? 1) }));

  const minTotal = () => working.reduce((sum, s) => sum + s.minBars, 0);
  while (working.length > 1 && minTotal() > wanted) {
    let dropIndex = -1;
    for (let i = working.length - 1; i >= 1; i -= 1) {
      if (!working[i].essential) {
        dropIndex = i;
        break;
      }
    }
    if (dropIndex === -1) break;
    working = working.filter((_, i) => i !== dropIndex);
  }

  if (working.length === 1) return [{ ...working[0], bars: wanted }];

  const natural = working.reduce((sum, s) => sum + s.bars, 0);
  const floor = minTotal();
  const flexible = Math.max(0, wanted - floor);
  const flexibleNatural = Math.max(0, natural - floor);

  const exact = working.map((s) => {
    const share = flexibleNatural > 0 ? (s.bars - s.minBars) / flexibleNatural : 1 / working.length;
    return s.minBars + share * flexible;
  });

  const result = exact.map((value) => Math.floor(value));
  let remaining = wanted - result.reduce((a, b) => a + b, 0);
  const order = exact
    .map((value, index) => ({ index, frac: value - Math.floor(value) }))
    .sort((a, b) => b.frac - a.frac || a.index - b.index);
  for (let i = 0; remaining > 0 && i < order.length; i += 1) {
    result[order[i].index] += 1;
    remaining -= 1;
  }
  for (let i = 0; remaining > 0; i = (i + 1) % result.length) {
    result[i] += 1;
    remaining -= 1;
  }

  return working.map((s, i) => ({ ...s, bars: result[i] }));
}

/**
 * Walks a song form bar by bar, resolving the active section and its local
 * progress. Presets render inside `forEachBar`, which keeps the musical code
 * free of time arithmetic.
 */
export class Arrangement {
  /**
   * @param {{ bpm?: number, beatsPerBar?: number, sections?: Section[] }} [opts]
   */
  constructor({ bpm = 120, beatsPerBar = 4, sections = [] } = {}) {
    if (sections.length === 0) throw new Error('Arrangement needs at least one section');
    this.bpm = bpm;
    this.beatsPerBar = beatsPerBar;
    /** The declared form, kept pristine so repeated `fit()` calls never drift. */
    this.base = sections.map((section) => ({ ...section }));
    this.natural = this.base.reduce((sum, s) => sum + s.bars, 0);
    this.sections = fitBars(this.base, this.natural);
    this.fitted = false;
  }

  /** @returns {number} seconds per beat at the arrangement's base tempo */
  get beat() {
    return 60 / this.bpm;
  }

  /** @returns {number} seconds per bar at the arrangement's base tempo */
  get bar() {
    return this.beat * this.beatsPerBar;
  }

  /** @returns {number} the form's natural length in bars, ignoring any fit */
  get naturalBars() {
    return this.natural;
  }

  /**
   * Seconds per bar for a section, honouring its own `bpm` when it has one.
   * @param {Section} section
   * @returns {number}
   */
  barSeconds(section) {
    const bpm = section?.bpm ?? this.bpm;
    return (this.beatsPerBar * 60) / bpm;
  }

  /** @returns {number} current total bars */
  get bars() {
    return this.sections.reduce((sum, s) => sum + s.bars, 0);
  }

  /** @returns {number} current total length in seconds, across every tempo */
  get seconds() {
    return this.sections.reduce((sum, s) => sum + s.bars * this.barSeconds(s), 0);
  }

  /** @returns {number} the natural form's length in seconds */
  get naturalSeconds() {
    return this.base.reduce((sum, s) => sum + s.bars * this.barSeconds(s), 0);
  }

  /**
   * Rescales the form so it lasts approximately `seconds`. Always fits from the
   * original declaration, so calling it repeatedly is stable.
   * @param {number} seconds
   * @returns {this}
   */
  fit(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`fit() needs a positive duration, got ${seconds}`);
    // Scale by the ratio of durations, not by a single bar length: sections may
    // run at different tempi.
    const targetBars = Math.max(1, Math.round((seconds / this.naturalSeconds) * this.natural));
    this.sections = fitBars(this.base, targetBars);
    this.fitted = targetBars !== this.natural;
    return this;
  }

  /**
   * Resolves each section to absolute bar and time ranges.
   * @returns {Array<Section & { bars: number, barSeconds: number, from: number, to: number, start: number, end: number, index: number }>}
   */
  layout() {
    let bar = 0;
    let time = 0;
    return this.sections.map((section, index) => {
      const barSeconds = this.barSeconds(section);
      const from = bar;
      const to = bar + section.bars;
      const start = time;
      const end = start + section.bars * barSeconds;
      bar = to;
      time = end;
      return { ...section, index, barSeconds, from, to, start, end };
    });
  }

  /**
   * @param {number} seconds absolute time
   * @returns {(Section & { from: number, to: number, start: number, end: number }) | null}
   */
  sectionAt(seconds) {
    const layout = this.layout();
    for (const section of layout) {
      if (seconds >= section.start && seconds < section.end) return section;
    }
    return layout[layout.length - 1] ?? null;
  }

  /**
   * Iterates every bar in the form.
   * @param {(ctx: {
   *   bar: number, start: number, section: object, sectionIndex: number,
   *   barInSection: number, barsInSection: number, progress: number,
   *   sectionProgress: number, intensity: number, barSeconds: number,
   *   beatSeconds: number, at: (beats: number) => number,
   * }) => void} fn
   */
  forEachBar(fn) {
    const layout = this.layout();
    for (const section of layout) {
      const barsInSection = section.bars;
      const barSeconds = section.barSeconds;
      const beatSeconds = barSeconds / this.beatsPerBar;
      for (let i = 0; i < barsInSection; i += 1) {
        const bar = section.from + i;
        const start = section.start + i * barSeconds;
        const ctx = {
          bar,
          start,
          section,
          sectionIndex: section.index,
          barInSection: i,
          barsInSection,
          progress: bar / Math.max(1, this.bars - 1),
          sectionProgress: barsInSection <= 1 ? 1 : i / (barsInSection - 1),
          intensity: section.intensity ?? 0.5,
          barSeconds,
          beatSeconds,
          at: (beats) => start + beats * beatSeconds,
        };
        fn(ctx);
      }
    }
  }
}

/**
 * Human-readable one-line form summary, e.g. `intro:8 groove:24 break:16`.
 * @param {Arrangement} arrangement
 * @returns {string}
 */
export function describeForm(arrangement) {
  return arrangement
    .layout()
    .map((s) => `${s.name}:${s.bars}`)
    .join(' ');
}
