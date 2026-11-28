// GoPattern: the chord pattern as the GO:KEYS holds it, in its own bar numbers. A snapshot: after an edit that moves
// bars, build a new one.
//   GoPattern.of(song)                       the song as it is
//   GoPattern.from(song, start, rotate)      for playing from song bar `start`: the GO:KEYS always starts a pattern at
//                                            its first bar, so it gets the bars from `start` to the end (rotate false),
//                                            or all bars rotated to begin there (rotate true, for LOOP: it plays on
//                                            into bar 1 and round again). The chord and variation already sounding at
//                                            `start` go on its first beat, and the intro is left out.
//   goBar(songBar) / songBar(goBar)          bar numbers both ways; goBar is -1 for a bar that was cut off
//   chordEntry / styleEntry                  the edit entry to send after a chord or variation edit (null: not on it)
//   firstBeatEntries(song)                   after an edit while playing from a bar: the carried chord and variation
//   toSysEx()                                the whole-pattern transfer, in Chord Director's order
// Loaded as a classic script (window.GoKeys.GoPattern) or with require() in Node (tests).
(function () {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports;
  const S = isNode ? require('./go-sysex.js') : window.GoKeys.GoSysEx;
  const byPos = (x, y) => x.bar - y.bar || (x.beat || 0) - (y.beat || 0);

  class GoPattern {
    constructor(f) {
      this.name = f.name || '';
      this.bars = f.bars || 0;
      this.chords = f.chords || [];
      this.variations = f.variations || [];
      this.settings = f.settings || {};
      this.introChord = f.introChord || null;
      this.endingChord = f.endingChord || null;
      this.start = f.start || 0;                 // the song bar the pattern begins at
      this.rotate = !!f.rotate;
      this.songBars = f.songBars != null ? f.songBars : this.bars;
    }

    static of(song) { return GoPattern.from(song, 0, false); }

    static from(song, start, rotate) {
      const n = song.bars;
      start = start > 0 && start < n ? start : 0;
      const p = new GoPattern({
        name: song.name, start, rotate: !!rotate && !!start, songBars: n, bars: !start || rotate ? n : n - start,
        settings: Object.assign({}, song.settings, start ? { intro: false } : {}),
        introChord: song.introChord, endingChord: song.endingChord,
      });
      const on = (x) => x.bar >= 0;
      p.chords = song.chords.map((c) => Object.assign({}, c, { bar: p.goBar(c.bar) })).filter(on);
      p.variations = song.variations.map((v) => ({ bar: p.goBar(v.bar), value: v.value })).filter(on);
      if (start) {
        // Rotated, song bar 1 needs nothing added where it comes round: the chord and variation held into it are the
        // song's last ones, as when the song loops.
        const k = GoPattern.carried(song, start);
        if (k.chord && !p.chords.some((c) => c.bar === 0 && c.beat === 0)) p.chords.push(Object.assign({}, k.chord, { bar: 0, beat: 0 }));
        if (k.variation && !p.variations.some((v) => v.bar === 0)) p.variations.push({ bar: 0, value: k.variation });
      }
      p.chords.sort(byPos); p.variations.sort(byPos);
      return p;
    }
    // What sounds when song bar `start` begins: the chord in effect and the variation playing (0 = none known).
    static carried(song, start) {
      const st = song.barStyles()[start];
      return { chord: song.chordInEffect(start, 0), variation: st ? st.value : 0 };
    }

    goBar(bar) {
      if (!this.start) return bar;
      return this.rotate ? (bar - this.start + this.songBars) % this.songBars : bar - this.start;
    }
    songBar(goBar) {
      if (!this.start) return goBar;
      return this.rotate ? (goBar + this.start) % this.songBars : goBar + this.start;
    }

    chordEntry(songBar, beat, c) {
      const g = this.goBar(songBar);
      return g < 0 ? null : S.hiLo(g).concat([beat], S.chordBytes(c));
    }
    styleEntry(songBar, value) {
      const g = this.goBar(songBar);
      return g < 0 ? null : S.hiLo(g).concat([value]);
    }
    // [{ lo, entry }] for its first beat, from the song as it is now (an edit before the start, or of the start bar,
    // can change what's carried). None when the pattern starts at the song's first bar.
    firstBeatEntries(song) {
      if (!this.start) return [];
      const k = GoPattern.carried(song, this.start);
      return [{ lo: S.CHORDS, entry: [0, 0, 0].concat(S.chordBytes(k.chord)) }, { lo: S.VARIATIONS, entry: [0, 0, k.variation] }];
    }

    // Same order as Chord Director: 02 08 begin, 03 40 chords (13 entries per packet), 03 41 variations, 03 00 name,
    // 03 22 transpose, 24 intro, 42 intro chord, 25 intro long, 26 ending, 43 ending chord, 27 ending long, 23 loop,
    // 03 20 bars, 02 0C end.
    toSysEx() {
      const st = this.settings, A = S.song, msgs = [S.dt1(S.ADDR.begin, [0, 0, 0, 0])];
      // A stream is sent as packets of [count 2B] + entries; an empty stream as one packet with count 0.
      const stream = (lo, items, bytes) => {
        let k = 0;
        do {
          const part = items.slice(k, k + 13);
          let data = S.hiLo(part.length);
          part.forEach((x) => { data = data.concat(bytes(x)); });
          msgs.push(S.dt1(A(lo), data));
          k += 13;
        } while (k < items.length);
      };
      stream(S.CHORDS, this.chords, (c) => S.hiLo(c.bar).concat([c.beat], S.chordBytes(c)));
      if (this.variations.length) stream(S.VARIATIONS, this.variations, (v) => S.hiLo(v.bar).concat([v.value]));
      const name = ((this.name || S.DEFAULT_NAME) + ' '.repeat(32)).slice(0, 32).split('').map((ch) => ch.charCodeAt(0) & 0x7F);
      const set = (key) => S.dt1(A(S.SETTINGS[key]), [S.settingByte(key, st[key])]);
      msgs.push(S.dt1(A(S.NAME), name), set('transpose'), set('intro'), S.dt1(A(S.INTRO_CHORD), S.chordBytes(this.introChord)),
        set('introLong'), set('ending'), S.dt1(A(S.ENDING_CHORD), S.chordBytes(this.endingChord)), set('endingLong'),
        set('loop'), S.dt1(A(S.BARS), S.hiLo(this.bars)), S.dt1(S.ADDR.end, [0, 0, 0, 0]));
      return msgs;
    }
  }

  if (isNode) module.exports = GoPattern;
  else (window.GoKeys = window.GoKeys || {}).GoPattern = GoPattern;
}());
