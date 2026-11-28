// Song: the chord progression as the page edits it. No MIDI, no DOM.
//   bars          number of bars, written out as the GO:KEYS plays them (a repeat's passes are real bars)
//   chords        chord changes [{ bar, beat, root, acc, type, bass, bassAcc }], sorted; a beat without one holds
//   variations    [{ bar, value }] 1-4 = Var 1-4, 5 = Fill Down, 6 = Fill Up; a variation carries on, a fill doesn't
//   settings      { transpose, loop, intro, introLong, ending, endingLong }
//   introChord, endingChord   one chord each, or null
//   starts, ends  repeat signs (bar -> true; a number in starts = that repeat's exact passes). Page-only: the GO:KEYS
//                 has no repeats, only the written-out bars.
//   pins          named bars that move with the bars around them (insert, delete, repeats), e.g. where play started.
// Edits that move bars return { structure: true } (the GO:KEYS needs the whole song again), plus optionally
// { select, open } (where the editor goes), { info } (a message) or { error } (refused, with the reason).
// Loaded as a classic script (window.GoKeys.Song) or with require() in Node (tests).
(function () {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports;
  const GoSysEx = isNode ? require('../midi/go-sysex.js') : window.GoKeys.GoSysEx;
  const { copyChord, majorChord, chordKey } = isNode ? require('./chord-names.js') : window.GoKeys.ChordNames;

  const BEATS = 4;                                  // GO:KEYS chord patterns are 4/4 (beat byte 0-3)
  const MAX_BARS = GoSysEx.MAX_BARS;
  const MIN_REPEAT = 4, MAX_REPEAT = 32;            // repeats found when a song is read
  const TRANSPOSE_MIN = -6, TRANSPOSE_MAX = 5;      // Roland's usual transpose range; not checked on the GO:KEYS
  const byPos = (x, y) => x.bar - y.bar || x.beat - y.beat;
  const copy = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));
  const tooLong = (more) => `The keyboard holds at most ${MAX_BARS} measures (repeats count every pass): no room for ${more} more.`;

  class Song {
    constructor(data) {
      this.loaded = false;
      this.set(data || {});
    }

    static defaults() { return { transpose: 0, loop: true, intro: false, introLong: false, ending: false, endingLong: false }; }

    // Replace everything with plain data (a saved song, a parsed file). Pins are cleared.
    set(d) {
      this.name = d.name || '';
      this.bars = d.bars || 0;
      this.chords = copy(d.chords || []);              // not re-sorted: saved songs are compared as JSON text
      this.variations = copy(d.variations || []);
      this.settings = Object.assign(Song.defaults(), d.settings);
      this.introChord = copy(d.introChord) || null;
      this.endingChord = copy(d.endingChord) || null;
      this.starts = Object.assign({}, d.starts);
      this.ends = Object.assign({}, d.ends);
      this.pins = {};
      this.changed();
      return this;
    }
    // A saved song: set it and mark it loaded.
    load(d) { this.set(d); this.loaded = true; return this; }
    // A song read from the GO:KEYS (a GoPattern or the same fields): its repeats are found from the written-out bars.
    loadFromGo(p) {
      this.set({ name: (p.name || '').replace(/\s+$/, ''), bars: p.bars, chords: p.chords, variations: p.variations,
        settings: p.settings, introChord: p.introChord, endingChord: p.endingChord });
      this.chords.sort(byPos);
      this.bars = Math.max(this.bars, this.chords.reduce((m, c) => Math.max(m, c.bar + 1), 0));
      this.detectRepeats();
      this.loaded = true;
      return this;
    }
    static fromJSON(d) { return new Song().load(d); }
    // Name (case and spaces at the ends ignored) and what sounds on each beat: two songs with the same key count as the
    // same song when one is uploaded, whatever their settings, variations or repeat signs.
    static likeKey(d) {
      return `${String(d.name || '').trim().toLowerCase()}\n${new Song(d).barSignatures().join('/')}`;
    }
    // What a saved song stores (the order of the fields matters: saved songs are compared as JSON text).
    toJSON() {
      return { name: this.name, bars: this.bars, chords: this.chords, variations: this.variations, settings: this.settings,
        introChord: this.introChord || null, endingChord: this.endingChord || null, starts: this.starts, ends: this.ends };
    }
    changed() { this.cache = null; }

    // ------------------------------------------------------------ queries
    chordAt(bar, beat) { return this.chords.find((c) => c.bar === bar && c.beat === beat) || null; }
    // The chord sounding at a position: the last change at or before it.
    chordInEffect(bar, beat) {
      let found = null;
      this.chords.forEach((c) => { if (c.bar < bar || (c.bar === bar && c.beat <= beat)) found = c; });
      return found;
    }
    // What each bar plays: { value, own } (own = the bar has its own entry, otherwise the variation carries on from an
    // earlier bar), or null when it isn't known: before the first entry, and after a fill until the next entry.
    barStyles() {
      const entry = {}, out = [];
      this.variations.forEach((v) => { entry[v.bar] = v.value; });
      let cur = null;
      for (let b = 0; b < this.bars; b++) {
        if (entry[b]) { cur = entry[b]; out.push({ value: cur, own: true }); continue; }
        if (cur > 4) cur = null;
        out.push(cur ? { value: cur, own: false } : null);
      }
      return out;
    }
    // The last variation entry before a bar.
    styleBefore(bar) {
      let prev = null;
      this.variations.forEach((v) => { if (v.bar < bar && (!prev || v.bar > prev.bar)) prev = v; });
      return prev;
    }

    // ------------------------------------------------------------ repeats
    // The chord changes written in each bar, as the grid shows them.
    barEntries() {
      const out = [];
      for (let b = 0; b < this.bars; b++) out.push('');
      this.chords.forEach((c) => {
        if (c.bar < this.bars) out[c.bar] += `${c.beat}.${chordKey(c)}|`;
      });
      return out;
    }
    // What sounds on each beat of each bar (a held F equals a new F entry).
    barSignatures() {
      const sigs = [], chords = this.chords;
      let k = 0, cur = '-';
      for (let b = 0; b < this.bars; b++) {
        const beats = [];
        for (let beat = 0; beat < BEATS; beat++) {
          while (k < chords.length && (chords[k].bar < b || (chords[k].bar === b && chords[k].beat <= beat))) cur = chordKey(chords[k++]);
          beats.push(cur);
        }
        sigs.push(beats.join('|'));
      }
      return sigs;
    }
    // Repeats in the written-out song: a block of 4+ bars played 2+ times in a row, compared by what sounds on each
    // beat (variations are ignored). Greedy from the start: at each bar the block covering the most bars (shorter on a tie).
    findRepeats() {
      const sig = this.barSignatures(), n = sig.length, found = [];
      const same = (a, b, len) => { for (let i = 0; i < len; i++) if (sig[a + i] !== sig[b + i]) return false; return true; };
      let s = 0;
      while (s < n) {
        let best = null;
        for (let len = MIN_REPEAT; len <= MAX_REPEAT && s + 2 * len <= n; len++) {
          let times = 1;
          while (s + (times + 1) * len <= n && same(s, s + times * len, len)) times++;
          if (times >= 2 && (!best || times * len > best.times * best.len)) best = { start: s, len, times };
        }
        if (best) { found.push(best); s += best.times * best.len; } else s++;
      }
      return found;
    }
    // Only when a song is read: after that the signs are the user's.
    detectRepeats() {
      this.starts = {}; this.ends = {};
      this.findRepeats().forEach((r) => { this.starts[r.start] = true; this.ends[r.start + r.len - 1] = true; });
      this.changed();
    }
    // Sign pairs -> repeats { start, len, times }; times counts the written-out passes. A pass matches if it sounds the
    // same or is written the same: a section that starts on a held chord looks identical to its copy even though a
    // different chord is held into each.
    markedRepeats() {
      const sig = this.barSignatures(), written = this.barEntries(), out = [];
      const same = (a, b, len) => {
        for (let i = 0; i < len; i++) if (sig[a + i] !== sig[b + i] && written[a + i] !== written[b + i]) return false;
        return true;
      };
      let open = null;
      for (let b = 0; b < this.bars; b++) {
        if (this.starts[b]) open = b;
        if (this.ends[b] && open != null) {
          const len = b - open + 1;
          const most = typeof this.starts[open] === 'number' ? this.starts[open] : Infinity;
          let times = 1;
          while (times < most && open + (times + 1) * len <= this.bars && same(open, open + times * len, len)) times++;
          out.push({ start: open, len, times });
          open = null;
          b += (times - 1) * len;                    // signs inside the hidden passes don't count
        }
      }
      return out;
    }
    // What the grid shows: repeats (active = played 2+ times), their later passes hidden, and the shown bars numbered
    // 1, 2, 3... as written (the bar after |: 1-8 :| is 9). Cached until the song changes.
    view() {
      if (!this.cache) {
        const repeats = this.markedRepeats(), active = repeats.filter((r) => r.times >= 2), hidden = {}, number = {};
        active.forEach((r) => { for (let b = r.start + r.len; b < r.start + r.times * r.len; b++) hidden[b] = true; });
        let n = 1;
        for (let b = 0; b < this.bars; b++) if (!hidden[b]) number[b] = n++;
        this.cache = { repeats, active, hidden, number };
      }
      return this.cache;
    }
    activeRepeatAt(bar) { return this.view().active.find((r) => bar >= r.start && bar < r.start + r.times * r.len) || null; }
    // The shown bar for a song bar (a bar in a hidden pass maps back to the first pass), and which pass it is (1, 2...).
    shownBar(bar) {
      if (typeof bar !== 'number') return { bar, pass: 0, r: null };
      const r = this.activeRepeatAt(bar);
      if (!r) return { bar, pass: 0, r: null };
      return { bar: r.start + ((bar - r.start) % r.len), pass: Math.floor((bar - r.start) / r.len) + 1, r };
    }
    // Every song bar a shown bar stands for (all passes of a repeat).
    passesOf(bar) {
      const r = this.activeRepeatAt(bar);
      if (!r) return [bar];
      const out = [];
      for (let k = 0; k < r.times; k++) out.push(bar + k * r.len);
      return out;
    }
    // A song bar as the user reads it: "3" on the first pass, "3+8" on the second, "3+16" on the third.
    passLabel(bar) {
      const at = this.shownBar(bar), n = this.view().number[at.bar];
      return at.r && at.pass > 1 ? `${n}+${(at.pass - 1) * at.r.len}` : String(n);
    }
    lastShownBar() { const h = this.view().hidden; for (let b = this.bars - 1; b >= 0; b--) if (!h[b]) return b; return 0; }

    // ------------------------------------------------------------ pins
    pin(name, bar) { this.pins[name] = bar; }
    pinned(name) { return this.pins[name]; }
    unpin(name) { delete this.pins[name]; }
    movePins(fn) {
      Object.keys(this.pins).forEach((k) => { const v = fn(this.pins[k]); if (v == null || v < 0) delete this.pins[k]; else this.pins[k] = v; });
    }

    // ------------------------------------------------------------ edits that keep the bars
    // Set (or with c = null delete) the chord at a beat. A bar inside a repeat stands for all its passes, so the
    // change goes to every pass. Returns the song bars changed.
    setChord(bar, beat, c) {
      const bars = this.passesOf(bar);
      bars.forEach((b) => {
        this.chords = this.chords.filter((x) => !(x.bar === b && x.beat === beat));
        if (c) this.chords.push(Object.assign({ bar: b, beat }, copyChord(c)));
      });
      this.chords.sort(byPos);
      this.changed();
      return bars;
    }
    setSectionChord(which, c) {
      this[`${which}Chord`] = copyChord(c);
    }
    // The variation or fill on one song bar (0 = none). Only that bar: each pass of a repeat keeps its own.
    setStyle(bar, value) {
      this.variations = this.variations.filter((v) => v.bar !== bar);
      if (value) this.variations.push({ bar, value });
      this.variations.sort((x, y) => x.bar - y.bar);
      this.changed();
    }
    // Returns the keys that changed.
    setSettings(changes) {
      const keys = Object.keys(changes).filter((k) => this.settings[k] !== changes[k]);
      keys.forEach((k) => { this.settings[k] = changes[k]; });
      return keys;
    }
    setName(name) { this.name = name; }
    // Back to the GO:KEYS's initial pattern: 4 bars of C with default settings.
    clear(name) {
      this.set({ name, bars: 4, chords: [Object.assign({ bar: 0, beat: 0 }, majorChord())] });
      this.loaded = true;
    }

    // ------------------------------------------------------------ edits that move bars
    // Insert an empty bar at index at (the chord before it keeps sounding), or remove bar at. Signs and pins move along.
    addBarAt(at) {
      this.movePins((p) => (at <= p ? p + 1 : p));
      this.shiftSigns(at, 1);
      const shift = (x) => { if (x.bar >= at) x.bar += 1; };
      this.chords.forEach(shift); this.variations.forEach(shift);
      this.bars += 1;
      this.changed();
    }
    removeBarAt(at) {
      this.movePins((p) => (at < p ? p - 1 : p));
      this.shiftSigns(at, -1);
      this.chords = this.chords.filter((c) => c.bar !== at);
      this.variations = this.variations.filter((v) => v.bar !== at);
      const shift = (x) => { if (x.bar > at) x.bar -= 1; };
      this.chords.forEach(shift); this.variations.forEach(shift);
      this.bars -= 1;
      this.changed();
    }
    // Move signs when bars are inserted (delta > 0) or deleted (delta < 0, the bar at at is removed).
    shiftSigns(at, delta) {
      const move = (m) => {
        const out = {};
        Object.keys(m).forEach((k) => {
          const b = +k;
          if (delta < 0 && b === at) return;
          out[b >= at + (delta < 0 ? 1 : 0) ? b + delta : b] = m[k];
        });
        return out;
      };
      this.starts = move(this.starts); this.ends = move(this.ends);
    }
    insertBar(at) {
      if (this.bars >= MAX_BARS) return { error: tooLong(1) };
      this.addBarAt(at);
      return { structure: true, select: at, open: true };
    }
    // <+ / +> beside a shown bar. A repeat counts as one block: next to its |: or :| the bar goes before the first pass or
    // after the last, and inside it the bar goes into every pass, so the passes still match and stay one repeat.
    insertBeside(bar, after) {
      const r = this.activeRepeatAt(bar);
      if (!r) return this.insertBar(after ? bar + 1 : bar);
      const off = this.shownBar(bar).bar - r.start + (after ? 1 : 0);
      if (off <= 0) return this.insertBar(r.start);
      if (off >= r.len) return this.insertBar(r.start + r.times * r.len);
      if (this.bars + r.times > MAX_BARS) return { error: tooLong(r.times) };
      for (let k = r.times - 1; k >= 0; k--) this.addBarAt(r.start + k * r.len + off);   // last pass first: earlier ones don't move
      return { structure: true, select: r.start + off, open: true };
    }
    deleteBar(at) {
      if (this.bars <= 1) return {};
      // A bar between the signs of a repeat goes from every pass, like insertBeside.
      const r = this.activeRepeatAt(at), off = r ? this.shownBar(at).bar - r.start : -1;
      if (r && off > 0 && off < r.len - 1) {
        for (let k = r.times - 1; k >= 0; k--) this.removeBarAt(r.start + k * r.len + off);
        return { structure: true, select: Math.min(r.start + off, r.start + r.len - 2) };
      }
      // A repeat that loses a sign also loses its written-out passes; the other sign stays, grey.
      const pair = this.markedRepeats().find((x) => x.start === at || x.start + x.len - 1 === at);
      if (pair && pair.times >= 2) {
        this.dropCopies(pair);
        if (pair.start === at) this.ends[pair.start + pair.len - 1] = true;
        if (pair.start + pair.len - 1 === at) this.starts[pair.start] = true;
      }
      this.removeBarAt(at);
      // The sign left behind may now pair with a grey sign: that new repeat needs its pass written out.
      const lostStart = !!pair && pair.start === at, kept = pair && (lostStart ? pair.start + pair.len - 2 : pair.start);
      const formed = pair && pair.len > 1 && this.markedRepeats().find((x) => (lostStart ? x.start + x.len - 1 === kept : x.start === kept));
      const res = formed ? this.writeOutNewRepeat(formed) : {};
      return Object.assign(res, { structure: true, select: Math.min(at, this.bars - 1) });
    }

    // Toggle |: (kind 'start') or :| ('end') on a bar. A pair that isn't repeated yet gets its pass written out (bars
    // inserted after the :|). Removing a sign leaves its partner, grey, and removes the written-out passes, so the
    // grid doesn't change: the first pass stays. A new sign inside a repeat moves that repeat's sign.
    toggleSign(kind, bar) {
      const isStart = kind === 'start', set = () => (isStart ? this.starts : this.ends);
      const last = (x) => x.start + x.len - 1;
      let res = {};
      if (set()[bar]) {
        const pair = this.markedRepeats().find((x) => (isStart ? x.start : last(x)) === bar);
        delete set()[bar];
        const dropped = !!pair && pair.times >= 2;
        if (dropped) {
          this.dropCopies(pair);
          if (isStart) this.ends[last(pair)] = true; else this.starts[pair.start] = true;   // the partner stays, grey
        }
        // The partner may now pair with a grey sign: a new repeat, which needs its pass written out.
        const formed = pair && this.markedRepeats().find((x) => (isStart ? x.start + x.len === pair.start + pair.len : x.start === pair.start));
        if (formed) res = this.writeOutNewRepeat(formed);
        else if (dropped) res = { info: `Repeat removed: the song is now ${this.bars} bars.` };
        if (dropped) res.structure = true;
      } else {
        const moved = this.markedRepeats().find((x) => (isStart ? bar > x.start && bar <= last(x) : bar >= x.start && bar < last(x))) || null;
        if (moved && moved.times >= 2) {               // the repeat gets smaller: its passes are rebuilt to match
          res = this.reshapeRepeat(moved, isStart ? bar : moved.start, isStart ? last(moved) : bar);
        } else if (moved) {                            // the sign moves here; no bars are added
          delete set()[isStart ? moved.start : last(moved)];
          set()[bar] = true;
          this.starts[isStart ? bar : moved.start] = 1;
        } else {
          set()[bar] = true;
          const r = this.markedRepeats().find((x) => x.start === bar || last(x) === bar);
          if (r) res = this.writeOutNewRepeat(r);
        }
      }
      this.changed();
      return res;
    }
    // A repeat the user just made: its bars play twice, whatever comes after them.
    writeOutNewRepeat(r) {
      this.starts[r.start] = 1;
      return this.writeOutRepeat(r);
    }
    writeOutRepeat(r) {
      if (this.bars + r.len > MAX_BARS) return { error: tooLong(r.len) };
      const after = r.start + r.len;
      const move = (x) => { if (x.bar >= after) x.bar += r.len; };
      this.chords.forEach(move); this.variations.forEach(move);
      this.movePins((p) => (p >= after ? p + r.len : p));
      this.shiftSigns(after, r.len);
      const copyPass = (list) => list.filter((x) => x.bar >= r.start && x.bar < after).map((x) => Object.assign({}, x, { bar: x.bar + r.len }));
      this.chords = this.chords.concat(copyPass(this.chords)).sort(byPos);
      // A chord held into the copy from before the repeat must sound at its start too.
      if (!this.chords.some((c) => c.bar === after && c.beat === 0)) {
        const held = this.chordInEffect(after - 1, BEATS - 1);
        const first = this.chordInEffect(r.start, 0);
        if (first && held !== first) this.chords.push(Object.assign({}, first, { bar: after, beat: 0 }));
        this.chords.sort(byPos);
      }
      this.variations = this.variations.concat(copyPass(this.variations)).sort((x, y) => x.bar - y.bar);
      this.bars += r.len;
      this.starts[r.start] = 2;
      this.changed();
      return { structure: true, info: `Repeat written out: bars ${r.start + 1}–${after} now play twice.` };
    }
    // Shrink repeat r to bars from..to of its first pass, as the signs now read: the bars before them play once, then
    // from..to play r.times times (each pass keeps its own variations), then the bars after them play once. What sounds
    // on each kept bar stays the same: a chord or variation that used to carry over from a dropped bar is written on it.
    reshapeRepeat(r, from, to) {
      const oldEnd = r.start + r.times * r.len, order = [];
      for (let b = 0; b < from; b++) order.push(b);
      for (let k = 0; k < r.times; k++) for (let b = from; b <= to; b++) order.push(b + k * r.len);
      for (let b = to + 1; b < r.start + r.len; b++) order.push(b);
      for (let b = oldEnd; b < this.bars; b++) order.push(b);
      this.reorderBars(order, r);
      this.starts[from] = r.times; this.ends[to] = true;
      this.changed();
      return { structure: true, info: `Repeat changed: the song is now ${this.bars} bars.` };
    }
    // Take repeat r apart: its signs and written-out passes go, its first pass stays.
    dropCopies(r) {
      const order = [];
      for (let b = 0; b < r.start + r.len; b++) order.push(b);
      for (let b = r.start + r.times * r.len; b < this.bars; b++) order.push(b);
      this.reorderBars(order, r);
    }
    // Rebuild the song from the old bars listed in order. The signs of repeat r, and any others inside it, are dropped.
    reorderBars(order, r) {
      this.movePins((p) => { const k = order.findIndex((old) => old >= p); return k < 0 ? null : k; });
      const oldEnd = r.start + r.times * r.len;
      const oldStyles = this.barStyles(), chords = [], variations = [];
      let style = null;
      order.forEach((old, bar) => {
        const here = this.chords.filter((c) => c.bar === old);
        if (!here.some((c) => c.beat === 0)) {
          const held = this.chordInEffect(old, 0), before = chords[chords.length - 1];
          if (held && (!before || chordKey(held) !== chordKey(before))) chords.push(Object.assign({}, held, { bar, beat: 0 }));
        }
        here.forEach((c) => chords.push(Object.assign({}, c, { bar })));
        const v = this.variations.find((x) => x.bar === old && x.value), want = oldStyles[old];
        if (style > 4) style = null;
        if (v) { variations.push({ bar, value: v.value }); style = v.value; }
        else if (want && want.value !== style) { variations.push({ bar, value: want.value }); style = want.value; }
      });
      const delta = order.length - this.bars;
      const moveSigns = (m) => {
        const out = {};
        Object.keys(m).forEach((k) => { const b = +k; if (b < r.start) out[b] = m[k]; else if (b >= oldEnd) out[b + delta] = m[k]; });
        return out;
      };
      this.starts = moveSigns(this.starts); this.ends = moveSigns(this.ends);
      this.chords = chords; this.variations = variations; this.bars = order.length;
      this.changed();
    }
  }

  Object.assign(Song, { BEATS, MAX_BARS, TRANSPOSE_MIN, TRANSPOSE_MAX, tooLong });
  if (isNode) module.exports = Song;
  else (window.GoKeys = window.GoKeys || {}).Song = Song;
}());
