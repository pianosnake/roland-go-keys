# Roland GO:KEYS MIDI Explorer

Live at https://pianosnake.github.io/roland-go-keys/

A Web MIDI page for the Roland GO:KEYS 3/5. It lists the keyboard's thousand+ tones and lets you keep many more favorites than the 5 the keyboard allows. The **Chords** tab edits the chord progression, like the [Chord Director](https://www.roland.com/us/products/roland_chord_director/) app, with a smoother interface and more features: repeats, following along while the style plays, typing chords from a computer keyboard and downloading the chord pattern as a CSV file.

## Features

**Tones**
- Search the full tone list and tap a tone to select it.
- Star tones as favorites, and show only the favorites.
- Sliders for the controllers (CCs), in six sections.

**Chords** (SysEx permission required)
- Reads chord progression currently active on the keyboard, modify it and write it back. 
- The song is shown bar by bar, 4 beats per bar. Play / Stop the style from the page; the bar being played is highlighted and the view follows it.
- Tap a beat to edit it. Use computer keyboard to type chords or onscreen buttons.
- Play song starting on selected measure
- Repeats: set |: and :|. Repeats are auto detected in the source chord pattern, as repeats are not natively supported in the GO:KEYS format
- Insert and delete bars, rename the song, clear the chart.
- Save songs on your device
- Download the song as a CSV in the keyboard's own chord-pattern format, or upload CSV.

## Setup

The page needs a browser with Web MIDI, and the **Chords** tab needs SysEx (allow it when asked). It has no libraries and needs no network access.

### 1. Desktop computer with Chrome

- **USB:** connect the GO:KEYS to the computer with a USB cable.
- **Bluetooth on a Mac:** turn on Bluetooth on the GO:KEYS, open Audio MIDI Setup → Window → Show MIDI Studio, click the Bluetooth icon and connect to `GO:KEYS 3 MIDI`.
- Open the page in Chrome and allow MIDI device control (including SysEx) when Chrome asks.

### 2. Android with Chrome

- **USB:** connect the GO:KEYS to the phone with a USB cable. Android picks it up by itself.
- **Bluetooth:** pairing in Android's Bluetooth settings is not enough, because Chrome only sees MIDI devices that Android's MIDI system has opened. Connect the GO:KEYS with a Bluetooth MIDI connector app (for example *MIDI BLE Connect*; it may need the Location permission), then open or reload the page.
- Allow MIDI access when Chrome asks. If the PORT menu shows `(none)`, the keyboard isn't connected yet.

### 3. iPad with MIDIWeb or Web MIDI Browser

- [MIDIWeb](https://midiweb.app/) (iPadOS 17 and later) or [Web MIDI Browser](https://apps.apple.com/us/app/web-midi-browser/id953846217), which also runs on older iPads (tested on an iPad Air 2 with iPadOS 15).
- Connect the GO:KEYS over Bluetooth or with USB (Lightning/USB-C to USB adapter). In Web MIDI Browser the keyboard's port may simply be called `Bluetooth`; the page picks it.
- Over Bluetooth, the Chords tab needs GO:KEYS firmware 1.12 or later (with 1.11 the keyboard's SysEx never reached the iPad).
- Open the page's address in the app.

### Running it locally

Start a web server in this folder and open http://localhost:8000 in Chrome:
```
python3 -m http.server 8000
```

### Notes

- Default channel 4: with firmware 1.12 the GO:KEYS only changes the UPPER tone from channel 4.
- Ports: picks one named like `GO:KEYS`, `Roland` or `Bluetooth`, otherwise the first port
- The keyboard doesn't report its controller values, so the sliders on the **GLOBAL** tab show what the page last sent (or received). Double-tap a value to send its default.

Not affiliated with Roland.
