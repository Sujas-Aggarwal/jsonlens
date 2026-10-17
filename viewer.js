/* JSON Lens content script.
 * Detects JSON documents, pretty-prints the raw text (numbers and key order preserved exactly),
 * and renders only the visible lines, so size is limited by the browser's string limit, not the DOM. */
(() => {
'use strict';

const ct = (document.contentType || '').toLowerCase();
const isJson = /^[\w.-]+\/([\w.+-]*\+)?json$/.test(ct);
if (!isJson && ct !== 'text/plain') return;
const body = document.body;
if (!body) return;
const pre = body.querySelector(':scope > pre');
if (!pre) return;
if (!isJson && body.children.length !== 1) return;

let raw = pre.textContent;
if (!isJson && !/^\s*[\[{]/.test(raw.slice(0, 200))) return;
// validate cheaply for normal sizes; for huge documents the formatter's structural checks decide
if (!isJson || raw.length < 5e6) { try { JSON.parse(raw); } catch (_) { return; } }

const ROW = 18;            // px per line
const MAX_H = 10e6;        // browsers cap element height (~17M px in Firefox, ~33M in Chrome)
const CAP = 20000;         // characters rendered per line before a "more" chip appears

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
const base = prettify(raw);
raw = null;
if (!base) return;
const fmtMs = performance.now() - t0;

// ------------------------------------------------------------------ highlighting (per visible line)
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
      o += `<span class="${t === 'null' ? 'z' : t === 'true' || t === 'false' ? 'b' : 'n'}">${esc(t)}</span>`; i = j;
    }
  }
  return o;
}

// ------------------------------------------------------------------ virtual list
class View {
  constructor(vp, sizer, pin, rows, chw) {
    Object.assign(this, { vp, sizer, pin, rows, chw, vTop: 0, lastSet: 0, scale: 1, raf: 0, expanded: new Set() });
    vp.addEventListener('scroll', () => {
      if (this.scale > 1) {
        const st = vp.scrollTop;
        if (Math.abs(st - this.lastSet) >= 1) { this.vTop = st * this.scale; this.lastSet = st; }
      }
      this.schedule();
    });
    // With very tall content the native scrollbar is scaled, so wheel/keys move by exact lines instead
    vp.addEventListener('wheel', e => {
      if (this.scale <= 1 || e.ctrlKey) return;
      e.preventDefault();
      let dy = e.deltaY;
      if (e.deltaMode === 1) dy *= ROW; else if (e.deltaMode === 2) dy *= this.viewH;
      if (e.deltaX) vp.scrollLeft += e.deltaX;
      this.scrollBy(dy);
    }, { passive: false });
    vp.addEventListener('keydown', e => {
      if (this.scale <= 1 || e.ctrlKey || e.metaKey || e.altKey) return;
      const page = this.viewH - ROW, max = this.H - this.viewH;
      const m = { ArrowDown: () => this.scrollBy(ROW), ArrowUp: () => this.scrollBy(-ROW), PageDown: () => this.scrollBy(page),
        PageUp: () => this.scrollBy(-page), Home: () => this.scrollBy(-max), End: () => this.scrollBy(max),
        ' ': () => this.scrollBy(e.shiftKey ? -page : page) }[e.key];
      if (m) { e.preventDefault(); m(); }
    });
    rows.addEventListener('click', e => {
      const i = e.target.dataset && e.target.dataset.i;
      if (i === undefined) return;
      this.expanded.add(+i);
      const s = this.starts[+i], t = (+i + 1 < this.n ? this.starts[+i + 1] - 1 : this.bytes.length) - s;
      this.sizer.style.width = Math.max(parseFloat(this.sizer.style.width) || 0, Math.min(t, 5e6) * this.chw + 48) + 'px';
      this.render();
    });
  }
  set(d) {
    Object.assign(this, { bytes: d.bytes, starts: d.starts, n: d.n, maxLen: d.maxLen });
    this.expanded.clear();
    this.vTop = 0; this.lastSet = 0; this.vp.scrollTop = 0; this.vp.scrollLeft = 0;
    this.layout(); this.render();
  }
  layout() {
    const viewH = this.viewH = this.vp.clientHeight;
    const H = this.H = this.n * ROW, sz = Math.min(H, MAX_H);
    this.scale = H > sz ? (H - viewH) / (sz - viewH) : 1;
    this.sizer.style.height = Math.max(sz, viewH) + 'px';
    this.sizer.style.width = Math.min(this.maxLen, CAP) * this.chw + 48 + 'px';
    this.pin.style.height = viewH + 'px';
  }
  scrollBy(dy) {
    this.vTop = Math.min(Math.max(this.vTop + dy, 0), Math.max(0, this.H - this.viewH));
    this.lastSet = this.vTop / this.scale;
    this.vp.scrollTop = this.lastSet;
    this.schedule();
  }
  schedule() { if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.render(); }); }
  lineHtml(i) {
    const s = this.starts[i], e = i + 1 < this.n ? this.starts[i + 1] - 1 : this.bytes.length;
    let len = e - s, more = 0;
    const cap = this.expanded.has(i) ? 5e6 : CAP;
    if (len > cap) { more = len - cap; len = cap; }
    return `<div class="r">${hl(dec.decode(this.bytes.subarray(s, s + len)))}${more ? `<span class="m" data-i="${i}">… ${more.toLocaleString()} more characters</span>` : ''}</div>`;
  }
  render() {
    if (!this.bytes) return;
    const top = this.scale === 1 ? this.vp.scrollTop : this.vTop;
    const vTop = Math.min(Math.max(top, 0), Math.max(0, this.H - this.viewH));
    const first = Math.floor(vTop / ROW), last = Math.min(this.n, first + Math.ceil(this.viewH / ROW) + 1);
    let html = '';
    for (let i = first; i < last; i++) html += this.lineHtml(i);
    this.rows.innerHTML = html;
    this.rows.style.transform = `translateY(${-(vTop - first * ROW)}px)`;
  }
}

