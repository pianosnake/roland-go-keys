// GoPlayer: playing the song on the GO:KEYS and following the bar it plays. Connects a Song, the GoPattern the GO:KEYS
// holds, and a GoLink.
//   toggle(fromBar)  Play / Stop. From bar 0 a plain start (with the intro). From a later bar the GO:KEYS gets the song
//                    from there (GoPattern.from; rotated if LOOP is on when Play is pressed), then starts. The start bar
//                    is a pin in the Song, so bars inserted or deleted meanwhile move it along. Stopping (here or on the
//                    GO:KEYS) puts the song back in order.
//   playing, bar     state for the page; bar is a song bar, 'intro', 'ending' or null.
//   sendSong()       the whole song (as the GO:KEYS should hold it now), after bars move, a load, a rename...
//   chordEdited / styleEdited   send an edit to the GO:KEYS's bar for it (nothing for a bar cut off), and while playing
//                    from a bar, the chord and variation carried onto its first beat.
//   playState / barMessage      the GO:KEYS's messages (give them GoLink's handlers).
// Loaded as a classic script (window.GoKeys.GoPlayer) or with require() in Node (tests).
(function () {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports;
  const S = isNode ? require('./go-sysex.js') : window.GoKeys.GoSysEx;
  const GoPattern = isNode ? require('./go-pattern.js') : window.GoKeys.GoPattern;
  const START = 'start';                          // the Song pin for the bar play started from

  class GoPlayer {
    constructor(song, link, onChange) {
      this.song = song; this.link = link; this.onChange = onChange || (() => {});
      this.playing = false; this.bar = null;
      this.pattern = null;                          // what the GO:KEYS holds, as last sent (null: the song as it is)
      this.rotate = false;
    }
    get start() { return this.song.pinned(START) || 0; }
    // A new song on the page (read, loaded, cleared): its pins are gone, and so is the old mapping.
    reset() { this.pattern = null; }
    firstBar() { return this.start ? this.start : this.song.loaded && this.song.settings.intro ? 'intro' : 0; }
    current() { return this.pattern || GoPattern.of(this.song); }

    sendSong() {
      if (!this.link.ready) return false;
      this.pattern = GoPattern.from(this.song, this.start, this.rotate);
      return this.link.pattern(this.pattern);
    }

    toggle(fromBar) {
      if (!this.link.ready) return false;
      if (!this.playing && fromBar > 0) { this.playFrom(fromBar); return true; }
      if (this.playing) this.link.stop(); else this.link.start(false);
      this.playing = !this.playing;
      this.bar = this.playing ? this.firstBar() : null;
      if (!this.playing) this.endPlayFrom();
      this.onChange();
      return true;
    }
    playFrom(bar) {
      this.song.pin(START, bar);
      this.rotate = !!this.song.settings.loop;
      this.sendSong();
      this.link.start(true);                        // after the transfer
      this.playing = true; this.bar = this.firstBar();
      this.onChange();
    }
    endPlayFrom() {
      if (!this.start) return;
      this.song.unpin(START);
      this.sendSong();
    }

    // ------------------------------------------------------------ from the GO:KEYS
    toSong(goBar) { return typeof goBar === 'number' ? this.current().songBar(goBar) : goBar; }
    playState(playing, goBar) {
      this.playing = playing;
      this.bar = !playing ? null : goBar != null ? this.toSong(goBar) : this.firstBar();
      if (!playing) this.endPlayFrom();
      this.onChange();
    }
    // The GO:KEYS also sends the bar while stopped, whenever a song setting changes, so only the play state decides playing.
    barMessage(goBar) {
      this.bar = this.playing ? this.toSong(goBar) : null;
      this.onChange();
    }

    // ------------------------------------------------------------ edits (the Song is already changed)
    chordEdited(bars, beat, c) {
      if (!this.link.ready) return false;
      const p = this.current();
      bars.forEach((b) => { const e = p.chordEntry(b, beat, c); if (e) this.link.edit(S.CHORDS, e); });
      this.syncStart();
      return true;
    }
    styleEdited(bar, value) {
      if (!this.link.ready) return false;
      const e = this.current().styleEntry(bar, value);
      if (e) this.link.edit(S.VARIATIONS, e);
      this.syncStart();
      return true;
    }
    syncStart() { this.current().firstBeatEntries(this.song).forEach((x) => this.link.edit(x.lo, x.entry)); }
  }

  if (isNode) module.exports = GoPlayer;
  else (window.GoKeys = window.GoKeys || {}).GoPlayer = GoPlayer;
}());
