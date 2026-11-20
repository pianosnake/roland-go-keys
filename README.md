# Roland GO:KEYS MIDI Explorer

Live at https://pianosnake.github.io/roland-go-keys/

A Web MIDI page for the Roland GO:KEYS 3/5. It lists the keyboard's thousand+ tones and lets you keep many more favorites than the 5 the keyboard allows. The **Chords** tab edits the chord progression, like the [Chord Director](https://www.roland.com/us/products/roland_chord_director/) app, with a smoother interface and more features: repeats, following along while the style plays, typing chords from a computer keyboard and downloading the chord pattern as a CSV file.

## Features

**Tones**
- Search the full tone list and tap a tone to select it.
- Star tones as favorites, and show only the favorites.
- Sliders for the controllers (CCs), in six sections.

**Chords**
- **GET** reads the chord progression stored on the keyboard (the song Chord Director edits) and **SEND** writes it back, over undocumented SysEx. Chrome asks for SysEx permission.
- The song is shown bar by bar, 4 beats per bar. Play / stop the style from the page; the bar being played is highlighted and the view follows it.
- Tap a beat to edit it. Use computer keyboard to type chords.
- Repeats: set |: and :| on bars and the repeated bars are written out on the keyboard, while the page shows them once.
- Insert and delete bars, rename the song, clear the chart back to the keyboard's initial pattern.
- Download the song as a CSV in the keyboard's own chord-pattern format (the CHORDnnn.CSV files of a USB backup).

## Setup

Enable Bluetooth on the GO:KEYS and connect to it from your computer (on a Mac: the built-in Audio MIDI Setup app), then open the page in Chrome. Or use a USB cable to connect to your computer/iPad.

To run it locally, start a web server in this folder and open http://localhost:8000 in Chrome:
```
python3 -m http.server 8000
```
(Web MIDI works on `localhost` but not from `file://`. If a reload shows an old version, use Cmd+Shift+R.)

- Runs in desktop Chrome, Android or inside the [MIDIWeb](https://midiweb.app/) Browser on iPad. No libraries and no network access needed.
- Default channel 4: with firmware 1.12 the GO:KEYS only changes the UPPER tone from channel 4.
- Ports: picks one named like `GO:KEYS`, `Roland` or `Bluetooth`, otherwise the first port
- The keyboard doesn't report its controller values, so the sliders show what the page last sent (or received).  Double-tap a value to send its default.
- Tones were retrieved from `tones.csv` posted on Roland GO:KEYS [Facebook forum](https://www.facebook.com/groups/8596326350405837)

Not affiliated with Roland.
