// Fixtures sniffed from Chord Director talking to the GO:KEYS (fixtures/chord-director.json, built by
// ../extract-fixtures.js): the only record of exactly what the GO:KEYS accepts.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { Song, GoPattern, GoSysEx, recordingLink, addr, hex, parseTransfer } = require('./helpers.js');
const fx = require(path.join(__dirname, '../fixtures/chord-director.json'));

test('fixtures are there', () => {
  assert.ok(fx.transfers.length >= 5);
  assert.ok(fx.dumps.length >= 3);
  assert.ok(fx.edits.length >= 20);
});

// One known difference: Chord Director writes the name as 33 bytes (32 characters and one more space, which lands on
// the bar count's first byte and is overwritten by 03 20 later), or as the whole 40-byte 03 00 block. The page sends
// the 32 name bytes, which the GO:KEYS takes (in use since 2026-11-15), so a Chord Director name message is cut to its
// first 32 bytes before comparing. Transfers that send the 40-byte block are skipped: they're a different path.
const S = GoSysEx;
const nameData = (m) => m.slice(11, m.length - 2);
const cutName = (m) => (addr(m) === '01 00 03 00' ? S.dt1(S.song(S.NAME), nameData(m).slice(0, 32)) : m);
fx.transfers.forEach((t) => {
  const block = t.messages.some((m) => addr(m) === '01 00 03 00' && nameData(m).length === 40);
  test(`Chord Director transfer ${t.file}:${t.line} is reproduced byte for byte`, { skip: block && 'sends the 40-byte name block' }, () => {
    const song = new Song().loadFromGo(parseTransfer(t.messages));
    const ours = GoPattern.of(song).toSysEx();
    assert.deepEqual(ours.map(hex), t.messages.map(cutName).map(hex));
  });
});

fx.dumps.forEach((d) => {
  test(`GO:KEYS dump ${d.file}:${d.line} reads into a song, and our transfer of it reads back the same`, () => {
    const p = parseTransfer(d.messages);
    assert.ok(p, 'dump parsed');
    const song = new Song().loadFromGo(p);
    assert.ok(song.bars > 0);
    const chordEntries = d.messages.filter((m) => addr(m) === '01 00 03 40').reduce((n, m) => n + GoSysEx.w14(m[11], m[12]), 0);
    assert.equal(song.chords.length, chordEntries);
    const again = new Song().loadFromGo(parseTransfer(GoPattern.of(song).toSysEx()));
    assert.deepEqual(again.toJSON(), song.toJSON());
  });
});

// Each single edit: decode Chord Director's entry, build the same edit with our code, compare the three messages.
fx.edits.forEach((e) => {
  const m = e.messages[1], lo = m[10], data = m.slice(11, m.length - 2);
  test(`Chord Director edit ${e.file}:${e.line} (03 ${lo.toString(16)}) is reproduced`, () => {
    const link = recordingLink();
    const p = GoPattern.of(new Song());
    if (lo === GoSysEx.CHORDS) {
      const x = data.slice(2), bar = GoSysEx.w14(x[0], x[1]), c = GoSysEx.chordFromBytes(x.slice(3));
      link.edit(lo, p.chordEntry(bar, x[2], c));
    } else if (lo === GoSysEx.VARIATIONS) {
      const x = data.slice(2);
      link.edit(lo, p.styleEntry(GoSysEx.w14(x[0], x[1]), x[2]));
    } else if (lo === GoSysEx.INTRO_CHORD || lo === GoSysEx.ENDING_CHORD) {
      link.sectionChord(lo === GoSysEx.INTRO_CHORD ? 'intro' : 'ending', GoSysEx.chordFromBytes(data));
    } else {
      const key = Object.keys(GoSysEx.SETTINGS).find((k) => GoSysEx.SETTINGS[k] === lo);
      if (!key) return;                                     // 03 20 (bar count) is sent with the whole song by us
      link.settings({ [key]: key === 'transpose' ? data[0] - 0x40 : data[0] === 1 });
    }
    link.flush();
    assert.deepEqual(link.sent.map(hex), e.messages.map(hex));
  });
});
