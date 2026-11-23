// Roland GO:KEYS tone browser: tones on the left (bank select + program change), every CC on the right.
// Plain JS, no libraries or network: it must run unmodified in desktop Chrome and inside the MIDI Charmer AUv3
// (iPad, iOS 15 WebKit: no class fields, no .at(), no container queries).
(function () {
  'use strict';
  // The favorite star in each tone row: an SVG, not the ★ character, which iPad's font draws much smaller.
  const STAR_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.3L12 17.1l-5.7 3.1 1.2-6.3-4.7-4.4 6.4-.8z"/></svg>';
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
    portId: saved.portId || null,  // the same port's id (names can repeat: "Bluetooth" on iOS)
    controlPort: saved.controlPort || null,   // input port of a controller (foot pedal), by name; null = none
    controlPortId: saved.controlPortId || null,
    playCC: saved.playCC == null ? null : saved.playCC,   // the CC on the control port that toggles play/stop; null = none
    current: null,                 // tone index the keyboard is on (last sent or received)
    values: saved.values || {},    // cc -> last value sent or received
    bank: { msb: null, lsb: null },// last bank select received from the keyboard
    favOnly: !!saved.favOnly,      // the list shows only the favorites (star next to the search field)
    favorites: (saved.favorites || []).filter((num) => TONES.some((t) => t.num === num)), // tone numbers, in the order added
  };
  const midi = { access: null, input: null, output: null, control: null, sysex: false, identified: false };

  function load() { try { return JSON.parse(localStorage.getItem(STORE) || '{}') || {}; } catch (e) { return {}; } }
  function save() {
    try {
      const tone = state.current == null ? null : TONES[state.current].num;
      localStorage.setItem(STORE, JSON.stringify({ channel: state.channel, port: state.port, portId: state.portId, controlPort: state.controlPort, controlPortId: state.controlPortId, playCC: state.playCC, tone, values: state.values, favorites: state.favorites, favOnly: state.favOnly }));
    } catch (e) { /* private mode */ }
  }

  function setStatus(t) { $('status-text').textContent = t; }
  function setConn(text, cls, title) { const el = $('conn-status'); el.textContent = text; el.className = `status ${cls}`; el.title = title || ''; }

  // ------------------------------------------------------------ tone list
  function renderList() {
    let html = '', cat = null;
    TONES.forEach((t) => {
      if (t.category !== cat) { cat = t.category; html += `<div class="cat" data-cat="${esc(cat)}">${esc(cat)}</div>`; }
      // The star is a text glyph, not an SVG button: 1228 rows, and the iPad Air 2 is slow. \uFE0E keeps iOS from drawing an emoji.
      const fav = state.favorites.indexOf(t.num) >= 0;
      html += `<div class="row" data-i="${t.i}"><span class="num">${esc(t.num)}</span><span class="name">${esc(t.name)}</span>` +
        `<span class="row-star${fav ? ' on' : ''}" role="button" aria-label="Favorite" aria-pressed="${fav}">${STAR_SVG}</span></div>`;
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
    const top = el.offsetTop;   // .list is position: relative, so this is already measured from the top of the list
    if (center) list.scrollTop = top - list.clientHeight / 2 + el.offsetHeight / 2;
    else if (top < list.scrollTop + 22) list.scrollTop = top - 22;  // keep the category heading visible
    else if (top + el.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + el.offsetHeight - list.clientHeight;
  }

  // ------------------------------------------------------------ favorites
  // The star on each row of the list adds that tone to / removes it from the favorites.
  const isFavorite = (i) => state.favorites.indexOf(TONES[i].num) >= 0;
  function toggleFavorite(i) {
    const num = TONES[i].num, k = state.favorites.indexOf(num);
    if (k >= 0) state.favorites.splice(k, 1); else state.favorites.push(num);
    const row = rowEl(i);
    if (row) {
      const star = row.querySelector('.row-star');
      star.classList.toggle('on', k < 0);
      star.setAttribute('aria-pressed', k < 0 ? 'true' : 'false');
    }
    save();
    if (state.favOnly) filter();
  }
  function markFavOnly() {
    const b = $('fav-only');
    b.classList.toggle('on', state.favOnly);
    b.setAttribute('aria-pressed', state.favOnly ? 'true' : 'false');
    b.title = state.favOnly ? 'Show all tones' : 'Show only the favorites';
  }

  function markCurrent() {
    $('list').querySelectorAll('.row.cur').forEach((el) => el.classList.remove('cur'));
    const t = state.current == null ? null : TONES[state.current];
    if (t) { const el = rowEl(t.i); if (el) el.classList.add('cur'); }
    $('cur-num').textContent = t ? t.num : '-----';
    $('cur-name').textContent = t ? t.name : 'No tone selected';
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
    sendTone();                                     // program changes work in app mode too (tested 2026-11-21, fw 1.12)
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
  const NAMES = /go:?\s?keys|roland|bluetooth/i, GO_NAMES = /go:?\s?keys|roland/i;
  // The GO:KEYS PORT menu overrides that (needed when the keyboard sits behind a MIDI interface with generic port names).
  // The ports of a MIDIInputMap / MIDIOutputMap. Walked with next() by hand: the iOS "Web MIDI Browser" app's maps give
  // an iterator that isn't iterable, so Array.from(map.values()) came back empty there and the port list said (none).
  function portsOf(map) {
    const out = [];
    if (!map) return out;
    const it = map.values();
    // Chrome keeps a port that went away in the map, as 'disconnected' (a Bluetooth port that came back as
    // "GO:KEYS 3 MIDI 1" left the old "MIDI 2" there, and the saved choice kept picking it): those are skipped.
    for (let o = it.next(); !o.done; o = it.next()) if (o.value.state !== 'disconnected') out.push(o.value);
    return out;
  }
  // Ports are kept apart by id: two can share a name (in the iOS Web MIDI Browser app every Bluetooth device's port is
  // just "Bluetooth"). A name shared by several ports is shown with a number, in port order ("Bluetooth 1", "Bluetooth 2").
  const byId = (list, id) => (id && list.find((p) => p.id === id)) || null;
  const byName = (list, name) => { const same = list.filter((p) => p.name === name); return same.length === 1 ? same[0] : null; };
  function labelOf(list, p) {
    const same = list.filter((q) => q.name === p.name);
    return same.length > 1 ? `${p.name} ${same.indexOf(p) + 1}` : p.name;
  }

  // Asks one output "who are you" (the MIDI identity request) and resolves with the input a Roland answers on, or null
  // after 600 ms. The inputs' handlers are borrowed meanwhile (other messages still reach them) and put back after.
  const IDENTITY_REQUEST = [0xF0, 0x7E, 0x7F, 0x06, 0x01, 0xF7];
  const isRolandIdentity = (d) => d.length > 5 && d[0] === 0xF0 && d[1] === 0x7E && d[3] === 0x06 && d[4] === 0x02 && d[5] === 0x41;
  function askIdentity(output) {
    return new Promise((resolve) => {
      const ins = portsOf(midi.access.inputs), kept = ins.map((p) => p.onmidimessage);
      let done = false;
      const finish = (inp) => {
        if (done) return;
        done = true;
        ins.forEach((p, k) => { p.onmidimessage = kept[k]; });
        resolve(inp);
      };
      ins.forEach((p, k) => {
        p.onmidimessage = (ev) => { if (isRolandIdentity(ev.data)) finish(p); else if (kept[k]) kept[k].call(p, ev); };
      });
      try { output.send(IDENTITY_REQUEST); } catch (e) { finish(null); return; }
      setTimeout(() => finish(null), 600);
    });
  }

  function renderPorts() {
    const outs = portsOf(midi.access.outputs), ins = portsOf(midi.access.inputs);
    const goTag = (p) => (midi.identified && (p === midi.output || p === midi.input) ? ' (GO:KEYS)' : '');
    $('port').innerHTML = outs.length
      ? outs.map((p) => `<option value="${esc(p.id)}">${esc(labelOf(outs, p))}${goTag(p)}</option>`).join('')
      : '<option value="">(none)</option>';
    $('port').value = midi.output ? midi.output.id : '';
    // The control port: any connected input, or none. A saved one that isn't connected now isn't listed (the menu shows
    // none), but it stays saved and is picked up again when it comes back (connectControl runs on every port change).
    $('control-port').innerHTML = '<option value="">none</option>' +
      ins.map((p) => `<option value="${esc(p.id)}">${esc(labelOf(ins, p))}${goTag(p)}</option>`).join('');
    $('control-port').value = midi.control ? midi.control.id : '';
  }

  // ------------------------------------------------------------ control port (a foot pedal)
  // A press of the play/stop CC (value above 0, any channel) starts or stops the style, as the Play button does.
  // Pedals send 127 on press and 0 on release; repeats within 250 ms are ignored.
  let lastControlAt = 0;
  // While the PLAY/STOP CC list is open (focused), a CC picks that CC instead ("learn"), and the port it came from
  // becomes the control port: every input is heard meanwhile, so the pedal's port needn't be found by name. The list
  // closes on it and that press doesn't start the style. Any port counts, the GO:KEYS's own too (when the GO:KEYS PORT
  // is set to the pedal by mistake, the press still shows which port the pedal is).
  function onControl(d, port) {
    if ((d[0] & 0xF0) !== 0xB0 || d.length < 3) return;
    const list = $('control-cc');
    if (document.activeElement === list) {
      state.playCC = d[1]; list.value = String(d[1]);
      state.controlPortId = port.id; state.controlPort = port.name;
      save(); connectControl(); renderPorts();
      list.blur();
      lastControlAt = performance.now();
      setStatus(`Play/stop: CC ${d[1]} from ${labelOf(portsOf(midi.access.inputs), port)}.`);
      return;
    }
    if (port !== midi.control || state.playCC == null || d[1] !== state.playCC || d[2] === 0) return;
    const now = performance.now();
    if (now - lastControlAt < 250) return;
    lastControlAt = now;
    if (CHORDS) CHORDS.togglePlay();
  }
  // Learning: a handler on every input that has none, taken off again when the list closes.
  let learning = [];
  function startLearn() {
    stopLearn();
    if (!midi.access) return;
    portsOf(midi.access.inputs).forEach((p) => {
      if (p === midi.input || p === midi.control) return;
      p.onmidimessage = (ev) => onControl(ev.data, p);
      learning.push(p);
    });
  }
  function stopLearn() {
    learning.forEach((p) => { if (p !== midi.input && p !== midi.control) p.onmidimessage = null; });
    learning = [];
  }
  // The control port's input: by id, else by name (when several share it, not the GO:KEYS's one). If it's the
  // GO:KEYS's own port, onMessage passes its messages on instead (an input has one onmidimessage).
  function connectControl() {
    const ins = portsOf(midi.access.inputs);
    let inp = null;
    if (state.controlPort) {
      inp = byId(ins, state.controlPortId);
      if (!inp) { const same = ins.filter((p) => p.name === state.controlPort); inp = same.find((p) => p !== midi.input) || same[0] || null; }
    }
    if (midi.control && midi.control !== inp && midi.control !== midi.input) midi.control.onmidimessage = null;
    midi.control = inp;
    if (inp && inp !== midi.input) inp.onmidimessage = (ev) => onControl(ev.data, inp);
  }

  const CHORDS = window.GOKEYS_CHORDS;

  function onMessage(ev) {
    const d = ev.data;
    onControl(d, midi.input);                       // the pedal on the GO:KEYS's own port, or learning
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

  // The GO:KEYS's output and input.
  //   Output: the one picked in GO:KEYS PORT (by id, or by name when the name is unique); else the one output named
  //   like the keyboard (NAMES), or the only one. When several could be it (all called "Bluetooth", or an AUv3 host's
  //   ports), each is asked who it is in turn, and the one a Roland answers wins; none answering: the first.
  //   Input: the one input with the output's name; else the one the GO:KEYS answers the identity request on; else the
  //   same-named input in the same position.
  let connectRun = 0;
  async function connect() {
    const run = ++connectRun;
    const outs = portsOf(midi.access.outputs), ins = portsOf(midi.access.inputs);
    let output = byId(outs, state.portId) || (state.port && byName(outs, state.port)) || null, input = null, identified = false;
    if (!output) {
      // Named for the keyboard first, then any Bluetooth port (a pedal is "Bluetooth" too), then all.
      const keys = outs.filter((p) => GO_NAMES.test(p.name)), named = outs.filter((p) => NAMES.test(p.name));
      const cands = keys.length ? keys : named.length ? named : outs;
      if (cands.length > 1 && midi.sysex) {
        setStatus('Looking for the GO:KEYS…');
        for (const o of cands) {
          const i = await askIdentity(o);
          if (run !== connectRun) return;
          if (i) { output = o; input = i; identified = true; break; }
        }
      }
      if (!output) output = cands[0] || null;
    }
    if (output && !input) {
      input = byName(ins, output.name);
      if (!input && midi.sysex) {
        input = await askIdentity(output);
        if (run !== connectRun) return;
        identified = !!input;
      }
      if (!input) {
        const sameIn = ins.filter((p) => p.name === output.name), sameOut = outs.filter((p) => p.name === output.name);
        input = sameIn[sameOut.indexOf(output)] || sameIn[0] || ins.find((p) => NAMES.test(p.name)) || ins[0] || null;
      }
    }
    if (midi.input && midi.input !== input) midi.input.onmidimessage = null;
    midi.input = input; midi.output = output; midi.identified = identified;
    if (input) input.onmidimessage = onMessage;
    connectControl();
    renderPorts();
    if (CHORDS) CHORDS.setOutput(output && midi.sysex ? (bytes) => output.send(bytes) : null);
    if (output) {
      setConn(identified || NAMES.test(output.name) ? 'GO:KEYS' : 'MIDI out', 'on',
        `Out: ${labelOf(outs, output)}${input ? ` · In: ${labelOf(ins, input)}` : ''}`);
      const asked = (outs.some((p) => GO_NAMES.test(p.name)) ? outs.filter((p) => GO_NAMES.test(p.name)) : outs.filter((p) => NAMES.test(p.name))).length > 1 || (!byName(ins, output.name) && ins.length > 1);
      setStatus(!input ? 'No MIDI input: the page won\'t follow the keyboard.'
        : asked && !identified ? `No port answered as a GO:KEYS; using ${labelOf(outs, output)}. If the keyboard doesn't respond, pick another GO:KEYS PORT.` : '');
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
    $('control-cc').innerHTML = '<option value="">none</option>' + Array.from({ length: 128 }, (_, k) => `<option value="${k}">CC ${k}</option>`).join('');
    $('control-cc').value = state.playCC == null ? '' : String(state.playCC);
    $('control-cc').onchange = (e) => { state.playCC = e.target.value === '' ? null : +e.target.value; save(); };
    $('control-port').onchange = (e) => {
      if (!midi.access) return;
      const p = byId(portsOf(midi.access.inputs), e.target.value);
      state.controlPortId = p ? p.id : null; state.controlPort = p ? p.name : null;
      save(); connectControl(); renderPorts();
    };
    $('control-cc').onfocus = startLearn;
    $('control-cc').onblur = stopLearn;

    renderList();
    renderGrid();
    if (saved.tone) { const t = TONES.find((x) => x.num === saved.tone); if (t) state.current = t.i; }
    markCurrent();
    markFavOnly();
    filter();
    if (state.current != null) scrollToRow(state.current, true);

    $('list').onclick = (e) => {
      const row = e.target.closest('.row');
      if (!row) return;
      if (e.target.closest('.row-star')) toggleFavorite(+row.dataset.i);   // the star doesn't change the tone
      else selectTone(+row.dataset.i);
      $('list').focus();
    };
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

    $('port').onchange = (e) => {
      if (!midi.access) return;
      const p = byId(portsOf(midi.access.outputs), e.target.value);
      state.portId = p ? p.id : null; state.port = p ? p.name : null;
      save(); connect();
    };

    // Tabs: TONE (tone details + CCs) and CHORDS (chords-tab.js).
    $('tabs').onclick = (e) => {
      const b = e.target.closest('.tab');
      if (!b) return;
      $('tabs').querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t === b));
      $('tab-tones').hidden = b.dataset.tab !== 'tones';
      $('tab-chords').hidden = b.dataset.tab !== 'chords';
      $('details').classList.toggle('on-tones', b.dataset.tab === 'tones');
      if (CHORDS) CHORDS.setActive(b.dataset.tab === 'chords');
    };
    if (CHORDS) { CHORDS.init({ status: setStatus }); CHORDS.setActive(true); }   // the page opens on the Chords tab (not in app mode yet)

    // No zooming on the iPad: Safari ignores user-scalable=no for pinches, so its gesture events are cancelled, and so is
    // any move with two fingers down (double-tap zoom is off through touch-action in style.css).
    ['gesturestart', 'gesturechange', 'gestureend'].forEach((t) => document.addEventListener(t, (e) => e.preventDefault(), { passive: false }));
    document.addEventListener('touchmove', (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });

    initMIDI();
  }

  function clearSearch() {
    $('search').value = '';
    filter();
    if (state.current != null) scrollToRow(state.current, true); else $('list').scrollTop = 0;
  }

  init();
}());
