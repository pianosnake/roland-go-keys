const test = require('node:test');
const assert = require('node:assert/strict');
const { GoPattern, GoSysEx, song, repeatSong, C, addr } = require('./helpers.js');

const pos = (p) => p.chords.map((c) => `${c.bar}.${c.beat}:${c.root}`);

test('of(song) is the song as it is', () => {
  const s = repeatSong(4), p = GoPattern.of(s);
  assert.equal(p.bars, s.bars);
  assert.equal(p.start, 0);
  assert.deepEqual(p.chords.map((c) => [c.bar, c.beat, c.root]), s.chords.map((c) => [c.bar, c.beat, c.root]));
  for (let b = 0; b < s.bars; b++) { assert.equal(p.goBar(b), b); assert.equal(p.songBar(b), b); }
});

test('from(song, n): the bars from n to the end, with the carried chord and variation, no intro', () => {
  const s = song(['C', 'Am', '.', 'F', 'G'], { variations: [{ bar: 0, value: 3 }], settings: { intro: true } });
  const p = GoPattern.from(s, 2, false);
  assert.equal(p.bars, 3);
  assert.equal(p.settings.intro, false);
  assert.equal(s.settings.intro, true);                    // the song keeps it
  assert.deepEqual(pos(p), [`0.0:${C('Am').root}`, `1.0:${C('F').root}`, `2.0:${C('G').root}`]);
  assert.deepEqual(p.variations, [{ bar: 0, value: 3 }]);
  assert.equal(p.goBar(1), -1);
  assert.equal(p.chordEntry(1, 0, C('D')), null);
  assert.equal(p.songBar(0), 2);
});

test('from(song, n, rotate): every bar, rotated, mapped both ways', () => {
  const s = repeatSong(4), n = s.bars, p = GoPattern.from(s, 5, true);
  assert.equal(p.bars, n);
  for (let b = 0; b < n; b++) {
    assert.equal(p.songBar(p.goBar(b)), b);
    assert.ok(p.goBar(b) >= 0 && p.goBar(b) < n);
  }
  assert.equal(p.goBar(5), 0);
  assert.equal(p.goBar(0), n - 5);
  // Bar 5 has its own chord, so nothing is added; every song chord is there once.
  assert.equal(p.chords.length, s.chords.length);
  // Bar 1 comes round with nothing added at it.
  assert.ok(!p.chords.some((c) => c.bar === p.goBar(0) && c.beat === 0 && c.root !== s.chordAt(0, 0).root));
});

test('the chord held into the start bar goes on its first beat', () => {
  const s = song(['C . . G', '.', 'F']);
  const p = GoPattern.from(s, 1, true);
  assert.equal(p.chords[0].bar, 0);
  assert.equal(p.chords[0].root, C('G').root);
  assert.equal(p.chords.length, s.chords.length + 1);
});

test('chordEntry / styleEntry bytes', () => {
  const s = song(['C', 'D', 'E', 'F']), p = GoPattern.from(s, 2, false);
  assert.deepEqual(p.chordEntry(3, 1, C('Am7')), [0, 1, 1].concat(GoSysEx.chordBytes(C('Am7'))));
  assert.deepEqual(p.chordEntry(3, 1, null), [0, 1, 1, 0x00, 0x40, 0x00, 0x01, 0x00, 0x40]);
  assert.deepEqual(p.styleEntry(2, 4), [0, 0, 4]);
  assert.deepEqual(GoPattern.of(s).chordEntry(200, 0, null).slice(0, 2), [1, 72]);   // 200 = 1 * 128 + 72
});

test('firstBeatEntries follow edits made before the start', () => {
  const s = song(['C', '.', 'F'], { variations: [{ bar: 0, value: 2 }] });
  const p = GoPattern.from(s, 1, false);
  assert.deepEqual(p.firstBeatEntries(s), [
    { lo: GoSysEx.CHORDS, entry: [0, 0, 0].concat(GoSysEx.chordBytes(C('C'))) }, { lo: GoSysEx.VARIATIONS, entry: [0, 0, 2] }]);
  s.setChord(0, 0, C('Dm'));
  assert.equal(p.firstBeatEntries(s)[0].entry[3], C('Dm').root);
  assert.deepEqual(GoPattern.of(s).firstBeatEntries(s), []);
});

test('toSysEx: begin, chord packets of 13, settings in order, bars, end', () => {
  const bars = []; for (let k = 0; k < 15; k++) bars.push('C');
  const s = song(bars, { variations: [{ bar: 0, value: 1 }], settings: { transpose: -2, loop: false, ending: true } });
  const msgs = GoPattern.of(s).toSysEx();
  assert.deepEqual(msgs.map(addr), ['01 00 02 08', '01 00 03 40', '01 00 03 40', '01 00 03 41', '01 00 03 00', '01 00 03 22',
    '01 00 03 24', '01 00 03 42', '01 00 03 25', '01 00 03 26', '01 00 03 43', '01 00 03 27', '01 00 03 23', '01 00 03 20', '01 00 02 0c']);
  assert.deepEqual(msgs[1].slice(11, 13), [0, 13]);
  assert.deepEqual(msgs[2].slice(11, 13), [0, 2]);
  assert.equal(msgs[5][11], 0x40 - 2);                    // transpose
  assert.equal(msgs[9][11], 1);                           // ending on
  assert.equal(msgs[12][11], 0);                          // loop off
  assert.deepEqual(msgs[13].slice(11, 13), [0, 15]);      // bars
  msgs.forEach((m) => { const body = m.slice(7, m.length - 2); assert.equal(m[m.length - 2], GoSysEx.checksum(body)); });
});

test('toSysEx: no variation packet without variations; a blank name is sent as Initial Pattern', () => {
  const s = song(['C']); s.setName('');
  const msgs = GoPattern.of(s).toSysEx();
  assert.ok(!msgs.some((m) => addr(m) === '01 00 03 41'));
  const name = msgs.find((m) => addr(m) === '01 00 03 00').slice(11, 43).map((b) => String.fromCharCode(b)).join('').trim();
  assert.equal(name, 'Initial Pattern');
});
