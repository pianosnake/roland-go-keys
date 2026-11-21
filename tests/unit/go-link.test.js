const test = require('node:test');
const assert = require('node:assert/strict');
const { GoLink, GoSysEx, GoPattern, song, C, recordingLink, addr, hex, parseTransfer } = require('./helpers.js');

const fromGo = (a2, a3, data) => GoSysEx.dt1([0x01, 0x00, a2, a3], data);

test('DT1 bytes and checksum match what Chord Director sends', () => {
  assert.equal(hex(GoSysEx.dt1(GoSysEx.ADDR.request, [0, 0, 0, 0])), 'F0 41 10 01 05 11 12 01 00 02 04 00 00 00 00 79 F7');
  assert.equal(hex(GoSysEx.dt1(GoSysEx.ADDR.app, [1])), 'F0 41 10 01 05 11 12 01 00 02 00 01 7C F7');
  assert.equal(hex(GoSysEx.rq1([0x01, 0x00, 0x03, 0x20], [0, 0, 0, 2])), 'F0 41 10 01 05 11 11 01 00 03 20 00 00 00 02 5A F7');
});

test('play state and bar messages, with the intro and ending flags', () => {
  const got = [];
  const link = new GoLink({ playState: (p, b) => got.push(['state', p, b]), bar: (b) => got.push(['bar', b]) });
  link.onSysEx(fromGo(0x01, 0x01, [1, 0x20, 0]));
  link.onSysEx(fromGo(0x01, 0x02, [0, 2]));
  link.onSysEx(fromGo(0x01, 0x02, [1, 3]));
  link.onSysEx(fromGo(0x01, 0x02, [0x40, 0]));
  link.onSysEx(fromGo(0x01, 0x01, [1]));
  link.onSysEx(fromGo(0x01, 0x01, [0]));
  assert.deepEqual(got, [['state', true, 'intro'], ['bar', 2], ['bar', 131], ['bar', 'ending'], ['state', true, null], ['state', false, null]]);
});

test('not a GO:KEYS DT1: returns false', () => {
  const link = new GoLink({});
  assert.equal(link.onSysEx([0xF0, 0x7E, 0x7F, 0x06, 0x01, 0xF7]), false);
  const bad = fromGo(0x01, 0x02, [0, 2]); bad[1] = 0x42;
  assert.equal(link.onSysEx(bad), false);
});

test('a dump only counts after requestDump (a loopback echo of our own transfer is ignored)', () => {
  const transfer = GoPattern.of(song(['C', 'G'])).toSysEx();
  let dumps = 0;
  const link = new GoLink({ dump: () => { dumps++; } });
  link.setOutput(() => {});
  transfer.forEach((m) => link.onSysEx(m));
  assert.equal(dumps, 0);
  link.requestDump(10);
  transfer.forEach((m) => link.onSysEx(m));
  clearTimeout(link.dumpTimer);
  assert.equal(dumps, 1);
  transfer.forEach((m) => link.onSysEx(m));                // a second echo after it ended
  assert.equal(dumps, 1);
});

test('a dump is parsed into a pattern', () => {
  const s = song(['C . G7 .', 'Am/E'], { variations: [{ bar: 1, value: 6 }], settings: { transpose: 3, intro: true, introLong: true },
    introChord: C('F'), name: 'Hello' });
  const p = parseTransfer(GoPattern.of(s).toSysEx());
  assert.equal(p.name.trim(), 'Hello');
  assert.equal(p.bars, 2);
  assert.deepEqual(p.chords, s.chords);
  assert.deepEqual(p.variations, [{ bar: 1, value: 6 }]);
  assert.deepEqual(p.introChord, C('F'));
  assert.equal(p.endingChord, null);
  assert.equal(p.settings.transpose, 3);
  assert.equal(p.settings.introLong, true);
});

test('requestDump times out', async () => {
  let timedOut = false;
  const link = new GoLink({ dumpTimeout: () => { timedOut = true; } });
  link.setOutput(() => {});
  link.requestDump(20);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(timedOut, true);
});

test('queue order: a pattern queued first goes out before a later edit and a queued start', () => {
  const link = recordingLink();
  link.pattern(GoPattern.of(song(['C'])));
  link.edit(GoSysEx.CHORDS, [0, 0, 0].concat(GoSysEx.chordBytes(C('D'))));
  link.start(true);
  link.flush();
  const a = link.sent.map(addr);
  assert.equal(a[0], '01 00 02 08');
  const end = a.indexOf('01 00 02 0c');
  assert.deepEqual(a.slice(end + 1), ['01 00 02 14', '01 00 03 40', '01 00 02 18', '01 00 02 01']);
});

test('start and stop go out at once; nothing is sent without an output', () => {
  const link = recordingLink();
  link.start(false); link.stop();
  assert.deepEqual(link.sent.map((m) => [addr(m), m[11]]), [['01 00 02 01', 1], ['01 00 02 01', 0]]);
  const none = new GoLink({});
  assert.equal(none.ready, false);
  assert.equal(none.edit(GoSysEx.CHORDS, [0, 0, 0]), false);
  assert.equal(none.pattern(GoPattern.of(song(['C']))), false);
  assert.equal(none.requestDump(), false);
});

test('an edit enters app mode first when needed', () => {
  const link = new GoLink({}); const sent = [];
  link.setOutput((m) => sent.push(m));
  link.edit(GoSysEx.VARIATIONS, [0, 0, 1]); link.flush();
  assert.deepEqual(sent.map(addr), ['01 00 02 00', '01 00 02 14', '01 00 03 41', '01 00 02 18']);
});

test('leaving the tab ends app mode', () => {
  const link = recordingLink();
  link.setActive(true); link.engage(); link.setActive(false);
  assert.equal(addr(link.sent[link.sent.length - 1]), '01 00 02 00');
  assert.equal(link.sent[link.sent.length - 1][11], 0);
  assert.equal(link.aliveTimer, 0);
});
