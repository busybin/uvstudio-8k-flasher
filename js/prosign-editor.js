// Prosign editor — 8K overlay fork customization.
//
// Edits the F+digit prosign table of our overlay Apps (CW, SECMSG) directly on
// the radio: the page reads the installed App's code from its slot, rewrites the
// prosign bytes in place (one 4 KiB code sector + the header code CRC-32) and
// nothing else is reflashed. A full slot erase (App reinstall/upgrade) resets the
// table to the package defaults, so the last set is also cached in localStorage
// and can be restored with one click.
//
// The table is located by the shipped default layout; an already-customised table
// is found through the fixed offset of that published build. Pure helpers are
// exported for Node tests; the browser runtime is guarded and self-boots.
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
  const CACHE_PREFIX = 'uvstudio.prosigns.';

  // Where each App keeps its prosign table in the published build. `tableAt` /
  // `offsetsAt`+`blobAt` are the compiled offsets (fallback when the table has
  // already been customised); `budget` is the packed table's byte capacity.
  const APPS = {
    cw: {
      id: 'cw',
      kind: 'fixed',
      labelKey: 'prosigns_app_cw',
      appName: 'CW V16',
      maxChars: 5,
      hintKey: 'prosigns_hint_fixed',
      tableAt: 5217,
      defaults: ['', 'CQ', 'DE', 'UR', 'RST', 'R', 'TU', '73', 'AR', 'SK']
    },
    secmsg: {
      id: 'secmsg',
      kind: 'packed',
      labelKey: 'prosigns_app_secmsg',
      appName: 'SECMSG V24',
      maxChars: 9,
      hintKey: 'prosigns_hint_packed',
      offsetsAt: 6656,
      blobAt: 6666,
      budget: 28,
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

  // ---- locating / patching a code image -----------------------------------

  // Pattern-only locator (used on the shipped package image; refuses an unknown
  // layout so a wrong .app can never be patched into garbage).
  function locate(code, app) {
    if (app.kind === 'fixed') {
      const off = findFixedTable(code, app.defaults);
      return off < 0 ? null : { kind: 'fixed', at: off, budget: 60 };
    }
    return findPackedTables(code, app.defaults);
  }

  // Radio locator: the default pattern (fresh install or after an upgrade), else
  // the fixed offset of the published build (an already-customised table).
  function locateInCode(code, app) {
    const byPattern = locate(code, app);
    if (byPattern) return byPattern;
    if (app.kind === 'fixed') {
      return app.tableAt != null ? { kind: 'fixed', at: app.tableAt, budget: 60 } : null;
    }
    return app.offsetsAt != null
      ? { kind: 'packed', offsetsAt: app.offsetsAt, blobAt: app.blobAt, budget: app.budget }
      : null;
  }

  const defaultAt = app => (app.kind === 'fixed'
    ? { kind: 'fixed', at: app.tableAt, budget: 60 }
    : { kind: 'packed', offsetsAt: app.offsetsAt, blobAt: app.blobAt, budget: app.budget });

  function readCodeRows(code, app) {
    const at = locateInCode(code, app);
    if (!at) throw new Error('prosign table not found in this App');
    return { at, rows: app.kind === 'fixed' ? decodeFixed(code, at.at) : decodePacked(code, at) };
  }

  // rows: array of 10 strings (index 0 ignored). Returns a new code image.
  function patchCode(code, app, rows) {
    const at = locateInCode(code, app);
    if (!at) throw new Error('prosign table not found in this App');
    const out = code.slice();
    if (app.kind === 'fixed') {
      out.set(encodeFixed(rows), at.at);
    } else {
      const packed = encodePacked(rows, at.budget);
      out.set(packed.offsets, at.offsetsAt);
      out.set(packed.blob, at.blobAt);
      at.used = packed.used;
    }
    return { code: out, at };
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
      out.set(encodeFixed(rows), HDR_SIZE + at.at);
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

  let state = { app: null, at: null, statusKey: null, statusArgs: [] };

  function el(id) { return document.getElementById(id); }

  // --- local cache: survives a reinstall/upgrade (which resets the table) ---
  function cacheKey(id) { return CACHE_PREFIX + id; }

  function saveCachedRows(id, rows) {
    try { localStorage.setItem(cacheKey(id), JSON.stringify(rows)); } catch (e) { /* storage denied */ }
  }

  function loadCachedRows(id) {
    try {
      const text = localStorage.getItem(cacheKey(id));
      if (!text) return null;
      const rows = JSON.parse(text);
      if (Array.isArray(rows) && rows.length === ROWS) return rows.map(r => String(r == null ? '' : r));
    } catch (e) { /* ignore malformed cache */ }
    return null;
  }

  function setStatus(key, ...args) {
    state.statusKey = key;
    state.statusArgs = args;
    const node = el('prosignStatus');
    if (node) node.textContent = t(key, ...args);
  }

  function setBusy(busy) {
    ['prosignLoad', 'prosignInstall', 'prosignReset'].forEach(id => {
      const b = el(id);
      if (b) b.disabled = busy;
    });
  }

  function renderRows(app, rows, at) {
    const body = el('prosignRows');
    if (!body) return;
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
    if (app.kind === 'fixed') { note.textContent = ''; return; }
    try {
      const packed = encodePacked(currentRows(app), at.budget);
      const remaining = at.budget - packed.used;
      const budgetState = remaining === 0
        ? t('prosigns_budget_full')
        : t('prosigns_budget_free', remaining);
      note.textContent = t('prosigns_budget', packed.used, at.budget, budgetState);
    } catch (e) {
      note.textContent = e.message;
    }
  }

  function showRows(app, rows, statusKey, ...statusArgs) {
    state.app = app;
    state.at = defaultAt(app);
    renderRows(app, rows, state.at);
    const hint = el('prosignHint');
    if (hint) hint.textContent = t(app.hintKey);
    setStatus(statusKey, ...statusArgs);
  }

  // Prefill from the local cache (or the shipped defaults) without touching the
  // radio, so the pane is useful straight away.
  function preload(kind) {
    const app = APPS[kind];
    if (!app) return;
    const cached = loadCachedRows(app.id);
    showRows(
      app,
      cached || app.defaults,
      cached ? 'prosigns_status_cache' : 'prosigns_status_idle',
      t(app.labelKey)
    );
  }

  async function readFromRadio(kind) {
    const app = APPS[kind];
    if (!app) return;
    const slot = parseInt(el('prosignSlot').value, 10);
    setBusy(true);
    setStatus('prosigns_status_loading', t(app.labelKey));
    try {
      if (!window.UVStudioFlash || !window.UVStudioFlash.prosignReadApp) {
        throw new Error('flasher entry point unavailable');
      }
      const res = await window.UVStudioFlash.prosignReadApp(slot);
      if (!res) { setStatus('prosigns_status_idle', t(app.labelKey)); return; }
      if (res.name !== app.appName) {
        throw new Error(t('prosigns_wrong_app', slot + 1, res.name, app.appName));
      }
      const info = readCodeRows(res.code, app);
      state.app = app;
      state.at = info.at;
      renderRows(app, info.rows, info.at);
      const hint = el('prosignHint');
      if (hint) hint.textContent = t(app.hintKey);
      saveCachedRows(app.id, info.rows);       // the radio's current set is the cache
      setStatus('prosigns_status_read', res.name, res.version, slot + 1);
    } catch (e) {
      setStatus('prosigns_load_failed', e.message);
    } finally {
      setBusy(false);
    }
  }

  async function writeProsigns(kind) {
    const app = APPS[kind];
    if (!app) return;
    const slot = parseInt(el('prosignSlot').value, 10);
    setBusy(true);
    setStatus('prosigns_status_writing', t(app.labelKey));
    try {
      if (!window.UVStudioFlash || !window.UVStudioFlash.prosignWriteApp) {
        throw new Error('flasher entry point unavailable');
      }
      const rows = currentRows(app);
      const res = await window.UVStudioFlash.prosignReadApp(slot);
      if (!res) { setStatus('prosigns_status_idle', t(app.labelKey)); return; }
      if (res.name !== app.appName) {
        throw new Error(t('prosigns_wrong_app', slot + 1, res.name, app.appName));
      }
      const patched = patchCode(res.code, app, rows);
      const ok = await window.UVStudioFlash.prosignWriteApp(slot, patched.code);
      if (!ok) { setStatus('prosigns_status_idle', t(app.labelKey)); return; }
      state.app = app;
      state.at = defaultAt(app);
      saveCachedRows(app.id, rows);
      setStatus('prosigns_write_done', slot + 1);
    } catch (e) {
      setStatus('prosigns_install_failed', e.message);
    } finally {
      setBusy(false);
    }
  }

  function resetToDefaults(kind) {
    const app = APPS[kind];
    if (!app) return;
    showRows(app, app.defaults.slice(), 'prosigns_status_idle', t(app.labelKey));
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
    select.addEventListener('change', () => preload(select.value));
    el('prosignLoad').addEventListener('click', () => { void readFromRadio(select.value); });
    el('prosignInstall').addEventListener('click', () => { void writeProsigns(select.value); });
    el('prosignReset').addEventListener('click', () => resetToDefaults(select.value));
    // Re-render the translated strings when the language changes.
    window.addEventListener('uvstudio:languagechange', () => {
      if (!state.app) return;
      const hint = el('prosignHint');
      if (hint) hint.textContent = t(state.app.hintKey);
      if (state.statusKey) setStatus(state.statusKey, ...state.statusArgs);
      updateBudget(state.app, state.at || defaultAt(state.app));
    });
    preload(select.value);
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
    locateInCode,
    defaultAt,
    readCodeRows,
    patchCode,
    readRows,
    patchPackage,
    loadCachedRows,
    saveCachedRows,
    APPS
  };
});
