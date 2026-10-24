/* JSON Lens content script.
 * JSON: pretty-prints the raw text (numbers / key order preserved) and renders only visible lines.
 * CSV/TSV: indexes row offsets and renders only visible rows as a table.
 * Both are filterable with jq (CSV rows are exposed as an array of objects keyed by header). */
(() => {
'use strict';

const ct = (document.contentType || '').toLowerCase();
const body = document.body;
if (!body) return;
const pre = body.querySelector(':scope > pre');
if (!pre) return;
const pathExt = ((location.pathname.match(/\.(csv|tsv)$/i) || [])[1] || '').toLowerCase();
const isJson = /^[\w.-]+\/([\w.+-]*\+)?json$/.test(ct);
// text/vnd.jsonlens.* is what the bundled network rule rewrites text/csv & friends to (Chrome would download them otherwise)
const isCsv = ct.startsWith('text/vnd.jsonlens.') || /^(text\/(csv|x-csv|tab-separated-values)|application\/csv)$/.test(ct) || (ct === 'text/plain' && !!pathExt);
if (!isJson && !isCsv && ct !== 'text/plain') return;
if (!isJson && !isCsv && body.children.length !== 1) return;

let raw = pre.textContent;
if (!isJson && !isCsv && !/^\s*[\[{]/.test(raw.slice(0, 200))) return;
// validate cheaply for normal sizes; for huge documents the formatter's structural checks decide
if (!isCsv && (!isJson || raw.length < 5e6)) { try { JSON.parse(raw); } catch (_) { return; } }
if (isCsv && !raw.trim()) return;

const ROW = 20;            // px per row
const HDR = 32;            // px, table header
const MAX_H = 10e6;        // browsers cap element height (~17M px in Firefox, ~33M in Chrome)
const CAP = 20000;         // characters rendered per JSON line before a "more" chip appears

// ------------------------------------------------------------------ CSV
const NUMRE = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
function countOut(l, dc) {
  let q = false, c = 0;
  for (let i = 0; i < l.length; i++) { const ch = l.charCodeAt(i); if (ch === 34) q = !q; else if (!q && ch === dc) c++; }
  return c;
}
function sniffDelim(t) {
  const head = t.slice(0, 65536).split('\n', 40).filter(l => l.trim() !== '').slice(0, 20);
  let best = ',', bestScore = 0;
  for (const d of [',', '\t', ';', '|']) {
    const counts = head.map(l => countOut(l, d.charCodeAt(0))), c0 = counts[0];
    if (!c0) continue;
    const ok = counts.filter(c => c === c0).length / counts.length;
    if (ok >= 0.8 && c0 * ok > bestScore) { best = d; bestScore = c0 * ok; }
  }
  return best;
}
// Row offsets only: a newline inside quotes does not end a row. Cells are parsed lazily for visible rows.
function csvIndex(t) {
  let cap = 4096, starts = new Uint32Array(cap), n = 1, p = 0, par = 0, nq = t.indexOf('"');
  const len = t.length;
  while (p < len) {
    let q = t.indexOf('\n', p); if (q === -1) q = len;
    while (nq !== -1 && nq < q) { par ^= 1; nq = t.indexOf('"', nq + 1); }
    if (q >= len) break;
    p = q + 1;
    if (par === 0) {
      if (p >= len) break;
      if (n === cap) { cap *= 2; const x = new Uint32Array(cap); x.set(starts); starts = x; }
      starts[n++] = p;
    }
  }
  return { text: t, starts: starts.subarray(0, n), n, end: t.charCodeAt(len - 1) === 10 ? len - 1 : len };
}
function parseRow(t, s, e, d) {
  if (t.charCodeAt(e - 1) === 13) e--;
  const line = t.slice(s, e);
  if (line.indexOf('"') === -1) return line.split(d);
  const out = [], n = line.length; let i = 0;
  while (i <= n) {
    if (line.charCodeAt(i) === 34) {
      i++; let buf = '';
      for (;;) {
        const q = line.indexOf('"', i);
        if (q === -1) { buf += line.slice(i); i = n; break; }
        buf += line.slice(i, q);
        if (line.charCodeAt(q + 1) === 34) { buf += '"'; i = q + 2; } else { i = q + 1; break; }
      }
      const nx = line.indexOf(d, i);
      if (nx === -1) { out.push(buf + line.slice(i)); return out; }
      out.push(buf + line.slice(i, nx)); i = nx + 1;
    } else {
      const nx = line.indexOf(d, i);
      if (nx === -1) { out.push(line.slice(i)); return out; }
      out.push(line.slice(i, nx)); i = nx + 1;
    }
  }
  return out;
}
const coerce = v => v.length < 16 && NUMRE.test(v) && !/^-?0\d/.test(v) ? Number(v) : v;

// ------------------------------------------------------------------ formatting
// The document is stored as UTF-8 bytes + a line-start table, so size is bounded by memory, not by
// the JS string limit, and only the visible lines are ever decoded.
const enc = new TextEncoder(), dec = new TextDecoder();
function indexLines(bytes) {
  let cap = 4096, starts = new Uint32Array(cap), n = 1, p = 0, maxLen = 0;
  for (;;) {
    const q = bytes.indexOf(10, p);
    if (q === -1) { if (bytes.length - p > maxLen) maxLen = bytes.length - p; break; }
    if (n === cap) { cap *= 2; const t = new Uint32Array(cap); t.set(starts); starts = t; }
    starts[n++] = q + 1;
    if (q - p > maxLen) maxLen = q - p;
    p = q + 1;
  }
  return { bytes, starts, n, maxLen };
}
const indexText = text => indexLines(enc.encode(text));

// Re-indents raw JSON byte by byte. Never builds objects, so numbers / key order / duplicates stay exact.
function prettify(text) {
  const src = enc.encode(text), n = src.length;
  let out = new Uint8Array(Math.max(1 << 16, Math.ceil(n * 1.25))), o = 0;
  let cap = 4096, starts = new Uint32Array(cap), lines = 1, lineStart = 0, maxLen = 0, depth = 0;
  const ensure = k => {
    if (o + k <= out.length) return;
    const t = new Uint8Array(Math.max(out.length * 1.5, o + k) | 0); t.set(out.subarray(0, o)); out = t;
  };
  const newline = () => {
    if (o - lineStart > maxLen) maxLen = o - lineStart;
    ensure(2 * depth + 1);
    out[o++] = 10;
    if (lines === cap) { cap *= 2; const t = new Uint32Array(cap); t.set(starts); starts = t; }
    starts[lines++] = lineStart = o;
    if (depth > 12) { out.fill(32, o, o + 2 * depth); o += 2 * depth; }
    else for (let k = 2 * depth; k > 0; k--) out[o++] = 32;
  };
  let i = (src[0] === 0xEF && src[1] === 0xBB && src[2] === 0xBF) ? 3 : 0;
  while (i < n) {
    const c = src[i];
    if (c === 32 || c === 10 || c === 13 || c === 9) { i++; continue; }
    if (c === 123 || c === 91) {
      let j = i + 1;
      while (j < n) { const d = src[j]; if (d === 32 || d === 10 || d === 13 || d === 9) j++; else break; }
      ensure(2);
      if (j < n && src[j] === (c === 123 ? 125 : 93)) { out[o++] = c; out[o++] = src[j]; i = j + 1; }
      else { out[o++] = c; depth++; newline(); i++; }
    } else if (c === 125 || c === 93) {
      if (--depth < 0) return null;
      newline(); ensure(1); out[o++] = c; i++;
    } else if (c === 44) { ensure(1); out[o++] = 44; newline(); i++; }
    else if (c === 58) { ensure(2); out[o++] = 58; out[o++] = 32; i++; }
    else {
      let j = i + 1;
      if (c === 34) {
        for (;;) { if (j >= n) return null; const d = src[j]; if (d === 34) break; j += d === 92 ? 2 : 1; }
        j++;
      } else {
        while (j < n) {
          const d = src[j];
          if (d === 44 || d === 125 || d === 93 || d === 32 || d === 10 || d === 13 || d === 9 || d === 58) break;
          j++;
        }
      }
      const len = j - i; ensure(len);
      if (len > 48) { out.set(src.subarray(i, j), o); o += len; }
      else for (let k = i; k < j; k++) out[o++] = src[k];
      i = j;
    }
  }
  if (depth !== 0 || o === 0) return null;
  if (o - lineStart > maxLen) maxLen = o - lineStart;
  return { bytes: out.subarray(0, o), starts: starts.subarray(0, lines), n: lines, maxLen };
}

const t0 = performance.now();
let base = null, csvDoc = null;
if (isCsv) {
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  const delim = ct.endsWith('.tsv') || ct === 'text/tab-separated-values' || pathExt === 'tsv' ? '\t' : sniffDelim(raw);
  csvDoc = Object.assign(csvIndex(raw), { delim });
} else {
  base = prettify(raw);
  if (!base) return;
}
raw = null;
const fmtMs = performance.now() - t0;

// ------------------------------------------------------------------ highlighting (JSON lines)
const esc = s => /[&<>]/.test(s) ? s.replace(/[&<>]/g, c => c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;') : s;
function hl(L) {
  let o = '', i = 0; const n = L.length;
  while (i < n) {
    const c = L.charCodeAt(i);
    if (c === 32) { let j = i; while (L.charCodeAt(j) === 32) j++; o += L.slice(i, j); i = j; }
    else if (c === 34) {
      let j = i + 1;
      for (;;) {
        j = L.indexOf('"', j);
        if (j === -1) { j = n; break; }
        let b = 0, k = j - 1;
        while (k > i && L.charCodeAt(k) === 92) { b++; k--; }
        j++;
        if (!(b & 1)) break;
      }
      o += `<span class="${L.charCodeAt(j) === 58 ? 'k' : 's'}">${esc(L.slice(i, j))}</span>`; i = j;
    }
    else if (c === 44 || c === 58 || c === 91 || c === 93 || c === 123 || c === 125) { o += L[i]; i++; }
    else {
      let j = i;
      while (j < n) { const d = L.charCodeAt(j); if (d === 44 || d === 32 || d === 93 || d === 125) break; j++; }
      const t = L.slice(i, j);
      o += `<span class="${t === 'null' || t === 'true' || t === 'false' ? 'b' : 'n'}">${esc(t)}</span>`; i = j;
    }
  }
  return o;
}


// ------------------------------------------------------------------ list specs
const escAttr = s => esc(s).replace(/"/g, '&quot;');
function makeJsonSpec(d) {
  const expanded = new Set();
  const span = i => [d.starts[i], i + 1 < d.n ? d.starts[i + 1] - 1 : d.bytes.length];
  return {
    n: d.n, header: null, width: Math.min(d.maxLen, CAP) * chw + 48,
    row(i) {
      const [s, e] = span(i); let len = e - s, more = 0;
      const cap = expanded.has(i) ? 5e6 : CAP;
      if (len > cap) { more = len - cap; len = cap; }
      return `<div class="r">${hl(dec.decode(d.bytes.subarray(s, s + len)))}${more ? `<span class="m" data-i="${i}">… ${more.toLocaleString()} more characters</span>` : ''}</div>`;
    },
    copy: () => dec.decode(d.bytes),
    click(el, list) {
      const i = el.dataset && el.dataset.i; if (i === undefined) return;
      expanded.add(+i); const [s, e] = span(+i);
      list.widen(Math.min(e - s, 5e6) * chw + 48); list.render();
    },
  };
}
function makeCsvSpec(doc) {
  const { text, starts, n, delim, end: tEnd } = doc;
  const end = i => i + 1 < n ? starts[i + 1] - 1 : tEnd;
  const cells = i => parseRow(text, starts[i], end(i), delim);
  const head = cells(0), sampleN = Math.min(n - 1, 1000);
  let ncols = head.length;
  const sample = [];
  for (let r = 1; r <= sampleN; r++) { const cs = cells(r); sample.push(cs); if (cs.length > ncols) ncols = cs.length; }
  const maxLen = new Array(ncols).fill(0), numeric = new Array(ncols).fill(true), seen = new Array(ncols).fill(0);
  for (const cs of sample) for (let c = 0; c < cs.length; c++) {
    const v = cs[c]; if (v.length > maxLen[c]) maxLen[c] = v.length;
    if (v !== '') { seen[c]++; if (!NUMRE.test(v)) numeric[c] = false; }
  }
  const nu = numeric.map((x, c) => x && seen[c] > 0);
  const lim = [], w = [];
  for (let c = 0; c < ncols; c++) {
    const L = Math.min(Math.max(maxLen[c], (head[c] || '').length, 3), 44);
    lim[c] = L; w[c] = Math.ceil(L * chw) + 28;
  }
  const gutter = Math.ceil(String(n - 1).length * chw) + 36;
  const width = gutter + w.reduce((a, b) => a + b, 0) + 16;
  const disp = v => {
    if (v.length > 300) v = v.slice(0, 300) + '…';
    if (v.indexOf('\n') !== -1 || v.indexOf('\r') !== -1) v = v.replace(/\r?\n|\r/g, ' ⏎ ');
    return esc(v);
  };
  let header = `<div class="r t"><span class="g" style="width:${gutter}px">#</span>`;
  for (let c = 0; c < ncols; c++) header += `<span class="c${nu[c] ? ' nu' : ''}" style="width:${w[c]}px" title="${escAttr(head[c] || '')}">${disp(head[c] || '')}</span>`;
  header += '</div>';
  const seenKeys = new Map();
  const keys = Array.from({ length: ncols }, (_, c) => {
    const k = (head[c] || '').trim() || 'col' + (c + 1), k0 = seenKeys.get(k) || 0;
    seenKeys.set(k, k0 + 1);
    return k0 ? `${k}_${k0 + 1}` : k;
  });
  return {
    n: n - 1, header, width, keys, ncols, copy: () => text,
    row(i) {
      const cs = cells(i + 1);
      let h = `<div class="r t"><span class="g" style="width:${gutter}px">${i + 1}</span>`;
      for (let c = 0; c < ncols; c++) {
        const v = cs[c] === undefined ? '' : cs[c];
        h += `<span class="c${nu[c] ? ' nu' : ''}" style="width:${w[c]}px"${v.length > lim[c] ? ` title="${escAttr(v.slice(0, 500))}"` : ''}>${disp(v)}</span>`;
      }
      return h + '</div>';
    },
  };
}

// ------------------------------------------------------------------ virtual list
class List {
  constructor(vp, sizer, pin, hd, rw, rows) {
    Object.assign(this, { vp, sizer, pin, hd, rw, rows, vTop: 0, lastSet: 0, scale: 1, raf: 0, hdrH: 0, spec: null });
    vp.addEventListener('scroll', () => {
      if (this.scale > 1) {
        const st = vp.scrollTop;
        if (Math.abs(st - this.lastSet) >= 1) { this.vTop = st * this.scale; this.lastSet = st; }
      }
      this.schedule();
    });
    // With very tall content the native scrollbar is scaled, so wheel/keys move by exact rows instead
    vp.addEventListener('wheel', e => {
      if (this.scale <= 1 || e.ctrlKey) return;
      e.preventDefault();
      let dy = e.deltaY;
      if (e.deltaMode === 1) dy *= ROW; else if (e.deltaMode === 2) dy *= this.vh;
      if (e.deltaX) vp.scrollLeft += e.deltaX;
      this.scrollBy(dy);
    }, { passive: false });
    vp.addEventListener('keydown', e => {
      if (this.scale <= 1 || e.ctrlKey || e.metaKey || e.altKey) return;
      const page = this.vh - ROW, max = this.H - this.vh;
      const m = { ArrowDown: () => this.scrollBy(ROW), ArrowUp: () => this.scrollBy(-ROW), PageDown: () => this.scrollBy(page),
        PageUp: () => this.scrollBy(-page), Home: () => this.scrollBy(-max), End: () => this.scrollBy(max),
        ' ': () => this.scrollBy(e.shiftKey ? -page : page) }[e.key];
      if (m) { e.preventDefault(); m(); }
    });
    rows.addEventListener('click', e => { if (this.spec && this.spec.click) this.spec.click(e.target, this); });
  }
  set(spec) {
    this.spec = spec; this.hdrH = spec.header ? HDR : 0;
    this.hd.innerHTML = spec.header || '';
    this.hd.style.display = spec.header ? 'block' : 'none';
    this.rw.style.top = this.hdrH + 'px';
    this.vTop = 0; this.lastSet = 0; this.vp.scrollTop = 0; this.vp.scrollLeft = 0;
    this.layout(); this.render();
  }
  layout() {
    if (!this.spec) return;
    const viewH = this.vp.clientHeight, vh = this.vh = Math.max(0, viewH - this.hdrH);
    const H = this.H = this.spec.n * ROW, sz = Math.min(H, MAX_H);
    this.scale = H > sz ? (H - vh) / (sz - vh) : 1;
    this.sizer.style.height = Math.max(sz + this.hdrH, viewH) + 'px';
    this.setWidth(this.spec.width);
    this.pin.style.height = viewH + 'px';
  }
  setWidth(px) { this.width = px; this.sizer.style.width = px + 'px'; }
  widen(px) { if (px > this.width) this.setWidth(px); }
  scrollBy(dy) {
    this.vTop = Math.min(Math.max(this.vTop + dy, 0), Math.max(0, this.H - this.vh));
    this.lastSet = this.vTop / this.scale;
    this.vp.scrollTop = this.lastSet;
    this.schedule();
  }
  schedule() { if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.render(); }); }
  render() {
    if (!this.spec) return;
    const top = this.scale === 1 ? this.vp.scrollTop : this.vTop;
    const vTop = Math.min(Math.max(top, 0), Math.max(0, this.H - this.vh));
    const first = Math.floor(vTop / ROW), last = Math.min(this.spec.n, first + Math.ceil(this.vh / ROW) + 1);
    let html = '';
    for (let i = first; i < last; i++) html += this.spec.row(i);
    this.rows.innerHTML = html;
    this.rows.style.transform = `translateY(${-(vTop - first * ROW)}px)`;
  }
}

// ------------------------------------------------------------------ UI
const CSS = `
*{box-sizing:border-box}
.app{position:absolute;inset:0;display:flex;flex-direction:column;background:#121314;color:#bbbebf;
  font:13px "Cascadia Code","Cascadia Mono",Consolas,"SF Mono",Menlo,"DejaVu Sans Mono","Liberation Mono",monospace;
  font-variant-ligatures:none}
.app ::selection{background:#264f78aa}
.bar{display:flex;align-items:center;gap:14px;padding:0 16px;height:40px;flex:none;background:#121314;border-bottom:1px solid #2a2b2c}
.bar:focus-within{border-bottom-color:#3994bc}
.pr{color:#3994bc;user-select:none}
.bar input{flex:1;min-width:0;font:inherit;padding:0;border:0;background:transparent;color:#d7d9da;outline:none;caret-color:#3994bc}
.bar input::placeholder{color:#555859}
#st{color:#6b6e70;white-space:nowrap;max-width:50%;overflow:hidden;text-overflow:ellipsis;font-size:12px}
#st.err{color:#f48771}
#cp{font-size:12px;font-family:inherit;padding:0;border:0;background:none;color:#6b6e70;cursor:pointer}
#cp:hover{color:#d7d9da}
.vp{flex:1;overflow:auto;outline:none}
.vp::-webkit-scrollbar{width:10px;height:10px}
.vp::-webkit-scrollbar-track,.vp::-webkit-scrollbar-corner{background:transparent}
.vp::-webkit-scrollbar-thumb{background:#ffffff14;border-radius:5px;border:2px solid #121314}
.vp::-webkit-scrollbar-thumb:hover{background:#ffffff2e}
@supports not selector(::-webkit-scrollbar){.vp{scrollbar-color:#2a2b2c #121314;scrollbar-width:thin}}
.sz{position:relative;min-width:100%}
.pin{position:sticky;top:0;overflow:hidden}
.hd{display:none;height:${HDR}px;border-bottom:1px solid #2a2b2c;background:#121314}
.rw{position:absolute;left:0;right:0;bottom:0;overflow:hidden}
.rows{color:#6b6e70;white-space:pre;will-change:transform}
.r{height:${ROW}px;line-height:${ROW}px;padding:0 16px}
.r.t{padding:0;color:#d7d9da}
.g,.c{display:inline-block;vertical-align:top;height:${ROW}px;overflow:hidden;text-overflow:ellipsis;white-space:pre;padding:0 14px}
.g{color:#4a4d4f;text-align:right;padding-right:18px}
.nu{text-align:right;color:#b5cea8}
.hd .r{height:${HDR - 1}px;line-height:${HDR - 1}px}
.hd .g,.hd .c{height:${HDR - 1}px}
.hd .c{color:#9cdcfe;font-weight:600}
.k{color:#9cdcfe}.s{color:#ce9178}.n{color:#b5cea8}.b{color:#569cd6}
.m{color:#bbbebf;background:#1e1f20;border-radius:3px;padding:0 6px;margin-left:8px;cursor:pointer}
.m:hover{background:#2a2b2c}
.all .r{background:#264f78aa}
`;
const host = document.createElement('div');
host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;color-scheme:dark';
const sh = host.attachShadow({ mode: 'open' });
sh.innerHTML = `<style>${CSS}</style><div class="app">
<div class="bar"><span class="pr">jq</span>
<input id="q" spellcheck="false" autocomplete="off">
<span id="st"></span><button id="cp" title="Copy everything shown">copy</button></div>
<div class="vp" tabindex="0"><div class="sz"><div class="pin"><div class="hd"></div><div class="rw"><div class="rows"></div></div></div></div></div></div>`;
body.textContent = '';
body.style.margin = '0';
body.appendChild(host);

const $ = id => sh.getElementById(id);
const app = sh.querySelector('.app'), vp = sh.querySelector('.vp'), q = $('q'), st = $('st'), cp = $('cp');
q.placeholder = isCsv ? '.[] | select(.price > 10) | .name      (rows are objects keyed by header)' : '.items[] | {id, name}';
const probe = document.createElement('span');
probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre';
probe.textContent = '0'.repeat(100);
app.appendChild(probe);
const chw = probe.getBoundingClientRect().width / 100 || 7.8;
probe.remove();

const list = new List(vp, sh.querySelector('.sz'), sh.querySelector('.pin'), sh.querySelector('.hd'), sh.querySelector('.rw'), sh.querySelector('.rows'));
const fmtSize = n => n < 1e3 ? n + ' B' : n < 1e6 ? (n / 1e3).toFixed(1) + ' KB' : n < 1e9 ? (n / 1e6).toFixed(1) + ' MB' : (n / 1e9).toFixed(2) + ' GB';
const setSt = (m, err) => { st.textContent = m; st.title = m; st.className = err ? 'err' : ''; };

let baseSpec, baseInfo, shown;
if (isCsv) {
  baseSpec = makeCsvSpec(csvDoc);
  baseInfo = `${baseSpec.n.toLocaleString()} rows · ${baseSpec.ncols} columns · ${fmtSize(csvDoc.text.length)} · indexed in ${Math.round(fmtMs)} ms`;
} else {
  baseSpec = makeJsonSpec(base);
  baseInfo = `${base.n.toLocaleString()} lines · ${fmtSize(base.bytes.length)} · formatted in ${Math.round(fmtMs)} ms`;
}
shown = baseSpec; list.set(baseSpec); setSt(baseInfo);
new ResizeObserver(() => { list.layout(); list.render(); }).observe(vp);

// ------------------------------------------------------------------ jq
let runId = 0, data, parsed = false;
const tick = () => new Promise(r => setTimeout(r, 0));
async function csvObjects() {
  const { text, starts, n, delim, end: tEnd } = csvDoc, keys = baseSpec.keys, nk = keys.length;
  const out = new Array(n - 1); let t = performance.now();
  for (let r = 1; r < n; r++) {
    const cs = parseRow(text, starts[r], r + 1 < n ? starts[r + 1] - 1 : tEnd, delim), o = {};
    for (let c = 0; c < nk; c++) o[keys[c]] = cs[c] === undefined ? null : coerce(cs[c]);
    out[r - 1] = o;
    if ((r & 1023) === 0 && performance.now() - t > 25) { setSt(`parsing CSV… ${Math.round(r / n * 100)}%`); await tick(); t = performance.now(); }
  }
  return out;
}
async function apply(src) {
  src = src.trim();
  const id = ++runId;
  if (src === '' || src === '.') {
    shown = baseSpec; list.set(baseSpec); setSt(baseInfo);
    return;
  }
  let ast;
  try { ast = JQ.compile(src); } catch (e) { setSt('jq: ' + e.message, true); return; }
  if (!parsed) {
    setSt('parsing…'); await tick();
    try { data = isCsv ? await csvObjects() : JSON.parse(dec.decode(base.bytes)); parsed = true; }
    catch (e) { setSt('parse error: ' + e.message, true); return; }
    if (id !== runId) return;
  }
  const t = performance.now(), parts = [];
  let n = 0, err = null, slice = t;
  try {
    for (const r of JQ.run(ast, data)) {
      const s = JSON.stringify(r, null, 2);
      parts.push(s === undefined ? 'null' : s); n++;
      if ((n & 63) === 0 && performance.now() - slice > 25) {
        setSt(`running… ${n.toLocaleString()} results`); await tick();
        if (id !== runId) return;
        slice = performance.now();
      }
    }
  } catch (e) { err = e; }
  if (id !== runId) return;
  let text;
  try { text = parts.join('\n'); } catch (_) { setSt('jq: output is too large to display', true); return; }
  const d = indexText(text);
  shown = makeJsonSpec(d); list.set(shown);
  const ms = Math.round(performance.now() - t);
  if (err) setSt(`jq: error: ${err.message}` + (n ? ` (after ${n.toLocaleString()} results)` : ''), true);
  else setSt(`${n.toLocaleString()} result${n === 1 ? '' : 's'} · ${d.n.toLocaleString()} lines · ${ms} ms`);
}
let timer = 0;
q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => apply(q.value), 250); });
q.addEventListener('keydown', e => {
  if (e.key === 'Enter') { clearTimeout(timer); apply(q.value); }
  else if (e.key === 'Escape') { q.value = ''; clearTimeout(timer); apply(''); q.blur(); }
});

// ------------------------------------------------------------------ copy / select-all / shortcuts
cp.addEventListener('click', async () => {
  let text;
  try { text = shown.copy(); } catch (_) { setSt('Too large to copy in one piece', true); return; }
  try { await navigator.clipboard.writeText(text); }
  catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
  cp.textContent = 'copied'; setTimeout(() => { cp.textContent = 'copy'; }, 1200);
});
let all = false;
const setAll = on => { all = on; app.classList.toggle('all', on); };
document.addEventListener('keydown', e => {
  const inInput = sh.activeElement === q;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && !inInput) { e.preventDefault(); setAll(true); }
  else if (e.key === '/' && !inInput && !e.ctrlKey && !e.metaKey) { e.preventDefault(); q.focus(); q.select(); }
  else if (!(e.ctrlKey || e.metaKey) && e.key !== 'Shift') setAll(false);
}, true);
document.addEventListener('mousedown', () => setAll(false), true);
document.addEventListener('copy', e => {
  if (!all) return;
  try { e.clipboardData.setData('text/plain', shown.copy()); e.preventDefault(); } catch (_) {}
}, true);
})();
