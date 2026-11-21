const test = require('node:test');
const assert = require('node:assert/strict');
const { Song, song, repeatSong, at, C } = require('./helpers.js');

const roots = (s) => s.chords.map((c) => `${c.bar}.${c.beat}:${c.root}`);
const shown = (s) => { const h = s.view().hidden; const out = []; for (let b = 0; b < s.bars; b++) if (!h[b]) out.push(b); return out; };

test('chordAt and chordInEffect', () => {
  const s = song(['C . G .', '.', 'F']);
  assert.equal(s.chordAt(0, 2).root, C('G').root);
  assert.equal(s.chordAt(1, 0), null);
  assert.equal(s.chordInEffect(1, 3).root, C('G').root);   // held from bar 0 beat 2
  assert.equal(s.chordInEffect(2, 0).root, C('F').root);
  assert.equal(song(['.', 'C']).chordInEffect(0, 3), null);
});

test('barStyles: variations carry on, fills do not', () => {
  const s = song(['C', 'C', 'C', 'C', 'C'], { variations: [{ bar: 0, value: 2 }, { bar: 2, value: 5 }] });
  const st = s.barStyles();
  assert.deepEqual(st[0], { value: 2, own: true });
  assert.deepEqual(st[1], { value: 2, own: false });
  assert.deepEqual(st[2], { value: 5, own: true });
  assert.equal(st[3], null);                                // not known after a fill
  assert.equal(s.styleBefore(3).value, 5);
});

test('findRepeats on a written-out song', () => {
  const s = song(['C', 'Am', 'F', 'G', 'C', 'Am', 'F', 'G', 'D']);
  assert.deepEqual(s.findRepeats(), [{ start: 0, len: 4, times: 2 }]);
  s.detectRepeats();
  assert.deepEqual(s.starts, { 0: true });
  assert.deepEqual(s.ends, { 3: true });
});

test('a held chord equals a new entry of the same chord', () => {
  const s = song(['C', '.', 'F', 'G', 'C', 'C', 'F', 'G']);
  assert.deepEqual(s.findRepeats(), [{ start: 0, len: 4, times: 2 }]);
});

test('marked repeats, hidden passes, bar numbers and pass labels', () => {
  const s = repeatSong(4);
  assert.deepEqual(s.markedRepeats(), [{ start: 0, len: 4, times: 2 }]);
  assert.deepEqual(shown(s), [0, 1, 2, 3, 8, 9, 10, 11]);
  assert.equal(s.view().number[8], 5);
  assert.deepEqual(s.passesOf(1), [1, 5]);
  assert.deepEqual(s.shownBar(6), { bar: 2, pass: 2, r: s.activeRepeatAt(6) });
  assert.equal(s.passLabel(6), '3+4');
  assert.equal(s.lastShownBar(), 11);
});

test('a sign with no partner is not a repeat', () => {
  const s = song(['C', 'Am', 'F', 'G', 'C', 'Am', 'F', 'G'], { starts: { 0: true } });
  assert.deepEqual(s.markedRepeats(), []);
  assert.deepEqual(shown(s), [0, 1, 2, 3, 4, 5, 6, 7]);
});

test('setChord goes to every pass of a repeat', () => {
  const s = repeatSong(0);
  assert.deepEqual(s.setChord(1, 2, C('E7')), [1, 5]);
  assert.equal(s.chordAt(5, 2).type, C('E7').type);
  assert.deepEqual(s.markedRepeats(), [{ start: 0, len: 4, times: 2 }]);
});

test('insertBeside on the :| bar adds after the last pass; the repeat stays', () => {
  const s = repeatSong(2);
  const res = s.insertBeside(3, true);
  assert.equal(res.structure, true);
  assert.equal(res.select, 8);
  assert.equal(s.bars, 11);
  assert.deepEqual(s.markedRepeats(), [{ start: 0, len: 4, times: 2 }]);
  assert.deepEqual(shown(s), [0, 1, 2, 3, 8, 9, 10]);
});

test('insertBeside inside a repeat adds to every pass', () => {
  const s = repeatSong(2);
  const res = s.insertBeside(1, true);
  assert.equal(res.select, 2);
  assert.equal(s.bars, 12);
  assert.deepEqual(s.markedRepeats(), [{ start: 0, len: 5, times: 2 }]);
  assert.deepEqual(shown(s), [0, 1, 2, 3, 4, 10, 11]);
});

test('insertBeside on the |: bar adds before the repeat', () => {
  const s = repeatSong(2);
  s.insertBeside(0, false);
  assert.deepEqual(s.markedRepeats(), [{ start: 1, len: 4, times: 2 }]);
  assert.equal(s.chordAt(0, 0), null);
});

test('deleteBar inside a repeat removes it from every pass', () => {
  const s = repeatSong(2);
  const res = s.deleteBar(1);
  assert.equal(res.structure, true);
  assert.equal(s.bars, 8);
  assert.deepEqual(s.markedRepeats(), [{ start: 0, len: 3, times: 2 }]);
});