// ------------------------------------------------------------------ UI
const CSS = `
*{box-sizing:border-box}
.app{position:absolute;inset:0;display:flex;flex-direction:column;background:var(--bg);color:var(--fg);
  font:13px ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
  --bg:#fff;--fg:#1f2328;--bar:#f6f8fa;--bd:#d0d7de;--k:#0550ae;--s:#0a6b30;--n:#a04100;--b:#8250df;--nl:#8c959f;--p:#6e7781;--sel:#cfe3ff;--err:#cf222e}
@media (prefers-color-scheme:dark){.app{--bg:#0d1117;--fg:#e6edf3;--bar:#161b22;--bd:#30363d;--k:#79c0ff;--s:#7ee787;--n:#ffa657;--b:#d2a8ff;--nl:#8b949e;--p:#8b949e;--sel:#1f3d66;--err:#ff7b72}}
.bar{display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--bar);border-bottom:1px solid var(--bd);flex:none}
.bar b{color:var(--k)}
.bar input{flex:1;min-width:0;font:inherit;padding:5px 8px;border:1px solid var(--bd);border-radius:6px;background:var(--bg);color:var(--fg);outline:none}
.bar input:focus{border-color:var(--k)}
.bar button{font:inherit;padding:4px 10px;border:1px solid var(--bd);border-radius:6px;background:var(--bg);color:var(--fg);cursor:pointer}
.bar button:hover{border-color:var(--k)}
#st{color:var(--p);white-space:nowrap;max-width:50%;overflow:hidden;text-overflow:ellipsis}
#st.err{color:var(--err)}
.vp{flex:1;overflow:auto;outline:none}
.sz{position:relative;min-width:100%}
.pin{position:sticky;top:0;overflow:hidden}
.rows{color:var(--p);white-space:pre;will-change:transform}
.r{height:${ROW}px;line-height:${ROW}px;padding:0 12px}
.k{color:var(--k)}.s{color:var(--s)}.n{color:var(--n)}.b{color:var(--b)}.z{color:var(--nl)}
.m{color:var(--fg);background:var(--bar);border:1px solid var(--bd);border-radius:4px;padding:0 5px;margin-left:6px;cursor:pointer}
.all .r{background:var(--sel)}
`;
const host = document.createElement('div');
host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;color-scheme:light dark';
const sh = host.attachShadow({ mode: 'open' });
sh.innerHTML = `<style>${CSS}</style><div class="app">
<div class="bar"><b>{ }</b>
<input id="q" spellcheck="false" autocomplete="off" placeholder="jq filter, e.g.  .items[] | {id, name}     ( / to focus, Esc to clear )">
<button id="cp" title="Copy everything currently shown">Copy</button><span id="st"></span></div>
<div class="vp" tabindex="0"><div class="sz"><div class="pin"><div class="rows"></div></div></div></div></div>`;
body.textContent = '';
body.style.margin = '0';
body.appendChild(host);

