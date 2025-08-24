const tonePromise = fetch('tones.csv')
  .then(res => res.text())
  .then(text => {
    return parseCSV(text);
  });

const ccPromise = fetch('cc.csv')
  .then(res => res.text())
  .then(text => {
    return parseCSV(text);
  });

function parseCSV (text) {
  const lines = text.split('\n').filter(Boolean);
  const header = lines[0].split(',');
  return lines.slice(1).map(line => {
    const cols = line.split(',');
    let obj = {};
    header.forEach((h, i) => obj[h.trim()] = cols[i]?.trim());
    return obj;
  });
}

document.addEventListener('alpine:init', () => {
  Alpine.data('app', () => ({
    midiChannel: 4,
    ccList: [],
    selectedCCs: [],
    userFilter: '',
    selectedToneNum: null,
    tonesDiv: document.getElementById('tones-list'),
    groupedTones: [],
    async init () {
      const ccs = await ccPromise;
      this.ccList = ccs.map(cc => ({ ...cc, value: 0, CC: isNaN(Number(cc.CC)) ? cc.CC : Number(cc.CC) }));
      const tones = await tonePromise;
      const map = {};
      tones.forEach(tone => {
        tone.lowerName = tone.Name ? tone.Name.toLowerCase() : '';
        if (!tone.Category) return;
        if (!map[tone.Category]) map[tone.Category] = [];
        map[tone.Category].push(tone);
      });
      // Convert to array of {category, tones}
      this.groupedTones = Object.entries(map).map(([category, tones]) => ({ category, tones }));
    },
    get filteredTones () {
      const filter = this.userFilter.trim().toLowerCase();
      if (!filter) {
        this.onFilterCleared();
        return this.groupedTones;
      }
      return this.groupedTones
        .map(group => ({
          category: group.category,
          tones: group.tones.filter(t => t.lowerName.includes(filter))
        }))
        .filter(group => group.tones.length > 0);
    },
    get selectedCCObjects () {
      const nums = this.selectedCCs.map(Number);
      return this.ccList.filter(c => nums.includes(c.CC));
    },
    onFilterCleared () {
      // Scroll the instrument list to the selected instrument
      setTimeout(() => {
        const list = this.tonesDiv;
        if (list) {
          const item = list.querySelector(`[data-num="${this.selectedToneNum}"]`);
          if (item) {
            // Center the item in the scrollable list without scrolling the whole page
            const listRect = list.getBoundingClientRect();
            const itemRect = item.getBoundingClientRect();
            list.scrollTop += (itemRect.top - listRect.top) - (list.clientHeight / 2) + (item.clientHeight / 2);
          }
        }
      }, 50);
    },
    onXbtnClick (event) {
      this.userFilter = '';
      // Scroll the instrument list to the selected instrument
      this.onFilterCleared();
    },
    onToneClick (event) {
      const midi = event.currentTarget.dataset.midi;
      if (midi) {
        const [msb, lsb, pc] = midi.split(',').map(Number);
        window.sendProgramChange(this.midiChannel, msb, lsb, pc);
        this.selectedToneNum = event.currentTarget.dataset.num;
      }
    }
  }))
})

document.addEventListener('DOMContentLoaded', () => {
  let midiReady = false;

  import('./midi.js').then(midi => {
    const btn = document.getElementById('connect-midi');
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = 'Connecting...';
      midiReady = await midi.connectMIDI();
      btn.textContent = midiReady ? 'MIDI Connected' : 'Connect MIDI';
      btn.disabled = midiReady;
    };
    window.sendProgramChange = midi.sendProgramChange;
    window.sendCC = midi.sendCC;
  });
});
