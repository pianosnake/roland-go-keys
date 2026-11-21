const test = require('node:test');
const assert = require('node:assert/strict');
const { GoPlayer, GoSysEx, song, repeatSong, C, recordingLink, addr, parseTransfer } = require('./helpers.js');

// The last whole transfer the link sent, parsed back.
function lastPattern(link) {
  const a = link.sent.map(addr), end = a.lastIndexOf('01 00 02 0c'), begin = a.lastIndexOf('01 00 02 08', end);
  return parseTransfer(link.sent.slice(begin, end + 1));
}
// synced: the GO:KEYS already holds the song (as after GET or a load), so edits go out one by one.
function setup(s, unsynced) {
  const link = recordingLink(), player = new GoPlayer(s, link);
  player.synced = !unsynced;
  link.on = { playState: (p, b) => player.playState(p, b), bar: (b) => player.barMessage(b) };
  return { link, player };
}
const fromGo = (a3, data) => GoSysEx.dt1([0x01, 0x00, 0x01, a3], data);

test('Play from bar 1 is a plain start', () => {
  const { link, player } = setup(song(['C', 'G']));
  player.toggle(0);
  assert.deepEqual(link.sent.map(addr), ['01 00 02 01']);
  assert.equal(player.playing, true);
  assert.equal(player.bar, 0);
});

test('Play from a bar with LOOP off sends only the bars from there, then starts', () => {
  const s = song(['C', 'D', 'E', 'F', 'G'], { settings: { loop: false } });
  const { link, player } = setup(s);
  player.toggle(2); link.flush();
  const p = lastPattern(link);
  assert.equal(p.bars, 3);
  assert.equal(addr(link.sent[link.sent.length - 1]), '01 00 02 01');
  assert.equal(player.bar, 2);
  link.onSysEx(fromGo(0x02, [0, 1]));
  assert.equal(player.bar, 3);
});

test('Play from a bar with LOOP on sends the song rotated; bar numbers wrap back', () => {
  const s = song(['C', 'D', 'E', 'F', 'G']);
  const { link, player } = setup(s);
  player.toggle(3); link.flush();
  assert.equal(lastPattern(link).bars, 5);
  link.onSysEx(fromGo(0x02, [0, 2]));
  assert.equal(player.bar, 0);                            // the GO:KEYS's bar 2 is song bar 0 (3, 4, 0, 1, 2)
});

test('stopping puts the song back in order; a stop from the GO:KEYS does too, once', () => {
  const s = song(['C', 'D', 'E', 'F']);
  const { link, player } = setup(s);
  player.toggle(2); link.flush(); link.sent.length = 0;
  player.toggle(0); link.flush();
  assert.equal(addr(link.sent[0]), '01 00 02 01');
  assert.equal(lastPattern(link).bars, 4);
  assert.equal(s.pinned('start'), undefined);
  player.toggle(1); link.flush(); link.sent.length = 0;
  link.onSysEx(fromGo(0x01, [0])); link.flush();
  assert.equal(lastPattern(link).bars, 4);
  const n = link.sent.length;
  link.onSysEx(fromGo(0x01, [0])); link.flush();
  assert.equal(link.sent.length, n);
});

test('edits while playing from a bar go to the GO:KEYS bar, or nowhere when cut off', () => {
  const s = song(['C', 'D', 'E', 'F', 'G'], { settings: { loop: false } });
  const { link, player } = setup(s);
  player.toggle(2); link.flush(); link.sent.length = 0;
  player.chordEdited(s.setChord(4, 1, C('Am')), 1, C('Am')); link.flush();
  const entries = link.sent.filter((m) => addr(m) === '01 00 03 40').map((m) => m.slice(13, 16));
  assert.deepEqual(entries[0], [0, 2, 1]);                // song bar 4 = GO:KEYS bar 2, beat 1
  link.sent.length = 0;
  player.chordEdited(s.setChord(0, 0, C('Bb')), 0, C('Bb')); link.flush();
  const bars = link.sent.filter((m) => addr(m) === '01 00 03 40').map((m) => m.slice(13, 15));
  assert.deepEqual(bars, [[0, 0]]);                       // only the carried first beat, no edit for bar 0
});

test('bars inserted before the start bar move it; the song sent follows', () => {
  const s = repeatSong(4);
  const { link, player } = setup(s);
  player.toggle(9); link.flush();
  s.insertBeside(1, true); player.sendSong(); link.flush();   // inside the repeat: one bar per pass
  assert.equal(s.pinned('start'), 11);
  link.onSysEx(fromGo(0x02, [0, 1]));
  assert.equal(player.bar, 12);
});

test('before the GO:KEYS has the song, Play sends it first, then starts', () => {
  const { link, player } = setup(song(['C', 'G']), true);
  player.toggle(0); link.flush();
  const a = link.sent.map(addr);
  assert.equal(a[0], '01 00 02 08');
  assert.equal(a[a.length - 1], '01 00 02 01');
  assert.equal(player.synced, true);
});

test('before the GO:KEYS has the song, an edit sends the whole song; after that, single edits', () => {
  const s = song(['C', 'G']);
  const { link, player } = setup(s, true);
  player.chordEdited(s.setChord(1, 0, C('Am')), 0, C('Am')); link.flush();
  assert.equal(lastPattern(link).chords[1].root, C('Am').root);
  assert.ok(!link.sent.some((m) => addr(m) === '01 00 02 14'));
  link.sent.length = 0;
  player.styleEdited(1, 3); link.flush();
  assert.deepEqual(link.sent.map(addr), ['01 00 02 14', '01 00 03 41', '01 00 02 18']);
});

test('another output makes it unsynced again; GET makes it synced', () => {
  const { player } = setup(song(['C']));
  player.outputChanged();
  assert.equal(player.synced, false);
  player.readFromGo();
  assert.equal(player.synced, true);
});
