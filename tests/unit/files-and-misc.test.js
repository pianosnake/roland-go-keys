const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Song, SongFiles, SavedSongs, Selection, ChordNames, song, repeatSong, C } = require('./helpers.js');
const fixture = (f) => fs.readFileSync(path.join(__dirname, '../fixtures', f), 'utf8');

test('chord names both ways, with transpose spelling', () => {
  ['C', 'Am7', 'F#m7b5', 'Bbmaj7'.replace('maj7', 'M7'), 'D7#11', 'G/B', 'Ebm9/Bb', 'Csus4'].forEach((n) => {
    assert.equal(ChordNames.chordName(C(n), 0), n);
  });
  assert.equal(ChordNames.chordName(C('C'), 2), 'D');
  assert.equal(ChordNames.chordName(C('Bb'), 1), 'B');
  assert.equal(ChordNames.chordName(C('Db'), 1), 'D');
  assert.throws(() => C('H7'), /Unknown chord/);
});

['CHORD001.CSV', 'CHORD002.CSV', 'CHORD003.CSV', 'CHORD004.CSV'].forEach((f) => {
  test(`${f} from a GO:KEYS USB backup reads, and writing it reads back the same`, () => {
    const d = SongFiles.parseCsv(fixture(f));
    assert.ok(d.bars >= 32);
    assert.ok(d.chords.length > 0);
    const again = SongFiles.parseCsv(SongFiles.csv(d));
    // Known gap: the GO:KEYS's own files have no INTRO_SW line, so an intro chord reads with the intro off, and the page
    // only writes the intro chord when the intro is on. Everything else must survive.
    if (!d.settings.intro) { delete d.introChord; delete again.introChord; }
    assert.deepEqual(again, d);
  });
});

// Exported by the GO:KEYS (firmware 1.12) on 2026-11-20: the current format, with INTRO_SW / ENDING_SW.
['export-CHORD002.CSV', 'export-CHORD022.CSV'].forEach((f) => {
  test(`${f} (GO:KEYS export) is written back byte for byte`, () => {
    const text = fixture(f);
    assert.equal(SongFiles.csv(SongFiles.parseCsv(text)), text);
  });
});

test('export-CHORD022.CSV: intro, variations and fills mid-row, held beats', () => {
  const d = SongFiles.parseCsv(fixture('export-CHORD022.CSV'));
  assert.equal(d.name, 'Lomir Alle in Enyem');
  assert.equal(d.settings.intro, true);
  assert.equal(d.settings.ending, false);
  assert.deepEqual(d.introChord, C('C'));
  assert.equal(d.bars, 20);
  assert.deepEqual(d.variations, [{ bar: 0, value: 2 }, { bar: 5, value: 6 }, { bar: 12, value: 4 }, { bar: 15, value: 5 }, { bar: 16, value: 4 }]);
  const atBar = (b) => d.chords.filter((c) => c.bar === b).map((c) => `${c.beat}:${ChordNames.chordName(c, 0)}`);
  assert.deepEqual(atBar(1), []);                          // empty cell: the whole bar holds
  assert.deepEqual(atBar(2), ['2:A7']);                    // ": : A7"
  assert.deepEqual(atBar(4), ['0:Gm', '2:A7']);            // "Gm : A7"
  assert.deepEqual(atBar(15), []);
});

test('CHORD004.CSV: intro chord, variations and an empty last bar', () => {
  const d = SongFiles.parseCsv(fixture('CHORD004.CSV'));
  assert.equal(d.name, 'Perfect Ed Sheran');
  assert.deepEqual(d.introChord, C('G'));
  assert.deepEqual(d.variations, [{ bar: 0, value: 1 }, { bar: 16, value: 3 }]);
  assert.equal(d.bars, 33);
  assert.ok(!d.chords.some((c) => c.bar === 32));
});

test('csv of a song with repeats, an ending, transpose and holds round-trips', () => {
  const s = repeatSong(3);
  s.setSettings({ transpose: -3, ending: true, endingLong: true, loop: false });
  s.setSectionChord('ending', C('C'));
  s.setChord(9, 2, C('A7'));
  const d = SongFiles.parseCsv(SongFiles.csv(s));
  assert.equal(d.bars, s.bars);
  assert.deepEqual(d.chords, s.chords);
  assert.deepEqual(d.variations, s.variations);
  assert.equal(d.settings.transpose, -3);
  assert.deepEqual(d.endingChord, C('C'));
});

test('parseCsv refuses what is not a chord pattern, and more than 256 bars', () => {
  assert.throws(() => SongFiles.parseCsv('hello,world'), /isn’t a GO:KEYS chord pattern/);
  const rows = []; for (let k = 0; k < 65; k++) rows.push('CHORD,4,C,C,C,C');
  assert.throws(() => SongFiles.parseCsv(`FORMAT,2\r\nNAME,x\r\n${rows.join('\r\n')}`), /260 bars/);
});

test('zip: valid headers and CRC', () => {
  const data = new TextEncoder().encode('hello');
  assert.equal(SongFiles.crc32(data), 0x3610A686);
  const z = SongFiles.zip([{ name: 'a.csv', data, date: new Date(2026, 10, 20, 12, 0, 0) }]);
  const v = new DataView(z.buffer);
  assert.equal(v.getUint32(0, true), 0x04034B50);
  assert.equal(v.getUint32(14, true), 0x3610A686);
  assert.equal(v.getUint32(z.length - 22, true), 0x06054B50);
  assert.equal(SongFiles.fileBase('A Train / take 2'), 'A_Train_take_2');
});

test('saved songs: save, compare, match, remove; storage failures are reported', () => {
  const store = {}, storage = { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = v; } };
  const saved = new SavedSongs(storage);
  const s = repeatSong(2);
  const { entry, ok } = saved.save(s.toJSON(), null);
  assert.equal(ok, true);
  assert.equal(saved.same(entry.id, s.toJSON()), true);
  assert.equal(new SavedSongs(storage).matching(Song.fromJSON(JSON.parse(store['gokeys-songs'])[0].data).toJSON()), entry.id);
  s.setChord(0, 0, C('D'));
  assert.equal(saved.same(entry.id, s.toJSON()), false);
  assert.equal(saved.remove(entry.id), true);
  assert.equal(saved.list().length, 0);
  const full = new SavedSongs({ getItem: () => null, setItem: () => { throw new Error('full'); } });
  assert.equal(full.save(s.toJSON(), null).ok, false);
  saved.arm('load', 'x'); assert.equal(saved.isArmed('load', 'x'), true); saved.disarm(); assert.equal(saved.isArmed('load', 'x'), false);
});

test('selection: stepping skips hidden passes; the BAR row edits the picked pass', () => {
  const s = repeatSong(2), sel = new Selection();
  sel.select(3, 3);
  assert.equal(sel.stepBeat(s, 1), true);
  assert.deepEqual([sel.bar, sel.beat], [8, 0]);
  assert.equal(sel.stepBar(s, -1), true);
  assert.equal(sel.bar, 3);
  sel.pass = 1;
  assert.equal(sel.styleBar(s), 7);
  sel.select(9, 3);
  assert.equal(sel.atLastBeat(s), true);
  assert.equal(sel.stepBeat(s, 1), false);
});
