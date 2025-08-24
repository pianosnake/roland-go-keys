let midiAccess = null;
let output = null;
const instrumentName = ['go:keys', 'roland', 'bluetooth'] // the second 2 are for Web MIDI browser on iPad

export async function connectMIDI () {
  if (!navigator.requestMIDIAccess) {
    alert('Web MIDI API not supported in this browser.');
    return false;
  }
  midiAccess = await navigator.requestMIDIAccess();
  // Try to find Roland output port
  const iter = midiAccess.outputs.values();
  for (let o = iter.next(); !o.done; o = iter.next()) {
    // o.value is the MIDIOutput object
    const out = o.value;
    console.log('output', out && out.name);
    if (out && out.name && instrumentName.some(name => out.name.toLowerCase().includes(name))) {
      output = out;
      break;
    }
  }
  if (!output) {
    alert(`Not found any of: ${instrumentName.join(', ')}.`);
    return false;
  }
  return true;
}

export function sendCC (channel, cc, value) {
  console.log(`CC${cc} ${value} on channel ${channel}`);
  if (!output) return;
  output.send([0xB0 | Number(channel) - 1, Number(cc), Number(value)]);
}

export function sendProgramChange (channel, msb, lsb, pc) {
  console.log(`PC to channel ${channel}: MSB=${msb}, LSB=${lsb}, PC=${pc}`);
  if (!output) return;
  output.send([0xB0 | Number(channel) - 1, 0x00, Number(msb)]); // CC#0 MSB
  output.send([0xB0 | Number(channel) - 1, 0x20, Number(lsb)]); // CC#32 LSB
  output.send([0xC0 | Number(channel) - 1, Number(pc) - 1]);    // Program Change (PC is 1-based)
}
