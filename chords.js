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
//   Style:    DT1 01 00 02 01 = 01 start / 00 stop. Needs "app connected" DT1 01 00 02 00 = 01.
//   App mode: while the Chords tab is shown the page stays connected like Chord Director: 02 00 = 01 on opening the
//             tab and every 20 s (it times out after ~60 s: bar messages stop and the keyboard shows "App disconnected").
//             Leaving the tab sends 02 00 = 00. While connected the keyboard ignores program changes, so a tone change
//             made on this tab is wrapped in disconnect / reconnect (see whileDisconnected).
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

  let send = null, status = () => {};
  const song = { name: '', bars: 0, chords: [], variations: [], settings: defaults(), loaded: false };
  function defaults() { return { transpose: 0, loop: true, intro: false, introLong: false, ending: false, endingLong: false }; }
  // song setting -> offset in the 01 00 03 block
  const SETTINGS = { transpose: 0x22, loop: 0x23, intro: 0x24, introLong: 0x25, ending: 0x26, endingLong: 0x27 };
  const TRANSPOSE_MIN = -6, TRANSPOSE_MAX = 5;   // Roland's usual transpose range; not checked on the GO:KEYS
  let incoming = null;          // dump being received
  let timeout = 0;
  const play = { playing: false, bar: null };

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
      setInfo('No answer from the keyboard. Check the PORT menu: with the H4MIDI WC the GO:KEYS is on Port 3.');
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
    if (!connected) connectApp();
    setTimeout(() => send && send(dt1([0x01, 0x00, 0x02, 0x01], [wasPlaying ? 0 : 1])), connected ? 50 : 0);
    play.playing = !play.playing;
    play.bar = play.playing ? firstBar() : null;
    markPlay(); markBar();
  }

  // App mode, kept up while the Chords tab is shown. The 20 s timer is backed up by the bar messages, because Chrome
  // slows timers down in background windows.
  let active = false, connected = false, aliveTimer = 0, lastAlive = 0;
  const appCmd = (v) => dt1([0x01, 0x00, 0x02, 0x00], [v]);
  function connectApp() {
    if (!send) return;
    send(appCmd(1)); connected = true; lastAlive = performance.now();
  }
  function setActive(on) {
    active = on;
    if (on) {
      connectApp();
      if (!aliveTimer) aliveTimer = setInterval(() => { if (active) connectApp(); }, 20000);
    } else {
      if (aliveTimer) { clearInterval(aliveTimer); aliveTimer = 0; }
      if (connected && send) send(appCmd(0));
      connected = false;
    }
  }
  function keepAlive() { if (active && performance.now() - lastAlive > 15000) connectApp(); }

  // Runs fn (a tone change) with app mode briefly off, so the keyboard accepts the program change.
  function whileDisconnected(fn) {
    if (!connected || !send) { fn(); return; }
    send(appCmd(0)); connected = false;
    setTimeout(() => { fn(); setTimeout(() => { if (active) connectApp(); }, 100); }, 30);
  }

  // Change song settings the way Chord Director does: begin edit, write, end edit. Writes need "app connected".
  function setSetting(key, value) { const c = {}; c[key] = value; setSettings(c); }
  function setSettings(changes) {
    if (!send) { setInfo('No MIDI output, or Chrome refused SysEx access.'); return; }
    if (!song.loaded) { setInfo('Read the chords from the keyboard first.'); return; }
    const keys = Object.keys(changes).filter((key) => song.settings[key] !== changes[key]);
    if (!keys.length) return;
    if (!connected) connectApp();
    const msgs = [dt1([0x01, 0x00, 0x02, 0x14], [0, 0, 0, 0])];           // begin edit
    keys.forEach((key) => {
      const v = changes[key];
      msgs.push(dt1([0x01, 0x00, 0x03, SETTINGS[key]], [key === 'transpose' ? 0x40 + v : (v ? 1 : 0)]));
    });
    msgs.push(dt1([0x01, 0x00, 0x02, 0x18], [0, 0, 0, 0]));                 // end edit
    msgs.forEach((m, k) => setTimeout(() => send && send(m), 50 + k * 30));
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
    $('set-loop').classList.toggle('on', loop); $('set-loop').textContent = loop ? 'ON' : 'OFF';
    $('set-loop').disabled = off || st.ending;                    // a song with an ending doesn't loop
    $('set-loop').title = st.ending ? 'Turn the ending off to loop the song' : '';
    ['intro', 'ending'].forEach((sec) => {
      const v = off ? null : !st[sec] ? 'off' : length(st[`${sec}Long`]);
      $(`seg-${sec}`).querySelectorAll('button').forEach((b) => { b.classList.toggle('on', b.dataset.v === v); });
    });
  }

  function sectionBox(key, label, long) {
    return `<div class="bar section" data-bar="${key}"><div class="bar-head"><span class="bar-num">${label}</span>` +
      `<span class="bar-var">${length(long)}</span></div><div class="beats"><span class="beat held">${label}</span></div></div>`;
  }

  function render() {
    renderSettings();
    $('chords-name').textContent = song.loaded ? (song.name || 'Untitled') : '';
    $('dl-txt').disabled = !song.loaded || !song.chords.length;
    if (!song.loaded) { $('bars').innerHTML = ''; return; }
    if (!song.chords.length) { $('bars').innerHTML = '<div class="fav-empty">The song on the keyboard has no chords.</div>'; return; }
    const st = song.settings;
    // Intro and ending get rows of their own, above and below the song's bars.
    const row = (html) => `<div class="bars-grid">${html}</div>`;
    $('bars').innerHTML = (st.intro ? row(sectionBox('intro', 'INTRO', st.introLong)) : '') + row(byBar().map((bar, b) => {
      const beats = [];
      for (let k = 0; k < BEATS; k++) {
        const c = bar.chords.find((x) => x.beat === k);
        beats.push(`<span class="beat${c ? '' : ' held'}">${c ? esc(c.name) : '·'}</span>`);
      }
      return `<div class="bar" data-bar="${b}"><div class="bar-head"><span class="bar-num">${b + 1}</span>` +
        `${bar.variation ? `<span class="bar-var">${esc(bar.variation)}</span>` : ''}</div>` +
        `<div class="beats">${beats.join('')}</div></div>`;
    }).join('')) + (st.ending ? row(sectionBox('ending', 'ENDING', st.endingLong)) : '');
    markBar();
  }

  function markBar() {
    $('bars').querySelectorAll('.bar.now').forEach((el) => el.classList.remove('now'));
    if (!play.playing || play.bar == null) return;
    const el = $('bars').querySelector(`.bar[data-bar="${play.bar}"]`);
    if (el) el.classList.add('now');
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
    lines.push('FORMAT,2', `NAME,${(song.name || 'Chords').replace(/,/g, ' ')}`, `INTRO_SW,${onOff(st.intro)}`,
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
    $('chords-read').onclick = request;
    $('chords-play').onclick = togglePlay;
    $('dl-txt').onclick = () => download(`${fileBase()}.csv`, 'text/csv', csvText());
    $('tr-down').onclick = () => setSetting('transpose', Math.max(TRANSPOSE_MIN, song.settings.transpose - 1));
    $('tr-up').onclick = () => setSetting('transpose', Math.min(TRANSPOSE_MAX, song.settings.transpose + 1));
    $('set-loop').onclick = () => setSetting('loop', !song.settings.loop);
    // OFF / SHORT / LONG: on/off is 03 24 / 26, the length 03 25 / 27.
    ['intro', 'ending'].forEach((sec) => {
      $(`seg-${sec}`).onclick = (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        const c = {};
        c[sec] = b.dataset.v !== 'off';
        if (b.dataset.v !== 'off') c[`${sec}Long`] = b.dataset.v === 'long';
        if (sec === 'ending' && c.ending) c.loop = false;          // a song with an ending doesn't loop
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
    setOutput(fn) { send = fn; connected = false; if (active) connectApp(); },
  };
}());
