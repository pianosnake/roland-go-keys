// GoLink: the connection to the GO:KEYS. All MIDI traffic, no song logic.
//   Output: messages go out through one queue, 30 ms apart, so several edits sent together don't interleave (each
//   begin-edit / entry / end-edit triple stays together). start()/stop() and app mode go out at once.
//   App mode (02 00 = 01): entered by engage() (the first use of a control on the Chords tab other than Play) and kept up
//   every 20 s like Chord Director (it times out after ~60 s: bar messages stop and the GO:KEYS shows "App
//   disconnected"), until setActive(false) (leaving the tab) sends 02 00 = 00. While in app mode the GO:KEYS ignores
//   program changes, so a tone change goes through whileReleased(). Start/stop and dump requests work without it.
//   Input: onSysEx(bytes) decodes what the GO:KEYS sends and calls the handlers given to the constructor:
//     playState(playing, goBar)   goBar: a bar index, 'intro', 'ending', or null (the first bar sends none)
//     bar(goBar)                  on each downbeat
//     dump(GoPattern)             a song read after requestDump()
//     dumpTimeout()               no dump came within 3 s
//   A dump only counts after requestDump(): the GO:KEYS never sends one unasked, but a loopback port (IAC Driver) echoes
//   the page's own song transfers back, and taking those as dumps showed an older copy of the song.
// Loaded as a classic script (window.GoKeys.GoLink) or with require() in Node (tests).
(function () {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports;
  const S = isNode ? require('./go-sysex.js') : window.GoKeys.GoSysEx;
  const GoPattern = isNode ? require('./go-pattern.js') : window.GoKeys.GoPattern;
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const ZEROS = [0, 0, 0, 0];

  class GoLink {
    constructor(on) {
      this.on = on || {};
      this.out = null;
      this.queue = []; this.queueTimer = 0;
      this.active = false; this.engaged = false; this.connected = false; this.aliveTimer = 0; this.lastAlive = 0;
      this.incoming = null; this.dumpTimer = 0;
    }
    get ready() { return !!this.out; }
    setOutput(fn) { this.out = fn; this.connected = false; if (this.engaged) this.connect(); }

    // ------------------------------------------------------------ output
    sendNow(m) { if (this.out) this.out(m); }
    enqueue(msgs) {
      this.queue = this.queue.concat(msgs);
      if (!this.queueTimer) this.queueTimer = setTimeout(() => this.drain(), 50);
    }
    drain() {
      if (!this.queue.length) { this.queueTimer = 0; return; }
      this.sendNow(this.queue.shift());
      this.queueTimer = setTimeout(() => this.drain(), 30);
    }
    // Send whatever is queued now (tests).
    flush() {
      clearTimeout(this.queueTimer); this.queueTimer = 0;
      while (this.queue.length) this.sendNow(this.queue.shift());
    }

    // ------------------------------------------------------------ app mode
    connect() {
      if (!this.out) return;
      this.sendNow(S.dt1(S.ADDR.app, [1])); this.connected = true; this.lastAlive = now();
    }
    setActive(on) {
      this.active = on;
      if (on) return;
      this.engaged = false;
      if (this.aliveTimer) { clearInterval(this.aliveTimer); this.aliveTimer = 0; }
      if (this.connected && this.out) this.sendNow(S.dt1(S.ADDR.app, [0]));
      this.connected = false;
    }
    engage() {
      if (!this.active || this.engaged) return;
      this.engaged = true;
      this.connect();
      this.aliveTimer = setInterval(() => this.connect(), 20000);
    }
    // Backs up the 20 s timer, which Chrome slows down in background windows.
    keepAlive() { if (this.engaged && now() - this.lastAlive > 15000) this.connect(); }
    // Runs fn (a tone change) with app mode briefly off, so the GO:KEYS accepts the program change.
    whileReleased(fn) {
      if (!this.connected || !this.out) { fn(); return; }
      this.sendNow(S.dt1(S.ADDR.app, [0])); this.connected = false;
      setTimeout(() => { fn(); setTimeout(() => { if (this.engaged) this.connect(); }, 100); }, 30);
    }

    // ------------------------------------------------------------ commands (false: no output)
    // One edit, like Chord Director: 02 14 / 03 lo = 00 01 + entry / 02 18.
    edit(lo, entry) {
      if (!this.out) return false;
      if (!this.connected) this.connect();
      this.enqueue([S.dt1(S.ADDR.editBegin, ZEROS), S.dt1(S.song(lo), [0, 1].concat(entry)), S.dt1(S.ADDR.editEnd, ZEROS)]);
      this.lastAlive = now();
      return true;
    }
    // The intro or ending chord (c = null: none): 02 14 / 03 42 or 43 / 02 18.
    sectionChord(which, c) {
      if (!this.out) return false;
      if (!this.connected) this.connect();
      this.enqueue([S.dt1(S.ADDR.editBegin, ZEROS), S.dt1(S.song(which === 'intro' ? S.INTRO_CHORD : S.ENDING_CHORD), S.chordBytes(c)),
        S.dt1(S.ADDR.editEnd, ZEROS)]);
      this.lastAlive = now();
      return true;
    }
    // Song settings { key: value }, changed live like Chord Director (applied on the next bar).
    settings(changes) {
      if (!this.out) return false;
      if (!this.connected) this.connect();
      const msgs = [S.dt1(S.ADDR.editBegin, ZEROS)];
      Object.keys(changes).forEach((key) => msgs.push(S.dt1(S.song(S.SETTINGS[key]), [S.settingByte(key, changes[key])])));
      msgs.push(S.dt1(S.ADDR.editEnd, ZEROS));
      this.enqueue(msgs);
      return true;
    }
    // A whole pattern (after bars move, a load, a rename, or to play from a bar).
    pattern(p) {
      if (!this.out) return false;
      if (!this.connected) this.connect();
      this.enqueue(p.toSysEx());
      this.lastAlive = now();
      return true;
    }
    // queued: after what's already queued (a pattern being sent first).
    start(queued) {
      const m = S.dt1(S.ADDR.play, [1]);
      if (queued) this.enqueue([m]); else this.sendNow(m);
    }
    stop() { this.sendNow(S.dt1(S.ADDR.play, [0])); }
    requestDump(ms) {
      if (!this.out) return false;
      this.incoming = GoLink.newDump();
      this.sendNow(S.dt1(S.ADDR.request, ZEROS));
      clearTimeout(this.dumpTimer);
      this.dumpTimer = setTimeout(() => {
        if (!this.incoming) return;
        this.incoming = null;
        if (this.on.dumpTimeout) this.on.dumpTimeout();
      }, ms || 3000);
      return true;
    }
    static newDump() { return { name: '', bars: 0, chords: [], variations: [], settings: {}, introChord: null, endingChord: null }; }

    // ------------------------------------------------------------ input
    // Every SysEx from the MIDI input. Returns true if it was a GO:KEYS DT1.
    onSysEx(d) {
      const m = S.parse(d);
      if (!m) return false;
      const { a2, a3, data } = m, on = this.on;
      if (a2 === 0x01 && a3 === 0x01) {                           // play state [+ bar]; no bar message comes for the first bar
        this.keepAlive();
        if (on.playState) on.playState(data[0] === 1, data.length >= 3 ? S.bar(data[1], data[2]) : null);
        return true;
      }
      if (a2 === 0x01 && a3 === 0x02 && data.length >= 2) {
        this.keepAlive();
        if (on.bar) on.bar(S.bar(data[0], data[1]));
        return true;
      }
      if (a2 === 0x02 && a3 === 0x08) { if (this.incoming) this.incoming = GoLink.newDump(); return true; }
      const dump = this.incoming;
      if (!dump) return true;
      if (a2 === 0x03 && a3 < 0x40) {                             // name / settings block
        for (let k = 0; k < data.length; k++) {
          const off = a3 + k;
          if (off < 0x20) dump.name += String.fromCharCode(data[k]);
          if (off === 0x21 && k > 0) dump.bars = S.w14(data[k - 1], data[k]);
          Object.keys(S.SETTINGS).forEach((key) => {
            if (S.SETTINGS[key] === off) dump.settings[key] = key === 'transpose' ? data[k] - 0x40 : data[k] === 1;
          });
        }
      } else if (a2 === 0x03 && a3 === S.CHORDS) {
        const n = S.w14(data[0], data[1]);
        for (let k = 0; k < n && 2 + k * 9 + 9 <= data.length; k++) {
          const e = data.slice(2 + k * 9, 11 + k * 9);
          dump.chords.push({ bar: S.w14(e[0], e[1]), beat: e[2], root: e[3], acc: e[4], type: S.w14(e[5], e[6]), bass: e[7], bassAcc: e[8] });
        }
      } else if (a2 === 0x03 && a3 === S.VARIATIONS) {
        const n = S.w14(data[0], data[1]);
        for (let k = 0; k < n && 2 + k * 3 + 3 <= data.length; k++) {
          const e = data.slice(2 + k * 3, 5 + k * 3);
          dump.variations.push({ bar: S.w14(e[0], e[1]), value: e[2] });
        }
      } else if (a2 === 0x03 && (a3 === S.INTRO_CHORD || a3 === S.ENDING_CHORD)) {
        dump[a3 === S.INTRO_CHORD ? 'introChord' : 'endingChord'] = S.chordFromBytes(data);
      } else if (a2 === 0x02 && a3 === 0x0C) {                    // end of dump
        clearTimeout(this.dumpTimer);
        this.incoming = null;
        if (on.dump) on.dump(new GoPattern(dump));
      }
      return true;
    }
  }

  if (isNode) module.exports = GoLink;
  else (window.GoKeys = window.GoKeys || {}).GoLink = GoLink;
}());
