// SongFiles: songs as files. Pure functions, no DOM.
//   csv(data) / parseCsv(text)   the GO:KEYS's own chord-pattern format (ROLAND/CHORD_PTN/CHORDnnn.CSV on a USB backup)
//   fileBase(name)               a file name for a song
// The CSV format, CRLF line ends:
//   FORMAT,2 / NAME / INTRO_SW / ENDING_SW / LOOP / TRANSPOSE, a blank line, then
//   DIVISION,Intro,Short + CHORD,1,<intro chord>, and the song as rows of CHORD,<bars in row>,<bar>,<bar>,...
//   A bar lists its beats separated by spaces: a chord name = change on that beat, ":" = hold, empty = whole bar held.
//   Rows break every 4 bars (bars 1, 5, 9...) and at each DIVISION,Variation,1-4 / FillIn,Down|Up; a division in the
//   middle of a 4-bar line gets a blank line first. After the song a blank line, then (if on)
//   DIVISION,Ending,Short|Long and CHORD,1,<ending chord> (empty = none).
//   Chord names are stored untransposed; TRANSPOSE says how far the GO:KEYS shifts them.
// Loaded as a classic script (window.GoKeys.SongFiles) or with require() in Node (tests).
(function () {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports;
  const G = isNode ? { ChordNames: require('./chord-names.js'), Song: require('./song.js'), GoSysEx: require('../midi/go-sysex.js') } : window.GoKeys;
  const { chordName, parseChord } = G.ChordNames, Song = G.Song, DEFAULT_NAME = G.GoSysEx.DEFAULT_NAME;

  function fileBase(name) {
    const n = (name || 'gokeys-chords').replace(/~$/, '').replace(/[^\w#-]+/g, '_').replace(/^_+|_+$/g, '');
    return n || 'gokeys-chords';
  }

  const onOff = (b) => (b ? 'On' : 'Off');
  const DIVISIONS = { 1: 'Variation,1', 2: 'Variation,2', 3: 'Variation,3', 4: 'Variation,4', 5: 'FillIn,Down', 6: 'FillIn,Up' };
  function csvCell(chords) {
    if (!chords.length) return '';
    const last = Math.max.apply(null, chords.map((c) => c.beat));
    const beats = [];
    for (let k = 0; k <= last; k++) {
      const c = chords.find((x) => x.beat === k);
      beats.push(c ? chordName(c, 0) : ':');
    }
    return beats.join(' ');
  }
  // data: a Song or a saved song's data (the same fields).
  function csv(data) {
    const st = data.settings, lines = [];
    lines.push('FORMAT,2', `NAME,${(data.name || DEFAULT_NAME).replace(/,/g, ' ')}`, `INTRO_SW,${onOff(st.intro)}`,
      `ENDING_SW,${onOff(st.ending)}`, `LOOP,${onOff(st.loop)}`, `TRANSPOSE,${st.transpose}`, '');
    if (st.intro) {
      lines.push(`DIVISION,Intro,${st.introLong ? 'Long' : 'Short'}`, `CHORD,1,${data.introChord ? chordName(data.introChord, 0) : ''}`, '');
    }
    const divisions = {};
    data.variations.forEach((v) => { divisions[v.bar] = DIVISIONS[v.value] || `Variation,${v.value}`; });
    // Rows follow 4-bar lines counted from the song's first bar; a division also starts a new row, after a blank line
    // when it falls in the middle of a line (as in the GO:KEYS's own files).
    let row = [];
    const flush = () => { if (row.length) lines.push(`CHORD,${row.length},${row.join(',')}`); row = []; };
    for (let b = 0; b < data.bars; b++) {
      if (b % 4 === 0) flush();
      if (divisions[b]) {
        flush();
        if (b % 4 !== 0 && lines[lines.length - 1] !== '') lines.push('');
        lines.push(`DIVISION,${divisions[b]}`);
      }
      row.push(csvCell(data.chords.filter((c) => c.bar === b)));
    }
    flush();
    lines.push('');
    if (st.ending) {
      lines.push(`DIVISION,Ending,${st.endingLong ? 'Long' : 'Short'}`, `CHORD,1,${data.endingChord ? chordName(data.endingChord, 0) : ''}`);
    }
    return lines.join('\r\n') + '\r\n';
  }

  // Reading one back (Upload song). Returns plain song data; throws an Error with a message for the user when the
  // file isn't one of these.
  function parseCsv(text) {
    const out = { name: '', bars: 0, chords: [], variations: [], settings: Song.defaults(), introChord: null, endingChord: null };
    const VAR = { 'Variation,1': 1, 'Variation,2': 2, 'Variation,3': 3, 'Variation,4': 4, 'FillIn,Down': 5, 'FillIn,Up': 6 };
    let division = null, sawFormat = false;
    text.replace(/^﻿/, '').split(/\r?\n/).forEach((raw) => {
      const line = raw.trim();
      if (!line) return;
      const cells = line.split(','), key = cells[0].toUpperCase(), rest = cells.slice(1).join(',');
      if (key === 'FORMAT') sawFormat = true;
      else if (key === 'NAME') out.name = rest.replace(/[^\x20-\x7E]/g, '').trim().slice(0, 32);
      else if (key === 'INTRO_SW') out.settings.intro = /^on$/i.test(rest);
      else if (key === 'ENDING_SW') out.settings.ending = /^on$/i.test(rest);
      else if (key === 'LOOP') out.settings.loop = /^on$/i.test(rest);
      else if (key === 'TRANSPOSE') out.settings.transpose = Math.max(Song.TRANSPOSE_MIN, Math.min(Song.TRANSPOSE_MAX, parseInt(rest, 10) || 0));
      else if (key === 'DIVISION') {
        division = rest;
        if (/^Intro,/i.test(rest)) out.settings.introLong = /,Long$/i.test(rest);
        else if (/^Ending,/i.test(rest)) out.settings.endingLong = /,Long$/i.test(rest);
        else if (VAR[rest]) out.variations.push({ bar: out.bars, value: VAR[rest] });
      } else if (key === 'CHORD') {
        const bars = cells.slice(2);
        if (/^(Intro|Ending),/i.test(division || '')) {           // one cell: the section's chord (empty = none)
          const c = bars[0] && bars[0].trim() ? parseChord(bars[0].trim().split(/\s+/)[0]) : null;
          out[/^Intro/i.test(division) ? 'introChord' : 'endingChord'] = c;
          division = null;
          return;
        }
        bars.forEach((cell) => {
          cell.trim().split(/\s+/).forEach((tok, beat) => {
            if (!tok || tok === ':') return;
            if (beat >= Song.BEATS) throw new Error(`Bar ${out.bars + 1} has more than ${Song.BEATS} beats.`);
            out.chords.push(Object.assign({ bar: out.bars, beat }, parseChord(tok)));
          });
          out.bars++;
        });
        division = null;
      }
    });
    if (!sawFormat || !out.bars) throw new Error('This isn’t a GO:KEYS chord pattern file (FORMAT and CHORD lines are missing).');
    if (out.bars > Song.MAX_BARS) throw new Error(`The file has ${out.bars} bars; the keyboard takes up to ${Song.MAX_BARS}.`);
    if (out.settings.ending) out.settings.loop = false;
    return out;
  }

  const SongFiles = { fileBase, csv, parseCsv };
  if (isNode) module.exports = SongFiles;
  else (window.GoKeys = window.GoKeys || {}).SongFiles = SongFiles;
}());
