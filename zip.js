// Zip: zip files without a library. Pure functions, no DOM; knows nothing about songs.
//   zip(files)     [{ name, data: Uint8Array, date }] -> Uint8Array, stored (uncompressed) entries, UTF-8 names
//   unzip(bytes)   Uint8Array -> Promise of [{ name, data: Uint8Array }]: stored entries, and deflated ones where the
//                  browser has DecompressionStream (a zip re-made by Finder or Files is deflated). Folders and the Mac's
//                  __MACOSX/._ files are left out. Throws an Error with a message for the user.
//   crc32(bytes)   the CRC zip files use
// Loaded as a classic script (window.GoKeys.Zip) or with require() in Node (tests).
(function () {
  'use strict';

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function zip(files) {
    const enc = new TextEncoder(), parts = [], central = [];
    let offset = 0;
    files.forEach((f) => {
      const name = enc.encode(f.name), d = f.date;
      const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
      const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
      const crc = crc32(f.data), size = f.data.length;
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034B50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);   // UTF-8 names
      local.setUint16(10, time, true); local.setUint16(12, date, true); local.setUint32(14, crc, true);
      local.setUint32(18, size, true); local.setUint32(22, size, true); local.setUint16(26, name.length, true);
      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014B50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true); cen.setUint16(8, 0x0800, true);
      cen.setUint16(12, time, true); cen.setUint16(14, date, true); cen.setUint32(16, crc, true);
      cen.setUint32(20, size, true); cen.setUint32(24, size, true); cen.setUint16(28, name.length, true);
      cen.setUint32(42, offset, true);
      parts.push(new Uint8Array(local.buffer), name, f.data);
      central.push(new Uint8Array(cen.buffer), name);
      offset += 30 + name.length + size;
    });
    const cenSize = central.reduce((n, p) => n + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054B50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cenSize, true); end.setUint32(16, offset, true);
    const all = parts.concat(central, [new Uint8Array(end.buffer)]);
    const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
    let at = 0;
    all.forEach((p) => { out.set(p, at); at += p.length; });
    return out;
  }

  // Reads the central directory (sizes are there even when the local headers use data descriptors). Folders and the
  // Mac's __MACOSX/._ files are left out.
  async function unzip(bytes) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), dec = new TextDecoder();
    let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) if (v.getUint32(i, true) === 0x06054B50) { end = i; break; }
    if (end < 0) throw new Error('This isn’t a zip file.');
    const count = v.getUint16(end + 10, true);
    let at = v.getUint32(end + 16, true);
    const out = [];
    for (let k = 0; k < count; k++) {
      if (v.getUint32(at, true) !== 0x02014B50) throw new Error('The zip file is damaged.');
      const method = v.getUint16(at + 10, true), size = v.getUint32(at + 20, true);
      const nameLen = v.getUint16(at + 28, true), extraLen = v.getUint16(at + 30, true), commentLen = v.getUint16(at + 32, true);
      const local = v.getUint32(at + 42, true), name = dec.decode(bytes.subarray(at + 46, at + 46 + nameLen));
      at += 46 + nameLen + extraLen + commentLen;
      if (/\/$/.test(name) || /(^|\/)(__MACOSX\/|\._)/.test(name)) continue;
      const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
      const raw = bytes.subarray(start, start + size);
      if (method === 0) out.push({ name, data: raw });
      else if (method === 8) {
        if (typeof DecompressionStream === 'undefined') throw new Error('This zip is compressed, which this browser can’t open. Use a zip this page made.');
        const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        out.push({ name, data: new Uint8Array(await new Response(stream).arrayBuffer()) });
      } else throw new Error(`${name} uses a zip compression the page can’t open.`);
    }
    return out;
  }

  const Zip = { zip, unzip, crc32 };
  if (typeof module !== 'undefined' && module.exports) module.exports = Zip;
  else (window.GoKeys = window.GoKeys || {}).Zip = Zip;
}());
