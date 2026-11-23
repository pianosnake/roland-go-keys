const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const Zip = require('../../zip.js');
const SongFiles = require('../../song-files.js');
const fixture = (f) => fs.readFileSync(path.join(__dirname, '../fixtures', f), 'utf8');

test('zip: valid headers and CRC', () => {
  const data = new TextEncoder().encode('hello');
  assert.equal(Zip.crc32(data), 0x3610A686);
  const z = Zip.zip([{ name: 'a.csv', data, date: new Date(2026, 10, 20, 12, 0, 0) }]);
  const v = new DataView(z.buffer);
  assert.equal(v.getUint32(0, true), 0x04034B50);
  assert.equal(v.getUint32(14, true), 0x3610A686);
  assert.equal(v.getUint32(z.length - 22, true), 0x06054B50);
});

test('unzip: reads the page\'s own zip, a deflated one, and skips Mac extras', async () => {
  const enc = new TextEncoder(), date = new Date(2026, 10, 22, 12, 0, 0);
  const a = enc.encode(fixture('CHORD001.CSV')), b = enc.encode('FORMAT,2\r\nNAME,B\r\n\r\nCHORD,1,C\r\n');
  const back = await Zip.unzip(Zip.zip([{ name: 'a.csv', data: a, date }, { name: 'b.csv', data: b, date }]));
  assert.deepEqual(back.map((x) => x.name), ['a.csv', 'b.csv']);
  assert.equal(new TextDecoder().decode(back[0].data), fixture('CHORD001.CSV'));
  assert.equal(SongFiles.parseCsv(new TextDecoder().decode(back[1].data)).name, 'B');

  // A zip as Finder makes it: deflated entries, a folder, __MACOSX files. Built by hand from the stored one.

  const entries = [{ name: 'songs/', data: new Uint8Array(0) }, { name: 'songs/a.csv', data: a }, { name: '__MACOSX/songs/._a.csv', data: b }];
  const parts = [], central = [];
  let offset = 0;
  entries.forEach((e) => {
    const name = Buffer.from(e.name), packed = zlib.deflateRawSync(Buffer.from(e.data));
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034B50, 0); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(Zip.crc32(e.data), 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(e.data.length, 22); local.writeUInt16LE(name.length, 26);
    const cen = Buffer.alloc(46); cen.writeUInt32LE(0x02014B50, 0); cen.writeUInt16LE(8, 10);
    cen.writeUInt32LE(Zip.crc32(e.data), 16); cen.writeUInt32LE(packed.length, 20); cen.writeUInt32LE(e.data.length, 24);
    cen.writeUInt16LE(name.length, 28); cen.writeUInt32LE(offset, 42);
    parts.push(local, name, packed); central.push(cen, name);
    offset += 30 + name.length + packed.length;
  });
  const cenBuf = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054B50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cenBuf.length, 12); end.writeUInt32LE(offset, 16);
  const finder = await Zip.unzip(new Uint8Array(Buffer.concat(parts.concat([cenBuf, end]))));
  assert.deepEqual(finder.map((x) => x.name), ['songs/a.csv']);
  assert.equal(new TextDecoder().decode(finder[0].data), fixture('CHORD001.CSV'));

  await assert.rejects(Zip.unzip(enc.encode('not a zip at all, just some text that is long enough')), /isn’t a zip/);
});
