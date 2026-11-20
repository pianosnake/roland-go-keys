// Chords tab: reads the chord progression stored in the GO:KEYS 3/5 (the song Chord Director edits) over SysEx,
// shows it bar by bar with its settings (transpose, loop, intro, ending), follows the bar the style is playing, changes
// the settings live, and downloads it as a CSV in the keyboard's own chord-pattern format.
// Protocol (undocumented, found by sniffing Chord Director; see ~/workspace/roland-hidden-midi/gokeys35-research-2026-11-14.md):
//   header F0 41 10 01 05 11, DT1 = 12, Roland checksum.
//   We send   DT1 01 00 02 04 = 00 00 00 00  request a dump. Works without the "app connected" DT1 02 00 = 01,
//             which we don't send: after it the keyboard ignored program changes until it was switched off.
//   Keyboard  DT1 01 00 02 08                begin
//             DT1 01 00 03 00 (40 bytes)     32-char name, 03 20-21 = bar count, then the song settings:
//                                            22 transpose (40 = 0, +/-1 per semitone), 23 loop, 24 intro, 25 intro long,
//                                            26 ending, 27 ending long
//             DT1 01 00 03 40 (repeatable)   [count 2B] + count x [bar 2B][beat][root][acc][type 2B][bass][bass acc]
//             DT1 01 00 03 41 (optional)     [count 2B] + count x [bar 2B][variation]
//             DT1 01 00 03 42 / 03 43        intro / ending chord: [root][acc][type 2B][bass][bass acc] (root 0 = none,
//                                            written as an empty CHORD,1, cell in the keyboard's CSV)
//             DT1 01 00 02 0C                end
//   Style:    DT1 01 00 02 01 = 01 start / 00 stop. Works without app mode.
//   App mode: opening the page or the tab doesn't enter it. The first use of a control on the Chords tab other than
//             Play/Stop does: 02 00 = 01, then every 20 s like Chord Director (it times out after ~60 s: bar messages
//             stop and the keyboard shows "App disconnected").
//             Leaving the tab sends 02 00 = 00. While connected the keyboard ignores program changes, so a tone change
//             made on this tab is wrapped in disconnect / reconnect (see whileDisconnected).
//   Editing:  like Chord Director, one entry per edit inside 02 14 / 02 18: DT1 03 40 = 00 01 + one chord entry
//             (root 00 = delete the chord at that bar/beat), DT1 03 41 = 00 01 + [bar 2B][value] (value 00 = none).
//   Bars:     inserting or deleting a bar resends the whole song (02 08 ... 02 0C, Chord Director's order), because
//             every later chord and variation moves.
//   Settings: changed live like Chord Director: DT1 02 14 = 00 00 00 00 (begin edit), DT1 03 2x = value, DT1 02 18 (end).
//             The keyboard applies them on the next bar. Transpose is applied by the keyboard: chords stay untransposed.
//   Unprompted: 01 00 01 01 = play state [+ bar], 01 00 01 02 = bar number (sent on each downbeat). The bar number's
//             high byte flags the section: 20 = intro, 40 = ending.
// Plain JS for iOS 15 WebKit (see app.js).
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const HEADER = [0xF0, 0x41, 0x10, 0x01, 0x05, 0x11];
  const BEATS = 4;   // Chord Director songs are 4/4 (beat byte 0-3)

  // Chord types 01-1F: [name suffix, intervals from the root in semitones].
  const TYPES = {
    0x01: ['', [0, 4, 7]],          0x02: ['m', [0, 3, 7]],         0x03: ['7', [0, 4, 7, 10]],
    0x04: ['m7b5', [0, 3, 6, 10]],  0x05: ['dim', [0, 3, 6]],       0x06: ['dim7', [0, 3, 6, 9]],
    0x07: ['aug', [0, 4, 8]],       0x08: ['aug7', [0, 4, 8, 10]],  0x09: ['sus4', [0, 5, 7]],
    0x0A: ['7sus4', [0, 5, 7, 10]], 0x0B: ['add9', [0, 4, 7, 14]],  0x0C: ['madd9', [0, 3, 7, 14]],
    0x0D: ['6', [0, 4, 7, 9]],      0x0E: ['69', [0, 4, 7, 9, 14]], 0x0F: ['m6', [0, 3, 7, 9]],
    0x10: ['m69', [0, 3, 7, 9, 14]], 0x11: ['m11', [0, 3, 7, 10, 14, 17]], 0x12: ['m13', [0, 3, 7, 10, 14, 21]],
    0x13: ['M7', [0, 4, 7, 11]],    0x14: ['m7', [0, 3, 7, 10]],    0x15: ['mM7', [0, 3, 7, 11]],
    0x16: ['mM9', [0, 3, 7, 11, 14]], 0x17: ['M9', [0, 4, 7, 11, 14]], 0x18: ['m9', [0, 3, 7, 10, 14]],
    0x19: ['9', [0, 4, 7, 10, 14]], 0x1A: ['7b5', [0, 4, 6, 10]],   0x1B: ['7b9', [0, 4, 7, 10, 13]],
    0x1C: ['7#9', [0, 4, 7, 10, 15]], 0x1D: ['7#11', [0, 4, 7, 10, 18]], 0x1E: ['13', [0, 4, 7, 10, 14, 21]],
    0x1F: ['7b13', [0, 4, 7, 10, 20]],
  };
  const LETTERS = ' ABCDEFG';                                    // root byte 1-7
  const PC = { A: 9, B: 11, C: 0, D: 2, E: 4, F: 5, G: 7 };      // pitch class of each letter
  const VARIATIONS = { 1: 'Var 1', 2: 'Var 2', 3: 'Var 3', 4: 'Var 4', 5: 'Fill Down', 6: 'Fill Up' };

  const w14 = (hi, lo) => hi * 128 + lo;                         // 2-byte values are 7 bits per byte
  const noteName = (letter, acc) => {
    const l = LETTERS[letter];
    if (!l || l === ' ') return null;
    return l + (acc === 0x41 ? '#' : acc === 0x3F ? 'b' : '');
  };
  const notePc = (letter, acc) => (PC[LETTERS[letter]] + (acc - 0x40) + 12) % 12;

  const DEFAULT_NAME = 'Initial Pattern';   // a pattern with a blank title can't be saved to a user slot on the keyboard
  let send = null, status = () => {};
  const song = { name: '', bars: 0, chords: [], variations: [], settings: defaults(), loaded: false };
  function defaults() { return { transpose: 0, loop: true, intro: false, introLong: false, ending: false, endingLong: false }; }
  // song setting -> offset in the 01 00 03 block
  const SETTINGS = { transpose: 0x22, loop: 0x23, intro: 0x24, introLong: 0x25, ending: 0x26, endingLong: 0x27 };
  const TRANSPOSE_MIN = -6, TRANSPOSE_MAX = 5;   // Roland's usual transpose range; not checked on the GO:KEYS
  let incoming = null;          // dump being received
  let timeout = 0;
  const play = { playing: false, bar: null };

  // Outgoing edits go through one queue, 30 ms apart, so several edits sent together don't interleave
  // (each begin-edit / entry / end-edit triple stays together).
  let queue = [], queueTimer = 0;
  function enqueue(msgs) { queue = queue.concat(msgs); if (!queueTimer) queueTimer = setTimeout(drain, 50); }
  function drain() {
    if (!queue.length) { queueTimer = 0; return; }
    const m = queue.shift();
    if (send) send(m);
    queueTimer = setTimeout(drain, 30);
  }

  function dt1(addr, data) {
    const body = addr.concat(data);
    const sum = (128 - (body.reduce((a, b) => a + b, 0) % 128)) % 128;
    return HEADER.concat([0x12], body, [sum, 0xF7]);
  }

  function request() {
    if (!send) { setInfo('No MIDI output, or Chrome refused SysEx access (allow MIDI device control in the site settings, then reload).'); return; }
    incoming = newDump();
    send(dt1([0x01, 0x00, 0x02, 0x04], [0, 0, 0, 0]));          // request a dump
    setInfo('Reading the chords from the keyboard…');
    clearTimeout(timeout);
    timeout = setTimeout(() => {
      if (!incoming) return;
      incoming = null;
      setInfo('No answer from the keyboard.');
    }, 3000);
  }

  // Called by app.js with every SysEx message. Returns true if it was a GO:KEYS DT1.
  function onSysEx(d) {
    if (d.length < 13 || d[d.length - 1] !== 0xF7) return false;
    for (let k = 0; k < HEADER.length; k++) if (d[k] !== HEADER[k]) return false;
    if (d[6] !== 0x12 || d[7] !== 0x01 || d[8] !== 0x00) return false;
    const a2 = d[9], a3 = d[10], data = Array.prototype.slice.call(d, 11, d.length - 2);

    if (a2 === 0x01 && a3 === 0x01) {                           // play state [+ bar]; no bar message comes for the first bar
      play.playing = data[0] === 1;
      play.bar = !play.playing ? null : data.length >= 3 ? section(data[1], data[2]) : firstBar();
      markBar(); markPlay(); keepAlive(); return true;
    }
    if (a2 === 0x01 && a3 === 0x02 && data.length >= 2) { onBar(section(data[0], data[1])); return true; }

    if (a2 === 0x02 && a3 === 0x08) { incoming = newDump(); return true; }
    if (!incoming) return true;
    if (a2 === 0x03 && a3 < 0x40) {                             // name / settings block
      for (let k = 0; k < data.length; k++) {
        const off = a3 + k;
        if (off < 0x20) incoming.name += String.fromCharCode(data[k]);
        if (off === 0x21 && k > 0) incoming.bars = w14(data[k - 1], data[k]);
        Object.keys(SETTINGS).forEach((key) => {
          if (SETTINGS[key] === off) incoming.settings[key] = key === 'transpose' ? data[k] - 0x40 : data[k] === 1;
        });
      }
    } else if (a2 === 0x03 && a3 === 0x40) {                    // chord stream
      const n = w14(data[0], data[1]);
      for (let k = 0; k < n && 2 + k * 9 + 9 <= data.length; k++) {
        const e = data.slice(2 + k * 9, 11 + k * 9);
        incoming.chords.push({ bar: w14(e[0], e[1]), beat: e[2], root: e[3], acc: e[4], type: w14(e[5], e[6]), bass: e[7], bassAcc: e[8] });
      }
    } else if (a2 === 0x03 && a3 === 0x41) {                    // variation stream
      const n = w14(data[0], data[1]);
      for (let k = 0; k < n && 2 + k * 3 + 3 <= data.length; k++) {
        const e = data.slice(2 + k * 3, 5 + k * 3);
        incoming.variations.push({ bar: w14(e[0], e[1]), value: e[2] });
      }
    } else if (a2 === 0x03 && (a3 === 0x42 || a3 === 0x43)) {   // intro / ending chord
      incoming[a3 === 0x42 ? 'intro' : 'ending'] = sectionChord(data);
    } else if (a2 === 0x02 && a3 === 0x0C) {                    // end of dump
      clearTimeout(timeout);
      song.name = incoming.name.replace(/\s+$/, '');
      song.chords = incoming.chords.sort((x, y) => x.bar - y.bar || x.beat - y.beat);
      song.variations = incoming.variations;
      song.settings = incoming.settings;
      song.introChord = incoming.intro; song.endingChord = incoming.ending;
      const lastBar = song.chords.reduce((m, c) => Math.max(m, c.bar + 1), 0);
      song.bars = Math.max(incoming.bars, lastBar);
      song.loaded = true;
      markersFromSong();
      incoming = null;
      render();
      setInfo('');
    }
    return true;
  }

  function newDump() { return { name: '', bars: 0, chords: [], variations: [], settings: defaults(), intro: null, ending: null }; }
  const sectionChord = (e) => (e.length >= 6 && e[0] ? { root: e[0], acc: e[1], type: w14(e[2], e[3]), bass: e[4], bassAcc: e[5] } : null);

  // Bar number from the keyboard: 'intro', 'ending' or the bar index.
  function section(hi, lo) { return hi & 0x40 ? 'ending' : hi & 0x20 ? 'intro' : w14(hi, lo); }
  function firstBar() { return song.loaded && song.settings.intro ? 'intro' : 0; }

  // Bar counter: highlight the bar being played. The keyboard also sends it while stopped, whenever a song setting
  // changes (00 00, then 20 00 if there's an intro: back to the start), so only the play state decides playing.
  function onBar(bar) {
    play.bar = play.playing ? bar : null;
    keepAlive();
    markBar();
  }

  // Play/Stop button. The keyboard's play-state messages keep it in step with the panel's START/STOP button.
  function togglePlay() {
    if (!send) { setInfo('No MIDI output, or Chrome refused SysEx access.'); return; }
    const wasPlaying = play.playing;
    send(dt1([0x01, 0x00, 0x02, 0x01], [wasPlaying ? 0 : 1]));
    play.playing = !play.playing;
    play.bar = play.playing ? firstBar() : null;
    markPlay(); markBar();
  }

  // App mode, entered by engage() and kept up until the user leaves the Chords tab. The 20 s timer is backed up by the
  // bar messages, because Chrome slows timers down in background windows.
  let active = false, engaged = false, connected = false, aliveTimer = 0, lastAlive = 0;
  const appCmd = (v) => dt1([0x01, 0x00, 0x02, 0x00], [v]);
  function connectApp() {
    if (!send) return;
    send(appCmd(1)); connected = true; lastAlive = performance.now();
  }
  function setActive(on) {
    active = on;
    if (on) return;
    engaged = false;
    if (aliveTimer) { clearInterval(aliveTimer); aliveTimer = 0; }
    if (connected && send) send(appCmd(0));
    connected = false;
  }
  function engage() {
    if (!active || engaged) return;
    engaged = true;
    connectApp();
    aliveTimer = setInterval(connectApp, 20000);
  }
  // Runs before the control's own handler, so app mode is on by the time an edit is sent.
  function onControlUsed(e) {
    if (e.target.closest('button, select, input') && !e.target.closest('#chords-play')) engage();
  }
  function keepAlive() { if (engaged && performance.now() - lastAlive > 15000) connectApp(); }

  // Runs fn (a tone change) with app mode briefly off, so the keyboard accepts the program change.
  function whileDisconnected(fn) {
    if (!connected || !send) { fn(); return; }
    send(appCmd(0)); connected = false;
    setTimeout(() => { fn(); setTimeout(() => { if (engaged) connectApp(); }, 100); }, 30);
  }

  // Change song settings the way Chord Director does: begin edit, write, end edit. Writes need "app connected".
  function setSetting(key, value) { const c = {}; c[key] = value; setSettings(c); }
  function setSettings(changes) {
    if (!send) { setInfo('No MIDI output, or Chrome refused SysEx access.'); return; }
    if (!song.loaded) { setInfo('Press GET to read the chords from the keyboard first.'); return; }
    const keys = Object.keys(changes).filter((key) => song.settings[key] !== changes[key]);
    if (!keys.length) return;
    if (!connected) connectApp();
    const msgs = [dt1([0x01, 0x00, 0x02, 0x14], [0, 0, 0, 0])];           // begin edit
    keys.forEach((key) => {
      const v = changes[key];
      msgs.push(dt1([0x01, 0x00, 0x03, SETTINGS[key]], [key === 'transpose' ? 0x40 + v : (v ? 1 : 0)]));
    });
    msgs.push(dt1([0x01, 0x00, 0x02, 0x18], [0, 0, 0, 0]));                 // end edit
    enqueue(msgs);
    keys.forEach((key) => { song.settings[key] = changes[key]; });
    render();
    setInfo(play.playing ? 'Sent. The keyboard applies it on the next bar.' : 'Sent.');
  }

  function markPlay() {
    const b = $('chords-play'), label = play.playing ? 'Stop the style' : 'Start the style';
    b.classList.toggle('on', play.playing);
    b.title = label; b.setAttribute('aria-label', label);
  }

  // Note names after transposing. Flats if the stored note was flat, otherwise sharps for C#/F# and flats for Eb/Ab/Bb.
  const SHARPS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const FLATS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  const MIXED = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  function spell(letter, acc) {
    const t = song.settings.transpose;
    if (!t) return noteName(letter, acc);
    if (!noteName(letter, acc)) return null;
    const pc = (notePc(letter, acc) + t + 120) % 12;
    return (acc === 0x3F ? FLATS : acc === 0x41 ? SHARPS : MIXED)[pc];
  }

  // The chord as heard: the song's transpose is applied (raw = as stored, which is what the keyboard's CSV files use).
  function chordName(c, raw) {
    const name = raw ? noteName : spell;
    const t = TYPES[c.type], root = name(c.root, c.acc);
    if (!root) return '?';
    const bass = c.bass ? name(c.bass, c.bassAcc) : null;
    return root + (t ? t[0] : `(type ${c.type})`) + (bass ? `/${bass}` : '');
  }

  // bar -> [{beat, name}] and bar -> variation label
  function byBar() {
    const bars = [];
    for (let b = 0; b < song.bars; b++) bars.push({ chords: [], variation: null });
    song.chords.forEach((c) => { if (bars[c.bar]) bars[c.bar].chords.push({ beat: c.beat, name: chordName(c) }); });
    song.variations.forEach((v) => { if (bars[v.bar]) bars[v.bar].variation = VARIATIONS[v.value] || `Var ${v.value}`; });
    return bars;
  }

  // ------------------------------------------------------------ view
  function setInfo(t) { $('chords-info').textContent = t; status(t); }

  const length = (long) => (long ? 'long' : 'short');
  const signed = (n) => (n > 0 ? `+${n}` : String(n));

  function renderSettings() {
    const st = song.settings, off = !song.loaded;
    $('chords-settings').querySelectorAll('button').forEach((b) => { b.disabled = off; });
    $('tr-val').textContent = off ? '--' : signed(st.transpose);
    $('tr-down').disabled = off || st.transpose <= TRANSPOSE_MIN;
    $('tr-up').disabled = off || st.transpose >= TRANSPOSE_MAX;
    const loop = !off && st.loop;
    $('set-loop').classList.toggle('on', loop); $('set-loop').setAttribute('aria-pressed', loop ? 'true' : 'false');
    $('set-loop').disabled = off || st.ending;                    // a song with an ending doesn't loop
    $('set-loop').title = st.ending ? 'Turn the ending off to loop the song' : '';
    ['intro', 'ending'].forEach((sec) => {
      const v = off || !st[sec] ? null : length(st[`${sec}Long`]);
      $(`seg-${sec}`).querySelectorAll('button').forEach((b) => {
        b.classList.toggle('on', b.dataset.v === v); b.setAttribute('aria-pressed', b.dataset.v === v ? 'true' : 'false');
      });
    });
  }

  // The intro and the ending have one chord each: tap it to edit it.
  function sectionBox(key, label, long) {
    const c = song[`${key}Chord`], sel = edit.open && edit.section === key ? ' sel' : '';
    return `<div class="bar section" data-bar="${key}"><div class="bar-head"><span class="bar-num">${label}</span>` +
      `<span class="bar-var">${length(long)}</span></div><div class="beats one"><button class="beat${c ? '' : ' held'}${sel}" type="button" ` +
      `data-section="${key}" aria-label="${label} chord">${c ? esc(chordName(c)) : '·'}</button></div></div>`;
  }

  function render() {
    renderSettings();
    $('chords-name-text').textContent = song.name || DEFAULT_NAME;
    $('chords-title').hidden = !song.loaded || !$('name-form').hidden;
    if (!song.loaded) $('name-form').hidden = true;
    $('dl-txt').disabled = !song.loaded || !song.chords.length;
    $('chords-send').disabled = !song.loaded || !song.bars;
    if (!song.loaded) { $('bars').innerHTML = ''; return; }
    if (!song.bars) { $('bars').innerHTML = '<div class="fav-empty">The song on the keyboard has no bars.</div>'; return; }
    const st = song.settings;
    // Intro and ending get rows of their own, above and below the song's bars.
    const row = (html) => `<div class="bars-grid">${html}</div>`;
    computeView();
    const marks = repeatMarks(view.repeats), styles = barStyles();
    $('bars').innerHTML = (st.intro ? row(sectionBox('intro', 'INTRO', st.introLong)) : '') + row(byBar().map((bar, b) => {
      if (view.hidden[b]) return '';
      const beats = [];
      for (let k = 0; k < BEATS; k++) {
        const c = bar.chords.find((x) => x.beat === k);
        const sel = edit.open && !edit.section && edit.bar === b && edit.beat === k ? ' sel' : '';
        beats.push(`<button class="beat${c ? '' : ' held'}${sel}" type="button" data-bar="${b}" data-beat="${k}">${c ? esc(c.name) : '·'}</button>`);
      }
      const mk = marks[b] || {};
      const num = view.number[b];
      const r = activeRepeatAt(b) || view.repeats.find((x) => x.start === b) || null;   // includes a pair with no copy yet
      // The repeat signs are drawn on the bar's left and right edges (rep-open, rep-close in style.css).
      // A sign with no partner is grey.
      const loneOpen = !!mk.start && !view.repeats.some((x) => x.start === b);
      const loneClose = mk.end != null && !view.repeats.some((x) => x.start + x.len - 1 === b);
      const signs = (mk.start ? ' rep-open' : '') + (mk.end != null ? ' rep-close' : '') +
        (loneOpen ? ' lone-open' : '') + (loneClose ? ' lone-close' : '');
      // Upper right: the bar's variation (bars in a repeat list theirs per pass, beside the number), the times played
      // and the pass being played.
      const right = (bar.variation && !r && !sameAsBarBefore(styles, b) ? `<span class="bar-var">${esc(bar.variation)}</span>` : '') +
        (mk.end != null ? `<span class="rep-end">${mk.end ? `<span class="rep-mark">${mk.end}</span>` : ''}<span class="rep-pass" data-end="${b}"></span></span>` : '');
      return `<div class="bar${signs}" data-bar="${b}"${loneOpen || loneClose ? ' title="This repeat sign has no partner"' : ''}><div class="bar-head"><span class="bar-num">${num}</span>` +
        `${r ? passStyles(b, r, styles) : ''}<span class="bar-right">${right}</span></div>` +
        `<div class="beats">${beats.join('')}</div></div>`;
    }).join('') + '<button class="bar add-bar" type="button" id="add-bar" title="Add a bar at the end">+ bar</button>') +
      (st.ending ? row(sectionBox('ending', 'ENDING', st.endingLong)) : '');
    markBar();
    renderEditor();
  }

  // What each song bar plays: { value, own } (own = the bar has its own entry, otherwise the variation carries on from
  // an earlier bar), or null when it isn't known: before the first entry, and after a fill until the next entry.
  function barStyles() {
    const entry = {}, out = [];
    song.variations.forEach((v) => { entry[v.bar] = v.value; });
    let cur = null;
    for (let b = 0; b < song.bars; b++) {
      if (entry[b]) { cur = entry[b]; out.push({ value: cur, own: true }); continue; }
      if (cur > 4) cur = null;
      out.push(cur ? { value: cur, own: false } : null);
    }
    return out;
  }

  // The bar plays the same variation as the bar before it, so its label can be left out. A fill is never the same:
  // each one is played again.
  function sameAsBarBefore(styles, bar) {
    if (!bar) return false;
    const s = styles[bar], before = styles[bar - 1];
    return s ? !!before && s.value <= 4 && s.value === before.value : !before;
  }

  // One label per pass of a repeated bar: "1 Var 1   2 —". The repeat's first bar always lists at least passes 1 and 2,
  // with the variation or fill picked on that bar for each pass, or — when none is (one carried on from an earlier bar
  // doesn't count). Later bars only show the passes that change.
  function passStyles(bar, r, styles) {
    const opening = bar === r.start;
    let html = '';
    for (let k = 0; k < Math.max(r.times, opening ? 2 : 1); k++) {
      const played = k < r.times ? styles[bar + k * r.len] : null;
      const s = opening && !(played && played.own) ? null : played;
      if (!opening && sameAsBarBefore(styles, bar + k * r.len)) continue;
      const sel = edit.open && !edit.section && edit.bar === bar && editPass() === k ? ' sel' : '';
      html += `<span class="pass-var${s && s.own ? ' own' : ''}${sel}" data-pass="${k}"><b>${k + 1}</b> ${s ? esc(VARIATIONS[s.value] || `Var ${s.value}`) : '—'}</span>`;
    }
    return html ? `<div class="bar-passes">${html}</div>` : '';
  }

  function markBar() {
    $('bars').querySelectorAll('.bar.now').forEach((el) => el.classList.remove('now'));
    $('bars').querySelectorAll('.pass-var.play').forEach((el) => el.classList.remove('play'));
    if (!play.playing || play.bar == null) { followed = null; return; }
    $('bars').querySelectorAll('.rep-pass').forEach((el) => { el.textContent = ''; });
    const at = shownBar(play.bar);
    const el = $('bars').querySelector(`.bar[data-bar="${at.bar}"]`);
    if (el) el.classList.add('now');
    if (at.r) {
      const p = $('bars').querySelector(`.rep-pass[data-end="${at.r.start + at.r.len - 1}"]`);
      if (p) p.textContent = ` ${at.pass}/${at.r.times}`;
      const pv = el && el.querySelector(`.pass-var[data-pass="${at.pass - 1}"]`);
      if (pv) pv.classList.add('play');
    }
    if (el && play.bar !== followed) { followed = play.bar; follow(el); }
  }

  // Keep the bar being played on screen: when it gets near the bottom of the pane (or above the top), scroll so it
  // sits about a third of the way down. Paused for a few seconds after the user scrolls or touches the pane, so it
  // doesn't fight them. The docked chord editor covers the bottom of the pane, so that part doesn't count as visible.
  let followed = null, userScrolledAt = -1e9;
  function follow(el) {
    let pane = $('details');
    if (!pane || $('tab-chords').hidden || performance.now() - userScrolledAt < 4000) return;
    // Narrow windows (the tone list on top) scroll the whole page instead of the pane.
    const page = pane.scrollHeight <= pane.clientHeight;
    if (page) pane = document.scrollingElement || document.documentElement;
    const box = page ? { top: 0, bottom: window.innerHeight } : pane.getBoundingClientRect(), r = el.getBoundingClientRect();
    const editor = $('chord-editor');
    const bottom = box.bottom - (editor && !editor.hidden ? editor.offsetHeight : 0);
    if (r.top >= box.top && r.bottom <= bottom - 8) return;
    const top = pane.scrollTop + (r.top - box.top) - (bottom - box.top) / 3;
    try { pane.scrollTo({ top: Math.max(0, top), behavior: 'smooth' }); } catch (e) { pane.scrollTop = Math.max(0, top); }
  }
  function watchUserScroll() {
    const pane = $('details');
    if (!pane) return;
    const mark = () => { userScrolledAt = performance.now(); };
    ['wheel', 'touchstart', 'touchmove', 'keydown'].forEach((t) => window.addEventListener(t, mark, { passive: true }));
  }

  // ------------------------------------------------------------ repeats
  // The keyboard stores songs written out, so repeats are found again on every render: a block of 4+ bars played
  // 2+ times in a row. Bars are compared by what sounds on each beat (a held F equals a new F entry); variations are
  // ignored. Greedy from the start: at each bar take the block covering the most bars (shorter block on a tie).
  // That only fills in the markers when a song is read. After that the markers are the user's: each bar can carry
  // |: (repeat start) and :| (repeat end); a |: followed by a :| makes the bars between them a repeat. Its passes are
  // the written-out copies with the same chords that follow it on the keyboard. A pair the user makes always gets a new
  // copy written out and remembers its number of passes, so matching bars after it stay in the grid as ordinary bars.
  // Chords are shared by all passes, but each pass keeps its own variations and fills.
  const MIN_REPEAT = 4, MAX_REPEAT = 32;
  let starts = {}, ends = {};                       // song bar -> true; a number in starts = that repeat's exact passes
  function markersFromSong() {
    starts = {}; ends = {};
    findRepeats().forEach((r) => { starts[r.start] = true; ends[r.start + r.len - 1] = true; });
  }
  // Marker pairs -> repeats { start, len, times }; times counts the copies on the keyboard. For a pair the user marked,
  // a copy matches if it sounds the same or is written the same: a section that starts on a held chord looks identical
  // to its copy even though a different chord is held into each.
  function markedRepeats() {
    const sig = barSignatures(), written = barEntries(), out = [];
    const same = (a, b, len) => {
      for (let i = 0; i < len; i++) if (sig[a + i] !== sig[b + i] && written[a + i] !== written[b + i]) return false;
      return true;
    };
    let open = null;
    for (let b = 0; b < song.bars; b++) {
      if (starts[b]) open = b;
      if (ends[b] && open != null) {
        const len = b - open + 1;
        const most = typeof starts[open] === 'number' ? starts[open] : Infinity;
        let times = 1;
        while (times < most && open + (times + 1) * len <= song.bars && same(open, open + times * len, len)) times++;
        out.push({ start: open, len, times });
        open = null;
        b += (times - 1) * len;                      // markers inside the hidden copies don't count
      }
    }
    return out;
  }
  // Move markers when bars are inserted (delta > 0) or deleted (delta < 0, the bar at at is removed).
  function shiftMarkers(at, delta) {
    const move = (m) => {
      const out = {};
      Object.keys(m).forEach((k) => {
        const b = +k;
        if (delta < 0 && b === at) return;
        out[b >= at + (delta < 0 ? 1 : 0) ? b + delta : b] = m[k];
      });
      return out;
    };
    starts = move(starts); ends = move(ends);
  }

  const chordSound = (c) => [c.root, c.acc, c.type, c.bass, c.bass ? c.bassAcc : 0].join('.');

  // The chord changes written in each bar, as the grid shows them.
  function barEntries() {
    const out = [];
    for (let b = 0; b < song.bars; b++) out.push('');
    song.chords.forEach((c) => {
      if (c.bar < song.bars) out[c.bar] += `${[c.beat, c.root, c.acc, c.type, c.bass, c.bass ? c.bassAcc : 0].join('.')}|`;
    });
    return out;
  }

  function barSignatures() {
    const sigs = [], chords = song.chords;
    let k = 0, cur = '-';
    for (let b = 0; b < song.bars; b++) {
      const beats = [];
      for (let beat = 0; beat < BEATS; beat++) {
        while (k < chords.length && (chords[k].bar < b || (chords[k].bar === b && chords[k].beat <= beat))) {
          const c = chords[k++];
          cur = chordSound(c);
        }
        beats.push(cur);
      }
      sigs.push(beats.join('|'));
    }
    return sigs;
  }

  function findRepeats() {
    const sig = barSignatures(), n = sig.length, found = [];
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

  // What the grid shows: repeats that are on, their copies hidden, and the shown bars numbered 1, 2, 3...
  // as written (the bar after |: 1-8 :| is 9).
  let view = { repeats: [], active: [], hidden: {}, number: {} };
  function computeView() {
    const repeats = markedRepeats(), active = repeats.filter((r) => r.times >= 2), hidden = {}, number = {};
    active.forEach((r) => { for (let b = r.start + r.len; b < r.start + r.times * r.len; b++) hidden[b] = true; });
    let n = 1;
    for (let b = 0; b < song.bars; b++) if (!hidden[b]) number[b] = n++;
    view = { repeats, active, hidden, number };
  }
  const activeRepeatAt = (bar) => view.active.find((r) => bar >= r.start && bar < r.start + r.times * r.len) || null;
  // The shown bar for a song bar (a bar in a hidden copy maps back to the first pass), and which pass it is.
  function shownBar(bar) {
    if (typeof bar !== 'number') return { bar, pass: 0, r: null };
    const r = activeRepeatAt(bar);
    if (!r) return { bar, pass: 0, r: null };
    return { bar: r.start + ((bar - r.start) % r.len), pass: Math.floor((bar - r.start) / r.len) + 1, r };
  }
  // Every song bar a shown bar stands for (all passes of a repeat).
  function passesOf(bar) {
    const r = activeRepeatAt(bar);
    if (!r) return [bar];
    const out = [];
    for (let k = 0; k < r.times; k++) out.push(bar + k * r.len);
    return out;
  }
  // A song bar as the user reads it: "3" on the first pass, "3+8" on the second, "3+16" on the third.
  function passLabel(bar) {
    const at = shownBar(bar), n = view.number[at.bar];
    return at.r && at.pass > 1 ? `${n}+${(at.pass - 1) * at.r.len}` : String(n);
  }

  // bar -> { start: '|:', end: ':| ×n', copy: true } for the repeats that are on.
  function repeatMarks(repeats) {
    const marks = {};
    const m = (b) => (marks[b] = marks[b] || {});
    Object.keys(starts).forEach((b) => { m(+b).start = true; });
    Object.keys(ends).forEach((b) => { m(+b).end = ''; });
    repeats.forEach((r) => { if (r.times > 2) m(r.start + r.len - 1).end = `×${r.times}`; });
    return marks;
  }


  // ------------------------------------------------------------ editor
  // Tap a beat in the grid (touch or mouse), then pick the bar's variation or fill (first row), root / type / hold and
  // the bass note (a menu) in the panel docked at the bottom. Every tap is sent to the keyboard at once. The panel works in sounding pitch: with a
  // transpose the stored chord is shifted back before it's sent.
  const ROOTS = [[3, 0x40], [3, 0x41], [4, 0x40], [5, 0x3F], [5, 0x40], [6, 0x40], [6, 0x41], [7, 0x40], [1, 0x3F], [1, 0x40], [2, 0x3F], [2, 0x40]];
  const ROOT_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  const TYPE_ORDER = [0x01, 0x02, 0x03, 0x14, 0x13, 0x15, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0D, 0x0F,
    0x0E, 0x10, 0x0B, 0x0C, 0x19, 0x18, 0x17, 0x16, 0x11, 0x12, 0x1E, 0x1A, 0x1B, 0x1C, 0x1D, 0x1F];
  // The common types are buttons (major has no suffix, so its button is blank); the rest are in a menu.
  const TYPE_BUTTONS = [0x01, 0x02, 0x03, 0x13, 0x14, 0x05, 0x09];
  const TYPE_MORE = TYPE_ORDER.filter((t) => TYPE_BUTTONS.indexOf(t) < 0);
  const BAR_STYLES = [[0, 'Default'], [1, 'Var 1'], [2, 'Var 2'], [3, 'Var 3'], [4, 'Var 4'], [6, 'Fill Up'], [5, 'Fill Down']];
  // pass: which pass of a repeat the BAR row edits (0 = first). section: 'intro' / 'ending' while editing that chord.
  const edit = { open: false, bar: 0, beat: 0, pass: 0, section: null };
  const editedChord = () => (edit.section ? song[`${edit.section}Chord`] : chordAt(edit.bar, edit.beat));
  function editPass() {
    const r = activeRepeatAt(edit.bar);
    return r ? Math.min(edit.pass, r.times - 1) : 0;
  }
  // The song bar the BAR row edits: the selected bar on the selected pass.
  function styleBar() {
    const at = shownBar(edit.bar);
    return at.r ? at.bar + editPass() * at.r.len : edit.bar;
  }

  const chordAt = (bar, beat) => song.chords.find((c) => c.bar === bar && c.beat === beat) || null;
  // The chord sounding at a position (the last change at or before it), for defaults.
  function chordInEffect(bar, beat) {
    let found = null;
    song.chords.forEach((c) => { if (c.bar < bar || (c.bar === bar && c.beat <= beat)) found = c; });
    return found;
  }
  const soundingPc = (letter, acc) => (notePc(letter, acc) + song.settings.transpose + 120) % 12;
  const storedNote = (pc) => ROOTS[(pc - song.settings.transpose + 120) % 12];

  function sendEdit(addrLo, entry) {
    if (!send) { setInfo('No MIDI output, or Chrome refused SysEx access.'); return false; }
    if (!connected) connectApp();
    const msgs = [dt1([0x01, 0x00, 0x02, 0x14], [0, 0, 0, 0]), dt1([0x01, 0x00, 0x03, addrLo], [0, 1].concat(entry)),
      dt1([0x01, 0x00, 0x02, 0x18], [0, 0, 0, 0])];
    enqueue(msgs);
    lastAlive = performance.now();
    return true;
  }

  // Set (or with c = null delete) the chord at the selected beat.
  // A bar inside a shown repeat stands for all its passes, so the change goes to every pass (the repeat stays).
  function putChord(c) {
    if (edit.section) { putSectionChord(c); return; }
    const beat = edit.beat;
    for (const bar of passesOf(edit.bar)) {
      const entry = c ? [bar >> 7, bar & 0x7F, beat, c.root, c.acc, c.type >> 7, c.type & 0x7F, c.bass, c.bassAcc]
        : [bar >> 7, bar & 0x7F, beat, 0x00, 0x40, 0x00, 0x01, 0x00, 0x40];
      if (!sendEdit(0x40, entry)) return;
      song.chords = song.chords.filter((x) => !(x.bar === bar && x.beat === beat));
      if (c) song.chords.push({ bar, beat, root: c.root, acc: c.acc, type: c.type, bass: c.bass, bassAcc: c.bassAcc });
    }
    song.chords.sort((x, y) => x.bar - y.bar || x.beat - y.beat);
    render();
  }

  // Set (or with c = null clear) the intro or ending chord, the way Chord Director does: 02 14 / 03 42 or 43 / 02 18.
  function putSectionChord(c) {
    if (!send) { setInfo('No MIDI output, or Chrome refused SysEx access.'); return; }
    if (!connected) connectApp();
    enqueue([dt1([0x01, 0x00, 0x02, 0x14], [0, 0, 0, 0]), dt1([0x01, 0x00, 0x03, edit.section === 'intro' ? 0x42 : 0x43], chordBytes(c)),
      dt1([0x01, 0x00, 0x02, 0x18], [0, 0, 0, 0])]);
    lastAlive = performance.now();
    song[`${edit.section}Chord`] = c ? { root: c.root, acc: c.acc, type: c.type, bass: c.bass, bassAcc: c.bassAcc } : null;
    render();
  }

  // Change one part of the chord at the selected beat. A new chord on an empty beat is a plain major chord, on the root
  // of the chord sounding there until a root is picked.
  function changeChord(part, value) {
    const held = edit.section ? null : chordInEffect(edit.bar, edit.beat);
    const base = editedChord() || { root: held ? held.root : 3, acc: held ? held.acc : 0x40, type: 1, bass: 0, bassAcc: 0x40 };
    const c = { root: base.root, acc: base.acc, type: base.type, bass: base.bass, bassAcc: base.bassAcc };
    if (part === 'root') { const n = storedNote(value); c.root = n[0]; c.acc = n[1]; }
    if (part === 'acc') {                                          // sharp / flat on the root's letter; again = natural
      const name = spell(base.root, base.acc), sign = name[1] === '#' ? 1 : name[1] === 'b' ? -1 : 0;
      const acc = sign === value ? 0 : value;
      if (!song.settings.transpose) { c.root = LETTERS.indexOf(name[0]); c.acc = 0x40 + acc; }   // keeps the spelling (D# or Eb)
      else { const n = storedNote((PC[name[0]] + acc + 12) % 12); c.root = n[0]; c.acc = n[1]; }
    }
    if (part === 'type') c.type = value;
    if (part === 'bass') {
      if (value < 0) { c.bass = 0; c.bassAcc = 0x40; } else { const n = storedNote(value); c.bass = n[0]; c.bassAcc = n[1]; }
    }
    putChord(c);
  }

  // A variation that is already playing when the bar starts (the last entry before it is the same variation) is not
  // written again: the bar is left without an entry (an entry it had is removed). After a fill the variation that
  // follows isn't known here, so it is written. Only the selected pass of a repeat changes.
  function setBarStyle(value) {
    const bar = styleBar();
    if (value >= 1 && value <= 4) {
      let prev = null;
      song.variations.forEach((v) => { if (v.bar < bar && (!prev || v.bar > prev.bar)) prev = v; });
      if (prev && prev.value === value) {
        const had = song.variations.some((v) => v.bar === bar);
        if (had) setBarStyle(0);
        setInfo(`${VARIATIONS[value]} is already set from bar ${passLabel(prev.bar)}${had ? ': this bar\u2019s entry was removed' : ', nothing sent'}.`);
        return;
      }
    }
    if (!sendEdit(0x41, [bar >> 7, bar & 0x7F, value])) return;
    song.variations = song.variations.filter((v) => v.bar !== bar);
    if (value) song.variations.push({ bar, value });
    song.variations.sort((x, y) => x.bar - y.bar);
    render();
  }

  // ---- whole-song transfer, used when bars are inserted or deleted (later chords and variations move).
  // Same order as Chord Director: 02 08 begin, 03 40 chords (13 entries per packet), 03 41 variations, 03 00 name,
  // 03 22 transpose, 24 intro, 42 intro chord, 25 intro long, 26 ending, 43 ending chord, 27 ending long, 23 loop,
  // 03 20 bars, 02 0C end.
  const MAX_BARS = 999;
  const chordBytes = (c) => (c ? [c.root, c.acc, c.type >> 7, c.type & 0x7F, c.bass, c.bassAcc] : [0x00, 0x40, 0x00, 0x01, 0x00, 0x40]);
  function sendSong() {
    if (!send) { setInfo('No MIDI output, or Chrome refused SysEx access.'); return false; }
    if (!connected) connectApp();
    const st = song.settings, A = (lo) => [0x01, 0x00, 0x03, lo], msgs = [dt1([0x01, 0x00, 0x02, 0x08], [0, 0, 0, 0])];
    // A stream is sent as packets of [count 2B] + entries; an empty stream as one packet with count 0.
    const stream = (lo, items, size, bytes) => {
      let k = 0;
      do {
        const part = items.slice(k, k + size);
        let data = [part.length >> 7, part.length & 0x7F];
        part.forEach((x) => { data = data.concat(bytes(x)); });
        msgs.push(dt1(A(lo), data));
        k += size;
      } while (k < items.length);
    };
    stream(0x40, song.chords, 13, (c) => [c.bar >> 7, c.bar & 0x7F, c.beat].concat(chordBytes(c)));
    if (song.variations.length) stream(0x41, song.variations, 13, (v) => [v.bar >> 7, v.bar & 0x7F, v.value]);
    const name = ((song.name || DEFAULT_NAME) + ' '.repeat(32)).slice(0, 32).split('').map((ch) => ch.charCodeAt(0) & 0x7F);
    msgs.push(dt1(A(0x00), name), dt1(A(0x22), [0x40 + st.transpose]), dt1(A(0x24), [st.intro ? 1 : 0]),
      dt1(A(0x42), chordBytes(song.introChord)), dt1(A(0x25), [st.introLong ? 1 : 0]), dt1(A(0x26), [st.ending ? 1 : 0]),
      dt1(A(0x43), chordBytes(song.endingChord)), dt1(A(0x27), [st.endingLong ? 1 : 0]), dt1(A(0x23), [st.loop ? 1 : 0]),
      dt1(A(0x20), [song.bars >> 7, song.bars & 0x7F]), dt1([0x01, 0x00, 0x02, 0x0C], [0, 0, 0, 0]));
    enqueue(msgs);
    lastAlive = performance.now();
    return true;
  }

  // Insert an empty bar at index at (the chord before it keeps sounding), or delete bar at.
  function insertBar(at) {
    if (song.bars >= MAX_BARS) return;
    shiftMarkers(at, 1);
    const shift = (x) => { if (x.bar >= at) x.bar += 1; };
    song.chords.forEach(shift); song.variations.forEach(shift);
    song.bars += 1;
    if (sendSong()) { edit.open = true; edit.bar = at; edit.beat = 0; render(); }
  }
  function deleteBar(at) {
    if (song.bars <= 1) return;
    // A repeat that loses a sign also loses its written-out copies; the other sign stays, grey.
    const pair = markedRepeats().find((r) => r.start === at || r.start + r.len - 1 === at);
    if (pair && pair.times >= 2) {
      dropCopies(pair);
      if (pair.start === at) ends[pair.start + pair.len - 1] = true;
      if (pair.start + pair.len - 1 === at) starts[pair.start] = true;
    }
    shiftMarkers(at, -1);
    song.chords = song.chords.filter((c) => c.bar !== at);
    song.variations = song.variations.filter((v) => v.bar !== at);
    const shift = (x) => { if (x.bar > at) x.bar -= 1; };
    song.chords.forEach(shift); song.variations.forEach(shift);
    song.bars -= 1;
    // The sign left behind may now pair with a grey sign: that new repeat needs its copy on the keyboard.
    const lostStart = !!pair && pair.start === at, kept = pair && (lostStart ? pair.start + pair.len - 2 : pair.start);
    const formed = pair && pair.len > 1 && markedRepeats().find((x) => (lostStart ? x.start + x.len - 1 === kept : x.start === kept));
    if (formed) writeOutNewRepeat(formed);
    if (formed ? send : sendSong()) { edit.bar = Math.min(at, song.bars - 1); edit.beat = 0; render(); }
  }

  // Clear chart: back to the keyboard's initial pattern, 4 bars of C titled Initial Pattern with default settings. It replaces
  // the song on the keyboard, so it takes a second tap within 3 s (confirm() isn't reliable in the iPad plugin's web view).
  let clearTimer = 0;
  function disarmClear() {
    clearTimeout(clearTimer); clearTimer = 0;
    $('ed-clear').textContent = 'Clear chart';
    $('ed-clear').classList.remove('armed');
  }
  function clearChart() {
    if (!clearTimer) {
      $('ed-clear').textContent = 'Tap again to clear';
      $('ed-clear').classList.add('armed');
      clearTimer = setTimeout(disarmClear, 3000);
      return;
    }
    disarmClear();
    if (!send) { setInfo('No MIDI output, or Chrome refused SysEx access.'); return; }
    song.name = DEFAULT_NAME; song.variations = []; song.settings = defaults();
    song.bars = 4;
    song.chords = [{ bar: 0, beat: 0, root: 3, acc: 0x40, type: 1, bass: 0, bassAcc: 0x40 }];   // bars 2-4 hold the C
    song.introChord = null; song.endingChord = null;
    starts = {}; ends = {};
    edit.section = null; edit.pass = 0; edit.bar = 0; edit.beat = 0;
    sendSong();
    render();
    setInfo('Chart cleared.');
  }

  // Toggle |: or :| on the selected bar. A pair that isn't repeated on the keyboard yet gets its copy written out
  // (the bars are inserted after the :| and the whole song is resent). Removing a marker leaves its partner, grey, and
  // removes the repeat's written-out copies, so the grid doesn't change: the first pass stays.
  // Shrink repeat r to bars from..to of its first pass, as the signs now read: the bars before them play once, then
  // from..to play r.times times (each pass keeps its own variations), then the bars after them play once. The bars of
  // the old copies outside from..to are dropped and the whole song is resent. What sounds on each kept bar stays the
  // same: a chord or variation that used to carry over from a dropped bar is written on the bar.
  function reshapeRepeat(r, from, to) {
    const oldEnd = r.start + r.times * r.len, order = [];
    for (let b = 0; b < from; b++) order.push(b);
    for (let k = 0; k < r.times; k++) for (let b = from; b <= to; b++) order.push(b + k * r.len);
    for (let b = to + 1; b < r.start + r.len; b++) order.push(b);
    for (let b = oldEnd; b < song.bars; b++) order.push(b);
    reorderBars(order, r);
    starts[from] = r.times; ends[to] = true;
    if (sendSong()) setInfo(`Repeat changed: the song is now ${song.bars} bars.`);
  }
  // Take repeat r apart: its signs and written-out copies go, its first pass stays. The caller sends the song.
  function dropCopies(r) {
    const order = [];
    for (let b = 0; b < r.start + r.len; b++) order.push(b);
    for (let b = r.start + r.times * r.len; b < song.bars; b++) order.push(b);
    reorderBars(order, r);
  }
  // Rebuild the song from the old bars listed in order. The signs of repeat r, and any others inside it, are dropped.
  function reorderBars(order, r) {
    const oldEnd = r.start + r.times * r.len;
    const oldStyles = barStyles(), chords = [], variations = [];
    let style = null;
    order.forEach((old, bar) => {
      const here = song.chords.filter((c) => c.bar === old);
      if (!here.some((c) => c.beat === 0)) {
        const held = chordInEffect(old, 0), before = chords[chords.length - 1];
        if (held && (!before || chordSound(held) !== chordSound(before))) chords.push(Object.assign({}, held, { bar, beat: 0 }));
      }
      here.forEach((c) => chords.push(Object.assign({}, c, { bar })));
      const v = song.variations.find((x) => x.bar === old && x.value), want = oldStyles[old];
      if (style > 4) style = null;
      if (v) { variations.push({ bar, value: v.value }); style = v.value; }
      else if (want && want.value !== style) { variations.push({ bar, value: want.value }); style = want.value; }
    });

    const delta = order.length - song.bars;
    const moveSigns = (m) => {
      const out = {};
      Object.keys(m).forEach((k) => { const b = +k; if (b < r.start) out[b] = m[k]; else if (b >= oldEnd) out[b + delta] = m[k]; });
      return out;
    };
    starts = moveSigns(starts); ends = moveSigns(ends);
    song.chords = chords; song.variations = variations; song.bars = order.length;
  }
  // The repeat whose sign a new sign on the selected bar replaces: the repeat the bar is inside. Outside a repeat a new
  // sign does nothing until it has a partner.
  function repeatToMove(set) {
    const bar = edit.bar, isStart = set === starts, last = (x) => x.start + x.len - 1;
    return markedRepeats().find((x) => (isStart ? bar > x.start && bar <= last(x) : bar >= x.start && bar < last(x))) || null;
  }
  function toggleMarker(set) {
    if (set[edit.bar]) {
      const pair = markedRepeats().find((x) => (set === starts ? x.start : x.start + x.len - 1) === edit.bar);
      const isStart = set === starts;
      delete set[edit.bar];
      const dropped = !!pair && pair.times >= 2;
      if (dropped) {
        dropCopies(pair);
        if (isStart) ends[pair.start + pair.len - 1] = true; else starts[pair.start] = true;   // the partner stays, grey
      }
      // The partner may now pair with a grey sign: that makes a new repeat, which needs its copy on the keyboard.
      const formed = pair && markedRepeats().find((x) => (isStart ? x.start + x.len === pair.start + pair.len : x.start === pair.start));
      if (formed) writeOutNewRepeat(formed);
      else if (dropped && sendSong()) setInfo(`Repeat removed: the song is now ${song.bars} bars.`);
      render();
      return;
    }
    const moved = repeatToMove(set);
    if (moved) {
      const last = moved.start + moved.len - 1;
      if (moved.times >= 2) {                        // the repeat gets smaller: its copies are rebuilt to match
        reshapeRepeat(moved, set === starts ? edit.bar : moved.start, set === starts ? last : edit.bar);
        render();
        return;
      }
      delete set[set === starts ? moved.start : last];   // the sign moves here; no bars are added
      set[edit.bar] = true;
      starts[set === starts ? edit.bar : moved.start] = 1;
      render();
      return;
    }
    set[edit.bar] = true;
    const r = markedRepeats().find((x) => x.start === edit.bar || x.start + x.len - 1 === edit.bar);
    if (r) writeOutNewRepeat(r);
    render();
  }
  // A repeat the user just made: its bars play twice, whatever comes after them.
  function writeOutNewRepeat(r) {
    starts[r.start] = 1;
    writeOutRepeat(r);
  }
  function writeOutRepeat(r) {
    if (song.bars + r.len > MAX_BARS) return;
    const after = r.start + r.len;
    const move = (x) => { if (x.bar >= after) x.bar += r.len; };
    song.chords.forEach(move); song.variations.forEach(move);
    shiftMarkers(after, r.len);
    const copy = (list) => list.filter((x) => x.bar >= r.start && x.bar < after).map((x) => Object.assign({}, x, { bar: x.bar + r.len }));
    song.chords = song.chords.concat(copy(song.chords)).sort((x, y) => x.bar - y.bar || x.beat - y.beat);
    // A chord held into the copy from before the repeat must sound at its start too.
    if (!song.chords.some((c) => c.bar === after && c.beat === 0)) {
      const held = chordInEffect(after - 1, BEATS - 1);
      const first = chordInEffect(r.start, 0);
      if (first && held !== first) song.chords.push(Object.assign({}, first, { bar: after, beat: 0 }));
      song.chords.sort((x, y) => x.bar - y.bar || x.beat - y.beat);
    }
    song.variations = song.variations.concat(copy(song.variations)).sort((x, y) => x.bar - y.bar);
    song.bars += r.len;
    starts[r.start] = 2;
    if (sendSong()) setInfo(`Repeat written out: bars ${r.start + 1}–${after} now play twice.`);
  }

  function select(bar, beat) {
    edit.open = true; edit.section = null; edit.bar = bar; edit.beat = beat;
    render();
  }
  function selectSection(key) {
    edit.open = true; edit.section = key;
    render();
  }
  function stepBeat(dir) {
    let pos = edit.bar * BEATS + edit.beat;
    for (;;) {
      pos += dir;
      if (pos < 0 || pos >= song.bars * BEATS) return;
      if (!view.hidden[Math.floor(pos / BEATS)]) break;
    }
    select(Math.floor(pos / BEATS), pos % BEATS);
  }

  // « / »: the first beat of the previous / next shown bar.
  function stepBar(dir) {
    for (let b = edit.bar + dir; b >= 0 && b < song.bars; b += dir) if (!view.hidden[b]) { select(b, 0); return; }
  }

  function lastShownBar() { for (let b = song.bars - 1; b >= 0; b--) if (!view.hidden[b]) return b; return 0; }

  function renderEditor() {
    const panel = $('chord-editor'), sec = edit.section;
    if (sec && !song.settings[sec]) { edit.section = null; edit.open = false; }   // that section was just turned off
    panel.hidden = !(edit.open && song.loaded && (edit.section || edit.bar < song.bars));
    if (panel.hidden) return;
    panel.classList.toggle('section', !!sec);                     // only the chord rows apply to the intro and ending
    const c = editedChord(), eff = c || (sec ? null : chordInEffect(edit.bar, edit.beat));
    $('ed-pos').textContent = sec ? (sec === 'intro' ? 'Intro' : 'Ending') : `${passLabel(styleBar())}:${edit.beat + 1}`;
    $('ed-hold').textContent = sec ? 'NONE' : 'HOLD';
    $('ed-hold').title = sec ? 'No chord in this section' : 'No chord change on this beat: the previous chord continues';
    const bassPc = c ? (c.bass ? soundingPc(c.bass, c.bassAcc) : -1) : null;
    const btn = (attr, v, label, on) => `<button class="btn ed${on ? ' on' : ''}" type="button" data-${attr}="${v}">${esc(label)}</button>`;
    // A repeated bar is played once per pass: 1, 2, 3... The BAR row edits the pass picked here.
    const rep = sec ? null : activeRepeatAt(edit.bar);
    $('ed-pass-row').hidden = !rep;
    if (rep) {
      let passes = '';
      for (let k = 0; k < rep.times; k++) passes += btn('pass', k, String(k + 1), k === editPass());
      $('ed-pass').innerHTML = passes;
    }
    // Root: the seven letters plus sharp and flat (no E#, B#, Cb, Fb). The accidental buttons act on the chord at this
    // beat, or on the one sounding there if the beat is a hold.
    const rootName = eff ? spell(eff.root, eff.acc) : null, letter = rootName ? rootName[0] : 'C';
    const sign = !rootName ? 0 : rootName[1] === '#' ? 1 : rootName[1] === 'b' ? -1 : 0;
    const accBtn = (v, label, name, off) => `<button class="btn ed acc${c && sign === v ? ' on' : ''}" type="button" data-acc="${v}"` +
      ` title="${name}" aria-label="${name}"${off ? ' disabled' : ''}>${label}</button>`;
    $('ed-root').innerHTML = 'CDEFGAB'.split('').map((l) => btn('root', PC[l], l, !!c && l === letter)).join('') +
      accBtn(1, '\u266F', 'Sharp', letter === 'E' || letter === 'B') + accBtn(-1, '\u266D', 'Flat', letter === 'C' || letter === 'F');
    const more = !!c && TYPE_MORE.indexOf(c.type) >= 0;
    $('ed-type').innerHTML = TYPE_BUTTONS.map((t) => btn('type', t, TYPES[t][0], !!c && c.type === t)).join('')
        .replace('data-type="1">', 'data-type="1" title="Major" aria-label="Major">') +
      `<select id="ed-type-more" class="ed-select${more ? ' on' : ''}" aria-label="Other chord types"><option value="">more…</option>` +
      TYPE_MORE.map((t) => `<option value="${t}">${esc(TYPES[t][0])}</option>`).join('') + '</select>';
    $('ed-type-more').value = more ? String(c.type) : '';
    $('ed-bass').innerHTML = '<option value="-1">none</option>' + ROOT_NAMES.map((n, pc) => `<option value="${pc}">/${n}</option>`).join('');
    $('ed-bass').value = String(bassPc == null ? -1 : bassPc);
    const styled = styleBar(), v = song.variations.find((x) => x.bar === styled);
    $('ed-style').innerHTML = BAR_STYLES.map(([val, label]) => btn('style', val, label, (v ? v.value : 0) === val)).join('');
    $('ed-hold').classList.toggle('on', !c);
    $('ed-rep-start').classList.toggle('on', !!starts[edit.bar]);
    $('ed-rep-end').classList.toggle('on', !!ends[edit.bar]);
    $('ed-del-bar').disabled = song.bars <= 1;
    $('ed-ins-before').disabled = $('ed-ins-after').disabled = song.bars >= MAX_BARS;
    const lastShown = lastShownBar();
    $('ed-prev').disabled = edit.bar === 0 && edit.beat === 0;
    $('ed-next').disabled = edit.bar === lastShown && edit.beat === BEATS - 1;
    $('ed-prev-bar').disabled = edit.bar === 0;
    $('ed-next-bar').disabled = edit.bar === lastShown;
  }

  function initEditor() {
    $('bars').addEventListener('click', (e) => {
      if (e.target.closest('#add-bar')) { insertBar(song.bars); return; }
      const b = e.target.closest('button.beat');
      if (b && b.dataset.section) selectSection(b.dataset.section);
      else if (b) select(+b.dataset.bar, +b.dataset.beat);
    });
    $('chord-editor').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || b.disabled) return;
      if (b.dataset.pass != null) { edit.pass = +b.dataset.pass; render(); }
      else if (b.dataset.root != null) changeChord('root', +b.dataset.root);
      else if (b.dataset.acc != null) changeChord('acc', +b.dataset.acc);
      else if (b.dataset.type != null) changeChord('type', +b.dataset.type);
      else if (b.dataset.style != null) setBarStyle(+b.dataset.style);
      else if (b.id === 'ed-hold') { if (editedChord()) putChord(null); }
      else if (b.id === 'ed-prev') stepBeat(-1);
      else if (b.id === 'ed-next') stepBeat(1);
      else if (b.id === 'ed-prev-bar') stepBar(-1);
      else if (b.id === 'ed-next-bar') stepBar(1);
      else if (b.id === 'ed-close') { edit.open = false; render(); }
      else if (b.id === 'ed-rep-start' || b.id === 'ed-rep-end') toggleMarker(b.id === 'ed-rep-start' ? starts : ends);
      else if (b.id === 'ed-ins-before') insertBar(edit.bar);
      else if (b.id === 'ed-ins-after') insertBar(edit.bar + 1);
      else if (b.id === 'ed-del-bar') deleteBar(edit.bar);
      else if (b.id === 'ed-clear') clearChart();
    });
    $('ed-bass').addEventListener('change', (e) => changeChord('bass', +e.target.value));
    // The type menu is rebuilt on every render, so listen on the row.
    $('ed-type').addEventListener('change', (e) => { if (e.target.id === 'ed-type-more' && e.target.value) changeChord('type', +e.target.value); });
    document.addEventListener('keydown', onEditorKey, true);
    // A focused button clicks on the space bar's keyup; the keydown above already started or stopped the style.
    document.addEventListener('keyup', (e) => {
      if (e.key === ' ' && !$('tab-chords').hidden && !(e.target.closest && e.target.closest('input, textarea, [contenteditable]'))) e.preventDefault();
    }, true);
  }

  // Typing on a hardware keyboard (desktop, or an iPad with one attached). Nothing is focused for it, so the iPad's
  // on-screen keyboard never comes up. Space works on the whole Chords tab, the rest while the editor is open.
  //   space  play / stop    right / left arrow  the next / previous beat (past the song's last beat right adds a bar)
  //   a-g  root (natural)    m  minor on / off    6  sixth    7 / 9  the 7th / 9th chords; again = the next one
  //   delete  remove the chord: the beat holds the chord before it    [ or {  |:    ] or }  :|
  //   1-4  the bar's variation (Var 1-4)    l  loop on / off
  // The 6, 7 and 9 chords follow the chord's minor or major quality, so "a m 7" is Am7 and "a 7 m" is Am7 too.
  const MINOR_PAIRS = [[0x01, 0x02], [0x03, 0x14], [0x13, 0x15], [0x0D, 0x0F], [0x0E, 0x10], [0x0B, 0x0C], [0x19, 0x18], [0x17, 0x16]];
  const MINOR_TYPES = [0x02, 0x14, 0x15, 0x0F, 0x10, 0x0C, 0x18, 0x16, 0x04, 0x05, 0x06, 0x11, 0x12];
  const KEY_TYPES = {
    6: [[0x0D, 0x0E], [0x0F, 0x10]],
    7: [[0x03, 0x13, 0x0A, 0x1A, 0x08, 0x1B, 0x1C, 0x1D, 0x1F], [0x14, 0x15, 0x04, 0x06]],
    9: [[0x19, 0x17, 0x0B, 0x0E, 0x1B, 0x1C], [0x18, 0x16, 0x0C, 0x10]],
  };
  function onEditorKey(e) {
    if (e.metaKey || e.ctrlKey || e.altKey || $('tab-chords').hidden) return;
    const t = e.target;
    if (t && t.closest && t.closest('input, textarea, [contenteditable]')) return;
    if (e.key === ' ') {                                          // preventDefault: not a click on a focused button
      e.preventDefault();
      if (!e.repeat) togglePlay();
      return;
    }
    if ($('chord-editor').hidden) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {        // held down, it keeps stepping (but adds no bars)
      e.preventDefault();
      if (edit.section) return;
      if (e.key === 'ArrowLeft') stepBeat(-1);
      else if (edit.beat === BEATS - 1 && edit.bar === lastShownBar()) { if (!e.repeat) insertBar(song.bars); }
      else stepBeat(1);
      return;
    }
    if (e.repeat) return;
    const k = e.key.toLowerCase(), c = editedChord();
    if (e.key === 'Backspace' || e.key === 'Delete') {              // as HOLD (NONE for the intro / ending chord)
      e.preventDefault();
      if (c) { engage(); putChord(null); }
      return;
    }
    if ('[{]}'.indexOf(e.key) >= 0) {                              // as the |: and :| buttons
      e.preventDefault();
      if (!edit.section) { engage(); toggleMarker(e.key === '[' || e.key === '{' ? starts : ends); }
      return;
    }
    if (k === 'l') { e.preventDefault(); engage(); setSetting('loop', !song.settings.loop); return; }
    if ('1234'.indexOf(k) >= 0 && k.length === 1) {               // as the BAR row's Var 1-4
      e.preventDefault();
      if (!edit.section) { engage(); setBarStyle(+k); }
      return;
    }
    let part = null, value = null;
    if (k.length === 1 && 'abcdefg'.indexOf(k) >= 0) { part = 'root'; value = PC[k.toUpperCase()]; }
    else if (k === 'm') {
      const type = c ? c.type : 1, pair = MINOR_PAIRS.find((p) => p.indexOf(type) >= 0);
      part = 'type'; value = pair ? pair[1 - pair.indexOf(type)] : MINOR_TYPES.indexOf(type) >= 0 ? 0x01 : 0x02;
    } else if (KEY_TYPES[k]) {
      const type = c ? c.type : 1, list = KEY_TYPES[k][MINOR_TYPES.indexOf(type) >= 0 ? 1 : 0], at = list.indexOf(type);
      part = 'type'; value = list[(at + 1) % list.length];        // not in the list yet (at = -1): its first chord
    }
    if (!part) return;
    e.preventDefault();                                           // a focused menu would jump to the letter otherwise
    engage();
    changeChord(part, value);
  }

  // ------------------------------------------------------------ exports
  function fileBase() {
    const n = (song.name || 'gokeys-chords').replace(/~$/, '').replace(/[^\w#-]+/g, '_').replace(/^_+|_+$/g, '');
    return n || 'gokeys-chords';
  }

  // The keyboard's own chord-pattern format (ROLAND/CHORD_PTN/CHORDnnn.CSV on a USB backup), CRLF line ends:
  //   FORMAT,2 / NAME / INTRO_SW / ENDING_SW / LOOP / TRANSPOSE, a blank line, then
  //   DIVISION,Intro,Short + CHORD,1,<intro chord>, and the song as rows of CHORD,<bars in row>,<bar>,<bar>,...
  //   A bar lists its beats separated by spaces: a chord name = change on that beat, ":" = hold, empty = whole bar held.
  //   Rows break every 4 bars (bars 1, 5, 9...) and at each DIVISION,Variation,1-4 / FillIn,Down|Up; a division in the
  //   middle of a 4-bar line gets a blank line first. After the song a blank line, then (if on)
  //   DIVISION,Ending,Short|Long and CHORD,1,<ending chord> (empty = none).
  //   Chord names are stored untransposed; TRANSPOSE says how far the keyboard shifts them.
  const onOff = (b) => (b ? 'On' : 'Off');
  const DIVISIONS = { 1: 'Variation,1', 2: 'Variation,2', 3: 'Variation,3', 4: 'Variation,4', 5: 'FillIn,Down', 6: 'FillIn,Up' };
  function csvCell(chords) {
    if (!chords.length) return '';
    const last = Math.max.apply(null, chords.map((c) => c.beat));
    const beats = [];
    for (let k = 0; k <= last; k++) {
      const c = chords.find((x) => x.beat === k);
      beats.push(c ? chordName(c, true) : ':');
    }
    return beats.join(' ');
  }
  function csvText() {
    const st = song.settings, lines = [];
    lines.push('FORMAT,2', `NAME,${(song.name || DEFAULT_NAME).replace(/,/g, ' ')}`, `INTRO_SW,${onOff(st.intro)}`,
      `ENDING_SW,${onOff(st.ending)}`, `LOOP,${onOff(st.loop)}`, `TRANSPOSE,${st.transpose}`, '');
    if (st.intro) {
      lines.push(`DIVISION,Intro,${st.introLong ? 'Long' : 'Short'}`,
        `CHORD,1,${song.introChord ? chordName(song.introChord, true) : ''}`, '');
    }
    const divisions = {};
    song.variations.forEach((v) => { divisions[v.bar] = DIVISIONS[v.value] || `Variation,${v.value}`; });
    // Rows follow 4-bar lines counted from the song's first bar; a division also starts a new row, after a blank line
    // when it falls in the middle of a line (as in the keyboard's own files).
    let row = [];
    const flush = () => { if (row.length) lines.push(`CHORD,${row.length},${row.join(',')}`); row = []; };
    for (let b = 0; b < song.bars; b++) {
      if (b % 4 === 0) flush();
      if (divisions[b]) {
        flush();
        if (b % 4 !== 0 && lines[lines.length - 1] !== '') lines.push('');
        lines.push(`DIVISION,${divisions[b]}`);
      }
      row.push(csvCell(song.chords.filter((c) => c.bar === b)));
    }
    flush();
    lines.push('');
    if (st.ending) {
      lines.push(`DIVISION,Ending,${st.endingLong ? 'Long' : 'Short'}`,
        `CHORD,1,${song.endingChord ? chordName(song.endingChord, true) : ''}`);
    }
    return lines.join('\r\n') + '\r\n';
  }

  // a[download] works in Chrome (the MIDI Charmer plugin's web view has no downloads).
  function download(name, type, data) {
    const url = URL.createObjectURL(new Blob([data], { type }));
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    setInfo(`Downloaded ${name}.`);
  }

  function init(opts) {
    status = opts.status || status;
    $('tab-chords').addEventListener('click', onControlUsed, true);
    $('tab-chords').addEventListener('change', onControlUsed, true);
    $('chords-read').onclick = request;
    $('chords-send').onclick = () => { if (song.loaded && song.bars && sendSong()) setInfo('Sent the song to the keyboard.'); };
    // Rename: the keyboard stores 32 ASCII characters; sent with the whole song (Chord Director only sends the name
    // that way). Save sends it; Enter saves too, Escape cancels (desktop).
    const nameEl = $('chords-name');
    const closeRename = () => { $('name-form').hidden = true; nameEl.blur(); render(); };
    const saveRename = () => {
      const v = nameEl.value.normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // é -> e
        .replace(/[^\x20-\x7E]/g, '').replace(/\s+$/, '').slice(0, 32);
      if (song.loaded && v !== song.name) {
        const old = song.name;
        song.name = v;
        if (sendSong()) setInfo('Renamed.'); else song.name = old;
      }
      closeRename();
    };
    $('name-edit').onclick = () => {
      nameEl.value = song.name;
      $('name-form').hidden = false; $('chords-title').hidden = true;
      nameEl.focus();
    };
    $('name-save').onclick = saveRename;
    $('name-cancel').onclick = closeRename;
    nameEl.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); saveRename(); }
      if (e.key === 'Escape') closeRename();
    };
    initEditor();
    watchUserScroll();
    $('chords-play').onclick = togglePlay;
    $('dl-txt').onclick = () => download(`${fileBase()}.csv`, 'text/csv', csvText());
    $('tr-down').onclick = () => setSetting('transpose', Math.max(TRANSPOSE_MIN, song.settings.transpose - 1));
    $('tr-up').onclick = () => setSetting('transpose', Math.min(TRANSPOSE_MAX, song.settings.transpose + 1));
    $('set-loop').onclick = () => setSetting('loop', !song.settings.loop);
    // SHORT / LONG: tapping the one that's lit turns the section off. On/off is 03 24 / 26, the length 03 25 / 27.
    ['intro', 'ending'].forEach((sec) => {
      $(`seg-${sec}`).onclick = (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        const st = song.settings, c = {};
        c[sec] = !(st[sec] && length(st[`${sec}Long`]) === b.dataset.v);
        if (c[sec]) c[`${sec}Long`] = b.dataset.v === 'long';
        if (sec === 'ending') c.loop = !c.ending;                  // a song with an ending doesn't loop; without one it does
        setSettings(c);
      };
    });
    render();
  }

  window.addEventListener('pagehide', () => setActive(false));

  window.GOKEYS_CHORDS = {
    init,
    onSysEx,
    setActive,
    whileDisconnected,
    setOutput(fn) { send = fn; connected = false; if (engaged) connectApp(); },
  };
}());
