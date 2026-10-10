'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const editor = require('../js/prosign-editor.js');

// synthetic code image carrying both table layouts ------------------------

function synthPackage() {
  // padding + PROSIGN_OFF[10] + PROSIGN_ALL blob + padding, at deterministic offsets
  const padding = Buffer.from('dump filler rodata pattern 0123456789 abcdef', 'ascii');
  const defaults = editor.APPS.cw.defaults;
  const fixed = Buffer.from(editor.encodeFixed(defaults));
  const packed = editor.encodePacked(defaults, 64);
  // rebuild the reference blob exactly at its own reachable size
  let size = 1;
  for (let r = 1; r < 10; r++) if (defaults[r]) size += defaults[r].length + 1;
  const ref = editor.encodePacked(defaults, size);
  const code = Buffer.concat([
    padding,
    Buffer.from([0xaa, 0xbb]),
    Buffer.from(ref.offsets),
    Buffer.from(ref.blob),
    Buffer.from([0xcc, 0xdd]),
    fixed,
    Buffer.from('trailing rodata tail — prosign markers must not match here', 'ascii')
  ]);
  const hdr = Buffer.alloc(64);
  hdr.writeUInt32LE(0x31504146, 0);          // FAP1
  hdr.writeUInt32LE(code.length, 8);          // code size
  return { code, pkg: new Uint8Array(Buffer.concat([hdr, code])) };
}

test('crc32 matches the standard check value', () => {
  assert.equal(editor.crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('parses a FAP1 header', () => {
  const hdr = Buffer.alloc(64);
  hdr.writeUInt32LE(0x31504146, 0);
  hdr.writeUInt32LE(5356, 8);
  hdr.writeUInt32LE(0xdeadbeef, 12);
  hdr.write('CW V16', 20, 'ascii');
  hdr.write('16', 36, 'ascii');
  hdr.writeUInt16LE(0, 60, true);
  const pkg = Buffer.concat([hdr, Buffer.alloc(5356)]);
  const h = editor.parseHeader(new Uint8Array(pkg));
  assert.equal(h.name, 'CW V16');
  assert.equal(h.version, '16');
  assert.equal(h.codeSize, 5356);
  assert.equal(h.codeCrc, 0xdeadbeef);
});

test('fixed table: locate, decode, patch and re-checksum (CW)', () => {
  const { code, pkg } = synthPackage();
  const at = editor.findFixedTable(code, editor.APPS.cw.defaults);
  assert.ok(at > 0, 'table not located');
  assert.deepEqual(editor.decodeFixed(code, at), editor.APPS.cw.defaults);

  const rows = ['', 'CQ', 'DE', 'MYCALL', 'RST', 'R', 'TU', '88', 'AR', 'SK'];
  assert.throws(() => editor.encodeFixed(rows), /6 characters.*max 5|too long|5/);

  const ok = ['', 'CQ', 'DE', 'UR', 'RST', 'R', 'TU', '88', 'AR', 'SK'];
  const out = editor.patchPackage(pkg, editor.APPS.cw, ok);
  assert.equal(out.header.codeSize, code.length);
  assert.equal(out.at.at, at);
  const patched = out.pkg.subarray(64);
  assert.deepEqual(editor.decodeFixed(patched, at), ok);
  // header CRC must match the patched code image
  const dv = new DataView(out.pkg.buffer, out.pkg.byteOffset, out.pkg.byteLength);
  assert.equal(dv.getUint32(12, true), editor.crc32(patched));
  // and differ from the original
  assert.notEqual(dv.getUint32(12, true), 0xdeadbeef);
});

test('packed table: locate, decode, patch, budget (SECMSG)', () => {
  const { code, pkg } = synthPackage();
  const at = editor.findPackedTables(code, editor.APPS.secmsg.defaults);
  assert.ok(at, 'packed tables not located');
  assert.equal(at.blobAt, at.offsetsAt + 10);
  assert.deepEqual(editor.decodePacked(code, at), editor.APPS.secmsg.defaults);

  // growing beyond the shipped budget is refused, shrinking is fine
  const big = ['', 'CQ', 'DE', 'UR', 'RST IS NICE', 'R', 'TU', '73', 'AR', 'SK'];
  assert.throws(() => editor.encodePacked(big, at.budget), /need .* bytes/);

  const small = ['', 'CQ', '', 'UR', '', 'R', '', '', '', ''];
  const p = editor.encodePacked(small, at.budget);
  assert.equal(p.blob.length, at.budget);
  assert.equal(p.offsets[2], 0);           // emptied slot
  assert.equal(p.blob[p.offsets[1] + 2], 0); // CQ terminator intact

  const out = editor.patchPackage(pkg, editor.APPS.secmsg, small);
  const patched = out.pkg.subarray(64);
  assert.deepEqual(editor.decodePacked(patched, out.at), small);
  const dv = new DataView(out.pkg.buffer, out.pkg.byteOffset, out.pkg.byteLength);
  assert.equal(dv.getUint32(12, true), editor.crc32(patched));
});

test('unknown layout is refused instead of patching garbage', () => {
  const code = Buffer.from('nothing that looks like a prosign table here', 'ascii');
  const hdr = Buffer.alloc(64);
  hdr.writeUInt32LE(0x31504146, 0);
  hdr.writeUInt32LE(code.length, 8);
  const pkg = new Uint8Array(Buffer.concat([hdr, code]));
  assert.throws(() => editor.patchPackage(pkg, editor.APPS.cw, editor.APPS.cw.defaults), /not found/);
  assert.throws(() => editor.patchPackage(pkg, editor.APPS.secmsg, editor.APPS.secmsg.defaults), /not found/);
});

// ---- optional integration check against the real published packages ------

for (const [kind, file] of [['cw', 'CW-V16.app'], ['secmsg', 'SECMSG-V24.app']]) {
  const local = path.join(__dirname, '..', 'packages', file);
  if (!fs.existsSync(local)) continue;
  test(`real package ${file}: layout located and defaults decode`, () => {
    const pkg = new Uint8Array(fs.readFileSync(local));
    const info = editor.readRows(pkg, editor.APPS[kind]);
    assert.deepEqual(info.rows, editor.APPS[kind].defaults);
    // a round trip through the patcher must keep every other byte identical
    const out = editor.patchPackage(pkg, editor.APPS[kind], editor.APPS[kind].defaults);
    assert.equal(out.pkg.length, pkg.length);
    let diff = 0;
    for (let i = 0; i < pkg.length; i++) if (pkg[i] !== out.pkg[i]) diff++;
    assert.equal(diff, 0, 'rewriting the same prosigns must not change a single byte');
  });
}
