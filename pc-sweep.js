const easymidi = require('easymidi');

const outputName = 'U2MIDI Pro';
const output = new easymidi.Output(outputName);

console.log('Sweeping Bank Select MSB/LSB with Program Change...');

const msbCandidates = [0, 1, 7, 8, 16, 32, 48, 64, 80, 85, 96, 112, 127];
const lsbRange = [...Array(11).keys()]; // 0–10
const program = 0; // PC number (try 0 to start)

let delay = 0;

msbCandidates.forEach(msb => {
  lsbRange.forEach(lsb => {
    setTimeout(() => {
      console.log(`MSB=${msb}, LSB=${lsb}, PC=${program}`);
      output.send('cc', { controller: 0, value: msb, channel: 0 });   // CC#0 MSB
      output.send('cc', { controller: 32, value: lsb, channel: 0 });  // CC#32 LSB
      output.send('program', { number: program, channel: 0 });        // PC
    }, delay);
    delay += 150; // 150ms between attempts
  });
});

setTimeout(() => {
  output.close();
  process.exit(0);
}, delay + 500);