const $ = id => sh.getElementById(id);
const app = sh.querySelector('.app'), vp = sh.querySelector('.vp'), q = $('q'), st = $('st'), cp = $('cp');
const probe = document.createElement('span');
probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre';
probe.textContent = '0'.repeat(100);
app.appendChild(probe);
const chw = probe.getBoundingClientRect().width / 100 || 7.8;
probe.remove();

const view = new View(vp, sh.querySelector('.sz'), sh.querySelector('.pin'), sh.querySelector('.rows'), chw);
let current = base;
const fmtSize = n => n < 1e3 ? n + ' B' : n < 1e6 ? (n / 1e3).toFixed(1) + ' KB' : n < 1e9 ? (n / 1e6).toFixed(1) + ' MB' : (n / 1e9).toFixed(2) + ' GB';
const setSt = (m, err) => { st.textContent = m; st.title = m; st.className = err ? 'err' : ''; };
view.set(base);
setSt(`${base.n.toLocaleString()} lines · ${fmtSize(base.bytes.length)} · formatted in ${Math.round(fmtMs)} ms`);
new ResizeObserver(() => { view.layout(); view.render(); }).observe(vp);

// ------------------------------------------------------------------ jq
let runId = 0, data, parsed = false;
const tick = () => new Promise(r => setTimeout(r, 0));
async function apply(src) {
  src = src.trim();
  const id = ++runId;
  if (src === '' || src === '.') {
    current = base; view.set(base);
    setSt(`${base.n.toLocaleString()} lines · ${fmtSize(base.bytes.length)} · formatted in ${Math.round(fmtMs)} ms`);
    return;
  }
  let ast;
  try { ast = JQ.compile(src); } catch (e) { setSt('jq: ' + e.message, true); return; }
  if (!parsed) {
    setSt('parsing JSON…'); await tick();
    if (id !== runId) return;
    try { data = JSON.parse(dec.decode(base.bytes)); parsed = true; } catch (e) { setSt('parse error: ' + e.message, true); return; }
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
  current = indexText(text); view.set(current);
  const ms = Math.round(performance.now() - t);
  if (err) setSt(`jq: error: ${err.message}` + (n ? ` (after ${n.toLocaleString()} results)` : ''), true);
  else setSt(`${n.toLocaleString()} result${n === 1 ? '' : 's'} · ${current.n.toLocaleString()} lines · ${ms} ms`);
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
  try { text = dec.decode(current.bytes); } catch (_) { setSt('Too large to copy in one piece', true); return; }
  try { await navigator.clipboard.writeText(text); }
  catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
  cp.textContent = 'Copied'; setTimeout(() => { cp.textContent = 'Copy'; }, 1200);
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
  try { e.clipboardData.setData('text/plain', dec.decode(current.bytes)); e.preventDefault(); } catch (_) {}
}, true);
})();
