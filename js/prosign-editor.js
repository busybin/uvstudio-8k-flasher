// Prosign editor — 8K overlay fork customization.
//
// Edits the F+digit prosign table of our own overlay Apps (CW, SECMSG) directly in
// the browser and installs the patched package through the existing Apps installer:
// the table bytes are rewritten in the package image, the header code CRC-32 is
// recomputed (the firmware verifies it), and UVStudioFlash does the rest.
//
// The editor targets the currently published packages (it locates each table by the
// shipped default layout). Pure helpers are exported for Node tests; the browser
// runtime is guarded and self-boots.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.UVStudioProsignEditor = api;

  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => api.boot());
    } else {
      api.boot();
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ROWS = 10;               // F+1..F+9 live at indices 1..9; index 0 is the latch placeholder
  const HDR_SIZE = 64;           // FAP1 header size
  const CODE_CRC_OFF = 12;       // header: uint32 LE crc32 over the code image
  const APP_MAGIC = 0x31504146;  // "FAP1"

  // Where each App keeps its prosign table, and the default layout of the currently
  // published packages (the locator anchor). `budget` for the packed table is learned
  // from the located blob, so growing defaults in a future release is fine.
  const APPS = {
    cw: {
      kind: 'fixed',
      labelKey: 'prosigns_app_cw',
      local: 'packages/CW-V16.app',
      url: 'https://raw.githubusercontent.com/busybin/uv-k1-k5v3-firmware-f4hwn-8k/v610-8k/archive/apps/v6.1.0/CW-V16.app',
      maxChars: 5,
      hintKey: 'prosigns_hint_fixed',
      defaults: ['', 'CQ', 'DE', 'UR', 'RST', 'R', 'TU', '73', 'AR', 'SK']
    },
    secmsg: {
      kind: 'packed',
      labelKey: 'prosigns_app_secmsg',
      local: 'packages/SECMSG-V24.app',
      url: 'https://raw.githubusercontent.com/busybin/uv-k1-k5v3-firmware-f4hwn-8k/v610-8k/archive/apps/v6.1.0/SECMSG-V24.app',
      maxChars: 9,
      hintKey: 'prosigns_hint_packed',
      defaults: ['', 'CQ', 'DE', 'UR', 'RST', 'R', 'TU', '73', 'AR', 'SK']
    }
  };

  // Shared translation runtime (studio-i18n.js exposes window.uvStudioI18n).
  function t(key, ...values) {
    return window.uvStudioI18n ? window.uvStudioI18n.t(key, ...values) : key;
  }

  // ===================== pure helpers (Node-testable) =====================

  function crc32(bytes) {
    let c;
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      if (!crc32.table) crc32.table = new Uint32Array(256);
      crc32.table[n] = c >>> 0;
    }
    c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = crc32.table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function readCStr(bytes, off, max) {
    let s = '';
    for (let i = 0; i < max; i++) {
      const c = bytes[off + i];
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return s;
  }

  function parseHeader(pkg) {
    if (!(pkg instanceof Uint8Array) || pkg.length < HDR_SIZE) return null;
    const v = new DataView(pkg.buffer, pkg.byteOffset, pkg.byteLength);
    if (v.getUint32(0, true) !== APP_MAGIC) return null;
    return {
      name: readCStr(pkg, 20, 16),
      version: readCStr(pkg, 36, 16),
      codeSize: v.getUint32(8, true),
      assetSize: v.getUint16(60, true),
      codeCrc: v.getUint32(CODE_CRC_OFF, true)
    };
  }

  function cleanRow(value, maxChars) {
    const s = String(value == null ? '' : value).trim();
    if (s.length > maxChars) throw new Error(`prosign "${s}" is ${s.length} characters (max ${maxChars})`);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 32 || c > 126) throw new Error('prosigns must be printable ASCII');
    }
    return s;
  }

  // ---- fixed table (CW): PROSIGN_T[10][6], NUL-padded rows ----------------

  function encodeFixed(rows) {
    const out = new Uint8Array(ROWS * 6);
    for (let r = 0; r < ROWS; r++) {
      const s = cleanRow(rows[r], 5);   // a row is a char[6]: 5 chars + NUL
      for (let i = 0; i < s.length; i++) out[r * 6 + i] = s.charCodeAt(i);
    }
    return out;
  }

  function decodeFixed(code, off) {
    const rows = [];
    for (let r = 0; r < ROWS; r++) rows.push(readCStr(code, off + r * 6, 6));
    return rows;
  }

  function findFixedTable(code, defaults) {
    const want = encodeFixed(defaults);
    for (let i = 0; i + want.length <= code.length; i++) {
      let hit = true;
      for (let j = 0; j < want.length; j++) if (code[i + j] !== want[j]) { hit = false; break; }
      if (hit) return i;
    }
    return -1;
  }

  // ---- packed table (SECMSG): PROSIGN_OFF[10] followed by PROSIGN_ALL -----

  function encodePacked(rows, budget) {
    const offsets = new Uint8Array(ROWS);
    let size = 1;                                   // leading empty sentinel
    const entries = [];
    for (let r = 1; r < ROWS; r++) {
      const s = rows[r] || '';
      if (!s) { offsets[r] = 0; continue; }
      entries.push({ r, s });
      size += s.length + 1;
    }
    if (size > budget) {
      throw new Error(`prosigns need ${size} bytes, the table holds ${budget}`);
    }
    const blob = new Uint8Array(budget);
    let cursor = 1;
    for (const e of entries) {
      offsets[e.r] = cursor;
      for (let i = 0; i < e.s.length; i++) blob[cursor + i] = e.s.charCodeAt(i);
      cursor += e.s.length + 1;
    }
    return { offsets, blob, used: size };
  }

  function findPackedTables(code, defaults) {
    // anchor: the offset table and the blob are adjacent, so search the joined image
    const ref = encodePacked(defaults, 64);         // reference layout at a generous size
    // rebuild the reference bytes exactly as laid out in the shipped package:
    // offsets(10) + blob sized to the reference extent
    const extent = ref.used;
    const want = new Uint8Array(10 + extent);
    want.set(ref.offsets, 0);
    const refBlob = new Uint8Array(extent);
    let cursor = 1;
    for (let r = 1; r < ROWS; r++) {
      const s = defaults[r] || '';
      if (!s) continue;
      for (let i = 0; i < s.length; i++) refBlob[cursor + i] = s.charCodeAt(i);
      cursor += s.length + 1;
    }
    want.set(refBlob, 10);
    for (let i = 0; i + want.length <= code.length; i++) {
      let hit = true;
      for (let j = 0; j < want.length; j++) if (code[i + j] !== want[j]) { hit = false; break; }
      if (hit) return { offsetsAt: i, blobAt: i + 10, budget: extent };
    }
    return null;
  }

  function decodePacked(code, at) {
    const rows = [''];
    for (let r = 1; r < ROWS; r++) {
      const off = code[at.offsetsAt + r];
      rows.push(off ? readCStr(code, at.blobAt + off, 16) : '');
    }
    return rows;
  }

  // ---- package patching ---------------------------------------------------

  function locate(code, app) {
    if (app.kind === 'fixed') {
      const off = findFixedTable(code, app.defaults);
      return off < 0 ? null : { kind: 'fixed', at: off, budget: 60 };
    }
    return findPackedTables(code, app.defaults);
  }

  // rows: array of 10 strings (index 0 ignored). Returns a new package image.
  function patchPackage(pkg, app, rows) {
    const header = parseHeader(pkg);
    if (!header || header.codeSize <= 0) throw new Error('not a valid .app package');
    const code = pkg.subarray(HDR_SIZE, HDR_SIZE + header.codeSize);
    const at = locate(code, app);
    if (!at) {
      throw new Error('prosign table not found — this package is not the expected published build');
    }
    const out = pkg.slice();
    const view = new DataView(out.buffer);
    if (app.kind === 'fixed') {
      const table = encodeFixed(rows);
      out.set(table, HDR_SIZE + at.at);
    } else {
      const packed = encodePacked(rows, at.budget);
      out.set(packed.offsets, HDR_SIZE + at.offsetsAt);
      out.set(packed.blob, HDR_SIZE + at.blobAt);
      at.used = packed.used;
    }
    view.setUint32(CODE_CRC_OFF, crc32(out.subarray(HDR_SIZE, HDR_SIZE + header.codeSize)), true);
    return { pkg: out, header, at };
  }

  function readRows(pkg, app) {
    const header = parseHeader(pkg);
    if (!header) throw new Error('not a valid .app package');
    const code = pkg.subarray(HDR_SIZE, HDR_SIZE + header.codeSize);
    const at = locate(code, app);
    if (!at) throw new Error('prosign table not found — this package is not the expected published build');
    return {
      header,
      at,
      rows: app.kind === 'fixed' ? decodeFixed(code, at.at) : decodePacked(code, at)
    };
  }

  // ===================== browser runtime =====================

  let state = { app: null, pkg: null, info: null, where: '' };

  function el(id) { return document.getElementById(id); }

  async function fetchPackage(app) {
    // local copy first (local preview / offline), then the published archive
    for (const url of [app.local, app.url]) {
      try {
        const res = await fetch(url, { cache: 'no-cache' });
        if (res.ok) return new Uint8Array(await res.arrayBuffer());
      } catch (e) { /* try the next source */ }
    }
    throw new Error('package not reachable (' + app.url + ')');
  }

  function renderRows(app, rows, at) {
    const body = el('prosignRows');
    body.textContent = '';
    for (let r = 1; r < ROWS; r++) {
      const tr = document.createElement('tr');
      const th = document.createElement('th');
      th.scope = 'row';
      th.textContent = 'F+' + r;
      const td = document.createElement('td');
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'prosign-input';
      input.id = 'prosignRow' + r;
      input.value = rows[r] || '';
      input.maxLength = app.maxChars;
      input.size = Math.max(6, app.maxChars + 2);
      input.setAttribute('aria-label', 'prosign for F+' + r);
      input.addEventListener('input', () => updateBudget(app, at));
      td.appendChild(input);
      tr.appendChild(th);
      tr.appendChild(td);
      body.appendChild(tr);
    }
    updateBudget(app, at);
  }

  function currentRows(app) {
    const rows = [''];
    for (let r = 1; r < ROWS; r++) rows.push(cleanRow(el('prosignRow' + r).value, app.maxChars));
    return rows;
  }

  function updateBudget(app, at) {
    const note = el('prosignBudget');
    if (!note) return;
    if (app.kind === 'fixed') {
      note.textContent = '';
      return;
    }
    try {
      const rows = currentRows(app);
      const packed = encodePacked(rows, at.budget);
      const remaining = at.budget - packed.used;
      const budgetState = remaining === 0
        ? t('prosigns_budget_full')
        : t('prosigns_budget_free', remaining);
      note.textContent = t('prosigns_budget', packed.used, at.budget, budgetState);
    } catch (e) {
      note.textContent = e.message;
    }
  }

  function renderStatus() {
    const { app, info } = state;
    if (!app || !info) return;
    el('prosignHint').textContent = t(app.hintKey);
    el('prosignStatus').textContent = t(
      'prosigns_status_loaded',
      info.header.name,
      info.header.version,
      state.where
    );
  }

  async function loadPackage(kind) {
    const app = APPS[kind];
    if (!app) return;
    const status = el('prosignStatus');
    status.textContent = t('prosigns_status_loading', t(app.labelKey));
    try {
      const pkg = await fetchPackage(app);
      const info = readRows(pkg, app);
      const where = app.kind === 'fixed'
        ? `code offset ${info.at.at}`
        : `code offset ${info.at.offsetsAt}`;
      state = { app, pkg, info, where };
      renderRows(app, info.rows, info.at);
      renderStatus();
      el('prosignInstall').disabled = false;
      el('prosignReset').disabled = false;
    } catch (e) {
      status.textContent = t('prosigns_load_failed', e.message);
      el('prosignInstall').disabled = true;
    }
  }

  function installPackage() {
    if (!state.app) return;
    try {
      const rows = currentRows(state.app);
      const { pkg } = patchPackage(state.pkg, state.app, rows);
      const slot = parseInt(el('prosignSlot').value, 10);
      const name = state.app.kind === 'fixed' ? 'CW-V16.app (custom prosigns)' : 'SECMSG-V24.app (custom prosigns)';
      if (!window.UVStudioFlash || !window.UVStudioFlash.setAppImageBytes) {
        throw new Error('installer entry point unavailable');
      }
      window.UVStudioFlash.setAppImageBytes(pkg, name);
      window.UVStudioFlash.installAppToSlot(slot);
      el('prosignStatus').textContent = t('prosigns_install_done', slot + 1);
    } catch (e) {
      el('prosignStatus').textContent = t('prosigns_install_failed', e.message);
    }
  }

  function boot() {
    const select = el('prosignApp');
    if (!select) return;
    const slot = el('prosignSlot');
    if (slot && !slot.options.length) {
      for (let s = 0; s < 16; s++) {
        const o = document.createElement('option');
        o.value = String(s);
        o.textContent = String(s + 1);
        slot.appendChild(o);
      }
    }
    select.addEventListener('change', () => { void loadPackage(select.value); });
    el('prosignLoad').addEventListener('click', () => { void loadPackage(select.value); });
    el('prosignInstall').addEventListener('click', installPackage);
    el('prosignReset').addEventListener('click', () => { void loadPackage(select.value); });
    // Re-render the translated strings when the language changes.
    window.addEventListener('uvstudio:languagechange', () => {
      if (state.info) {
        renderStatus();
        updateBudget(state.app, state.info.at);
      }
    });
    void loadPackage(select.value);
  }

  return {
    boot,
    crc32,
    parseHeader,
    findFixedTable,
    encodeFixed,
    decodeFixed,
    encodePacked,
    findPackedTables,
    decodePacked,
    locate,
    readRows,
    patchPackage,
    APPS
  };
});
