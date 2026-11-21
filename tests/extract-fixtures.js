// Builds fixtures/chord-director.json from the sniff logs in ~/workspace/roland-hidden-midi (H4MIDI WC between
// Chord Director and the GO:KEYS: Port 1 = Chord Director -> GO:KEYS, Port 3 = GO:KEYS -> Chord Director).
// Run again only if new logs are wanted: node gokeys/tests/extract-fixtures.js [logs dir]
const fs = require('fs'), path = require('path'), os = require('os');
const dir = process.argv[2] || path.join(os.homedir(), 'workspace/roland-hidden-midi');
const logs = fs.readdirSync(dir).filter((f) => /^sniff.*\.log$/.test(f)).sort();
const hex = (s) => s.trim().split(/\s+/).map((x) => parseInt(x, 16));
const out = { source: 'Chord Director <-> GO:KEYS 3, sniffed 2026-11-14/15 (firmware 1.12)', transfers: [], dumps: [], edits: [] };
const seen = new Set();
const addr = (m) => m.slice(7, 11).map((b) => b.toString(16).padStart(2, '0')).join(' ');
logs.forEach((file) => {
  const msgs = [];
  fs.readFileSync(path.join(dir, file), 'utf8').split('\n').forEach((line, i) => {
    const m = /^\s*([\d.]+)\s+\[H4MIDI-WC Port (\d)\]\s+(F0 [0-9A-F ]+ F7)\s+SYSEX/.exec(line);
    if (m && m[3].startsWith('F0 41 10 01 05 11 12')) msgs.push({ line: i + 1, port: +m[2], bytes: hex(m[3]) });
  });
  // 01 00 01 xx only ever comes from the GO:KEYS (result code, play state, bar); in some sessions both directions were
  // logged on one port, so keep those out of Chord Director's side.
  msgs.forEach((x) => { if (x.port === 1 && /^01 00 01 /.test(addr(x.bytes))) x.port = 3; });
  // Whole transfers (02 08 .. 02 0C) from one side, ignoring the other side's messages in between.
  [1, 3].forEach((port) => {
    let cur = null;
    msgs.filter((x) => x.port === port).forEach((x) => {
      const a = addr(x.bytes);
      if (a === '01 00 02 08') cur = { file, line: x.line, messages: [x.bytes] };
      else if (cur) {
        cur.messages.push(x.bytes);
        if (a === '01 00 02 0c') {
          const key = JSON.stringify(cur.messages);
          if (!seen.has(key)) { seen.add(key); (port === 1 ? out.transfers : out.dumps).push(cur); }
          cur = null;
        }
      }
    });
  });
  // Single edits from Chord Director: 02 14, one 03 xx, 02 18.
  const p1 = msgs.filter((x) => x.port === 1);
  for (let k = 0; k + 2 < p1.length; k++) {
    if (addr(p1[k].bytes) === '01 00 02 14' && addr(p1[k + 2].bytes) === '01 00 02 18' && /^01 00 03 /.test(addr(p1[k + 1].bytes))) {
      const e = { file, line: p1[k].line, messages: [p1[k].bytes, p1[k + 1].bytes, p1[k + 2].bytes] };
      const key = JSON.stringify(e.messages);
      if (!seen.has(key)) { seen.add(key); out.edits.push(e); }
    }
  }
});
const keep = (list, n) => list.slice(0, n);
out.transfers = keep(out.transfers, 12); out.dumps = keep(out.dumps, 12);
// Up to 15 edits of each kind (chords, variations, settings...).
const per = {}; out.edits = out.edits.filter((e) => { const a = addr(e.messages[1]); per[a] = (per[a] || 0) + 1; return per[a] <= 15; });
fs.writeFileSync(path.join(__dirname, 'fixtures/chord-director.json'), JSON.stringify(out, null, 1));
console.log(`transfers ${out.transfers.length}, dumps ${out.dumps.length}, edits ${out.edits.length}`);
const kinds = {}; out.edits.forEach((e) => { const a = addr(e.messages[1]); kinds[a] = (kinds[a] || 0) + 1; }); console.log(kinds);
console.log('transfers with variations:', out.transfers.filter((t) => t.messages.some((m) => addr(m) === '01 00 03 41')).length,
  '; with > 13 chords:', out.transfers.filter((t) => t.messages.filter((m) => addr(m) === '01 00 03 40').length > 1).length);
