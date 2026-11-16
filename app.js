// Roland GO:KEYS tone browser: tones on the left (bank select + program change), every CC on the right.
// Plain JS, no libraries or network: it must run unmodified in desktop Chrome and inside the MIDI Charmer AUv3
// (iPad, iOS 15 WebKit: no class fields, no .at(), no container queries).
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const STORE = 'gokeys-tones';

  // [category, number, name, msb, lsb, program 1-128]
  const TONES = (window.GOKEYS_TONES || []).map((t, i) => ({
    i, category: t[0], num: t[1], name: t[2], msb: t[3], lsb: t[4], pc: t[5],
    key: norm(`${t[1]} ${t[2]} ${t[0]}`),
  }));

  // Search text: lower case, no accents, no periods ("B. Organ" -> "b organ"), single spaces.
  function norm(s) {
    return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\./g, ' ').replace(/\s+/g, ' ').trim();
  }

  // The CCs the GO:KEYS receives (from ~/workspace/roland/cc.csv). def = value sent by "double-tap to reset".
  // fmt: 'center' shows -64..+63 (Roland sound controllers: 64 = the tone's own setting), 'pan' L/C/R, 'note' a note name.
  const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const SECTIONS = [
    { title: 'Performance', ccs: [
      { cc: 1, name: 'Modulation', def: 0 },
      { cc: 11, name: 'Expression', def: 127 },
      { cc: 66, name: 'Sostenuto', kind: 'toggle' },
    ] },
    { title: 'Mix', ccs: [
      { cc: 7, name: 'Volume', def: 100 },
      { cc: 10, name: 'Pan', def: 64, fmt: 'pan' },
      { cc: 91, name: 'Reverb Send', def: 40 },
      { cc: 93, name: 'Chorus Send', def: 0 },
    ] },
    { title: 'Filter & Envelope', ccs: [
      { cc: 74, name: 'Cutoff', def: 64, fmt: 'center' },
      { cc: 71, name: 'Resonance', def: 64, fmt: 'center' },
      { cc: 73, name: 'Attack', def: 64, fmt: 'center' },
      { cc: 75, name: 'Decay', def: 64, fmt: 'center' },
      { cc: 72, name: 'Release', def: 64, fmt: 'center' },
    ] },
    { title: 'Vibrato', ccs: [
      { cc: 76, name: 'Rate', def: 64, fmt: 'center' },
      { cc: 77, name: 'Depth', def: 64, fmt: 'center' },
      { cc: 78, name: 'Delay', def: 64, fmt: 'center' },
    ] },
    { title: 'Portamento', ccs: [
      { cc: 65, name: 'On / Off', kind: 'toggle' },
      { cc: 5, name: 'Time', def: 0 },
      { cc: 84, name: 'From Note', def: 60, fmt: 'note' },
    ] },
    // Channel mode messages (standard MIDI numbers), shown as a row of buttons.
    { title: 'Channel', buttons: true, ccs: [
      { cc: 120, name: 'All Sounds Off', kind: 'button' },
      { cc: 123, name: 'All Notes Off', kind: 'button' },
      { cc: 121, name: 'Reset All Controllers', kind: 'button' },
      { cc: 124, name: 'Omni Off', kind: 'button' },
      { cc: 125, name: 'Omni On', kind: 'button' },
      { cc: 126, name: 'Mono', kind: 'button' },
      { cc: 127, name: 'Poly', kind: 'button' },
    ] },
  ];
  const CCS = [].concat.apply([], SECTIONS.map((sec) => sec.ccs));
  const ccInfo = {};
  CCS.forEach((c) => { ccInfo[c.cc] = c; });
  // What Reset All Controllers (121) puts back, per the MIDI spec (RP-015); volume, pan and effects are kept.
  const RESET_BY_121 = { 1: 0, 11: 127, 65: 0, 66: 0 };

  const saved = load();
  const state = {
    channel: saved.channel || 4,
    port: saved.port || null,      // output port name picked by hand (null = automatic)   // firmware 1.11 only changes the UPPER tone from channel 4
    current: null,                 // tone index the keyboard is on (last sent or received)
    values: saved.values || {},    // cc -> last value sent or received
    bank: { msb: null, lsb: null },// last bank select received from the keyboard
    favOnly: !!saved.favOnly,      // the list shows only the favorites (star next to the search field)
    favorites: (saved.favorites || []).filter((num) => TONES.some((t) => t.num === num)), // tone numbers, in the order added
  };
  const midi = { access: null, input: null, output: null, sysex: false };

  function load() { try { return JSON.parse(localStorage.getItem(STORE) || '{}') || {}; } catch (e) { return {}; } }
  function save() {
    try {
      const tone = state.current == null ? null : TONES[state.current].num;
      localStorage.setItem(STORE, JSON.stringify({ channel: state.channel, port: state.port, tone, values: state.values, favorites: state.favorites, favOnly: state.favOnly }));
    } catch (e) { /* private mode */ }
  }

  function setStatus(t) { $('status-text').textContent = t; }
  function setConn(text, cls, title) { const el = $('conn-status'); el.textContent = text; el.className = `status ${cls}`; el.title = title || ''; }

  // ------------------------------------------------------------ tone list
  function renderList() {
    let html = '', cat = null;
    TONES.forEach((t) => {
      if (t.category !== cat) { cat = t.category; html += `<div class="cat" data-cat="${esc(cat)}">${esc(cat)}</div>`; }
      const fav = state.favorites.indexOf(t.num) >= 0 ? ' fav' : '';   // green number = favorite
      html += `<div class="row" data-i="${t.i}"><span class="num${fav}">${esc(t.num)}</span><span class="name">${esc(t.name)}</span></div>`;
    });
    $('list').innerHTML = html || '<div class="empty">No tones (tones.js is missing).</div>';
  }

  // Hides rows instead of re-rendering: 1228 rows, and the iPad Air 2 is slow.
  function filter() {
    const q = norm($('search').value);
    const words = q ? q.split(' ') : [];
    let shown = 0, catEl = null, catShown = 0;
    const flushCat = () => { if (catEl) catEl.hidden = catShown === 0; };
    for (const el of $('list').children) {
      if (el.classList.contains('cat')) { flushCat(); catEl = el; catShown = 0; continue; }
      const t = TONES[+el.dataset.i];
      const hit = words.every((w) => t.key.includes(w)) && (!state.favOnly || state.favorites.indexOf(t.num) >= 0);
      el.hidden = !hit;
      if (hit) { shown++; catShown++; }
    }
    flushCat();
    $('clear').hidden = !q;
    let none = $('list').querySelector('.none');
    if (!shown) {
      if (!none) { none = document.createElement('div'); none.className = 'empty none'; $('list').appendChild(none); }
      none.textContent = state.favOnly && !state.favorites.length ? 'No favorites yet. Tap the star next to a tone\u2019s name to add it.'
        : state.favOnly ? `No favorite matches “${$('search').value.trim()}”.` : `No tone matches “${$('search').value.trim()}”.`;
    } else if (none) none.remove();
  }

  function rowEl(i) { return $('list').querySelector(`.row[data-i="${i}"]`); }

  function scrollToRow(i, center) {
    const list = $('list'), el = rowEl(i);
    if (!el || el.hidden) return;
    const top = el.offsetTop - list.offsetTop;
    if (center) list.scrollTop = top - list.clientHeight / 2 + el.offsetHeight / 2;
    else if (top < list.scrollTop + 22) list.scrollTop = top - 22;  // keep the category heading visible
    else if (top + el.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + el.offsetHeight - list.clientHeight;
  }

  // ------------------------------------------------------------ favorites
  // The star next to the current tone's name adds it to / removes it from the favorites.
  const isFavorite = (i) => state.favorites.indexOf(TONES[i].num) >= 0;
  function toggleFavorite(i) {
    const num = TONES[i].num, k = state.favorites.indexOf(num);
    if (k >= 0) state.favorites.splice(k, 1); else state.favorites.push(num);
    const row = rowEl(i);
    if (row) row.querySelector('.num').classList.toggle('fav', k < 0);
    markStar(); save();
    if (state.favOnly) filter();
  }
  function markFavOnly() {
    const b = $('fav-only');
    b.classList.toggle('on', state.favOnly);
    b.setAttribute('aria-pressed', state.favOnly ? 'true' : 'false');
    b.title = state.favOnly ? 'Show all tones' : 'Show only the favorites';
  }
  function markStar() {
    const star = $('fav-star'), on = state.current != null && isFavorite(state.current);
    star.hidden = state.current == null;
    star.classList.toggle('on', on);
    star.setAttribute('aria-pressed', on ? 'true' : 'false');
    star.title = on ? 'Remove from favorites' : 'Add to favorites';
  }

  function markCurrent() {
    $('list').querySelectorAll('.row.cur').forEach((el) => el.classList.remove('cur'));
    markStar();
    const t = state.current == null ? null : TONES[state.current];
    if (t) { const el = rowEl(t.i); if (el) el.classList.add('cur'); }
    $('det-num').textContent = t ? t.num : '-----';
    $('det-name').textContent = t ? t.name : 'Pick a tone';
    $('det-note').textContent = t
      ? `${t.category} · bank ${t.msb}/${t.lsb} · program ${t.pc} · channel ${state.channel}`
      : 'Tap a tone on the left to send it to the keyboard.';
  }

  function selectTone(i) {
    const t = TONES[i];
    state.current = i;
    markCurrent(); scrollToRow(i); save();
    if (!midi.output) { setStatus('Not connected: the tone was not sent.'); return; }
    const ch = state.channel - 1, out = midi.output;
    const sendTone = () => {
      out.send([0xB0 | ch, 0, t.msb]);             // bank select MSB
      out.send([0xB0 | ch, 32, t.lsb]);            // bank select LSB
      out.send([0xC0 | ch, t.pc - 1]);             // program change (1-based in the list)
    };
    // On the Chords tab the keyboard is in app mode, which ignores program changes: chords.js steps out of it.
    if (CHORDS) CHORDS.whileDisconnected(sendTone); else sendTone();
    setStatus(`Sent ${t.num} ${t.name}.`);
  }

  // Up/down arrows step through the visible tones.
  function step(dir) {
    const rows = Array.prototype.filter.call($('list').querySelectorAll('.row'), (el) => !el.hidden);
    if (!rows.length) return;
    let k = rows.findIndex((el) => +el.dataset.i === state.current);
    k = k < 0 ? (dir > 0 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, k + dir));
    selectTone(+rows[k].dataset.i);
  }

  // ------------------------------------------------------------ CC grid
  function fmt(c, v) {
    if (c.fmt === 'center') return v === 64 ? '0' : (v > 64 ? `+${v - 64}` : String(v - 64));
    if (c.fmt === 'pan') return v === 64 ? 'C' : (v < 64 ? `L${64 - v}` : `R${v - 64}`);
    if (c.fmt === 'note') return `${NOTE[v % 12]}${Math.floor(v / 12) - 1}`;
    return String(v);
  }

  function card(c) {
    const head = `<div class="cc-head"><span class="cc-name">${esc(c.name)}</span><span class="cc-num">CC ${c.cc}</span></div>`;
    const unknown = state.values[c.cc] == null ? ' unknown' : '';
    if (c.kind === 'toggle') {
      const on = (state.values[c.cc] || 0) >= 64;
      return `<div class="card toggle${unknown}">${head}` +
        `<button class="btn onoff${on ? ' on' : ''}" type="button" data-cc="${c.cc}">${on ? 'ON' : 'OFF'}</button></div>`;
    }
    const v = unknown ? c.def : state.values[c.cc];
    return `<div class="card slider${unknown}">${head}` +
      `<div class="srow"><input type="range" min="0" max="127" value="${v}" data-cc="${c.cc}" style="--pct:${(v / 127) * 100}%">` +
      `<span class="sval" data-val="${c.cc}" title="Double-tap: send the default (${fmt(c, c.def)})">${fmt(c, v)}</span></div></div>`;
  }

  function renderGrid() {
    $('cc-grid').innerHTML = SECTIONS.map((sec) => {
      const body = sec.buttons
        ? sec.ccs.map((c) => `<button class="btn act" type="button" data-cc="${c.cc}">${esc(c.name)} <span class="btn-cc">${c.cc}</span></button>`).join('')
        : sec.ccs.map(card).join('');
      return `<section class="sect"><div class="sect-title">${esc(sec.title.toUpperCase())}</div>` +
        `<div class="sect-body${sec.buttons ? ' buttons' : ''}">${body}</div></section>`;
    }).join('');
  }

  // Updates one card in place (re-rendering would end a slider drag).
  function showValue(cc) {
    const c = ccInfo[cc], v = state.values[cc];
    if (!c || v == null) return;
    if (c.kind === 'toggle') {
      const b = $('cc-grid').querySelector(`.onoff[data-cc="${cc}"]`);
      b.classList.toggle('on', v >= 64); b.textContent = v >= 64 ? 'ON' : 'OFF';
      b.parentNode.classList.remove('unknown');
      return;
    }
    if (c.kind === 'button') return;
    const input = $('cc-grid').querySelector(`input[data-cc="${cc}"]`);
    if (+input.value !== v) input.value = v;
    input.style.setProperty('--pct', `${(v / 127) * 100}%`);
    $('cc-grid').querySelector(`[data-val="${cc}"]`).textContent = fmt(c, v);
    input.closest('.card').classList.remove('unknown');
  }

  // Slider drags send at most one message per CC every 15 ms (Bluetooth MIDI is slow). A timer, not
  // requestAnimationFrame: WebKit pauses rAF while the view is hidden (e.g. the plugin window is closed).
  const pendingCC = {};
  let frame = 0;
  function sendCC(cc, v) {
    state.values[cc] = v;
    showValue(cc);
    pendingCC[cc] = v;
    if (!frame) frame = setTimeout(flushCC, 15);
  }
  function flushCC() {
    frame = 0;
    for (const cc of Object.keys(pendingCC)) {
      if (midi.output) midi.output.send([0xB0 | (state.channel - 1), +cc, pendingCC[cc]]);
      delete pendingCC[cc];
    }
    if (!midi.output) setStatus('Not connected: nothing was sent.');
    save();
  }

  function sendButton(cc) {
    if (!midi.output) { setStatus('Not connected: nothing was sent.'); return; }
    midi.output.send([0xB0 | (state.channel - 1), cc, 0]);
    if (cc === 121) Object.keys(RESET_BY_121).forEach((k) => { state.values[k] = RESET_BY_121[k]; showValue(+k); });
    save();
    setStatus(`Sent ${ccInfo[cc].name}.`);
  }

  // ------------------------------------------------------------ MIDI
  // By name on a desktop; inside an AUv3 host the ports have the host's names, so fall back to the first one.
  const NAMES = /go:?\s?keys|roland|bluetooth/i;
  // The PORT menu overrides that (needed when the keyboard sits behind a MIDI interface with generic port names).
  // The input is the port with the same name as the output.
  const pick = (map, name) => {
    const list = Array.from(map.values());
    return (name && list.find((p) => p.name === name)) || list.find((p) => NAMES.test(p.name)) || list[0] || null;
  };

  function renderPorts() {
    const outs = Array.from(midi.access.outputs.values());
    $('port').innerHTML = outs.length
      ? outs.map((p) => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join('')
      : '<option value="">(none)</option>';
    $('port').value = midi.output ? midi.output.name : '';
  }

  const CHORDS = window.GOKEYS_CHORDS;

  function onMessage(ev) {
    const d = ev.data;
    if (d[0] === 0xF0) { if (CHORDS) CHORDS.onSysEx(d); return; }
    const type = d[0] & 0xF0, ch = (d[0] & 0x0F) + 1;
    if (ch !== state.channel) return;
    if (type === 0xB0 && d.length >= 3) {
      if (d[1] === 0) state.bank.msb = d[2];
      else if (d[1] === 32) state.bank.lsb = d[2];
      else if (ccInfo[d[1]] && ccInfo[d[1]].kind !== 'button') { state.values[d[1]] = d[2]; showValue(d[1]); save(); }
    } else if (type === 0xC0 && d.length >= 2) {
      const t = TONES.find((x) => x.pc === d[1] + 1 && (state.bank.msb == null || x.msb === state.bank.msb) &&
        (state.bank.lsb == null || x.lsb === state.bank.lsb));
      if (t) { state.current = t.i; markCurrent(); scrollToRow(t.i, true); save(); setStatus(`Keyboard: ${t.num} ${t.name}.`); }
    }
  }

  function connect() {
    const output = pick(midi.access.outputs, state.port);
    const input = pick(midi.access.inputs, output ? output.name : state.port);
    if (midi.input && midi.input !== input) midi.input.onmidimessage = null;
    midi.input = input; midi.output = output;
    if (input) input.onmidimessage = onMessage;
    renderPorts();
    if (CHORDS) CHORDS.setOutput(output && midi.sysex ? (bytes) => output.send(bytes) : null);
    if (output) {
      setConn(NAMES.test(output.name) ? 'GO:KEYS' : 'MIDI out', 'on', `Out: ${output.name}${input ? ` · In: ${input.name}` : ''}`);
      setStatus(input ? '' : 'No MIDI input: the page won\'t follow the keyboard.');
    } else {
      setConn('Not connected', 'off');
      setStatus('No MIDI output. Connect the GO:KEYS (Bluetooth: Audio MIDI Setup on a Mac).');
    }
  }

  async function initMIDI() {
    if (!navigator.requestMIDIAccess) { setConn('No Web MIDI', 'off'); setStatus('Use Chrome, or the MIDI Charmer plugin on iPad.'); return; }
    // SysEx is only needed by the Chords tab; without it the tone browser still works.
    try {
      midi.access = await navigator.requestMIDIAccess({ sysex: true });
      midi.sysex = true;
    } catch (e) {
      try {
        midi.access = await navigator.requestMIDIAccess();
      } catch (e2) {
        setConn('No access', 'warn'); setStatus(`MIDI access refused: ${e2.message || e2}`); return;
      }
    }
    midi.access.onstatechange = connect;
    connect();
  }

  // ------------------------------------------------------------ events
  function init() {
    $('channel').innerHTML = Array.from({ length: 16 }, (_, k) => `<option value="${k + 1}">${k + 1}</option>`).join('');
    $('channel').value = String(state.channel);
    $('channel').onchange = (e) => { state.channel = +e.target.value; markCurrent(); save(); };

    renderList();
    renderGrid();
    if (saved.tone) { const t = TONES.find((x) => x.num === saved.tone); if (t) state.current = t.i; }
    markCurrent();
    markFavOnly();
    filter();
    if (state.current != null) scrollToRow(state.current, true);

    $('list').onclick = (e) => { const row = e.target.closest('.row'); if (row) { selectTone(+row.dataset.i); $('list').focus(); } };
    $('fav-star').onclick = () => { if (state.current != null) toggleFavorite(state.current); };
    $('list').onkeydown = (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); step(e.key === 'ArrowDown' ? 1 : -1); }
    };
    $('search').oninput = () => { filter(); $('list').scrollTop = 0; };
    $('search').onkeydown = (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); step(e.key === 'ArrowDown' ? 1 : -1); }
      if (e.key === 'Escape') clearSearch();
    };
    $('clear').onclick = clearSearch;
    $('fav-only').onclick = () => {
      state.favOnly = !state.favOnly;
      markFavOnly(); filter(); save();
      if (state.current != null) scrollToRow(state.current, true); else $('list').scrollTop = 0;
    };

    const grid = $('cc-grid');
    grid.oninput = (e) => { if (e.target.type === 'range') sendCC(+e.target.dataset.cc, +e.target.value); };
    grid.onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const cc = +b.dataset.cc;
      if (b.classList.contains('onoff')) sendCC(cc, (state.values[cc] || 0) >= 64 ? 0 : 127);
      else sendButton(cc);
    };
    // Double-tap a value: send the default. (dblclick is unreliable on iOS, so time two taps.)
    let lastTap = { cc: null, at: 0 };
    grid.addEventListener('pointerup', (e) => {
      const el = e.target.closest('[data-val]');
      if (!el) return;
      const cc = +el.dataset.val, now = performance.now();
      if (lastTap.cc === cc && now - lastTap.at < 350) { sendCC(cc, ccInfo[cc].def); lastTap = { cc: null, at: 0 }; }
      else lastTap = { cc, at: now };
    });

    $('port').onchange = (e) => { state.port = e.target.value || null; save(); if (midi.access) connect(); };

    // Tabs: TONE (tone details + CCs) and CHORDS (chords.js).
    $('tabs').onclick = (e) => {
      const b = e.target.closest('.tab');
      if (!b) return;
      $('tabs').querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t === b));
      $('tab-tones').hidden = b.dataset.tab !== 'tones';
      $('tab-chords').hidden = b.dataset.tab !== 'chords';
      $('details').classList.toggle('on-tones', b.dataset.tab === 'tones');
      if (CHORDS) CHORDS.setActive(b.dataset.tab === 'chords');
    };
    if (CHORDS) CHORDS.init({ status: setStatus });

    initMIDI();
  }

  function clearSearch() {
    $('search').value = '';
    filter();
    if (state.current != null) scrollToRow(state.current, true); else $('list').scrollTop = 0;
  }

  init();
}());
