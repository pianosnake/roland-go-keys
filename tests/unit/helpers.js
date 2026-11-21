// Shared helpers for the unit tests: small songs and a GoLink whose output is recorded.
const path = require('path');
const lib = (f) => require(path.join(__dirname, '../..', f));
const ChordNames = lib('chord-names.js'), GoSysEx = lib('go-sysex.js'), Song = lib('song.js'), GoPattern = lib('go-pattern.js');
const GoLink = lib('go-link.js'), GoPlayer = lib('go-player.js'), Selection = lib('selection.js');
const SavedSongs = lib('saved-songs.js'), SongFiles = lib('song-files.js');

// A chord from its name, e.g. C('Am7') or C('D/F#').
const C = (name) => ChordNames.parseChord(name);
// A chord entry at bar/beat.
const at = (bar, beat, name) => Object.assign({ bar, beat }, C(name));

// A song from rows of bars: each bar is a string of up to 4 beats, '.' = hold, e.g. song(['C . G .', 'F', '. . . Am']).
function song(bars, extra) {
  const chords = [];
  bars.forEach((bar, b) => bar.split(/\s+/).filter(Boolean).forEach((tok, beat) => { if (tok !== '.') chords.push(at(b, beat, tok)); }));
  return new Song().load(Object.assign({ name: 'Test', bars: bars.length, chords }, extra || {}));
}
// A song whose bars 0-3 are |: A B C D :| played twice (bars 0-7), then `after` more bars.
function repeatSong(after) {
  const pass = ['C', 'Am', 'F', 'G'];
  const tail = [];
  for (let k = 0; k < (after == null ? 4 : after); k++) tail.push(['D', 'E', 'Bb', 'Eb'][k % 4]);
  return song(pass.concat(pass, tail), { starts: { 0: true }, ends: { 3: true }, variations: [{ bar: 0, value: 1 }, { bar: 4, value: 2 }] });
}

// A GoLink that records what it sends (decoded addresses with .addr) and is in app mode already.
function recordingLink(on) {
  const link = new GoLink(on);
  link.sent = [];
  link.setOutput((m) => link.sent.push(m));
  link.connected = true;
  return link;
}
const addr = (m) => m.slice(7, 11).map((b) => b.toString(16).padStart(2, '0')).join(' ');
const hex = (m) => m.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');

// Run a list of SysEx messages through a fresh GoLink as a requested dump; returns the GoPattern.
function parseTransfer(messages) {
  let got = null;
  const link = new GoLink({ dump: (p) => { got = p; } });
  link.setOutput(() => {});
  link.requestDump(10);
  messages.forEach((m) => link.onSysEx(m));
  clearTimeout(link.dumpTimer);
  return got;
}

module.exports = { ChordNames, GoSysEx, Song, GoPattern, GoLink, GoPlayer, Selection, SavedSongs, SongFiles,
  C, at, song, repeatSong, recordingLink, addr, hex, parseTransfer };
