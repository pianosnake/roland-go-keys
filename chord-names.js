// ChordNames: chord types, note names and spelling for the GO:KEYS chord bytes. Pure functions, no DOM, no MIDI.
// A chord is { root, acc, type, bass, bassAcc }: root/bass 1-7 = A-G (0 = none), acc 40 = natural, 41 = sharp, 3F = flat,
// type 01-1F (TYPES). Loaded as a classic script (window.GoKeys.ChordNames) or with require() in Node (tests).
(function () {
  'use strict';

  // Chord types 01-1F: the name suffix of each.
  const TYPES = {
    0x01: '', 0x02: 'm', 0x03: '7', 0x04: 'm7b5', 0x05: 'dim', 0x06: 'dim7', 0x07: 'aug', 0x08: 'aug7',
    0x09: 'sus4', 0x0A: '7sus4', 0x0B: 'add9', 0x0C: 'madd9', 0x0D: '6', 0x0E: '69', 0x0F: 'm6', 0x10: 'm69',
    0x11: 'm11', 0x12: 'm13', 0x13: 'M7', 0x14: 'm7', 0x15: 'mM7', 0x16: 'mM9', 0x17: 'M9', 0x18: 'm9',
    0x19: '9', 0x1A: '7b5', 0x1B: '7b9', 0x1C: '7#9', 0x1D: '7#11', 0x1E: '13', 0x1F: '7b13',
  };
  const LETTERS = ' ABCDEFG';                                    // root byte 1-7
  const PC = { A: 9, B: 11, C: 0, D: 2, E: 4, F: 5, G: 7 };      // pitch class of each letter
  const VARIATIONS = { 1: 'Var 1', 2: 'Var 2', 3: 'Var 3', 4: 'Var 4', 5: 'Fill Down', 6: 'Fill Up' };

  const noteName = (letter, acc) => {
    const l = LETTERS[letter];
    if (!l || l === ' ') return null;
    return l + (acc === 0x41 ? '#' : acc === 0x3F ? 'b' : '');
  };
  const notePc = (letter, acc) => (PC[LETTERS[letter]] + (acc - 0x40) + 12) % 12;

  // Note names after transposing. Flats if the stored note was flat, otherwise sharps for C#/F# and flats for Eb/Ab/Bb.
  const SHARPS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const FLATS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  const MIXED = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  function spell(letter, acc, transpose) {
    if (!transpose) return noteName(letter, acc);
    if (!noteName(letter, acc)) return null;
    const pc = (notePc(letter, acc) + transpose + 120) % 12;
    return (acc === 0x3F ? FLATS : acc === 0x41 ? SHARPS : MIXED)[pc];
  }

  // The chord as heard with the song's transpose applied; transpose 0 = as stored, which is what the GO:KEYS's CSV
  // files use.
  function chordName(c, transpose) {
    const suffix = TYPES[c.type], root = spell(c.root, c.acc, transpose);
    if (!root) return '?';
    const bass = c.bass ? spell(c.bass, c.bassAcc, transpose) : null;
    return root + (suffix != null ? suffix : `(type ${c.type})`) + (bass ? `/${bass}` : '');
  }

  // A chord name back to bytes: root + accidental + type suffix + optional /bass, e.g. Bbm7/F. Throws on anything else.
  const SUFFIX = {};
  Object.keys(TYPES).forEach((t) => { SUFFIX[TYPES[t]] = +t; });
  const ACC_BYTE = { '': 0x40, '#': 0x41, b: 0x3F };
  function parseChord(text) {
    const m = /^([A-G])([#b]?)(.*?)(?:\/([A-G])([#b]?))?$/.exec(text);
    if (!m || SUFFIX[m[3]] == null) throw new Error(`Unknown chord “${text}”.`);
    return { root: LETTERS.indexOf(m[1]), acc: ACC_BYTE[m[2]], type: SUFFIX[m[3]],
      bass: m[4] ? LETTERS.indexOf(m[4]) : 0, bassAcc: m[4] ? ACC_BYTE[m[5]] : 0x40 };
  }

  // A new chord object with just the chord fields, in the order saved songs store them (or null for none).
  const copyChord = (c) => (c ? { root: c.root, acc: c.acc, type: c.type, bass: c.bass, bassAcc: c.bassAcc } : null);
  // A major chord with no bass, on C unless a root is given.
  const majorChord = (root = 3, acc = 0x40) => ({ root, acc, type: 1, bass: 0, bassAcc: 0x40 });
  // Equal for two chords that sound the same (the bass accidental doesn't count when there is no bass).
  const chordKey = (c) => [c.root, c.acc, c.type, c.bass, c.bass ? c.bassAcc : 0].join('.');

  const ChordNames = { TYPES, LETTERS, PC, VARIATIONS, noteName, notePc, spell, chordName, parseChord,
    copyChord, majorChord, chordKey };
  if (typeof module !== 'undefined' && module.exports) module.exports = ChordNames;
  else (window.GoKeys = window.GoKeys || {}).ChordNames = ChordNames;
}());
