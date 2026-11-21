// Chords tab: the page side of the GO:KEYS 3/5 chord pattern (the song Chord Director edits). Reads it, shows it bar by
// bar with its settings, follows the bar being played, edits it live, saves songs in the browser, and reads/writes the
// GO:KEYS's CSV files. This file is only the UI: it renders and turns clicks and keys into calls on
//   Song (song.js)               the song as edited          GoPattern (go-pattern.js)   what the GO:KEYS holds
//   GoLink (go-link.js)          MIDI to/from the GO:KEYS    GoPlayer (go-player.js)     play, stop, play from a bar
//   Selection (selection.js)     the editor cursor           SavedSongs (saved-songs.js) songs saved in the browser
//   SongFiles (song-files.js)    CSV and zip                 ChordNames / GoSysEx        names and the SysEx format
// Plain JS for iOS 15 WebKit (see app.js). Exposes window.GOKEYS_CHORDS for app.js.
(function () {
  'use strict';
  const { ChordNames, GoSysEx, Song, GoLink, GoPlayer, Selection, SavedSongs, SongFiles } = window.GoKeys;
  const { TYPES, LETTERS, PC, VARIATIONS } = ChordNames;
  const { BEATS, MAX_BARS, TRANSPOSE_MIN, TRANSPOSE_MAX } = Song;
  const DEFAULT_NAME = GoSysEx.DEFAULT_NAME;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const NO_OUTPUT = 'No MIDI output, or Chrome refused SysEx access.';

  let status = () => {};
  // What the page shows before anything is read or loaded: | FM9 | | Em9 | |. It's only on the page until something
  // is sent (GoPlayer.synced): the first edit, setting or Play sends it whole to the GO:KEYS.
  const STARTER = { name: DEFAULT_NAME, bars: 4, chords: [Object.assign({ bar: 0, beat: 0 }, ChordNames.parseChord('FM9')),
    Object.assign({ bar: 2, beat: 0 }, ChordNames.parseChord('Em9'))] };
  const song = new Song().load(STARTER);
  const STARTER_JSON = JSON.stringify(song.toJSON());
  const isStarter = () => JSON.stringify(song.toJSON()) === STARTER_JSON;
  const sel = new Selection();
  const link = new GoLink({
    playState: (playing, bar) => player.playState(playing, bar),
    bar: (bar) => player.barMessage(bar),
    dump: onDump,
    dumpTimeout: () => setInfo('No answer from the keyboard.'),
  });
  const player = new GoPlayer(song, link, () => { markBar(); markPlay(); });
  let storage = null;
  try { storage = window.localStorage; } catch (e) { storage = null; }
  const saved = new SavedSongs(storage || { getItem: () => null, setItem: () => { throw new Error('no storage'); } });
  saved.onArmChange = () => renderSongs();
  let savedId = null;              // the saved song the page started from (loaded or last saved): Save overwrites it

  const spell = (letter, acc) => ChordNames.spell(letter, acc, song.settings.transpose);
  const chordName = (c) => ChordNames.chordName(c, song.settings.transpose);

  // ------------------------------------------------------------ reading, sending
  function request() {
    if (!link.requestDump()) { setInfo('No MIDI output, or Chrome refused SysEx access (allow MIDI device control in the site settings, then reload).'); return; }
    setInfo('Reading the chords from the keyboard…');
  }
  function onDump(pattern) {
    song.loadFromGo(pattern);
    player.readFromGo();
    savedId = saved.matching(song.toJSON());
    render();
    setInfo('');
  }
  // The whole song to the GO:KEYS (as it should hold it now). With no MIDI output the page still updates; Send catches up.
  function sendSong() {
    if (player.sendSong()) return true;
    setInfo(NO_OUTPUT);
    return false;
  }
  // After an edit that moves bars: send the song, show the result, move the editor.
  function applyStructure(res) {
    if (res.error) setInfo(res.error);
    if (res.structure && sendSong() && res.info) setInfo(res.info);
    if (res.select != null) { if (res.open) sel.open = true; sel.bar = res.select; sel.beat = 0; }
    render();
  }

  // Play / Stop. With the editor open on a bar after the first, Play starts from that bar, on the first pass of a repeat
  // (sel.bar is always a first-pass bar; the pass picked in the editor stays set from bar to bar).
  function togglePlay() {
    if (!link.ready) { setInfo(NO_OUTPUT); return; }
    // App mode on first: without it the GO:KEYS sends no play state or bar numbers, so the chart couldn't follow
    // (tested 2026-11-21, follow-test.js / follow-test2.js). Also covers the space bar, which isn't a click.
    link.engage();
    const from = !player.playing && song.loaded && sel.open && !sel.section ? sel.bar : 0;
    player.toggle(from);
    if (player.playing && from > 0) setInfo(`Playing from bar ${song.passLabel(from)}.`);
  }

  // Song settings, changed live like Chord Director. Turning LOOP on turns the ending (short or long) off.
  function toggleLoop() { const loop = !song.settings.loop; setSettings(loop ? { loop, ending: false } : { loop }); }
  function setSetting(key, value) { const c = {}; c[key] = value; setSettings(c); }
  function setSettings(changes) {
    if (!link.ready) { setInfo(NO_OUTPUT); return; }
    if (!song.loaded) { setInfo('Press GET to read the chords from the keyboard first.'); return; }
    const diff = {};
    Object.keys(changes).forEach((k) => { if (song.settings[k] !== changes[k]) diff[k] = changes[k]; });
    if (!Object.keys(diff).length) return;
    if (player.synced) link.settings(diff);
    song.setSettings(diff);
    if (!player.synced) sendSong();                  // the GO:KEYS doesn't have this song yet: send all of it
    render();
    setInfo(player.playing ? 'Sent. The keyboard applies it on the next bar.' : 'Sent.');
  }

  function markPlay() {
    const b = $('chords-play'), label = player.playing ? 'Stop the style' : 'Start the style';
    b.classList.toggle('on', player.playing);
    b.title = label; b.setAttribute('aria-label', label);
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
    const c = song[`${key}Chord`], on = sel.open && sel.section === key ? ' sel' : '';
    return `<div class="bar section" data-bar="${key}"><div class="bar-head"><span class="bar-num">${label}</span>` +
      `<span class="bar-var">${length(long)}</span></div><div class="beats one"><button class="beat${c ? '' : ' held'}${on}" type="button" ` +
      `data-section="${key}" aria-label="${label} chord">${c ? esc(chordName(c)) : '·'}</button></div></div>`;
  }

  // The grid is redrawn bar by bar: each piece's HTML is built (cheap), compared with what was drawn last time, and only
  // the pieces that changed are replaced, so selecting a beat or editing a chord touches one or two bars instead of
  // the whole grid. When the layout changes (bars added, removed, hidden or shown; intro or ending on or off) the grid
  // is rebuilt. markBar() runs after either and puts the playing-bar marks back.
  let drawn = null;                                 // { layout, html: { key: html } } of what's in #bars now
  function render() {
    renderSettings();
    renderSongs();
    $('chords-name-text').textContent = song.name || DEFAULT_NAME;
    $('chords-title').hidden = !song.loaded || !$('name-form').hidden;
    $('chords-info').hidden = song.loaded;            // a hint until there's a song; messages also go to the status line
    if (!song.loaded) $('name-form').hidden = true;
    $('dl-txt').disabled = !song.loaded || !song.chords.length;
    $('chords-send').disabled = !song.loaded || !song.bars;
    if (!song.loaded) { drawn = null; $('bars').innerHTML = ''; return; }
    if (!song.bars) { drawn = null; $('bars').innerHTML = '<div class="fav-empty">The song on the keyboard has no bars.</div>'; return; }
    drawGrid();
    markBar();
    renderEditor();
  }

  function drawGrid() {
    const st = song.settings, view = song.view();
    const marks = repeatMarks(view.repeats), styles = song.barStyles(), bars = byBar();
    // The pieces in order: [key, html]. Keys are what data-bar holds: 'intro', a bar index, 'ending'.
    const pieces = [];
    if (st.intro) pieces.push(['intro', sectionBox('intro', 'INTRO', st.introLong)]);
    bars.forEach((bar, b) => { if (!view.hidden[b]) pieces.push([String(b), barHtml(bar, b, view, marks, styles)]); });
    if (st.ending) pieces.push(['ending', sectionBox('ending', 'ENDING', st.endingLong)]);
    const layout = pieces.map((p) => p[0]).join(',');
    const html = {};
    pieces.forEach(([key, h]) => { html[key] = h; });
    if (drawn && drawn.layout === layout) {
      pieces.forEach(([key, h]) => {
        if (drawn.html[key] === h) return;
        const el = $('bars').querySelector(`.bar[data-bar="${key}"]`);
        if (el) el.outerHTML = h;
      });
    } else {
      // Intro and ending get rows of their own, above and below the song's bars.
      const row = (h) => `<div class="bars-grid">${h}</div>`;
      $('bars').innerHTML = (st.intro ? row(html.intro) : '') +
        row(pieces.filter((p) => p[0] !== 'intro' && p[0] !== 'ending').map((p) => p[1]).join('') +
          '<button class="bar add-bar" type="button" id="add-bar" title="Add a bar at the end">+ bar</button>') +
        (st.ending ? row(html.ending) : '');
    }
    drawn = { layout, html };
  }

  function barHtml(bar, b, view, marks, styles) {
    const beats = [];
    for (let k = 0; k < BEATS; k++) {
      const c = bar.chords.find((x) => x.beat === k);
      const on = sel.open && !sel.section && sel.bar === b && sel.beat === k ? ' sel' : '';
      beats.push(`<button class="beat${c ? '' : ' held'}${on}" type="button" data-bar="${b}" data-beat="${k}">${c ? esc(c.name) : '·'}</button>`);
    }
    const mk = marks[b] || {};
    const num = view.number[b];
    const r = song.activeRepeatAt(b) || view.repeats.find((x) => x.start === b) || null;   // includes a pair with no copy yet
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
      const on = sel.open && !sel.section && sel.bar === bar && sel.editPass(song) === k ? ' sel' : '';
      html += `<span class="pass-var${s && s.own ? ' own' : ''}${on}" data-pass="${k}"><b>${k + 1}</b> ${s ? esc(VARIATIONS[s.value] || `Var ${s.value}`) : '—'}</span>`;
    }
    return html ? `<div class="bar-passes">${html}</div>` : '';
  }

  // bar -> { start: '|:', end: ':| ×n' } for the signs.
  function repeatMarks(repeats) {
    const marks = {};
    const m = (b) => (marks[b] = marks[b] || {});
    Object.keys(song.starts).forEach((b) => { m(+b).start = true; });
    Object.keys(song.ends).forEach((b) => { m(+b).end = ''; });
    repeats.forEach((r) => { if (r.times > 2) m(r.start + r.len - 1).end = `×${r.times}`; });
    return marks;
  }

  function markBar() {
    $('bars').querySelectorAll('.bar.now').forEach((el) => el.classList.remove('now'));
    $('bars').querySelectorAll('.pass-var.play').forEach((el) => el.classList.remove('play'));
    if (!player.playing || player.bar == null) { followed = null; return; }
    $('bars').querySelectorAll('.rep-pass').forEach((el) => { el.textContent = ''; });
    const at = song.shownBar(player.bar);
    const el = $('bars').querySelector(`.bar[data-bar="${at.bar}"]`);
    if (el) el.classList.add('now');
    if (at.r) {
      const p = $('bars').querySelector(`.rep-pass[data-end="${at.r.start + at.r.len - 1}"]`);
      if (p) p.textContent = ` ${at.pass}/${at.r.times}`;
      const pv = el && el.querySelector(`.pass-var[data-pass="${at.pass - 1}"]`);
      if (pv) pv.classList.add('play');
    }
    if (el && player.bar !== followed) { followed = player.bar; follow(el); }
  }

  // Keep the bar being played on screen: when it gets near the bottom of the pane (or above the top), scroll so it
  // sits about a third of the way down. Paused for a few seconds after the user scrolls or touches the pane, so it
  // doesn't fight them.
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

  // ------------------------------------------------------------ editor
  // Tap a beat in the grid (touch or mouse), then pick the bar's variation or fill (first row), root / type / hold and
  // the bass note (a menu) in the panel. Every tap is sent to the GO:KEYS at once. The panel works in sounding pitch:
  // with a transpose the stored chord is shifted back before it's sent.
  const ROOTS = [[3, 0x40], [3, 0x41], [4, 0x40], [5, 0x3F], [5, 0x40], [6, 0x40], [6, 0x41], [7, 0x40], [1, 0x3F], [1, 0x40], [2, 0x3F], [2, 0x40]];
  const ROOT_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  const TYPE_ORDER = [0x01, 0x02, 0x03, 0x14, 0x13, 0x15, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0D, 0x0F,
    0x0E, 0x10, 0x0B, 0x0C, 0x19, 0x18, 0x17, 0x16, 0x11, 0x12, 0x1E, 0x1A, 0x1B, 0x1C, 0x1D, 0x1F];
  // The common types are buttons (major has no suffix, so its button is blank); the rest are in a menu.
  const TYPE_BUTTONS = [0x01, 0x02, 0x03, 0x13, 0x14, 0x05];
  const TYPE_MORE = TYPE_ORDER.filter((t) => TYPE_BUTTONS.indexOf(t) < 0);
  const BAR_STYLES = [[0, '0'], [1, '1'], [2, '2'], [3, '3'], [4, '4'], [6, 'Fill Up'], [5, 'Fill Down']];   // 0 = no change
  const editedChord = () => (sel.section ? song[`${sel.section}Chord`] : song.chordAt(sel.bar, sel.beat));
  const soundingPc = (letter, acc) => (ChordNames.notePc(letter, acc) + song.settings.transpose + 120) % 12;
  const storedNote = (pc) => ROOTS[(pc - song.settings.transpose + 120) % 12];

  // Set (or with c = null delete) the chord at the selected beat, on every pass of a repeat.
  function putChord(c) {
    if (sel.section) { putSectionChord(c); return; }
    if (!link.ready) { setInfo(NO_OUTPUT); return; }
    const bars = song.setChord(sel.bar, sel.beat, c);
    player.chordEdited(bars, sel.beat, c);
    render();
  }
  function putSectionChord(c) {
    if (!link.ready) { setInfo(NO_OUTPUT); return; }
    if (player.synced) link.sectionChord(sel.section, c);
    song.setSectionChord(sel.section, c);
    if (!player.synced) sendSong();
    render();
  }

  // Change one part of the chord at the selected beat. A new chord on an empty beat is a plain major chord, on the root
  // of the chord sounding there until a root is picked.
  function changeChord(part, value) {
    const held = sel.section ? null : song.chordInEffect(sel.bar, sel.beat);
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
    const bar = sel.styleBar(song);
    if (value >= 1 && value <= 4) {
      const prev = song.styleBefore(bar);
      if (prev && prev.value === value) {
        const had = song.variations.some((v) => v.bar === bar);
        if (had) setBarStyle(0);
        setInfo(`${VARIATIONS[value]} is already set from bar ${song.passLabel(prev.bar)}${had ? ': this bar’s entry was removed' : ', nothing sent'}.`);
        return;
      }
    }
    if (!link.ready) { setInfo(NO_OUTPUT); return; }
    song.setStyle(bar, value);
    player.styleEdited(bar, value);
    render();
  }

  // Clear chart: back to the GO:KEYS's initial pattern. It replaces the song on the GO:KEYS, so it takes a second tap
  // within 3 s (confirm() isn't reliable in the iPad plugin's web view).
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
    if (!link.ready) { setInfo(NO_OUTPUT); return; }
    song.clear(DEFAULT_NAME);
    player.reset();
    savedId = null;                                   // Save mustn't overwrite the saved song with the blank chart
    sel.home();
    sendSong();
    render();
    setInfo('Chart cleared.');
  }

  // Tapping a beat closes the MIDI settings if they're open, so the editor shows.
  function select(bar, beat) { gearOpen = false; sel.select(bar, beat); render(); }

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
    // The editor and the settings take over the whole column: no logo or gear (style.css, .side.takeover).
    document.querySelector('.side').classList.toggle('takeover', other);
  }

  function renderEditor() {
    const panel = $('chord-editor'), sec = sel.section;
    if (sec && !song.settings[sec]) { sel.section = null; sel.open = false; }   // that section was just turned off
    editorWanted = sel.open && song.loaded && (!!sel.section || sel.bar < song.bars);
    layoutSide();
    if (!editorWanted) return;
    panel.classList.toggle('section', !!sec);                     // only the chord rows apply to the intro and ending
    const c = editedChord(), eff = c || (sec ? null : song.chordInEffect(sel.bar, sel.beat));
    $('ed-pos').textContent = sec ? (sec === 'intro' ? 'Intro' : 'Ending') : `${song.passLabel(sel.styleBar(song))}:${sel.beat + 1}`;
    const bassPc = c ? (c.bass ? soundingPc(c.bass, c.bassAcc) : -1) : null;
    const btn = (attr, v, label, on) => `<button class="btn ed${on ? ' on' : ''}" type="button" data-${attr}="${v}">${esc(label)}</button>`;
    // A repeated bar is played once per pass: 1, 2, 3... The VARIATION row edits the pass picked here.
    const rep = sec ? null : song.activeRepeatAt(sel.bar);
    $('ed-pass-col').hidden = !rep;
    if (rep) {
      let passes = '';
      for (let k = 0; k < rep.times; k++) passes += btn('pass', k, String(k + 1), k === sel.editPass(song));
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
    // The hold button and the seven letters stay on one line (ed-root-row); sharp and flat go on the next.
    $('ed-root').innerHTML = `<span class="ed-root-row ed-pill-row"><button class="btn ed hold${c ? '' : ' on'}" type="button" data-hold="1" title="${holdTitle}" aria-label="${holdTitle}"></button>` +
      'CDEFGAB'.split('').map((l) => btn('root', PC[l], l, !!c && l === letter)).join('') + '</span>' +
      '<span class="ed-pill-row ed-acc-row">' + accBtn(1, '♯', 'Sharp', letter === 'E' || letter === 'B') + accBtn(-1, '♭', 'Flat', letter === 'C' || letter === 'F') + '</span>';
    const more = !!c && TYPE_MORE.indexOf(c.type) >= 0;
    $('ed-type').innerHTML = '<span class="ed-pill-row">' + TYPE_BUTTONS.map((t) => btn('type', t, TYPES[t][0], !!c && c.type === t)).join('')
        .replace('data-type="1">', 'data-type="1" title="Major" aria-label="Major">') + '</span>' +
      `<select id="ed-type-more" class="ed-select${more ? ' on' : ''}" aria-label="Other chord types"><option value="">more…</option>` +
      TYPE_MORE.map((t) => `<option value="${t}">${esc(TYPES[t][0])}</option>`).join('') + '</select>';
    $('ed-type-more').value = more ? String(c.type) : '';
    $('ed-bass').innerHTML = '<option value="-1">none</option>' + ROOT_NAMES.map((n, pc) => `<option value="${pc}">/${n}</option>`).join('');
    $('ed-bass').value = String(bassPc == null ? -1 : bassPc);
    const styled = sel.styleBar(song), v = song.variations.find((x) => x.bar === styled);
    $('ed-style').innerHTML = BAR_STYLES.map(([val, label]) => btn('style', val, label, (v ? v.value : 0) === val)).join('')
      .replace('data-style="0">', 'data-style="0" title="0: no variation change" aria-label="No variation change">');
    $('ed-rep-start').classList.toggle('on', !!song.starts[sel.bar]);
    $('ed-rep-end').classList.toggle('on', !!song.ends[sel.bar]);
    $('ed-del-bar').disabled = song.bars <= 1;
    $('ed-ins-before').disabled = $('ed-ins-after').disabled = song.bars >= MAX_BARS;
  }

  function initEditor() {
    $('bars').addEventListener('click', (e) => {
      if (e.target.closest('#add-bar')) { applyStructure(song.insertBar(song.bars)); return; }
      const b = e.target.closest('button.beat');
      if (b && b.dataset.section) { gearOpen = false; sel.selectSection(b.dataset.section); render(); }
      else if (b) select(+b.dataset.bar, +b.dataset.beat);
    });
    $('chord-editor').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || b.disabled) return;
      if (b.dataset.pass != null) { sel.pass = +b.dataset.pass; render(); }
      else if (b.dataset.root != null) changeChord('root', +b.dataset.root);
      else if (b.dataset.acc != null) changeChord('acc', +b.dataset.acc);
      else if (b.dataset.type != null) changeChord('type', +b.dataset.type);
      else if (b.dataset.style != null) setBarStyle(+b.dataset.style);
      else if (b.dataset.hold) { if (editedChord()) putChord(null); }
      else if (b.id === 'ed-close') { sel.open = false; render(); }
      else if (b.id === 'ed-del-bar') applyStructure(song.deleteBar(sel.bar));
      else if (b.id === 'ed-rep-start' || b.id === 'ed-rep-end') applyStructure(song.toggleSign(b.id === 'ed-rep-start' ? 'start' : 'end', sel.bar));
      else if (b.id === 'ed-ins-before') applyStructure(song.insertBeside(sel.bar, false));
      else if (b.id === 'ed-ins-after') applyStructure(song.insertBeside(sel.bar, true));
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
      if (sel.section) return;
      if (e.key === 'ArrowLeft') { if (sel.stepBeat(song, -1)) render(); }
      else if (sel.atLastBeat(song)) { if (!e.repeat) applyStructure(song.insertBar(song.bars)); }
      else if (sel.stepBeat(song, 1)) render();
      return;
    }
    if (e.repeat) return;
    const k = e.key.toLowerCase(), c = editedChord();
    if (e.key === 'Backspace' || e.key === 'Delete') {              // as HOLD (NONE for the intro / ending chord)
      e.preventDefault();
      if (c) { link.engage(); putChord(null); }
      return;
    }
    if ('[{]}'.indexOf(e.key) >= 0) {                              // as the |: and :| buttons
      e.preventDefault();
      if (!sel.section) { link.engage(); applyStructure(song.toggleSign(e.key === '[' || e.key === '{' ? 'start' : 'end', sel.bar)); }
      return;
    }
    if (k === 'l') { e.preventDefault(); link.engage(); toggleLoop(); return; }
    if ('1234'.indexOf(k) >= 0 && k.length === 1) {               // as the VARIATION row's 1-4
      e.preventDefault();
      if (!sel.section) { link.engage(); setBarStyle(+k); }
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
    link.engage();
    changeChord(part, value);
  }

  // ------------------------------------------------------------ saved songs
  // On the SONGS tab of the left column. A saved song keeps everything the page shows, repeat signs included. Loading
  // one sends it to the GO:KEYS, replacing the song there, so the page keeps showing what the GO:KEYS has. That loses
  // its song unless it's saved, so then a load takes a second tap within 3 s, like Clear chart. Deleting (⋯ menu,
  // Delete song) takes one too.
  const isSaved = () => song.loaded && saved.same(savedId, song.toJSON());

  function saveSong(asNew) {
    if (!song.loaded) { setInfo('Press GET to read the chords from the keyboard first.'); return; }
    const res = saved.save(song.toJSON(), asNew ? null : savedId);
    savedId = res.entry.id;
    setInfo(res.ok ? `Saved “${song.name || DEFAULT_NAME}” on this device.` : 'Couldn’t save: this browser’s storage is full or blocked.');
    render();
  }
  function loadSong(id) {
    const e = saved.get(id);
    if (!e) return;
    if (song.loaded && !isSaved() && !isStarter() && !saved.isArmed('load', id)) {
      saved.arm('load', id);
      setInfo('The song on the keyboard isn’t saved: loading replaces it. Tap again to load.');
      return;
    }
    saved.disarm();
    song.load(e.data);
    player.reset();
    savedId = id;
    sel.reset();
    render();
    if (sendSong()) setInfo(`Loaded “${song.name || DEFAULT_NAME}” and sent it to the keyboard.`);
  }
  function deleteSong(id) {
    if (!saved.isArmed('del', id)) { saved.arm('del', id); return; }
    if (savedId === id) savedId = null;
    saved.disarm();
    const name = (saved.get(id) || {}).data;
    if (!saved.remove(id)) setInfo('Couldn’t save: this browser’s storage is full or blocked.');
    else if (name) setInfo(`Deleted “${name.name || DEFAULT_NAME}” from this device.`);
    render();
  }

  function renderSongs() {
    const cur = isSaved() ? savedId : null;
    $('song-save-new').disabled = !song.loaded;
    // ⋯ menu: delete the saved song the page's song came from (a second tap within 3 s).
    const delArmed = !!savedId && saved.isArmed('del', savedId);
    $('song-delete').disabled = !savedId || !saved.get(savedId);
    $('song-delete').textContent = delArmed ? 'Tap again to delete' : 'Delete song';
    $('song-delete').classList.toggle('armed', delArmed);
    $('song-save-quick').disabled = !!cur;           // greyed out: nothing changed since it was saved
    $('song-save-quick').title = cur ? 'Saved on this device' : 'Save the song on this device';
    const day = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    $('song-list').innerHTML = saved.list().map((e) => {
      const d = e.data || {}, load = saved.isArmed('load', e.id);
      return `<div class="row song-row${e.id === cur ? ' cur' : ''}${load ? ' arm' : ''}" data-id="${esc(e.id)}" ` +
        `title="${esc(d.name || DEFAULT_NAME)}: ${d.bars || 0} bars, saved ${esc(day(e.saved))}">` +
        `<span class="name">${esc(d.name || DEFAULT_NAME)}</span>` +
        `<span class="song-meta">${load ? 'tap again' : `${d.bars || 0} bars`}</span></div>`;
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
    // An item closes the menu, except Delete on its first tap (it waits for the second).
    $('song-menu').addEventListener('click', (e) => {
      if (e.target.closest('#song-delete') && saved.isArmed('del', savedId)) return;
      if (e.target.closest('button.menu-item')) setMenu(false);
    });
    document.addEventListener('click', (e) => { if (!$('song-menu').hidden && !e.target.closest('.menu-wrap')) setMenu(false); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setMenu(false); });
    $('song-save-new').onclick = () => saveSong(true);
    $('song-delete').onclick = () => { if (savedId) deleteSong(savedId); };
    $('song-save-quick').onclick = () => saveSong(false);
    $('song-list').addEventListener('click', (e) => {
      const row = e.target.closest('.song-row');
      if (!row) return;
      loadSong(row.dataset.id);                      // deleting is in the ⋯ menu (Delete song)
    });
  }

  // ------------------------------------------------------------ files
  // Upload song: replaces the song on the page and on the GO:KEYS, like loading a saved song.
  function uploadCsv(file) {
    const reader = new FileReader();
    reader.onload = () => {
      let d;
      try { d = SongFiles.parseCsv(String(reader.result)); } catch (e) { setInfo(`Couldn’t read ${file.name}: ${e.message}`); return; }
      song.load(d);
      song.detectRepeats();
      player.reset();
      savedId = saved.matching(song.toJSON());
      sel.reset();
      render();
      if (sendSong()) setInfo(`Loaded ${file.name} and sent it to the keyboard.`);
    };
    reader.onerror = () => setInfo(`Couldn’t read ${file.name}.`);
    reader.readAsText(file);
  }
  // Download all songs: one CSV each, in a zip.
  function downloadAll() {
    const list = saved.list().filter((e) => e && e.data);
    if (!list.length) { setInfo('No saved songs to download.'); return; }
    const enc = new TextEncoder(), used = {};
    const files = list.map((e) => {
      const base = SongFiles.fileBase(e.data.name);
      let name = `${base}.csv`;
      for (let n = 2; used[name.toLowerCase()]; n++) name = `${base}_${n}.csv`;   // two songs with the same name
      used[name.toLowerCase()] = true;
      return { name, data: enc.encode(SongFiles.csv(e.data)), date: new Date(e.saved || Date.now()) };
    });
    download('gokeys-songs.zip', 'application/zip', SongFiles.zip(files));
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

  // ------------------------------------------------------------ setup
  // Runs before the control's own handler, so app mode is on by the time an edit is sent.
  function onControlUsed(e) {
    if (e.target.closest('button, select, input')) link.engage();
  }
  function setActive(on) {
    link.setActive(on);
    layoutSide();                                   // the chord editor only shows on the Chords tab
  }

  function init(opts) {
    status = opts.status || status;
    $('tab-chords').addEventListener('click', onControlUsed, true);
    $('tab-chords').addEventListener('change', onControlUsed, true);
    $('chord-editor').addEventListener('click', onControlUsed, true);
    $('chord-editor').addEventListener('change', onControlUsed, true);
    $('chords-read').onclick = request;
    $('chords-send').onclick = () => { if (song.loaded && song.bars && sendSong()) setInfo('Sent the song to the keyboard.'); };
    // Rename: the GO:KEYS stores 32 ASCII characters; sent with the whole song (Chord Director only sends the name
    // that way). Save sends it; Enter saves too, Escape cancels (desktop).
    const nameEl = $('chords-name');
    const closeRename = () => { $('name-form').hidden = true; nameEl.blur(); render(); };
    const saveRename = () => {
      const v = nameEl.value.normalize('NFD').replace(/[̀-ͯ]/g, '')   // é -> e
        .replace(/[^\x20-\x7E]/g, '').replace(/\s+$/, '').slice(0, 32);
      if (song.loaded && v !== song.name) {
        const old = song.name;
        song.setName(v);
        if (sendSong()) setInfo('Renamed.'); else song.setName(old);
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
    $('dl-txt').onclick = () => download(`${SongFiles.fileBase(song.name)}.csv`, 'text/csv', SongFiles.csv(song));
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
    onSysEx: (d) => link.onSysEx(d),
    setActive,
    setOutput: (fn) => { link.setOutput(fn); player.outputChanged(); },
  };
}());
