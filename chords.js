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
      if (!play.playing) endPlayFrom();
      markBar(); markPlay(); keepAlive(); return true;
    }
    if (a2 === 0x01 && a3 === 0x02 && data.length >= 2) { onBar(section(data[0], data[1])); return true; }

    // A dump only counts after GET asked for one (incoming is set until it ends or times out). The keyboard never sends
    // one unasked, but a loopback port (IAC Driver) echoes the page's own song transfers back, and taking those as
    // dumps put an older copy of the song on screen and re-ran repeat detection on it.
    if (a2 === 0x02 && a3 === 0x08) { if (incoming) incoming = newDump(); return true; }
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
      playFrom = 0;
      markersFromSong();
      incoming = null;
      savedId = matchingSaved();
      render();
      setInfo('');
    }
    return true;
  }

  function newDump() { return { name: '', bars: 0, chords: [], variations: [], settings: defaults(), intro: null, ending: null }; }
  const sectionChord = (e) => (e.length >= 6 && e[0] ? { root: e[0], acc: e[1], type: w14(e[2], e[3]), bass: e[4], bassAcc: e[5] } : null);

  // Bar number from the keyboard: 'intro', 'ending' or the bar index.
  // While playing from a bar, the keyboard holds the song rotated to start there (see kbSong), so its bar numbers are
  // turned back to song bars.
  function section(hi, lo) { return hi & 0x40 ? 'ending' : hi & 0x20 ? 'intro' : songBar(w14(hi, lo)); }
  function firstBar() { return playFrom ? playFrom : song.loaded && song.settings.intro ? 'intro' : 0; }

  // Bar counter: highlight the bar being played. The keyboard also sends it while stopped, whenever a song setting
  // changes (00 00, then 20 00 if there's an intro: back to the start), so only the play state decides playing.
  function onBar(bar) {
    play.bar = play.playing ? bar : null;
    keepAlive();
    markBar();
  }

  // Play/Stop button. The keyboard's play-state messages keep it in step with the panel's START/STOP button.
  // With the editor open on a bar after the first, Play starts from that bar (on a repeat's first pass).
  function togglePlay() {
    if (!send) { setInfo('No MIDI output, or Chrome refused SysEx access.'); return; }
    // edit.bar is the bar on the first pass of a repeat, so the repeat still plays all its passes from there. (The pass
    // picked in the editor stays set from bar to bar, so starting on it skipped the earlier passes.)
    if (!play.playing && song.loaded && edit.open && !edit.section && edit.bar > 0) { playFromBar(edit.bar); return; }
    const wasPlaying = play.playing;
    send(dt1([0x01, 0x00, 0x02, 0x01], [wasPlaying ? 0 : 1]));
    play.playing = !play.playing;
    play.bar = play.playing ? firstBar() : null;
    if (!play.playing) endPlayFrom();
    markPlay(); markBar();
  }

  // Play from the selected bar. The keyboard always starts a song at its first bar (song position is ignored by START),
  // so it gets the song from the selected bar on: with LOOP off just the bars to the end; with LOOP on the whole song
  // rotated (the bars to the end, then the bars before), so it plays on into bar 1 and round again, like the song does.
  // Which one is decided at Play (playRotated), so toggling LOOP while it plays doesn't confuse the bar numbers. The
  // chord and variation already sounding at the selected bar go on its first beat, and the intro is left out. Edits made
  // meanwhile go to the keyboard's bar (kbBar; none for a bar cut off), and the bar numbers it sends back are turned
  // back (songBar). Stopping puts the whole song back in order.
  let playFrom = 0, playRotated = false;
  function playFromBar(bar) {
    playFrom = bar; playRotated = !!song.settings.loop;
    sendSong();
    enqueue([dt1([0x01, 0x00, 0x02, 0x01], [1])]);                 // after the transfer
    play.playing = true; play.bar = firstBar();
    markPlay(); markBar();
    setInfo(`Playing from bar ${passLabel(playFrom)}. Stop puts the song back in order on the keyboard.`);
  }
  function endPlayFrom() {
    if (!playFrom) return;
    playFrom = 0;
    if (send) sendSong();
  }
  // < 0: the bar isn't on the keyboard (cut off before the start).
  const kbBar = (bar) => (!playFrom ? bar : playRotated ? (bar - playFrom + song.bars) % song.bars : bar - playFrom);
  const songBar = (kb) => (!playFrom ? kb : playRotated ? (kb + playFrom) % song.bars : kb + playFrom);
  // What the keyboard should have on its first beat while playing from a bar: the chord sounding and the variation playing.
  function kbStart() {
    const st = barStyles()[playFrom];
    return { chord: chordInEffect(playFrom, 0), variation: st ? st.value : 0 };
  }
  // After an edit, the start chord or variation may have changed (an edit before the start bar, or of the bar itself).
  // (Rotated, song bar 1 comes round without anything added, so nothing else needs fixing.)
  function syncStart() {
    if (!playFrom) return;
    const k = kbStart(), c = k.chord;
    sendEdit(0x40, [0, 0, 0].concat(chordBytes(c)));               // bar 0, beat 0; no chord = delete the entry
    sendEdit(0x41, [0, 0, k.variation]);
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
    layoutSide();                                   // the chord editor only shows on the Chords tab
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
  // Turning LOOP on turns the ending (short or long) off.
  function toggleLoop() { const loop = !song.settings.loop; setSettings(loop ? { loop, ending: false } : { loop }); }
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
    $('set-loop').title = st.ending && !loop ? 'Loop the song (turns the ending off)' : '';
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
    renderSongs();
    $('chords-name-text').textContent = song.name || DEFAULT_NAME;
    $('chords-title').hidden = !song.loaded || !$('name-form').hidden;
    $('chords-info').hidden = song.loaded;            // a hint until there's a song; messages also go to the status line
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
    const bottom = box.bottom;
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
  const TYPE_BUTTONS = [0x01, 0x02, 0x03, 0x13, 0x14, 0x05];
  const TYPE_MORE = TYPE_ORDER.filter((t) => TYPE_BUTTONS.indexOf(t) < 0);
  const BAR_STYLES = [[0, '\u2014'], [1, 'V1'], [2, 'V2'], [3, 'V3'], [4, 'V4'], [6, 'Fill Up'], [5, 'Fill Down']];
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
      const kb = kbBar(bar);
      const entry = c ? [kb >> 7, kb & 0x7F, beat, c.root, c.acc, c.type >> 7, c.type & 0x7F, c.bass, c.bassAcc]
        : [kb >> 7, kb & 0x7F, beat, 0x00, 0x40, 0x00, 0x01, 0x00, 0x40];
      if (kb >= 0 ? !sendEdit(0x40, entry) : !send) { if (!send) setInfo('No MIDI output, or Chrome refused SysEx access.'); return; }
      song.chords = song.chords.filter((x) => !(x.bar === bar && x.beat === beat));
      if (c) song.chords.push({ bar, beat, root: c.root, acc: c.acc, type: c.type, bass: c.bass, bassAcc: c.bassAcc });
    }
    song.chords.sort((x, y) => x.bar - y.bar || x.beat - y.beat);
    syncStart();
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
    const kb = kbBar(bar);
    if (kb >= 0 ? !sendEdit(0x41, [kb >> 7, kb & 0x7F, value]) : !send) { if (!send) setInfo('No MIDI output, or Chrome refused SysEx access.'); return; }
    song.variations = song.variations.filter((v) => v.bar !== bar);
    if (value) song.variations.push({ bar, value });
    song.variations.sort((x, y) => x.bar - y.bar);
    syncStart();
    render();
  }

  // ---- whole-song transfer, used when bars are inserted or deleted (later chords and variations move).
  // Same order as Chord Director: 02 08 begin, 03 40 chords (13 entries per packet), 03 41 variations, 03 00 name,
  // 03 22 transpose, 24 intro, 42 intro chord, 25 intro long, 26 ending, 43 ending chord, 27 ending long, 23 loop,
  // 03 20 bars, 02 0C end.
  const MAX_BARS = 256;                            // the most measures a GO:KEYS chord pattern holds, repeat passes included
  const tooLong = (more) => { setInfo(`The keyboard holds at most ${MAX_BARS} measures (repeats count every pass): no room for ${more} more.`); };
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
    const kb = kbSong();
    stream(0x40, kb.chords, 13, (c) => [c.bar >> 7, c.bar & 0x7F, c.beat].concat(chordBytes(c)));
    if (kb.variations.length) stream(0x41, kb.variations, 13, (v) => [v.bar >> 7, v.bar & 0x7F, v.value]);
    const name = ((song.name || DEFAULT_NAME) + ' '.repeat(32)).slice(0, 32).split('').map((ch) => ch.charCodeAt(0) & 0x7F);
    msgs.push(dt1(A(0x00), name), dt1(A(0x22), [0x40 + st.transpose]), dt1(A(0x24), [kb.intro ? 1 : 0]),
      dt1(A(0x42), chordBytes(song.introChord)), dt1(A(0x25), [st.introLong ? 1 : 0]), dt1(A(0x26), [st.ending ? 1 : 0]),
      dt1(A(0x43), chordBytes(song.endingChord)), dt1(A(0x27), [st.endingLong ? 1 : 0]), dt1(A(0x23), [st.loop ? 1 : 0]),
      dt1(A(0x20), [kb.bars >> 7, kb.bars & 0x7F]), dt1([0x01, 0x00, 0x02, 0x0C], [0, 0, 0, 0]));
    enqueue(msgs);
    lastAlive = performance.now();
    return true;
  }

  // The song as the keyboard gets it: as it is, or while playing from a bar, from that bar on (see playFromBar). Rotated,
  // bar 1 needs nothing added where it comes round: the chord and variation held into it are the song's last ones, as
  // when the song loops.
  function kbSong() {
    if (!playFrom) return { chords: song.chords, variations: song.variations, bars: song.bars, intro: song.settings.intro };
    const k = kbStart(), byPos = (x, y) => x.bar - y.bar || (x.beat || 0) - (y.beat || 0), on = (x) => x.bar >= 0;
    const chords = song.chords.map((c) => Object.assign({}, c, { bar: kbBar(c.bar) })).filter(on);
    if (k.chord && !chords.some((c) => c.bar === 0 && c.beat === 0)) chords.push(Object.assign({}, k.chord, { bar: 0, beat: 0 }));
    const variations = song.variations.map((v) => ({ bar: kbBar(v.bar), value: v.value })).filter(on);
    if (k.variation && !variations.some((v) => v.bar === 0)) variations.push({ bar: 0, value: k.variation });
    return { chords: chords.sort(byPos), variations: variations.sort(byPos),
      bars: playRotated ? song.bars : song.bars - playFrom, intro: false };
  }

  // Insert an empty bar at index at (the chord before it keeps sounding), or delete bar at.
  // While playing from a bar, the start bar moves with the bars before it.
  function addBarAt(at) {
    if (playFrom && at <= playFrom) playFrom += 1;
    shiftMarkers(at, 1);
    const shift = (x) => { if (x.bar >= at) x.bar += 1; };
    song.chords.forEach(shift); song.variations.forEach(shift);
    song.bars += 1;
  }
  function removeBarAt(at) {
    if (playFrom && at < playFrom) playFrom -= 1;
    shiftMarkers(at, -1);
    song.chords = song.chords.filter((c) => c.bar !== at);
    song.variations = song.variations.filter((v) => v.bar !== at);
    const shift = (x) => { if (x.bar > at) x.bar -= 1; };
    song.chords.forEach(shift); song.variations.forEach(shift);
    song.bars -= 1;
  }
  function insertBar(at) {
    if (song.bars >= MAX_BARS) { tooLong(1); return; }
    addBarAt(at);
    sendSong();                                     // with no MIDI output the page still updates; Send catches up
    edit.open = true; edit.bar = at; edit.beat = 0; render();
  }
  // <+ / +> beside a shown bar. A repeat counts as one block: next to its |: or :| the bar goes before the first pass or
  // after the last, and inside it the bar goes into every pass, so the passes still match and stay one repeat.
  // (Inserting after the first pass only made the hidden passes differ, and they showed up as plain bars.)
  function insertBeside(bar, after) {
    const r = activeRepeatAt(bar);
    if (!r) { insertBar(after ? bar + 1 : bar); return; }
    const off = shownBar(bar).bar - r.start + (after ? 1 : 0);
    if (off <= 0) { insertBar(r.start); return; }
    if (off >= r.len) { insertBar(r.start + r.times * r.len); return; }
    if (song.bars + r.times > MAX_BARS) { tooLong(r.times); return; }
    for (let k = r.times - 1; k >= 0; k--) addBarAt(r.start + k * r.len + off);   // last pass first: earlier ones don't move
    sendSong();
    edit.open = true; edit.bar = r.start + off; edit.beat = 0; render();
  }
  function deleteBar(at) {
    if (song.bars <= 1) return;
    // A bar between the signs of a repeat goes from every pass, like insertBeside.
    const r = activeRepeatAt(at), off = r ? shownBar(at).bar - r.start : -1;
    if (r && off > 0 && off < r.len - 1) {
      for (let k = r.times - 1; k >= 0; k--) removeBarAt(r.start + k * r.len + off);
      sendSong();
      edit.bar = Math.min(r.start + off, r.start + r.len - 2); edit.beat = 0; render();
      return;
    }
    // A repeat that loses a sign also loses its written-out copies; the other sign stays, grey.
    const pair = markedRepeats().find((r) => r.start === at || r.start + r.len - 1 === at);
    if (pair && pair.times >= 2) {
      dropCopies(pair);
      if (pair.start === at) ends[pair.start + pair.len - 1] = true;
      if (pair.start + pair.len - 1 === at) starts[pair.start] = true;
    }
    removeBarAt(at);
    // The sign left behind may now pair with a grey sign: that new repeat needs its copy on the keyboard.
    const lostStart = !!pair && pair.start === at, kept = pair && (lostStart ? pair.start + pair.len - 2 : pair.start);
    const formed = pair && pair.len > 1 && markedRepeats().find((x) => (lostStart ? x.start + x.len - 1 === kept : x.start === kept));
    if (formed) writeOutNewRepeat(formed);
    if (!formed) sendSong();
    edit.bar = Math.min(at, song.bars - 1); edit.beat = 0; render();
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
    playFrom = 0;
    song.chords = [{ bar: 0, beat: 0, root: 3, acc: 0x40, type: 1, bass: 0, bassAcc: 0x40 }];   // bars 2-4 hold the C
    song.introChord = null; song.endingChord = null;
    starts = {}; ends = {};
    savedId = null;                                   // Save mustn't overwrite the saved song with the blank chart
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
    if (playFrom) { const k = order.findIndex((old) => old >= playFrom); playFrom = k < 0 ? 0 : k; }
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
    if (song.bars + r.len > MAX_BARS) { tooLong(r.len); return; }
    const after = r.start + r.len;
    const move = (x) => { if (x.bar >= after) x.bar += r.len; };
    song.chords.forEach(move); song.variations.forEach(move);
    if (playFrom >= after) playFrom += r.len;
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

  // The left column shows one of: the TONES / SONGS tabs, the MIDI settings (gear), or the chord editor while a beat
  // is selected on the Chords tab. The settings win over the editor; closing them brings the editor back.
  let editorWanted = false, gearOpen = false;
  function layoutSide() {
    const showEd = editorWanted && !$('tab-chords').hidden && !gearOpen, other = showEd || gearOpen;
    const tab = $('side-tabs').querySelector('.on').dataset.pane;
    $('chord-editor').hidden = !showEd;
    $('pane-settings').hidden = !gearOpen;
    $('side-tabs').hidden = other;
    $('pane-tones').hidden = other || tab !== 'tones';
    $('pane-songs').hidden = other || tab !== 'songs';
    $('side-gear').classList.toggle('on', gearOpen); $('side-gear').setAttribute('aria-pressed', String(gearOpen));
  }

  function renderEditor() {
    const panel = $('chord-editor'), sec = edit.section;
    if (sec && !song.settings[sec]) { edit.section = null; edit.open = false; }   // that section was just turned off
    editorWanted = edit.open && song.loaded && (!!edit.section || edit.bar < song.bars);
    layoutSide();
    if (!editorWanted) return;
    panel.classList.toggle('section', !!sec);                     // only the chord rows apply to the intro and ending
    const c = editedChord(), eff = c || (sec ? null : chordInEffect(edit.bar, edit.beat));
    $('ed-pos').textContent = sec ? (sec === 'intro' ? 'Intro' : 'Ending') : `${passLabel(styleBar())}:${edit.beat + 1}`;
    const bassPc = c ? (c.bass ? soundingPc(c.bass, c.bassAcc) : -1) : null;
    const btn = (attr, v, label, on) => `<button class="btn ed${on ? ' on' : ''}" type="button" data-${attr}="${v}">${esc(label)}</button>`;
    // A repeated bar is played once per pass: 1, 2, 3... The BAR row edits the pass picked here.
    const rep = sec ? null : activeRepeatAt(edit.bar);
    $('ed-pass-col').hidden = !rep;                  // beside the repeat signs; the BAR row edits the pass picked
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
    // The blank button first (as major is on the TYPE row): no chord on this beat, the previous one continues
    // (in the intro or ending: no chord).
    const holdTitle = sec ? 'No chord' : 'Hold: no chord change on this beat, the previous chord continues';
    $('ed-root').innerHTML = `<button class="btn ed hold${c ? '' : ' on'}" type="button" data-hold="1" title="${holdTitle}" aria-label="${holdTitle}"></button>` +
      'CDEFGAB'.split('').map((l) => btn('root', PC[l], l, !!c && l === letter)).join('') +
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
    $('ed-style').innerHTML = BAR_STYLES.map(([val, label]) => btn('style', val, label, (v ? v.value : 0) === val)).join('')
      .replace('data-style="0">', 'data-style="0" title="Default: no variation change" aria-label="Default">');
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
      else if (b.dataset.hold) { if (editedChord()) putChord(null); }
      else if (b.id === 'ed-prev') stepBeat(-1);
      else if (b.id === 'ed-next') stepBeat(1);
      else if (b.id === 'ed-prev-bar') stepBar(-1);
      else if (b.id === 'ed-next-bar') stepBar(1);
      else if (b.id === 'ed-close') { edit.open = false; render(); }
      else if (b.id === 'ed-rep-start' || b.id === 'ed-rep-end') toggleMarker(b.id === 'ed-rep-start' ? starts : ends);
      else if (b.id === 'ed-ins-before') insertBeside(edit.bar, false);
      else if (b.id === 'ed-ins-after') insertBeside(edit.bar, true);
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
    if (k === 'l') { e.preventDefault(); engage(); toggleLoop(); return; }
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


  // ------------------------------------------------------------ saved songs
  // Songs saved in this browser (localStorage), on the SONGS tab of the left column. A saved song keeps everything the
  // page shows, repeat signs included. Loading one sends it to the keyboard, replacing the song there, so the page
  // keeps showing what the keyboard has. That loses the keyboard's song unless it's saved, so then a load takes a
  // second tap within 3 s, like Clear chart. Delete takes a second tap too.
  const SONGS_KEY = 'gokeys-songs';
  let savedSongs = null;           // [{ id, saved (ms), data }], newest first; read from storage once
  let savedId = null;              // the saved song the page started from (loaded or last saved): Save overwrites it
  let armed = null, armTimer = 0;  // { kind: 'load' | 'del', id } waiting for its second tap
  function songs() {
    if (!savedSongs) {
      try { savedSongs = JSON.parse(localStorage.getItem(SONGS_KEY) || '[]') || []; } catch (e) { savedSongs = []; }
      if (!Array.isArray(savedSongs)) savedSongs = [];
    }
    return savedSongs;
  }
  function storeSongs() {
    try { localStorage.setItem(SONGS_KEY, JSON.stringify(songs())); return true; } catch (e) {
      setInfo('Couldn’t save: this browser’s storage is full or blocked.');
      return false;
    }
  }
  const snapshot = () => JSON.stringify({ name: song.name, bars: song.bars, chords: song.chords, variations: song.variations,
    settings: song.settings, introChord: song.introChord || null, endingChord: song.endingChord || null, starts, ends });
  const sameAsSaved = (e) => !!e && JSON.stringify(e.data) === snapshot();
  const songById = (id) => songs().find((e) => e.id === id) || null;
  function matchingSaved() { const snap = snapshot(), e = songs().find((x) => JSON.stringify(x.data) === snap); return e ? e.id : null; }
  const isSaved = () => song.loaded && sameAsSaved(songById(savedId));

  function saveSong(asNew) {
    if (!song.loaded) { setInfo('Press GET to read the chords from the keyboard first.'); return; }
    let e = asNew ? null : songById(savedId);
    if (!e) { e = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6) }; songs().unshift(e); }
    e.saved = Date.now(); e.data = JSON.parse(snapshot());
    savedSongs.sort((a, b) => b.saved - a.saved);
    savedId = e.id;
    if (storeSongs()) setInfo(`Saved “${song.name || DEFAULT_NAME}” on this device.`);
    render();
  }
  function disarm() { armed = null; clearTimeout(armTimer); armTimer = 0; renderSongs(); }
  function arm(kind, id) { armed = { kind, id }; clearTimeout(armTimer); armTimer = setTimeout(disarm, 3000); renderSongs(); }
  const isArmed = (kind, id) => !!armed && armed.kind === kind && armed.id === id;

  function loadSong(id) {
    const e = songById(id);
    if (!e) return;
    if (song.loaded && !isSaved() && !isArmed('load', id)) {
      arm('load', id);
      setInfo('The song on the keyboard isn’t saved: loading replaces it. Tap again to load.');
      return;
    }
    disarm();
    const d = JSON.parse(JSON.stringify(e.data));
    song.name = d.name || ''; song.bars = d.bars || 0; song.chords = d.chords || []; song.variations = d.variations || [];
    song.settings = Object.assign(defaults(), d.settings);
    song.introChord = d.introChord; song.endingChord = d.endingChord;
    song.loaded = true;
    playFrom = 0;
    starts = d.starts || {}; ends = d.ends || {};
    savedId = id;
    edit.open = false; edit.section = null; edit.pass = 0; edit.bar = 0; edit.beat = 0;
    render();
    if (sendSong()) setInfo(`Loaded “${song.name || DEFAULT_NAME}” and sent it to the keyboard.`);
  }
  function deleteSong(id) {
    if (!isArmed('del', id)) { arm('del', id); return; }
    savedSongs = songs().filter((e) => e.id !== id);
    if (savedId === id) savedId = null;
    disarm();
    storeSongs();
    render();
  }

  function renderSongs() {
    const cur = isSaved() ? savedId : null;
    $('song-save-new').disabled = !song.loaded;
    $('song-save-quick').disabled = !!cur;           // greyed out: nothing changed since it was saved
    $('song-save-quick').title = cur ? 'Saved on this device' : 'Save the song on this device';
    const day = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    $('song-list').innerHTML = songs().map((e) => {
      const d = e.data || {}, load = isArmed('load', e.id), del = isArmed('del', e.id);
      return `<div class="row song-row${e.id === cur ? ' cur' : ''}${load ? ' arm' : ''}" data-id="${esc(e.id)}" ` +
        `title="${esc(d.name || DEFAULT_NAME)}: ${d.bars || 0} bars, saved ${esc(day(e.saved))}">` +
        `<span class="name">${esc(d.name || DEFAULT_NAME)}</span>` +
        `<span class="song-meta">${load ? 'tap again' : `${d.bars || 0} bars`}</span>` +
        `<span class="song-del${del ? ' armed' : ''}" role="button" aria-label="Delete">${del ? 'Delete?' : '✕'}</span></div>`;
    }).join('') || '<div class="empty">No saved songs yet. GET the song from the keyboard, then tap the save icon next to its name.</div>';
  }

  function initSongs() {
    $('side-tabs').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      Array.prototype.forEach.call($('side-tabs').children, (x) => x.classList.toggle('on', x === b));
      layoutSide();
    });
    // The gear swaps the left column for the MIDI settings (port, channel), which are seldom changed.
    $('side-gear').onclick = () => { gearOpen = !gearOpen; layoutSide(); };
    $('settings-close').onclick = () => { gearOpen = false; layoutSide(); };
    // The ⋯ menu by the song name: Rename, Save as new, CSV, Transpose. Transpose keeps it open; the rest close it.
    const setMenu = (open) => { $('song-menu').hidden = !open; $('song-more').setAttribute('aria-expanded', String(open)); };
    $('song-more').onclick = () => setMenu($('song-menu').hidden);
    $('song-menu').addEventListener('click', (e) => { if (e.target.closest('button.menu-item')) setMenu(false); });
    document.addEventListener('click', (e) => { if (!$('song-menu').hidden && !e.target.closest('.menu-wrap')) setMenu(false); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setMenu(false); });
    $('song-save-new').onclick = () => saveSong(true);
    $('song-save-quick').onclick = () => saveSong(false);
    $('song-list').addEventListener('click', (e) => {
      const row = e.target.closest('.song-row');
      if (!row) return;
      if (e.target.closest('.song-del')) deleteSong(row.dataset.id); else loadSong(row.dataset.id);
    });
  }

  // ------------------------------------------------------------ exports
  function fileBase(name = song.name) {
    const n = (name || 'gokeys-chords').replace(/~$/, '').replace(/[^\w#-]+/g, '_').replace(/^_+|_+$/g, '');
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
  const csvText = () => csvFor(song);
  function csvFor(song) {   // the page's song, or a saved song's data (same fields)
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


  // Reading one back (Upload chords): the same format. A chord name is root + accidental + type suffix + optional
  // /bass, e.g. Bbm7/F. Throws an Error with a message for the user when the file isn't one of these.
  const SUFFIX = {};
  Object.keys(TYPES).forEach((t) => { SUFFIX[TYPES[t][0]] = +t; });
  const ACC_BYTE = { '': 0x40, '#': 0x41, b: 0x3F };
  function parseChord(text) {
    const m = /^([A-G])([#b]?)(.*?)(?:\/([A-G])([#b]?))?$/.exec(text);
    if (!m || SUFFIX[m[3]] == null) throw new Error(`Unknown chord “${text}”.`);
    return { root: LETTERS.indexOf(m[1]), acc: ACC_BYTE[m[2]], type: SUFFIX[m[3]],
      bass: m[4] ? LETTERS.indexOf(m[4]) : 0, bassAcc: m[4] ? ACC_BYTE[m[5]] : 0x40 };
  }
  function parseCsv(text) {
    const out = { name: '', bars: 0, chords: [], variations: [], settings: defaults(), introChord: null, endingChord: null };
    const VAR = { 'Variation,1': 1, 'Variation,2': 2, 'Variation,3': 3, 'Variation,4': 4, 'FillIn,Down': 5, 'FillIn,Up': 6 };
    let division = null, sawFormat = false;
    text.replace(/^﻿/, '').split(/\r?\n/).forEach((raw) => {
      const line = raw.trim();
      if (!line) return;
      const cells = line.split(','), key = cells[0].toUpperCase(), rest = cells.slice(1).join(',');
      if (key === 'FORMAT') sawFormat = true;
      else if (key === 'NAME') out.name = rest.replace(/[^\x20-\x7E]/g, '').trim().slice(0, 32);
      else if (key === 'INTRO_SW') out.settings.intro = /^on$/i.test(rest);
      else if (key === 'ENDING_SW') out.settings.ending = /^on$/i.test(rest);
      else if (key === 'LOOP') out.settings.loop = /^on$/i.test(rest);
      else if (key === 'TRANSPOSE') out.settings.transpose = Math.max(TRANSPOSE_MIN, Math.min(TRANSPOSE_MAX, parseInt(rest, 10) || 0));
      else if (key === 'DIVISION') {
        division = rest;
        if (/^Intro,/i.test(rest)) out.settings.introLong = /,Long$/i.test(rest);
        else if (/^Ending,/i.test(rest)) out.settings.endingLong = /,Long$/i.test(rest);
        else if (VAR[rest]) out.variations.push({ bar: out.bars, value: VAR[rest] });
      } else if (key === 'CHORD') {
        const bars = cells.slice(2);
        if (/^(Intro|Ending),/i.test(division || '')) {           // one cell: the section's chord (empty = none)
          const c = bars[0] && bars[0].trim() ? parseChord(bars[0].trim().split(/\s+/)[0]) : null;
          out[/^Intro/i.test(division) ? 'introChord' : 'endingChord'] = c;
          division = null;
          return;
        }
        bars.forEach((cell) => {
          cell.trim().split(/\s+/).forEach((tok, beat) => {
            if (!tok || tok === ':') return;
            if (beat >= BEATS) throw new Error(`Bar ${out.bars + 1} has more than ${BEATS} beats.`);
            out.chords.push(Object.assign({ bar: out.bars, beat }, parseChord(tok)));
          });
          out.bars++;
        });
        division = null;
      }
    });
    if (!sawFormat || !out.bars) throw new Error('This isn’t a GO:KEYS chord pattern file (FORMAT and CHORD lines are missing).');
    if (out.bars > MAX_BARS) throw new Error(`The file has ${out.bars} bars; the keyboard takes up to ${MAX_BARS}.`);
    if (out.settings.ending) out.settings.loop = false;
    return out;
  }
  // Upload chords: replaces the song on the page and on the keyboard, like loading a saved song.
  function uploadCsv(file) {
    const reader = new FileReader();
    reader.onload = () => {
      let d;
      try { d = parseCsv(String(reader.result)); } catch (e) { setInfo(`Couldn’t read ${file.name}: ${e.message}`); return; }
      Object.assign(song, { name: d.name, bars: d.bars, chords: d.chords, variations: d.variations, settings: d.settings,
        introChord: d.introChord, endingChord: d.endingChord, loaded: true });
      markersFromSong();
      savedId = matchingSaved();
      edit.open = false; edit.section = null; edit.pass = 0; edit.bar = 0; edit.beat = 0;
      render();
      if (sendSong()) setInfo(`Loaded ${file.name} and sent it to the keyboard.`);
    };
    reader.onerror = () => setInfo(`Couldn’t read ${file.name}.`);
    reader.readAsText(file);
  }

  // Download all saved songs: one CSV each, in a zip. Stored (uncompressed) entries, so no library is needed;
  // the files are small text anyway.
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function zip(files) {   // [{ name, data: Uint8Array, date: Date }] -> Uint8Array
    const enc = new TextEncoder(), parts = [], central = [];
    let offset = 0;
    files.forEach((f) => {
      const name = enc.encode(f.name), d = f.date;
      const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
      const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
      const crc = crc32(f.data), size = f.data.length;
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034B50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);   // UTF-8 names
      local.setUint16(10, time, true); local.setUint16(12, date, true); local.setUint32(14, crc, true);
      local.setUint32(18, size, true); local.setUint32(22, size, true); local.setUint16(26, name.length, true);
      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014B50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true); cen.setUint16(8, 0x0800, true);
      cen.setUint16(12, time, true); cen.setUint16(14, date, true); cen.setUint32(16, crc, true);
      cen.setUint32(20, size, true); cen.setUint32(24, size, true); cen.setUint16(28, name.length, true);
      cen.setUint32(42, offset, true);
      parts.push(new Uint8Array(local.buffer), name, f.data);
      central.push(new Uint8Array(cen.buffer), name);
      offset += 30 + name.length + size;
    });
    const cenSize = central.reduce((n, p) => n + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054B50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cenSize, true); end.setUint32(16, offset, true);
    const all = parts.concat(central, [new Uint8Array(end.buffer)]);
    const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
    let at = 0;
    all.forEach((p) => { out.set(p, at); at += p.length; });
    return out;
  }
  function downloadAll() {
    const list = songs().filter((e) => e && e.data);
    if (!list.length) { setInfo('No saved songs to download.'); return; }
    const enc = new TextEncoder(), used = {};
    const files = list.map((e) => {
      const base = fileBase(e.data.name);
      let name = `${base}.csv`;
      for (let n = 2; used[name.toLowerCase()]; n++) name = `${base}_${n}.csv`;   // two songs with the same name
      used[name.toLowerCase()] = true;
      return { name, data: enc.encode(csvFor(e.data)), date: new Date(e.saved || Date.now()) };
    });
    download('gokeys-songs.zip', 'application/zip', zip(files));
    setInfo(`Downloaded ${files.length} song${files.length === 1 ? '' : 's'} in gokeys-songs.zip.`);
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
    $('chord-editor').addEventListener('click', onControlUsed, true);
    $('chord-editor').addEventListener('change', onControlUsed, true);
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
    initSongs();
    watchUserScroll();
    $('chords-play').onclick = togglePlay;
    $('dl-txt').onclick = () => download(`${fileBase()}.csv`, 'text/csv', csvText());
    $('dl-all').onclick = downloadAll;
    $('ul-txt').onclick = () => { $('ul-file').value = ''; $('ul-file').click(); };
    $('ul-file').onchange = (e) => { const f = e.target.files && e.target.files[0]; if (f) uploadCsv(f); };
    $('tr-down').onclick = () => setSetting('transpose', Math.max(TRANSPOSE_MIN, song.settings.transpose - 1));
    $('tr-up').onclick = () => setSetting('transpose', Math.min(TRANSPOSE_MAX, song.settings.transpose + 1));
    $('set-loop').onclick = toggleLoop;
    // SHORT / LONG: tapping the one that's lit turns the section off. On/off is 03 24 / 26, the length 03 25 / 27.
    ['intro', 'ending'].forEach((sec) => {
      $(`seg-${sec}`).onclick = (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        const st = song.settings, c = {};
        c[sec] = !(st[sec] && length(st[`${sec}Long`]) === b.dataset.v);
        if (c[sec]) c[`${sec}Long`] = b.dataset.v === 'long';
        if (sec === 'ending') c.loop = !c.ending;   // SHORT or LONG turns LOOP off; no ending turns it back on
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
