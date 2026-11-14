# Roland GO:KEYS MIDI Explorer

Live at https://pianosnake.github.io/roland-go-keys/

A Web MIDI page for the Roland GO:KEYS 3/5. It lists the keyboard's 1228 tones on the left, and sends a bank select
and program change when you tap one. Every CC it receives is on the right, in six sections.

Enable Bluetooth on the GO:KEYS and connect to it from your computer (on a Mac: the built-in Audio MIDI Setup app),
then open the page in Chrome.

- Runs in desktop Chrome (`python3 serve.py`, then http://localhost:8771) and inside the MIDI Charmer AUv3 on iPad
  (import this folder from Files). No libraries and no network access needed.
- Default channel 4: with firmware 1.11 the GO:KEYS only changes the UPPER tone from channel 4.
- Ports: picks one named like `GO:KEYS`, `Roland` or `Bluetooth`, otherwise the first port (inside an AUv3 host the
  ports have the host's names).
- The keyboard doesn't report its controller values, so the sliders show what the page last sent (or received).
  Double-tap a value to send its default.
- `tones.js` is generated from `~/workspace/roland/tones.csv`; the CC list comes from `cc.csv` there. The channel
  mode messages use the standard numbers (123 All Notes Off, 124/125 Omni Off/On, 126 Mono, 127 Poly).

Not affiliated with Roland.