test('deleteBar on a sign bar takes the repeat apart; the other sign stays, grey', () => {
  const s = repeatSong(2);
  s.deleteBar(3);
  assert.equal(s.bars, 5);                                 // 4 bars of pass 1 minus one, plus 2
  assert.deepEqual(s.markedRepeats(), []);
  assert.deepEqual(s.starts, { 0: true });
});

test('deleteBar never removes the last bar', () => {
  const s = song(['C']);
  assert.deepEqual(s.deleteBar(0), {});
  assert.equal(s.bars, 1);
});

test('toggleSign: a new pair writes out its second pass', () => {
  const s = song(['C', 'Am', 'F', 'G', 'D']);
  assert.deepEqual(s.toggleSign('start', 0), {});
  const res = s.toggleSign('end', 3);
  assert.equal(res.structure, true);
  assert.equal(s.bars, 9);
  assert.equal(s.starts[0], 2);
  assert.deepEqual(s.markedRepeats(), [{ start: 0, len: 4, times: 2 }]);
  assert.equal(s.chordAt(8, 0).root, C('D').root);
});

test('writing out a pass carries the chord held into it', () => {
  const s = song(['C', '.', 'G', 'D']);                  // |: bar 1 (holds C) bar 2 (G) :|; the copy would hold G
  s.toggleSign('start', 1); s.toggleSign('end', 2);
  assert.equal(s.bars, 6);
  assert.equal(s.chordAt(3, 0).root, C('C').root);         // so its first beat gets C written
  assert.equal(s.chordAt(4, 0).root, C('G').root);
  assert.equal(s.chordAt(5, 0).root, C('D').root);
});

test('removing a sign drops the written-out passes', () => {
  const s = repeatSong(2);
  const res = s.toggleSign('end', 3);
  assert.equal(res.structure, true);
  assert.equal(s.bars, 6);
  assert.deepEqual(s.markedRepeats(), []);
});

test('the 256-measure limit refuses inserts and says why', () => {
  const bars = []; for (let k = 0; k < Song.MAX_BARS; k++) bars.push('C');
  const s = song(bars);
  const res = s.insertBar(10);
  assert.match(res.error, /at most 256 measures/);
  assert.equal(s.bars, 256);
  const r = repeatSong(0);
  for (let k = 0; k < Song.MAX_BARS - 9; k++) r.addBarAt(r.bars);
  assert.equal(r.bars, 255);
  assert.match(r.insertBeside(1, true).error, /no room for 2 more/);
});

test('pins move with inserted and deleted bars and with repeats', () => {
  const s = song(['C', 'D', 'E', 'F', 'G', 'A']);
  s.pin('start', 3);
  s.insertBar(1); assert.equal(s.pinned('start'), 4);
  s.insertBar(6); assert.equal(s.pinned('start'), 4);
  s.deleteBar(0); assert.equal(s.pinned('start'), 3);
  s.toggleSign('start', 0); s.toggleSign('end', 1);       // writes out 2 bars before the pin
  assert.equal(s.pinned('start'), 5);
  s.unpin('start'); assert.equal(s.pinned('start'), undefined);
});

test('toJSON / fromJSON round trip keeps the field order (saved songs compare as JSON text)', () => {
  const s = repeatSong(2);
  const json = JSON.stringify(s.toJSON());
  assert.equal(JSON.stringify(Song.fromJSON(JSON.parse(json)).toJSON()), json);
  assert.deepEqual(Object.keys(s.toJSON()), ['name', 'bars', 'chords', 'variations', 'settings', 'introChord', 'endingChord', 'starts', 'ends']);
});

test('loadFromGo sorts chords, trims the name, counts bars and finds repeats', () => {
  const s = new Song().loadFromGo({ name: 'Song   ', bars: 2, chords: [at(9, 0, 'G'), at(0, 0, 'C'), at(4, 0, 'C'),
    at(1, 0, 'Am'), at(5, 0, 'Am'), at(2, 0, 'F'), at(6, 0, 'F'), at(3, 0, 'G'), at(7, 0, 'G')], variations: [], settings: { loop: false } });
  assert.equal(s.name, 'Song');
  assert.equal(s.bars, 10);
  assert.equal(s.chords[0].bar, 0);
  assert.equal(s.settings.loop, false);
  assert.equal(s.settings.transpose, 0);
  assert.deepEqual(s.starts, { 0: true });
  assert.equal(s.loaded, true);
});

test('clear gives the initial pattern', () => {
  const s = repeatSong(2);
  s.pin('start', 3);
  s.clear('Initial Pattern');
  assert.equal(s.bars, 4);
  assert.deepEqual(roots(s), ['0.0:3']);
  assert.deepEqual(s.pins, {});
});
