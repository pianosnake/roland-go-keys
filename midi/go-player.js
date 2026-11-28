// GoPlayer: playing the song on the GO:KEYS and following the bar it plays. Connects a Song, the GoPattern the GO:KEYS
// holds, and a GoLink.
//   toggle(fromBar)  Play / Stop. From a later bar the GO:KEYS gets the song from there (GoPattern.from; rotated if LOOP
//                    is on when Play is pressed), then starts. The start bar is a pin in the Song, so bars inserted or
//                    deleted meanwhile move it along. Stopping sends nothing: the GO:KEYS keeps the song from that bar
//                    (and edits keep going to its bars) until Play from bar 0, which sends the whole song first.
//   playing, bar     state for the page; bar is a song bar, 'intro', 'ending' or null.
//   sendSong()       the whole song (as the GO:KEYS should hold it now), after bars move, a load, a rename...
//   chordEdited / styleEdited   send an edit to the GO:KEYS's bar for it (nothing for a bar cut off), and while playing
//                    from a bar, the chord and variation carried onto its first beat.
//   playState / barMessage      the GO:KEYS's messages (give them GoLink's handlers).
//   synced           whether the GO:KEYS holds the page's song (it was sent, or read with GET). Until then (the starter
//                    song on a fresh page, or after switching to another output) an edit or Play sends the whole song
//                    first instead of a single edit, which would land on whatever song the GO:KEYS has.
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
      this.synced = false;
    }
    get start() { return this.song.pinned(START) || 0; }
    // A new song on the page (read, loaded, cleared): its pins are gone, and so is the old mapping.
    reset() { this.pattern = null; }
    // The song was just read from the GO:KEYS (GET).
    readFromGo() { this.pattern = null; this.synced = true; }
    // Another output (or none): what that device holds isn't known.
    outputChanged() { this.synced = false; }
    firstBar() { return this.start ? this.start : this.song.loaded && this.song.settings.intro ? 'intro' : 0; }
    current() { return this.pattern || GoPattern.of(this.song); }

    sendSong() {
      if (!this.link.ready) return false;
      this.pattern = GoPattern.from(this.song, this.start, this.rotate);
      if (this.link.pattern(this.pattern)) this.synced = true;
      return this.synced;
    }

    toggle(fromBar) {
      if (!this.link.ready) return false;
      if (this.playing) {                           // stop; the GO:KEYS keeps what it has (see playFromStart)
        this.link.stop();
        this.playing = false; this.bar = null;
      } else if (fromBar > 0) {
        this.playFrom(fromBar);
      } else {
        this.playFromStart();
      }
      this.onChange();
      return true;
    }
    // From a bar: the GO:KEYS gets the song from there (GoPattern.from), unless it already starts there.
    playFrom(bar) {
      const rotate = !!this.song.settings.loop;
      const same = this.synced && this.start === bar && this.rotate === rotate && this.pattern;
      this.song.pin(START, bar);
      this.rotate = rotate;
      if (same) this.link.start(false);
      else { this.sendSong(); this.link.start(true); }   // after the transfer
      this.playing = true; this.bar = this.firstBar();
    }
    // From the top: after playing from a bar the GO:KEYS still holds the song from that bar, so the whole song goes
    // first (nothing is sent back on stop: edits made meanwhile still go to the GO:KEYS's bars). Same when it doesn't
    // have the page's song at all.
    playFromStart() {
      if (this.start || !this.synced) {
        this.song.unpin(START);
        this.sendSong();
        this.link.start(true);
      } else this.link.start(false);
      this.playing = true; this.bar = this.firstBar();
    }

    // ------------------------------------------------------------ from the GO:KEYS
    toSong(goBar) { return typeof goBar === 'number' ? this.current().songBar(goBar) : goBar; }
    playState(playing, goBar) {
      this.playing = playing;
      this.bar = !playing ? null : goBar != null ? this.toSong(goBar) : this.firstBar();
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
      if (!this.synced) return this.sendSong();
      const p = this.current();
      bars.forEach((b) => { const e = p.chordEntry(b, beat, c); if (e) this.link.edit(S.CHORDS, e); });
      this.syncStart();
      return true;
    }
    styleEdited(bar, value) {
      if (!this.link.ready) return false;
      if (!this.synced) return this.sendSong();
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
