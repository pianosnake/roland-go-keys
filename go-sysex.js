// GoSysEx: the GO:KEYS 3/5 chord-pattern SysEx format (undocumented, found by sniffing Chord Director; see
// ~/workspace/roland-hidden-midi/gokeys35-research-2026-11-14.md and the later notes there). Pure helpers, no I/O.
//   header F0 41 10 01 05 11, DT1 = 12, RQ1 = 11, Roland checksum. 2-byte values are 7 bits per byte (hi, lo).
//   01 00 02 00 = app mode (01 on / 00 off)          01 00 02 01 = style start (01) / stop (00)
//   01 00 02 02-03 = song position (bar; START ignores it)
//   01 00 02 04 = request a dump (00 00 00 00)       01 00 02 08 / 02 0C = begin / end of a song transfer
//   01 00 02 14 / 02 18 = begin / end of an edit
//   01 00 03 00 (40 bytes): 32-char name, 03 20-21 = bar count, 22 transpose (40 = 0), 23 loop, 24 intro,
//                           25 intro long, 26 ending, 27 ending long
//   01 00 03 40 chords: [count 2B] + count x [bar 2B][beat][root][acc][type 2B][bass][bass acc] (root 00 = delete)
//   01 00 03 41 variations: [count 2B] + count x [bar 2B][value] (value 00 = none)
//   01 00 03 42 / 43 intro / ending chord: [root][acc][type 2B][bass][bass acc] (root 0 = none)
//   From the GO:KEYS, unprompted (in app mode): 01 00 01 00 = result code (00 ok, 03 refused),
//   01 00 01 01 = play state [+ bar], 01 00 01 02 = bar number on each downbeat; the bar's high byte flags the
//   section: 20 = intro, 40 = ending.
(function () {
  'use strict';
  const HEADER = [0xF0, 0x41, 0x10, 0x01, 0x05, 0x11];
  const DT1 = 0x12, RQ1 = 0x11;
  const ADDR = {
    app: [0x01, 0x00, 0x02, 0x00], play: [0x01, 0x00, 0x02, 0x01], position: [0x01, 0x00, 0x02, 0x02],
    request: [0x01, 0x00, 0x02, 0x04], begin: [0x01, 0x00, 0x02, 0x08], end: [0x01, 0x00, 0x02, 0x0C],
    editBegin: [0x01, 0x00, 0x02, 0x14], editEnd: [0x01, 0x00, 0x02, 0x18],
  };
  const song = (lo) => [0x01, 0x00, 0x03, lo];                  // an address in the song block
  const CHORDS = 0x40, VARIATIONS = 0x41, INTRO_CHORD = 0x42, ENDING_CHORD = 0x43, NAME = 0x00, BARS = 0x20;
  // song setting -> offset in the 01 00 03 block
  const SETTINGS = { transpose: 0x22, loop: 0x23, intro: 0x24, introLong: 0x25, ending: 0x26, endingLong: 0x27 };
  const DEFAULT_NAME = 'Initial Pattern';   // a pattern with a blank title can't be saved to a user slot on the GO:KEYS
  const MAX_BARS = 256;                     // the most measures a chord pattern holds (Reference Manual pp. 23-25)

  const w14 = (hi, lo) => hi * 128 + lo;
  const hiLo = (n) => [n >> 7, n & 0x7F];
  const checksum = (body) => (128 - (body.reduce((a, b) => a + b, 0) % 128)) % 128;
  function message(cmd, addr, data) {
    const body = addr.concat(data);
    return HEADER.concat([cmd], body, [checksum(body), 0xF7]);
  }
  const dt1 = (addr, data) => message(DT1, addr, data);
  const rq1 = (addr, size) => message(RQ1, addr, size);
  const chordBytes = (c) => (c ? [c.root, c.acc, c.type >> 7, c.type & 0x7F, c.bass, c.bassAcc] : [0x00, 0x40, 0x00, 0x01, 0x00, 0x40]);
  const chordFromBytes = (e) => (e.length >= 6 && e[0] ? { root: e[0], acc: e[1], type: w14(e[2], e[3]), bass: e[4], bassAcc: e[5] } : null);
  const settingByte = (key, v) => (key === 'transpose' ? 0x40 + v : (v ? 1 : 0));

  // A DT1 from the GO:KEYS in the 01 00 xx xx space -> { a2, a3, data }, or null for anything else.
  function parse(d) {
    if (!d || d.length < 13 || d[d.length - 1] !== 0xF7) return null;
    for (let k = 0; k < HEADER.length; k++) if (d[k] !== HEADER[k]) return null;
    if (d[6] !== DT1 || d[7] !== 0x01 || d[8] !== 0x00) return null;
    return { a2: d[9], a3: d[10], data: Array.prototype.slice.call(d, 11, d.length - 2) };
  }
  // A bar number from the GO:KEYS: 'intro', 'ending' or the bar index.
  const bar = (hi, lo) => (hi & 0x40 ? 'ending' : hi & 0x20 ? 'intro' : w14(hi, lo));

  const GoSysEx = { HEADER, ADDR, song, CHORDS, VARIATIONS, INTRO_CHORD, ENDING_CHORD, NAME, BARS, SETTINGS, DEFAULT_NAME,
    MAX_BARS, w14, hiLo, checksum, dt1, rq1, chordBytes, chordFromBytes, settingByte, parse, bar };
  if (typeof module !== 'undefined' && module.exports) module.exports = GoSysEx;
  else (window.GoKeys = window.GoKeys || {}).GoSysEx = GoSysEx;
}());
