# Tests

Unit tests for the classes behind the Chords tab. They run in plain Node (18+), with no packages and no browser:

```sh
node --test gokeys/tests/unit/
```

Each class file (`song.js`, `go-pattern.js`, `go-link.js`, …) ends with `module.exports = …` when it runs in Node, so
the tests load the same files the page does.

| File | Covers |
|---|---|
| `unit/song.test.js` | `Song`: held chords, variations and fills, finding repeats, signs, inserting and deleting around repeats, writing out passes, the 256-measure limit, pins, saved-song JSON |
| `unit/go-pattern.test.js` | `GoPattern`: the song as the GO:KEYS holds it, cut or rotated for playing from a bar, bar numbers both ways, edit entries, the whole-song transfer |
| `unit/go-link.test.js` | `GoLink`: message bytes and checksums, play-state and bar messages, dumps only after a request (the IAC loopback bug), queue order, app mode |
| `unit/go-player.test.js` | `GoPlayer`: play from a bar with LOOP off and on, bar numbers from the GO:KEYS, edits while playing, stopping |
| `unit/chord-director.test.js` | Fixtures sniffed from Chord Director: its song transfers rebuilt byte for byte, GO:KEYS dumps read back, single edits reproduced |
| `unit/files-and-misc.test.js` | Chord names, CSV files (including real ones from a GO:KEYS USB backup), zip, saved songs, the editor cursor |

## Fixtures

- `fixtures/chord-director.json`: Chord Director ↔ GO:KEYS traffic from the sniff logs in `~/workspace/roland-hidden-midi`
  (firmware 1.12). Rebuild it with `node gokeys/tests/extract-fixtures.js` if new logs are added.
- `fixtures/export-CHORD002.CSV`, `export-CHORD022.CSV`: chord patterns exported by the GO:KEYS (firmware 1.12,
  2026-11-20). The page writes them back byte for byte.
- `fixtures/CHORD00*.CSV`: chord patterns from an older GO:KEYS USB backup (`ROLAND/CHORD_PTN`), written without
  `INTRO_SW` / `ENDING_SW` lines (probably older firmware).

## Known differences, documented in the tests

- Chord Director sends the song name as 33 bytes (or as the whole 40-byte `03 00` block); the page sends the 32 name
  bytes, which the GO:KEYS takes. The transfer comparison cuts Chord Director's name to 32 bytes.
- The older backup files have no `INTRO_SW` line, so one with an intro chord (`CHORD004.CSV`) reads with the intro
  off, and writing it back leaves the intro chord out. Current exports have the line, so this only affects old backups.
