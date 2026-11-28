// Selection: the chord editor's cursor. bar/beat are a shown bar (the first pass of a repeat); pass is which pass of a
// repeat the VARIATION row edits, and it stays set as the cursor moves; section is 'intro' / 'ending' while
// editing that chord. Play always starts on the first pass, whatever pass is picked.
// Loaded as a classic script (window.GoKeys.Selection) or with require() in Node (tests).
(function () {
  'use strict';
  const BEATS = 4;

  class Selection {
    constructor() { this.reset(); }
    reset() { this.home(); this.open = false; }
    home() { this.bar = 0; this.beat = 0; this.pass = 0; this.section = null; }
    select(bar, beat) { this.open = true; this.section = null; this.bar = bar; this.beat = beat; }
    selectSection(key) { this.open = true; this.section = key; }

    editPass(song) {
      const r = song.activeRepeatAt(this.bar);
      return r ? Math.min(this.pass, r.times - 1) : 0;
    }
    // The song bar the VARIATION row edits: the selected bar on the selected pass.
    styleBar(song) {
      const at = song.shownBar(this.bar);
      return at.r ? at.bar + this.editPass(song) * at.r.len : this.bar;
    }
    // The next / previous beat, skipping hidden passes. false at either end of the song.
    stepBeat(song, dir) {
      const hidden = song.view().hidden;
      let pos = this.bar * BEATS + this.beat;
      for (;;) {
        pos += dir;
        if (pos < 0 || pos >= song.bars * BEATS) return false;
        if (!hidden[Math.floor(pos / BEATS)]) break;
      }
      this.select(Math.floor(pos / BEATS), pos % BEATS);
      return true;
    }
    // « / »: the first beat of the previous / next shown bar.
    stepBar(song, dir) {
      const hidden = song.view().hidden;
      for (let b = this.bar + dir; b >= 0 && b < song.bars; b += dir) if (!hidden[b]) { this.select(b, 0); return true; }
      return false;
    }
    atLastBeat(song) { return this.beat === BEATS - 1 && this.bar === song.lastShownBar(); }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = Selection;
  else (window.GoKeys = window.GoKeys || {}).Selection = Selection;
}());
