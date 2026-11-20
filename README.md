# Roland GO:KEYS MIDI Explorer

Live at https://pianosnake.github.io/roland-go-keys/

A Web MIDI page for the Roland GO:KEYS 3/5. It lists the keyboard's thousand+ tones on the left, and sends a bank select and program change when you tap one. Every CC it receives is on the right, in six sections.

The **Chords** tab reads the chord progression stored on a GO:KEYS 3/5 (the song Chord Director edits) over undocumented SysEx with **GET**, writes it back with **SEND**, shows it bar by bar, and downloads it as a CSV in the keyboard's own chord-pattern format (the CHORDnnn.CSV files of a USB backup). (Downloads don't work inside the MIDI Charmer plugin.) Chrome asks for SysEx permission.

Enable Bluetooth on the GO:KEYS and connect to it from your computer (on a Mac: the built-in Audio MIDI Setup app), then open the page in Chrome. Or use a USB cable to connect to your computer/iPad.

To run it locally, start a web server in this folder and open http://localhost:8000 in Chrome:
```
python3 -m http.server 8000
```
(Web MIDI works on `localhost` but not from `file://`. If a reload shows an old version, use Cmd+Shift+R.)

- Runs in desktop Chrome and inside the MIDIWeb Browser on iPad, or using MIDI Charmer AUv3 on iPad (import this folder from Files). No libraries and no network access needed.
- Default channel 4: with firmware 1.11 the GO:KEYS only changes the UPPER tone from channel 4.
- Ports: picks one named like `GO:KEYS`, `Roland` or `Bluetooth`, otherwise the first port (inside an AUv3 host the
  ports have the host's names).
- The keyboard doesn't report its controller values, so the sliders show what the page last sent (or received).  Double-tap a value to send its default.
- Tones were retrieved from `tones.csv` posted on Roland GO:KEYS [Facebook forum](https://www.facebook.com/groups/8596326350405837)

Not affiliated with Roland.
