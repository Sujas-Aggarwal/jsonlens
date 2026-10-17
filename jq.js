/* A compact jq implementation. Exposes globalThis.JQ = { compile, run, JqError }.
 * Generator based, so results stream lazily. Operates on already-parsed JS values. */
(() => {
'use strict';

class JqError extends Error {
  constructor(v) { super(typeof v === 'string' ? v : tojson(v) + ' (not a string)'); this.val = v; }
}
class Break { constructor(id) { this.id = id; } }

// ---------------------------------------------------------------- values
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const type = v => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
const truthy = v => v !== null && v !== false;
const tojson = v => { const s = JSON.stringify(v); return s === undefined ? 'null' : s; };
const trunc = s => s.length > 11 ? s.slice(0, 10) + '...' : s;
const desc = v => `${type(v)} (${trunc(tojson(v))})`;
const tostr = v => typeof v === 'string' ? v : tojson(v);
function setk(o, k, v) {
  if (k === '__proto__') Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
  else o[k] = v;
}
const rank = v => v === null ? 0 : v === false ? 1 : v === true ? 2 : typeof v === 'number' ? 3 : typeof v === 'string' ? 4 : Array.isArray(v) ? 5 : 6;
function cmp(a, b) {
  const ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  switch (ra) {
    case 3: case 4: return a < b ? -1 : a > b ? 1 : 0;
    case 5: {
      const n = Math.min(a.length, b.length);
      for (let i = 0; i < n; i++) { const c = cmp(a[i], b[i]); if (c) return c; }
      return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
    }
    case 6: {
      const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
      const c = cmp(ka, kb); if (c) return c;
      for (const k of ka) { const d = cmp(a[k], b[k]); if (d) return d; }
      return 0;
    }
    default: return 0;
  }
}

// ---------------------------------------------------------------- arithmetic
function add(a, b) {
  if (a === null) return b;
  if (b === null) return a;
  const ta = type(a), tb = type(b);
  if (ta === 'number' && tb === 'number') return a + b;
  if (ta === 'string' && tb === 'string') return a + b;
  if (ta === 'array' && tb === 'array') return a.concat(b);
  if (ta === 'object' && tb === 'object') return Object.assign({}, a, b);
  throw new JqError(`${desc(a)} and ${desc(b)} cannot be added`);
}
function sub(a, b) {
  const ta = type(a), tb = type(b);
  if (ta === 'number' && tb === 'number') return a - b;
  if (ta === 'array' && tb === 'array') return a.filter(x => !b.some(y => cmp(x, y) === 0));
  throw new JqError(`${desc(a)} and ${desc(b)} cannot be subtracted`);
}
function deepMerge(a, b) {
  const o = Object.assign({}, a);
  for (const k of Object.keys(b)) setk(o, k, isObj(o[k]) && isObj(b[k]) ? deepMerge(o[k], b[k]) : b[k]);
  return o;
}
function mul(a, b) {
  const ta = type(a), tb = type(b);
  if (ta === 'number' && tb === 'number') return a * b;
  if ((ta === 'string' && tb === 'number') || (ta === 'number' && tb === 'string')) {
    const s = ta === 'string' ? a : b, n = ta === 'string' ? b : a;
    return n <= 0 ? null : s.repeat(Math.max(1, Math.ceil(n)));
  }
  if (ta === 'object' && tb === 'object') return deepMerge(a, b);
  throw new JqError(`${desc(a)} and ${desc(b)} cannot be multiplied`);
}
const splitStr = (s, sep) => s === '' ? [] : sep === '' ? [...s] : s.split(sep);
function div(a, b) {
  const ta = type(a), tb = type(b);
  if (ta === 'number' && tb === 'number') {
    if (b === 0) throw new JqError(`${desc(a)} and ${desc(b)} cannot be divided because the divisor is zero`);
    return a / b;
  }
  if (ta === 'string' && tb === 'string') return splitStr(a, b);
  throw new JqError(`${desc(a)} and ${desc(b)} cannot be divided`);
}
function mod(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number') throw new JqError(`${desc(a)} and ${desc(b)} cannot be divided`);
  const x = Math.trunc(a), y = Math.trunc(b);
  if (y === 0) throw new JqError(`${desc(a)} and ${desc(b)} cannot be divided because the divisor is zero`);
  return x % y;
}
function binop(op, a, b) {
  switch (op) {
    case '+': return add(a, b);
    case '-': return sub(a, b);
    case '*': return mul(a, b);
    case '/': return div(a, b);
    case '%': return mod(a, b);
    case '==': return cmp(a, b) === 0;
    case '!=': return cmp(a, b) !== 0;
    case '<': return cmp(a, b) < 0;
    case '<=': return cmp(a, b) <= 0;
    case '>': return cmp(a, b) > 0;
    case '>=': return cmp(a, b) >= 0;
  }
  throw new JqError('unknown operator ' + op);
}

// ---------------------------------------------------------------- indexing & paths
function sliceRange(n, from, to) {
  let a = from == null ? 0 : from, b = to == null ? n : to;
  if (typeof a !== 'number' || typeof b !== 'number') throw new JqError('Start and end indices of an array slice must be numbers');
  a = Math.floor(a); b = Math.ceil(b);
  if (a < 0) a += n;
  if (b < 0) b += n;
  a = Math.min(Math.max(a, 0), n);
  b = Math.min(Math.max(b, a), n);
  return [a, b];
}
function slice(v, from, to) {
  if (v === null) return null;
  if (typeof v !== 'string' && !Array.isArray(v)) throw new JqError(`Cannot index ${type(v)} with object`);
  const [a, b] = sliceRange(v.length, from, to);
  return v.slice(a, b);
}
function indices(v, x) {
  if (v === null) return null;
  if (typeof v === 'string' && typeof x === 'string') {
    if (x === '') return null;
    const out = []; let i = v.indexOf(x);
    while (i !== -1) { out.push(i); i = v.indexOf(x, i + 1); }
    return out;
  }
  if (Array.isArray(v)) {
    const out = [];
    if (Array.isArray(x)) {
      if (x.length === 0) return null;
      for (let i = 0; i + x.length <= v.length; i++) if (x.every((y, j) => cmp(v[i + j], y) === 0)) out.push(i);
    } else v.forEach((y, i) => { if (cmp(y, x) === 0) out.push(i); });
    return out;
  }
  throw new JqError(`Cannot determine indices of ${type(x)} in ${type(v)}`);
}
function idx(v, k) {
  if (typeof k === 'string') {
    if (v === null) return null;
    if (isObj(v)) return hasOwn(v, k) ? v[k] : null;
    throw new JqError(`Cannot index ${type(v)} with "${k}"`);
  }
  if (typeof k === 'number') {
    if (v === null) return null;
    if (Array.isArray(v)) { let i = Math.floor(k); if (i < 0) i += v.length; return i >= 0 && i < v.length ? v[i] : null; }
    throw new JqError(`Cannot index ${type(v)} with number`);
  }
  if (isObj(k) && (v === null || Array.isArray(v) || typeof v === 'string')) return slice(v, k.start, k.end);
  if (Array.isArray(k) && Array.isArray(v)) return indices(v, k);
  throw new JqError(`Cannot index ${type(v)} with ${type(k)}`);
}
function getpath(v, p) {
  for (const k of p) { if (v === null) return null; v = idx(v, k); }
  return v;
}
// copy-on-write setpath; containers in `own` were already copied by this operation and may be mutated
function setpathM(v, p, i, nv, own) {
  if (i === p.length) return nv;
  const k = p[i];
  if (typeof k === 'string') {
    if (v === null) v = {}; else if (!isObj(v)) throw new JqError(`Cannot index ${type(v)} with "${k}"`);
    if (!own.has(v)) { v = Object.assign({}, v); own.add(v); }
    setk(v, k, setpathM(hasOwn(v, k) ? v[k] : null, p, i + 1, nv, own));
    return v;
  }
  if (typeof k === 'number') {
    if (v === null) v = []; else if (!Array.isArray(v)) throw new JqError(`Cannot index ${type(v)} with number`);
    if (!own.has(v)) { v = v.slice(); own.add(v); }
    let j = Math.floor(k);
    if (j < 0) { j += v.length; if (j < 0) throw new JqError('Out of bounds negative array index'); }
    const r = setpathM(j < v.length ? v[j] : null, p, i + 1, nv, own);
    while (v.length < j) v.push(null);
    v[j] = r;
    return v;
  }
  if (isObj(k)) {
    if (v !== null && !Array.isArray(v)) throw new JqError(`Cannot update field at object index of ${type(v)}`);
    const a = v || [], [s, e] = sliceRange(a.length, k.start, k.end);
    const r = setpathM(a.slice(s, e), p, i + 1, nv, own);
    if (!Array.isArray(r)) throw new JqError('A slice of an array can only be assigned another array');
    return a.slice(0, s).concat(r, a.slice(e));
  }
  throw new JqError(`Invalid path component ${tojson(k)}`);
}
function delpaths(v, paths) {
  if (v === null || paths.length === 0) return v;
  if (paths.some(p => p.length === 0)) return null;
  const isArr = Array.isArray(v);
  if (!isArr && !isObj(v)) throw new JqError(`Cannot delete field at ${type(v)} index`);
  const del = new Set(), rest = new Map();
  for (const p of paths) {
    let k = p[0];
    if (isArr) {
      if (typeof k === 'number') { k = Math.floor(k); if (k < 0) k += v.length; if (k < 0 || k >= v.length) continue; }
      else if (isObj(k)) {
        const [s, e] = sliceRange(v.length, k.start, k.end);
        if (p.length === 1) for (let i = s; i < e; i++) del.add(i);
        continue;
      } else throw new JqError(`Cannot delete field at object index of array`);
    } else if (typeof k !== 'string') throw new JqError(`Cannot delete field at array index of object`);
    if (p.length === 1) del.add(k);
    else { let l = rest.get(k); if (!l) rest.set(k, l = []); l.push(p.slice(1)); }
  }
  if (isArr) {
    const out = [];
    for (let i = 0; i < v.length; i++) {
      if (del.has(i)) continue;
      out.push(rest.has(i) ? delpaths(v[i], rest.get(i)) : v[i]);
    }
    return out;
  }
  const out = {};
  for (const k of Object.keys(v)) {
    if (del.has(k)) continue;
    setk(out, k, rest.has(k) ? delpaths(v[k], rest.get(k)) : v[k]);
  }
  return out;
}

// ---------------------------------------------------------------- lexer / parser
const KW = new Set(['def', 'if', 'then', 'elif', 'else', 'end', 'as', 'reduce', 'foreach', 'try', 'catch', 'label', 'and', 'or', 'import', 'include']);
const OPS = ['?//', '//=', '|=', '+=', '-=', '*=', '/=', '%=', '==', '!=', '<=', '>=', '//', '..', '|', ',', '=', '<', '>', '+', '-', '*', '/', '%', '?', '(', ')', '[', ']', '{', '}', ':', ';', '.'];
const BIN = {
  ',': [1, 'L'], '//': [2, 'R'],
  '=': [3, 'N'], '|=': [3, 'N'], '+=': [3, 'N'], '-=': [3, 'N'], '*=': [3, 'N'], '/=': [3, 'N'], '%=': [3, 'N'], '//=': [3, 'N'],
  'or': [4, 'L'], 'and': [5, 'L'],
  '==': [6, 'N'], '!=': [6, 'N'], '<': [6, 'N'], '<=': [6, 'N'], '>': [6, 'N'], '>=': [6, 'N'],
  '+': [7, 'L'], '-': [7, 'L'], '*': [8, 'L'], '/': [8, 'L'], '%': [8, 'L'],
};
const ID = { t: 'id', s: true };
const lit = v => ({ t: 'lit', v, s: true });
const idxNode = (e, k) => ({ t: 'idx', e, k, s: !!(e.s && k.s) });
const NUM = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const IDENT = /[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*/y;

class Parser {
  constructor(src, i = 0) { this.s = src; this.i = i; this.tok = null; this.end = i; }
  err(m) { throw new JqError(`syntax error: ${m} (at position ${this.i})`); }
  lex() {
    const s = this.s; let i = this.i;
    for (;;) {
      while (i < s.length && s.charCodeAt(i) <= 32) i++;
      if (s[i] === '#') { while (i < s.length && s[i] !== '\n') i++; } else break;
    }
    if (i >= s.length) { this.end = i; return { t: 'eof' }; }
    const c = s[i];
    if (c === '"') return this.lexStr(i);
    NUM.lastIndex = i;
    if ((c >= '0' && c <= '9') || (c === '.' && s[i + 1] >= '0' && s[i + 1] <= '9')) {
      const m = NUM.exec(s); this.end = i + m[0].length; return { t: 'num', v: parseFloat(m[0]) };
    }
    if (c === '$' || c === '@') {
      IDENT.lastIndex = i + 1; const m = IDENT.exec(s);
      if (!m) this.err('bad name');
      this.end = i + 1 + m[0].length; return { t: c === '$' ? 'var' : 'fmt', v: m[0] };
    }
    IDENT.lastIndex = i;
    let m = IDENT.exec(s);
    if (m) { this.end = i + m[0].length; return { t: 'id', v: m[0] }; }
    if (c === '.' && s[i + 1] !== '.') {
      IDENT.lastIndex = i + 1; m = IDENT.exec(s);
      if (m) { this.end = i + 1 + m[0].length; return { t: 'field', v: m[0] }; }
    }
    for (const op of OPS) if (s.startsWith(op, i)) { this.end = i + op.length; return { t: 'op', v: op }; }
    this.err(`unexpected character '${c}'`);
  }
  lexStr(i) {
    const s = this.s; i++;
    const parts = []; let cur = '';
    for (;;) {
      if (i >= s.length) this.err('unterminated string');
      const c = s[i];
      if (c === '"') { i++; break; }
      if (c === '\\') {
        const d = s[i + 1]; i += 2;
        switch (d) {
          case 'n': cur += '\n'; break; case 't': cur += '\t'; break; case 'r': cur += '\r'; break;
          case 'b': cur += '\b'; break; case 'f': cur += '\f'; break; case '/': cur += '/'; break;
          case '\\': cur += '\\'; break; case '"': cur += '"'; break;
          case 'u': cur += String.fromCharCode(parseInt(s.slice(i, i + 4), 16)); i += 4; break;
          case '(': {
            if (cur) { parts.push(cur); cur = ''; }
            const sub = new Parser(s, i); parts.push(sub.pipe()); sub.expect(')'); i = sub.i; break;
          }
          default: this.err('invalid escape');
        }
      } else { cur += c; i++; }
    }
    if (cur || !parts.length) parts.push(cur);
    this.end = i;
    return { t: 'str', parts };
  }
  peek() { if (!this.tok) this.tok = this.lex(); return this.tok; }
  next() { const t = this.peek(); this.tok = null; this.i = this.end; return t; }
  isOp(v) { const t = this.peek(); return t.t === 'op' && t.v === v; }
  isId(v) { const t = this.peek(); return t.t === 'id' && t.v === v; }
  accept(v) { if (this.isOp(v)) { this.next(); return true; } return false; }
  expect(v) { if (!this.accept(v)) this.err(`expected '${v}'`); }
  expectId(v) { if (!this.isId(v)) this.err(`expected '${v}'`); this.next(); }

  program() {
    if (this.peek().t === 'eof') return ID;
    const e = this.pipe();
    if (this.peek().t !== 'eof') this.err('unexpected token');
    return e;
  }
  funcdef() {
    this.next();
    const nt = this.next(); if (nt.t !== 'id') this.err('bad function name');
    const params = [];
    if (this.accept('(')) {
      do {
        const t = this.next();
        if (t.t === 'id') params.push(t.v); else if (t.t === 'var') params.push('$' + t.v); else this.err('bad parameter');
      } while (this.accept(';'));
      this.expect(')');
    }
    this.expect(':');
    const body = this.pipe(); this.expect(';');
    return { t: 'def', name: nt.v, params, body, rest: null };
  }
  pipe() {
    if (this.isId('def')) {
      const d = this.funcdef();
      d.rest = (this.peek().t === 'eof' || this.isOp(')')) ? ID : this.pipe();
      return d;
    }
    if (this.isId('label')) {
      this.next(); const v = this.next(); if (v.t !== 'var') this.err('expected label name');
      this.expect('|'); return { t: 'label', name: v.v, body: this.pipe() };
    }
    const l = this.bin(1);
    if (this.accept('|')) return { t: 'pipe', l, r: this.pipe() };
    return l;
  }
  bin(min) {
    let l = this.unary();
    for (;;) {
      const t = this.peek(); let op;
      if (t.t === 'op' && BIN[t.v]) op = t.v;
      else if (t.t === 'id' && (t.v === 'and' || t.v === 'or')) op = t.v;
      else break;
      const [prec, assoc] = BIN[op];
      if (prec < min) break;
      this.next();
      const r = this.bin(assoc === 'R' ? prec : prec + 1);
      if (op === ',') l = { t: 'comma', l, r };
      else if (op === '//') l = { t: 'alt', l, r };
      else if (op === 'and' || op === 'or') l = { t: op, l, r };
      else if (prec === 3) l = { t: 'assign', op, l, r };
      else l = { t: 'bin', op, l, r, s: !!(l.s && r.s) };
    }
    return l;
  }
  unary() {
    if (this.isOp('-')) { this.next(); return { t: 'neg', e: this.unary() }; }
    return this.postfix(false);
  }
  postfix(noAs) {
    let e = this.primary();
    for (;;) {
      const t = this.peek();
      if (t.t === 'field') { this.next(); e = idxNode(e, lit(t.v)); }
      else if (t.t === 'op' && t.v === '.') {
        this.next(); const u = this.peek();
        if (u.t === 'str') { this.next(); e = idxNode(e, this.strNode(u)); }
        else if (!(u.t === 'op' && u.v === '[')) this.err('unexpected .');
      }
      else if (t.t === 'op' && t.v === '[') { this.next(); e = this.bracket(e); }
      else if (t.t === 'op' && t.v === '?') { this.next(); e = { t: 'try', body: e, handler: null }; }
      else break;
    }
    if (!noAs && this.isId('as')) {
      this.next();
      const pats = [this.pattern()];
      if (this.isOp('?//')) this.err('destructuring alternatives (?//) are not supported');
      this.expect('|');
      return { t: 'as', src: e, pat: pats[0], body: this.pipe() };
    }
    return e;
  }
  bracket(e) {
    if (this.accept(']')) return { t: 'iter', e };
    if (this.accept(':')) { const to = this.pipe(); this.expect(']'); return { t: 'slice', e, from: null, to }; }
    const k = this.pipe();
    if (this.accept(':')) {
      if (this.accept(']')) return { t: 'slice', e, from: k, to: null };
      const to = this.pipe(); this.expect(']'); return { t: 'slice', e, from: k, to };
    }
    this.expect(']');
    return idxNode(e, k);
  }
  strNode(t, fmt) {
    if (t.parts.length === 1 && typeof t.parts[0] === 'string' && !fmt) return lit(t.parts[0]);
    return { t: 'str', parts: t.parts, fmt: fmt || null };
  }
  primary() {
    const t = this.next();
    switch (t.t) {
      case 'num': return lit(t.v);
      case 'str': return this.strNode(t);
      case 'fmt': {
        if (this.peek().t === 'str') return this.strNode(this.next(), t.v);
        return { t: 'fmt', name: t.v };
      }
      case 'field': return idxNode(ID, lit(t.v));
      case 'var': return t.v === '__loc__' ? lit({ file: '<top-level>', line: 1 }) : { t: 'var', name: t.v };
      case 'id': return this.identPrimary(t.v);
      case 'op':
        switch (t.v) {
          case '.': {
            const u = this.peek();
            if (u.t === 'str') { this.next(); return idxNode(ID, this.strNode(u)); }
            return ID;
          }
          case '..': return { t: 'call', name: 'recurse', args: [] };
          case '(': { const e = this.pipe(); this.expect(')'); return e; }
          case '[': {
            if (this.accept(']')) return { t: 'arr', e: null };
            const e = this.pipe(); this.expect(']'); return { t: 'arr', e };
          }
          case '{': return this.object();
        }
    }
    this.err('unexpected token');
  }
  identPrimary(name) {
    switch (name) {
      case 'true': return lit(true);
      case 'false': return lit(false);
      case 'null': return lit(null);
      case 'if': return this.ifExpr();
      case 'try': {
        const body = this.postfix(true); let handler = null;
        if (this.isId('catch')) { this.next(); handler = this.postfix(true); }
        return { t: 'try', body, handler };
      }
      case 'reduce': {
        const src = this.postfix(true); this.expectId('as'); const pat = this.pattern();
        this.expect('('); const init = this.pipe(); this.expect(';'); const upd = this.pipe(); this.expect(')');
        return { t: 'reduce', src, pat, init, upd };
      }
      case 'foreach': {
        const src = this.postfix(true); this.expectId('as'); const pat = this.pattern();
        this.expect('('); const init = this.pipe(); this.expect(';'); const upd = this.pipe();
        const ext = this.accept(';') ? this.pipe() : null; this.expect(')');
        return { t: 'foreach', src, pat, init, upd, ext };
      }
      case 'break': { const v = this.next(); if (v.t !== 'var') this.err('break requires a label'); return { t: 'break', name: v.v }; }
    }
    if (KW.has(name)) this.err(`unexpected keyword '${name}'`);
    const args = [];
    if (this.accept('(')) { do { args.push(this.pipe()); } while (this.accept(';')); this.expect(')'); }
    return { t: 'call', name, args };
  }
  ifExpr() {
    const cond = this.pipe(); this.expectId('then'); const th = this.pipe(); let el = null;
    if (this.isId('elif')) { this.next(); return { t: 'if', cond, th, el: this.ifExpr() }; }
    if (this.isId('else')) { this.next(); el = this.pipe(); }
    this.expectId('end');
    return { t: 'if', cond, th, el };
  }
  object() {
    const ents = [];
    if (this.accept('}')) return { t: 'obj', ents };
    do {
      let k, v = null; const t = this.peek();
      if (t.t === 'var') { this.next(); k = lit(t.v); v = { t: 'var', name: t.v }; }
      else if (t.t === 'id') { this.next(); k = lit(t.v); }
      else if (t.t === 'num') { this.next(); k = lit(String(t.v)); }
      else if (t.t === 'str') { this.next(); k = this.strNode(t); }
      else if (t.t === 'fmt') { this.next(); const u = this.next(); if (u.t !== 'str') this.err('bad object key'); k = this.strNode(u, t.v); }
      else if (t.t === 'op' && t.v === '(') { this.next(); k = this.pipe(); this.expect(')'); }
      else this.err('bad object key');
      if (this.accept(':')) v = this.objVal();
      else if (!v) v = idxNode(ID, k);
      ents.push({ k, v });
    } while (this.accept(','));
    this.expect('}');
    return { t: 'obj', ents };
  }
  objVal() {
    let l = this.bin(2);
    while (this.accept('|')) l = { t: 'pipe', l, r: this.bin(2) };
    return l;
  }
  pattern() {
    const t = this.next();
    if (t.t === 'var') return { t: 'pvar', name: t.v };
    if (t.t === 'op' && t.v === '[') {
      const items = [];
      do { items.push(this.pattern()); } while (this.accept(','));
      this.expect(']');
      return { t: 'parr', items };
    }
    if (t.t === 'op' && t.v === '{') {
      const ents = [];
      do {
        const u = this.next(); let key, vname = null, sub = null;
        if (u.t === 'var') { key = lit(u.v); vname = u.v; }
        else if (u.t === 'id') key = lit(u.v);
        else if (u.t === 'str') key = this.strNode(u);
        else if (u.t === 'op' && u.v === '(') { key = this.pipe(); this.expect(')'); }
        else this.err('bad pattern');
        if (this.accept(':')) sub = this.pattern();
        ents.push({ key, vname, sub });
      } while (this.accept(','));
      this.expect('}');
      return { t: 'pobj', ents };
    }
    this.err('bad pattern');
  }
}

// ---------------------------------------------------------------- environment
// Linked frames: {k:'var',name,val,p} | {k:'fn',name,arity,params,body,cenv,p} | {k:'label',name,id,p}
function lookupVar(env, name) {
  for (let f = env; f; f = f.p) if (f.k === 'var' && f.name === name) return f.val;
  if (name === 'ENV') return {};
  throw new JqError(`$${name} is not defined`);
}
function lookupLabel(env, name) {
  for (let f = env; f; f = f.p) if (f.k === 'label' && f.name === name) return f.id;
  throw new JqError(`$*label-${name} is not defined`);
}

// ---------------------------------------------------------------- evaluator
const iterVals = v => {
  if (Array.isArray(v)) return v;
  if (isObj(v)) return Object.values(v);
  throw new JqError(`Cannot iterate over ${desc(v)}`);
};
function* iterate(t) {
  if (Array.isArray(t)) yield* t;
  else if (isObj(t)) yield* Object.values(t);
  else throw new JqError(`Cannot iterate over ${desc(t)}`);
}
// simple nodes (id / literal / idx chains of those) are evaluated without generators
function sv(n, v) {
  switch (n.t) {
    case 'id': return v;
    case 'lit': return n.v;
    case 'bin': return binop(n.op, sv(n.l, v), sv(n.r, v));
    default: return idx(sv(n.e, v), sv(n.k, v));
  }
}
function* strParts(parts, i, acc, v, env, fmt) {
  if (i === parts.length) { yield acc; return; }
  const p = parts[i];
  if (typeof p === 'string') yield* strParts(parts, i + 1, acc + p, v, env, fmt);
  else for (const x of ev(p, v, env)) yield* strParts(parts, i + 1, acc + (fmt ? applyFormat(fmt, x) : tostr(x)), v, env, fmt);
}
function* mkobj(ents, i, acc, v, env) {
  if (i === ents.length) { yield acc; return; }
  const { k, v: vn } = ents[i];
  for (const kk of ev(k, v, env)) {
    if (typeof kk !== 'string') throw new JqError(`Object keys must be strings`);
    for (const vv of ev(vn, v, env)) {
      const o = Object.assign({}, acc); setk(o, kk, vv);
      yield* mkobj(ents, i + 1, o, v, env);
    }
  }
}
function* bindPat(p, x, env, v) {
  switch (p.t) {
    case 'pvar': yield { k: 'var', name: p.name, val: x, p: env }; return;
    case 'parr':
      if (x !== null && !Array.isArray(x)) throw new JqError(`Cannot index ${type(x)} with number`);
      yield* bindArr(p.items, 0, x, env, v); return;
    case 'pobj': yield* bindObj(p.ents, 0, x, env, v); return;
  }
}
function* bindArr(items, i, x, env, v) {
  if (i === items.length) { yield env; return; }
  for (const e of bindPat(items[i], x === null ? null : (x[i] === undefined ? null : x[i]), env, v)) yield* bindArr(items, i + 1, x, e, v);
}
function* bindObj(ents, i, x, env, v) {
  if (i === ents.length) { yield env; return; }
  const { key, vname, sub } = ents[i];
  for (const k of ev(key, v, env)) {
    if (typeof k !== 'string') throw new JqError(`Cannot index ${type(x)} with ${type(k)}`);
    const val = idx(x, k); let e = env;
    if (vname) e = { k: 'var', name: vname, val, p: e };
    if (sub) { for (const e2 of bindPat(sub, val, e, v)) yield* bindObj(ents, i + 1, x, e2, v); }
    else yield* bindObj(ents, i + 1, x, e, v);
  }
}
function modify(lhs, v, env, fn) {
  let out = v; const own = new Set(), dels = [];
  for (const [, p] of evp(lhs, [v, []], env)) {
    const [ok, nv] = fn(getpath(out, p));
    if (ok) out = setpathM(out, p, 0, nv, own); else dels.push(p);
  }
  return dels.length ? delpaths(out, dels) : out;
}
function* assign(n, v, env) {
  const op = n.op;
  if (op === '|=') {
    yield modify(n.l, v, env, cur => { for (const r of ev(n.r, cur, env)) return [true, r]; return [false]; });
    return;
  }
  if (op === '=') {
    for (const x of ev(n.r, v, env)) {
      let out = v; const own = new Set();
      for (const [, p] of evp(n.l, [v, []], env)) out = setpathM(out, p, 0, x, own);
      yield out;
    }
    return;
  }
  const bop = op.slice(0, -1);
  for (const x of ev(n.r, v, env))
    yield modify(n.l, v, env, cur => [true, bop === '//' ? (truthy(cur) ? cur : x) : binop(bop, cur, x)]);
}

function* ev(n, v, env) {
  switch (n.t) {
    case 'id': yield v; return;
    case 'lit': yield n.v; return;
    case 'idx':
      if (n.s) { yield sv(n, v); return; }
      for (const t of ev(n.e, v, env)) for (const k of ev(n.k, v, env)) yield idx(t, k);
      return;
    case 'slice':
      for (const t of ev(n.e, v, env))
        for (const to of n.to ? ev(n.to, v, env) : [null])
          for (const from of n.from ? ev(n.from, v, env) : [null]) yield slice(t, from, to);
      return;
    case 'iter':
      for (const t of ev(n.e, v, env)) yield* iterate(t);
      return;
    case 'pipe':
      if (n.l.s) { yield* ev(n.r, sv(n.l, v), env); return; }
      for (const x of ev(n.l, v, env)) yield* ev(n.r, x, env);
      return;
    case 'comma': yield* ev(n.l, v, env); yield* ev(n.r, v, env); return;
    case 'neg':
      for (const x of ev(n.e, v, env)) {
        if (typeof x !== 'number') throw new JqError(`${desc(x)} cannot be negated`);
        yield -x;
      }
      return;
    case 'bin':
      if (n.s) { yield binop(n.op, sv(n.l, v), sv(n.r, v)); return; }
      for (const r of ev(n.r, v, env)) for (const l of ev(n.l, v, env)) yield binop(n.op, l, r);
      return;
    case 'and':
      for (const l of ev(n.l, v, env)) {
        if (!truthy(l)) yield false;
        else for (const r of ev(n.r, v, env)) yield truthy(r);
      }
      return;
    case 'or':
      for (const l of ev(n.l, v, env)) {
        if (truthy(l)) yield true;
        else for (const r of ev(n.r, v, env)) yield truthy(r);
      }
      return;
    case 'alt': {
      let any = false;
      try { for (const x of ev(n.l, v, env)) if (truthy(x)) { any = true; yield x; } }
      catch (e) { if (!(e instanceof JqError)) throw e; }
      if (!any) yield* ev(n.r, v, env);
      return;
    }
    case 'if':
      for (const c of ev(n.cond, v, env)) {
        if (truthy(c)) yield* ev(n.th, v, env);
        else if (n.el) yield* ev(n.el, v, env);
        else yield v;
      }
      return;
    case 'arr': {
      const out = [];
      if (n.e) for (const x of ev(n.e, v, env)) out.push(x);
      yield out; return;
    }
    case 'obj': yield* mkobj(n.ents, 0, {}, v, env); return;
    case 'var': yield lookupVar(env, n.name); return;
    case 'str': yield* strParts(n.parts, 0, '', v, env, n.fmt); return;
    case 'fmt': yield applyFormat(n.name, v); return;
    case 'try':
      try { for (const x of ev(n.body, v, env)) yield x; }
      catch (e) {
        if (!(e instanceof JqError)) throw e;
        if (n.handler) yield* ev(n.handler, e.val, env);
      }
      return;
    case 'reduce':
      for (const init of ev(n.init, v, env)) {
        let acc = init;
        for (const x of ev(n.src, v, env)) for (const e2 of bindPat(n.pat, x, env, v)) {
          let last = null;
          for (const r of ev(n.upd, acc, e2)) last = r;
          acc = last;
        }
        yield acc;
      }
      return;
    case 'foreach':
      for (const init of ev(n.init, v, env)) {
        let st = init;
        for (const x of ev(n.src, v, env)) for (const e2 of bindPat(n.pat, x, env, v))
          for (const r of ev(n.upd, st, e2)) { st = r; if (n.ext) yield* ev(n.ext, r, e2); else yield r; }
      }
      return;
    case 'as':
      for (const x of ev(n.src, v, env)) for (const e2 of bindPat(n.pat, x, env, v)) yield* ev(n.body, v, e2);
      return;
    case 'label': {
      const id = {};
      try { yield* ev(n.body, v, { k: 'label', name: n.name, id, p: env }); }
      catch (e) { if (!(e instanceof Break && e.id === id)) throw e; }
      return;
    }
    case 'break': throw new Break(lookupLabel(env, n.name));
    case 'def': {
      const f = { k: 'fn', name: n.name, arity: n.params.length, params: n.params, body: n.body, cenv: null, p: env };
      f.cenv = f;
      yield* ev(n.rest, v, f); return;
    }
    case 'assign': yield* assign(n, v, env); return;
    case 'call': yield* call(n, v, env, false); return;
  }
  throw new JqError('cannot evaluate ' + n.t);
}

// path-tracking evaluator: yields [value, path]
function* evp(n, vp, env) {
  const v = vp[0];
  switch (n.t) {
    case 'id': yield vp; return;
    case 'idx':
      for (const [t, tp] of evp(n.e, vp, env)) for (const k of ev(n.k, v, env)) yield [idx(t, k), tp.concat([k])];
      return;
    case 'slice':
      for (const [t, tp] of evp(n.e, vp, env))
        for (const to of n.to ? ev(n.to, v, env) : [null])
          for (const from of n.from ? ev(n.from, v, env) : [null])
            yield [slice(t, from, to), tp.concat([{ start: from, end: to }])];
      return;
    case 'iter':
      for (const [t, tp] of evp(n.e, vp, env)) {
        if (Array.isArray(t)) for (let i = 0; i < t.length; i++) yield [t[i], tp.concat([i])];
        else if (isObj(t)) for (const k of Object.keys(t)) yield [t[k], tp.concat([k])];
        else throw new JqError(`Cannot iterate over ${desc(t)}`);
      }
      return;
    case 'pipe': for (const x of evp(n.l, vp, env)) yield* evp(n.r, x, env); return;
    case 'comma': yield* evp(n.l, vp, env); yield* evp(n.r, vp, env); return;
    case 'if':
      for (const c of ev(n.cond, v, env)) {
        if (truthy(c)) yield* evp(n.th, vp, env);
        else if (n.el) yield* evp(n.el, vp, env);
        else yield vp;
      }
      return;
    case 'alt': {
      let any = false;
      try { for (const x of evp(n.l, vp, env)) if (truthy(x[0])) { any = true; yield x; } }
      catch (e) { if (!(e instanceof JqError)) throw e; }
      if (!any) yield* evp(n.r, vp, env);
      return;
    }
    case 'try':
      if (n.handler) break;
      try { for (const x of evp(n.body, vp, env)) yield x; }
      catch (e) { if (!(e instanceof JqError)) throw e; }
      return;
    case 'as':
      for (const x of ev(n.src, v, env)) for (const e2 of bindPat(n.pat, x, env, v)) yield* evp(n.body, vp, e2);
      return;
    case 'def': {
      const f = { k: 'fn', name: n.name, arity: n.params.length, params: n.params, body: n.body, cenv: null, p: env };
      f.cenv = f;
      yield* evp(n.rest, vp, f); return;
    }
    case 'call': yield* call(n, vp, env, true); return;
  }
  throw new JqError(`Invalid path expression with result ${trunc(tojson(v))}`);
}

function* callUser(f, args, input, callerEnv, pm) {
  let scope = f.cenv; const dollar = [];
  f.params.forEach((pn, i) => {
    if (pn[0] === '$') dollar.push(i);
    else scope = { k: 'fn', name: pn, arity: 0, params: [], body: args[i], cenv: callerEnv, p: scope };
  });
  yield* withDollar(f, args, input, callerEnv, scope, dollar, 0, pm);
}
function* withDollar(f, args, input, callerEnv, scope, dollar, j, pm) {
  if (j === dollar.length) { yield* (pm ? evp(f.body, input, scope) : ev(f.body, input, scope)); return; }
  const i = dollar[j], pn = f.params[i].slice(1);
  for (const x of ev(args[i], pm ? input[0] : input, callerEnv)) {
    const s2 = { k: 'var', name: pn, val: x, p: { k: 'fn', name: pn, arity: 0, params: [], body: lit(x), cenv: null, p: scope } };
    yield* withDollar(f, args, input, callerEnv, s2, dollar, j + 1, pm);
  }
}
function* call(n, input, env, pm) {
  const ar = n.args.length;
  for (let f = env; f; f = f.p) if (f.k === 'fn' && f.name === n.name && f.arity === ar) { yield* callUser(f, n.args, input, env, pm); return; }
  const key = n.key || (n.key = n.name + '/' + ar);
  const u = P[key];
  if (u) { yield* callUser(u, n.args, input, env, pm); return; }
  if (pm) {
    const pf = PB[key];
    if (pf) { yield* pf(env, n.args, input); return; }
    if (B[key]) throw new JqError(`Invalid path expression with result ${trunc(tojson(input[0]))}`);
  } else {
    const nf = B[key];
    if (nf) { yield* nf(env, n.args, input); return; }
  }
  throw new JqError(`${key} is not defined`);
}

// ---------------------------------------------------------------- formats
const b64 = s => {
  const b = new TextEncoder().encode(s); let r = '';
  for (let i = 0; i < b.length; i += 0x8000) r += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(r);
};
const unb64 = s => {
  let r; try { r = atob(s.replace(/\s+/g, '')); } catch (_) { throw new JqError(`${desc(s)} is not valid base64 data`); }
  return new TextDecoder().decode(Uint8Array.from(r, c => c.charCodeAt(0)));
};
function sh1(x) {
  if (typeof x === 'string') return "'" + x.replace(/'/g, "'\\''") + "'";
  if (x !== null && typeof x === 'object') throw new JqError(`${desc(x)} can not be escaped for shell`);
  return tojson(x);
}
function csv(a, tsv) {
  if (!Array.isArray(a)) throw new JqError(`${desc(a)} cannot be ${tsv ? 'tsv' : 'csv'}-formatted, only an array can be`);
  return a.map(x => {
    switch (type(x)) {
      case 'number': return tojson(x);
      case 'boolean': return x ? 'true' : 'false';
      case 'null': return '';
      case 'string': return tsv ? x.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r') : '"' + x.replace(/"/g, '""') + '"';
      default: throw new JqError(`${desc(x)} is not valid in a csv row`);
    }
  }).join(tsv ? '\t' : ',');
}
function applyFormat(name, x) {
  switch (name) {
    case 'text': return tostr(x);
    case 'json': return tojson(x);
    case 'csv': return csv(x, false);
    case 'tsv': return csv(x, true);
    case 'html': return tostr(x).replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&#39;', '"': '&quot;' }[c]));
    case 'uri': return encodeURIComponent(tostr(x)).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
    case 'sh': return Array.isArray(x) ? x.map(sh1).join(' ') : sh1(x);
    case 'base64': return b64(tostr(x));
    case 'base64d': return unb64(tostr(x));
  }
  throw new JqError(`${name} is not a valid format`);
}

// ---------------------------------------------------------------- regex
function groupNames(re) {
  const names = []; let i = 0, cls = false;
  while (i < re.length) {
    const c = re[i];
    if (c === '\\') { i += 2; continue; }
    if (cls) { if (c === ']') cls = false; i++; continue; }
    if (c === '[') { cls = true; i++; continue; }
    if (c === '(') {
      if (re[i + 1] === '?') { const m = /^\(\?<([A-Za-z_]\w*)>/.exec(re.slice(i, i + 80)); if (m) names.push(m[1]); }
      else names.push(null);
    }
    i++;
  }
  return names;
}
function matches(s, re, flags) {
  if (Array.isArray(re)) { flags = re[1]; re = re[0]; }
  if (typeof s !== 'string') throw new JqError(`${desc(s)} cannot be matched, as it is not a string`);
  if (typeof re !== 'string') throw new JqError(`${desc(re)} cannot be matched, as it is not a string`);
  let f = 'd', global = false, skip = false;
  for (const c of (flags || '')) {
    switch (c) {
      case 'g': global = true; break;
      case 'i': f += 'i'; break;
      case 'x': re = re.replace(/\\.|\s+|#.*$/gm, m => m[0] === '\\' ? m : ''); break;
      case 's': case 'p': f += 's'; break;
      case 'n': skip = true; break;
      case 'l': break;
      default: throw new JqError(`${flags} is not a valid modifier string`);
    }
  }
  let R;
  try { R = new RegExp(re, f + 'g'); } catch (e) { throw new JqError(`${re} (at offset 0) is not a valid regex: ${e.message}`); }
  const names = groupNames(re), out = []; let m;
  while ((m = R.exec(s))) {
    const empty = m[0] === '';
    if (empty) R.lastIndex++;
    if (!(empty && skip)) {
      out.push({
        offset: m.index, length: m[0].length, string: m[0],
        captures: m.slice(1).map((c, i) => ({
          offset: c === undefined ? -1 : m.indices[i + 1][0], length: c === undefined ? 0 : c.length,
          string: c === undefined ? null : c, name: names[i] || null,
        })),
      });
    }
    if (!global) break;
  }
  return out;
}
const capObj = m => { const o = {}; for (const c of m.captures) if (c.name) setk(o, c.name, c.string); return o; };

// ---------------------------------------------------------------- builtins
const B = Object.create(null);   // value mode
const PB = Object.create(null);  // path mode (natives that can produce paths)
const P = Object.create(null);   // jq-defined prelude functions

const d0 = (n, f) => { B[n + '/0'] = function* (e, a, v) { yield f(v); }; };
const d1 = (n, f) => { B[n + '/1'] = function* (e, a, v) { for (const x of ev(a[0], v, e)) yield f(v, x); }; };
const d2 = (n, f) => { B[n + '/2'] = function* (e, a, v) { for (const x of ev(a[0], v, e)) for (const y of ev(a[1], v, e)) yield f(v, x, y); }; };
const num = v => { if (typeof v !== 'number') throw new JqError(`${desc(v)} number required`); return v; };
const str = (v, what) => { if (typeof v !== 'string') throw new JqError(`${desc(v)} ${what}`); return v; };
const arr = (v, what) => { if (!Array.isArray(v)) throw new JqError(`${desc(v)} ${what}`); return v; };

for (const m of ['floor', 'ceil', 'sqrt', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh', 'exp', 'log', 'log2', 'log10', 'cbrt', 'trunc'])
  d0(m, v => Math[m](num(v)));
d0('round', v => Math.sign(num(v)) * Math.round(Math.abs(v)));
d0('fabs', v => Math.abs(num(v)));
d0('abs', v => Math.abs(num(v)));
d0('exp2', v => 2 ** num(v));
d0('exp10', v => 10 ** num(v));
d2('pow', (v, a, b) => num(a) ** num(b));
d2('atan2', (v, a, b) => Math.atan2(num(a), num(b)));
d2('fmin', (v, a, b) => Math.min(a, b));
d2('fmax', (v, a, b) => Math.max(a, b));
d0('infinite', () => Infinity);
d0('nan', () => NaN);
d0('isinfinite', v => num(v) === Infinity || v === -Infinity);
d0('isnan', v => Number.isNaN(num(v)));
d0('isnormal', v => Number.isFinite(num(v)) && v !== 0);
d0('now', () => Date.now() / 1000);
d0('todate', v => new Date(num(v) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'));
d0('fromdate', v => {
  const t = Date.parse(str(v, 'cannot be parsed as a date'));
  if (Number.isNaN(t)) throw new JqError(`date "${v}" does not match format "%Y-%m-%dT%H:%M:%SZ"`);
  return Math.floor(t / 1000);
});
for (const [a, b] of [['date', 'todate'], ['todateiso8601', 'todate'], ['fromdateiso8601', 'fromdate']]) B[a + '/0'] = B[b + '/0'];

d0('length', v => {
  switch (type(v)) {
    case 'null': return 0;
    case 'boolean': throw new JqError(`${desc(v)} has no length`);
    case 'number': return Math.abs(v);
    case 'string': return /[\ud800-\udfff]/.test(v) ? [...v].length : v.length;
    case 'array': return v.length;
    default: return Object.keys(v).length;
  }
});
d0('utf8bytelength', v => new TextEncoder().encode(str(v, 'only strings have UTF-8 byte length')).length);
d0('not', v => !truthy(v));
d0('type', type);
d0('keys', v => {
  if (Array.isArray(v)) return v.map((_, i) => i);
  if (isObj(v)) return Object.keys(v).sort();
  throw new JqError(`${desc(v)} has no keys`);
});
d0('keys_unsorted', v => {
  if (Array.isArray(v)) return v.map((_, i) => i);
  if (isObj(v)) return Object.keys(v);
  throw new JqError(`${desc(v)} has no keys`);
});
function addAll(items) {
  if (items.length && items.every(Array.isArray)) { const out = []; for (const a of items) for (const x of a) out.push(x); return out; }
  let acc = null;
  for (const x of items) acc = add(acc, x);
  return acc;
}
d0('add', v => v === null ? null : addAll(iterVals(v)));
d0('any', v => iterVals(v).some(truthy));
d0('all', v => iterVals(v).every(truthy));
B['any/1'] = function* (e, a, v) {
  for (const x of iterVals(v)) for (const c of ev(a[0], x, e)) if (truthy(c)) { yield true; return; }
  yield false;
};
B['all/1'] = function* (e, a, v) {
  for (const x of iterVals(v)) for (const c of ev(a[0], x, e)) if (!truthy(c)) { yield false; return; }
  yield true;
};
B['any/2'] = function* (e, a, v) {
  for (const x of ev(a[0], v, e)) for (const c of ev(a[1], x, e)) if (truthy(c)) { yield true; return; }
  yield false;
};
B['all/2'] = function* (e, a, v) {
  for (const x of ev(a[0], v, e)) for (const c of ev(a[1], x, e)) if (!truthy(c)) { yield false; return; }
  yield true;
};
function flat(a, d) {
  arr(a, 'cannot be flattened');
  const out = [];
  const go = (x, dd) => { for (const y of x) { if (Array.isArray(y) && dd > 0) go(y, dd - 1); else out.push(y); } };
  go(a, d);
  return out;
}
d0('flatten', v => flat(v, 1e9));
d1('flatten', (v, d) => { if (d < 0) throw new JqError('flatten depth must not be negative'); return flat(v, d); });
d0('tostring', tostr);
d0('tojson', tojson);
d0('fromjson', v => {
  str(v, 'cannot be parsed as JSON');
  try { return JSON.parse(v); } catch (e) { throw new JqError(`${e.message} (while parsing '${v}')`); }
});
d0('tonumber', v => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') { const t = v.trim(), n = Number(t); if (t !== '' && !Number.isNaN(n)) return n; throw new JqError(`Cannot be parsed as a number`); }
  throw new JqError(`${desc(v)} cannot be parsed as a number`);
});
d0('ascii_downcase', v => str(v, 'cannot be lowercased, as it is not a string').replace(/[A-Z]/g, c => c.toLowerCase()));
d0('ascii_upcase', v => str(v, 'cannot be uppercased, as it is not a string').replace(/[a-z]/g, c => c.toUpperCase()));
d0('explode', v => Array.from(str(v, 'cannot be exploded'), c => c.codePointAt(0)));
d0('implode', v => String.fromCodePoint(...arr(v, 'cannot be imploded')));
d0('trim', v => str(v, 'cannot be trimmed').trim());
d0('ltrim', v => str(v, 'cannot be trimmed').trimStart());
d0('rtrim', v => str(v, 'cannot be trimmed').trimEnd());
d0('toarray', v => Array.isArray(v) ? v : [v]);
d0('reverse', v => {
  if (v === null) return [];
  if (typeof v === 'string') return [...v].reverse().join('');
  return arr(v, 'cannot be reversed, as it is not an array').slice().reverse();
});
d0('sort', v => arr(v, 'cannot be sorted, as it is not an array').slice().sort(cmp));
d0('unique', v => {
  const s = arr(v, 'cannot be sorted, as it is not an array').slice().sort(cmp), out = [];
  for (const x of s) if (!out.length || cmp(out[out.length - 1], x) !== 0) out.push(x);
  return out;
});
function keyed(v, f, e) {
  arr(v, 'cannot be sorted, as it is not an array');
  return v.map((x, i) => ({ k: [...ev(f, x, e)], x, i })).sort((a, b) => cmp(a.k, b.k) || a.i - b.i);
}
B['sort_by/1'] = function* (e, a, v) { yield keyed(v, a[0], e).map(o => o.x); };
B['group_by/1'] = function* (e, a, v) {
  const out = []; let last;
  for (const o of keyed(v, a[0], e)) {
    if (out.length && cmp(last, o.k) === 0) out[out.length - 1].push(o.x); else { out.push([o.x]); last = o.k; }
  }
  yield out;
};
B['unique_by/1'] = function* (e, a, v) {
  const out = []; let last;
  for (const o of keyed(v, a[0], e)) if (!out.length || cmp(last, o.k) !== 0) { out.push(o.x); last = o.k; }
  yield out;
};
function minmax(items, keyFn, wantMax) {
  let best = null, bk, first = true;
  for (const x of items) {
    const k = keyFn(x);
    if (first || (wantMax ? cmp(k, bk) >= 0 : cmp(k, bk) < 0)) { best = x; bk = k; first = false; }
  }
  return best;
}
d0('min', v => minmax(arr(v, 'cannot be iterated over'), x => x, false));
d0('max', v => minmax(arr(v, 'cannot be iterated over'), x => x, true));
B['min_by/1'] = function* (e, a, v) { yield minmax(arr(v, 'cannot be iterated over'), x => [...ev(a[0], x, e)], false); };
B['max_by/1'] = function* (e, a, v) { yield minmax(arr(v, 'cannot be iterated over'), x => [...ev(a[0], x, e)], true); };
d0('to_entries', v => {
  if (Array.isArray(v)) return v.map((x, i) => ({ key: i, value: x }));
  if (!isObj(v)) throw new JqError(`${desc(v)} has no keys`);
  return Object.keys(v).map(k => ({ key: k, value: v[k] }));
});
d0('from_entries', v => {
  const o = {};
  for (const e of iterVals(v)) {
    let k = null, val = null;
    if (isObj(e)) {
      for (const n of ['key', 'k', 'name', 'Name', 'K', 'Key']) if (e[n] !== undefined && e[n] !== null) { k = e[n]; break; }
      for (const n of ['value', 'v', 'Value', 'V']) if (e[n] !== undefined) { val = e[n]; break; }
    } else throw new JqError(`Cannot index ${type(e)} with "key"`);
    if (typeof k !== 'string') {
      if (k === null || typeof k === 'boolean' || typeof k === 'number') k = tostr(k);
      else throw new JqError(`Cannot use ${desc(k)} as object key`);
    }
    setk(o, k, val);
  }
  return o;
});
d0('transpose', v => {
  arr(v, 'cannot be transposed');
  let n = 0; for (const r of v) if (r.length > n) n = r.length;
  const out = [];
  for (let i = 0; i < n; i++) out.push(v.map(r => i < r.length ? r[i] : null));
  return out;
});
d1('has', (v, k) => {
  if (isObj(v) && typeof k === 'string') return hasOwn(v, k);
  if (Array.isArray(v) && typeof k === 'number') return k >= 0 && k < v.length;
  throw new JqError(`Cannot check whether ${type(v)} has a ${type(k)} key`);
});
function contains(a, b) {
  const ta = type(a), tb = type(b);
  if (ta !== tb) throw new JqError(`${desc(a)} and ${desc(b)} cannot have their containment checked`);
  if (ta === 'object') return Object.keys(b).every(k => hasOwn(a, k) && contains(a[k], b[k]));
  if (ta === 'array') return b.every(y => a.some(x => type(x) === type(y) && contains(x, y)));
  if (ta === 'string') return a.includes(b);
  return cmp(a, b) === 0;
}
d1('contains', contains);
d1('indices', indices);
d1('index', (v, x) => { const r = indices(v, x); return r && r.length ? r[0] : null; });
d1('rindex', (v, x) => { const r = indices(v, x); return r && r.length ? r[r.length - 1] : null; });
d1('startswith', (v, x) => { if (typeof v !== 'string' || typeof x !== 'string') throw new JqError('startswith() requires string inputs'); return v.startsWith(x); });
d1('endswith', (v, x) => { if (typeof v !== 'string' || typeof x !== 'string') throw new JqError('endswith() requires string inputs'); return v.endsWith(x); });
d1('ltrimstr', (v, x) => typeof v === 'string' && typeof x === 'string' && v.startsWith(x) ? v.slice(x.length) : v);
d1('rtrimstr', (v, x) => typeof v === 'string' && typeof x === 'string' && x !== '' && v.endsWith(x) ? v.slice(0, v.length - x.length) : v);
d1('split', (v, s) => {
  if (typeof v !== 'string' || typeof s !== 'string') throw new JqError('split input and separator must be strings');
  return splitStr(v, s);
});
d1('join', (v, s) => {
  arr(v, 'cannot be iterated over');
  if (v.length === 0) return '';
  str(s, 'is not a valid separator');
  return v.map(x => {
    if (x === null) return '';
    if (typeof x === 'string') return x;
    if (typeof x === 'number' || typeof x === 'boolean') return tojson(x);
    throw new JqError(`Cannot join with ${type(x)}`);
  }).join(s);
});
d1('format', (v, f) => applyFormat(f, v));
d1('getpath', (v, p) => { arr(p, 'Path must be specified as an array'); return getpath(v, p); });
d2('setpath', (v, p, x) => setpathM(v, arr(p, 'Path must be specified as an array'), 0, x, new Set()));
d1('delpaths', (v, ps) => delpaths(v, arr(ps, 'Paths must be specified as an array')));
d1('nth', (v, n) => idx(v, n));
d0('first', v => idx(v, 0));
d0('last', v => idx(v, -1));
d0('env', () => ({}));
d0('input_filename', () => null);
d0('input_line_number', () => 0);
d0('stderr', v => v);
d0('debug', v => { console.debug('[jq debug]', v); return v; });
d1('debug', (v, m) => { console.debug('[jq debug]', m); return v; });
B['input/0'] = function* () { throw new JqError('No more inputs'); };
B['inputs/0'] = function* () {};
B['empty/0'] = function* () {};
B['error/0'] = function* (e, a, v) { throw new JqError(v); };
B['error/1'] = function* (e, a, v) { for (const m of ev(a[0], v, e)) throw new JqError(m); };
B['select/1'] = function* (e, a, v) { for (const c of ev(a[0], v, e)) if (truthy(c)) yield v; };
B['map/1'] = function* (e, a, v) {
  const out = [];
  for (const x of iterVals(v)) for (const y of ev(a[0], x, e)) out.push(y);
  yield out;
};
B['path/1'] = function* (e, a, v) { for (const [, p] of evp(a[0], [v, []], e)) yield p; };
B['range/1'] = function* (e, a, v) { for (const n of ev(a[0], v, e)) { num(n); for (let i = 0; i < n; i++) yield i; } };
B['range/2'] = function* (e, a, v) {
  for (const f of ev(a[0], v, e)) for (const t of ev(a[1], v, e)) { num(f); num(t); for (let i = f; i < t; i++) yield i; }
};
B['range/3'] = function* (e, a, v) {
  for (const f of ev(a[0], v, e)) for (const t of ev(a[1], v, e)) for (const by of ev(a[2], v, e)) {
    num(f); num(t); num(by);
    if (by > 0) for (let i = f; i < t; i += by) yield i;
    else if (by < 0) for (let i = f; i > t; i += by) yield i;
  }
};
B['limit/2'] = function* (e, a, v) {
  for (const n of ev(a[0], v, e)) {
    if (n <= 0) continue;
    let i = 0;
    for (const x of ev(a[1], v, e)) { yield x; if (++i >= n) break; }
  }
};
B['first/1'] = function* (e, a, v) { for (const x of ev(a[0], v, e)) { yield x; return; } };
B['last/1'] = function* (e, a, v) { let l, has = false; for (const x of ev(a[0], v, e)) { l = x; has = true; } if (has) yield l; };
B['nth/2'] = function* (e, a, v) {
  for (const n of ev(a[0], v, e)) {
    if (n < 0) throw new JqError('Out of bounds negative array index');
    let i = 0, got = false;
    for (const x of ev(a[1], v, e)) if (i++ === n) { yield x; got = true; break; }
  }
};
B['isempty/1'] = function* (e, a, v) { for (const x of ev(a[0], v, e)) { yield false; return; } yield true; };
// iterative depth-first driver: visit(x) returns null (skip) or an iterable of children
function* dfs(x, visit) {
  const first = visit(x); if (first === null) return;
  yield x;
  const st = [first[Symbol.iterator]()];
  while (st.length) {
    const r = st[st.length - 1].next();
    if (r.done) { st.pop(); continue; }
    const kids = visit(r.value);
    if (kids === null) continue;
    yield r.value;
    st.push(kids[Symbol.iterator]());
  }
}
function* recurseAll(v) {
  const st = [v];
  while (st.length) {
    const x = st.pop(); yield x;
    if (Array.isArray(x)) { for (let i = x.length - 1; i >= 0; i--) st.push(x[i]); }
    else if (x !== null && typeof x === 'object') { const ks = Object.keys(x); for (let i = ks.length - 1; i >= 0; i--) st.push(x[ks[i]]); }
  }
}
function* filt(it, cond, e) { for (const y of it) for (const c of ev(cond, y, e)) if (truthy(c)) yield y; }
B['recurse/0'] = function* (e, a, v) { yield* recurseAll(v); };
B['recurse/1'] = function* (e, a, v) { yield* dfs(v, x => ev(a[0], x, e)); };
B['recurse/2'] = function* (e, a, v) { yield* dfs(v, x => filt(ev(a[0], x, e), a[1], e)); };
B['while/2'] = function* (e, a, v) {
  yield* dfs(v, x => { let ok = false; for (const c of ev(a[0], x, e)) { ok = truthy(c); break; } return ok ? ev(a[1], x, e) : null; });
};
B['repeat/1'] = B['recurse/1'];
B['until/2'] = function* (e, a, v) {
  const st = [[v][Symbol.iterator]()];
  while (st.length) {
    const r = st[st.length - 1].next();
    if (r.done) { st.pop(); continue; }
    let c = false; for (const cc of ev(a[0], r.value, e)) { c = truthy(cc); break; }
    if (c) yield r.value; else st.push(ev(a[1], r.value, e));
  }
};
function* tostreamGen(v, p) {
  if (v !== null && typeof v === 'object' && (Array.isArray(v) ? v.length : Object.keys(v).length)) {
    let last;
    for (const k of Array.isArray(v) ? v.keys() : Object.keys(v)) { yield* tostreamGen(v[k], p.concat([k])); last = k; }
    yield [p.concat([last])];
  } else yield [p, v];
}
B['tostream/0'] = function* (e, a, v) { yield* tostreamGen(v, []); };
// regex
d2('test', (v, re, fl) => matches(v, re, fl).length > 0);
d1('test', (v, re) => matches(v, re, null).length > 0);
B['match/1'] = function* (e, a, v) { for (const re of ev(a[0], v, e)) yield* matches(v, re, null); };
B['match/2'] = function* (e, a, v) { for (const re of ev(a[0], v, e)) for (const fl of ev(a[1], v, e)) yield* matches(v, re, fl); };
B['capture/1'] = function* (e, a, v) { for (const re of ev(a[0], v, e)) for (const m of matches(v, re, null)) yield capObj(m); };
B['capture/2'] = function* (e, a, v) { for (const re of ev(a[0], v, e)) for (const fl of ev(a[1], v, e)) for (const m of matches(v, re, fl)) yield capObj(m); };
const scanOut = m => m.captures.length ? m.captures.map(c => c.string) : m.string;
B['scan/1'] = function* (e, a, v) { for (const re of ev(a[0], v, e)) for (const m of matches(v, re, 'g')) yield scanOut(m); };
B['scan/2'] = function* (e, a, v) { for (const re of ev(a[0], v, e)) for (const fl of ev(a[1], v, e)) for (const m of matches(v, re, 'g' + (fl || ''))) yield scanOut(m); };
d2('split', (v, re, fl) => {
  const out = []; let last = 0;
  for (const m of matches(v, re, 'g' + (fl || ''))) { out.push(v.slice(last, m.offset)); last = m.offset + m.length; }
  out.push(v.slice(last));
  return out;
});
function* subImpl(e, a, v, g) {
  for (const re of ev(a[0], v, e)) for (const fl of (a[2] ? ev(a[2], v, e) : [null])) {
    let out = '', last = 0;
    for (const m of matches(v, re, (fl || '') + (g ? 'g' : ''))) {
      const cap = capObj(m); let rep;
      for (const r of ev(a[1], cap, e)) { rep = r; break; }
      if (rep === undefined) continue;
      if (typeof rep !== 'string') throw new JqError(`${desc(cap)} and ${desc(rep)} cannot be added`);
      out += v.slice(last, m.offset) + rep; last = m.offset + m.length;
    }
    yield out + v.slice(last);
  }
}
B['sub/2'] = function* (e, a, v) { yield* subImpl(e, a, v, false); };
B['sub/3'] = B['sub/2'];
B['gsub/2'] = function* (e, a, v) { yield* subImpl(e, a, v, true); };
B['gsub/3'] = B['gsub/2'];

// path-mode natives
function* recp(vp, kids) {
  const st = [vp];
  while (st.length) {
    const x = st.pop(); yield x;
    const ks = [...kids(x)];
    for (let i = ks.length - 1; i >= 0; i--) st.push(ks[i]);
  }
}
function* childPaths([t, tp]) {
  if (Array.isArray(t)) for (let i = 0; i < t.length; i++) yield [t[i], tp.concat([i])];
  else if (isObj(t)) for (const k of Object.keys(t)) yield [t[k], tp.concat([k])];
}
PB['empty/0'] = B['empty/0'];
PB['error/0'] = B['error/0'] && function* (e, a, vp) { throw new JqError(vp[0]); };
PB['error/1'] = function* (e, a, vp) { for (const m of ev(a[0], vp[0], e)) throw new JqError(m); };
PB['select/1'] = function* (e, a, vp) { for (const c of ev(a[0], vp[0], e)) if (truthy(c)) yield vp; };
PB['recurse/0'] = function* (e, a, vp) { yield* recp(vp, childPaths); };
PB['recurse/1'] = function* (e, a, vp) {
  const st = [vp];
  while (st.length) {
    const x = st.pop(); yield x;
    const ks = [...evp(a[0], x, e)];
    for (let i = ks.length - 1; i >= 0; i--) st.push(ks[i]);
  }
};
PB['recurse/2'] = function* (e, a, vp) {
  const st = [vp];
  while (st.length) {
    const x = st.pop(); yield x;
    const ks = [...evp(a[0], x, e)].filter(y => { for (const c of ev(a[1], y[0], e)) if (truthy(c)) return true; return false; });
    for (let i = ks.length - 1; i >= 0; i--) st.push(ks[i]);
  }
};
PB['getpath/1'] = function* (e, a, vp) {
  for (const p of ev(a[0], vp[0], e)) { arr(p, 'Path must be specified as an array'); yield [getpath(vp[0], p), vp[1].concat(p)]; }
};
PB['first/1'] = function* (e, a, vp) { for (const x of evp(a[0], vp, e)) { yield x; return; } };
PB['last/1'] = function* (e, a, vp) { let l, has = false; for (const x of evp(a[0], vp, e)) { l = x; has = true; } if (has) yield l; };
PB['limit/2'] = function* (e, a, vp) {
  for (const n of ev(a[0], vp[0], e)) {
    if (n <= 0) continue;
    let i = 0;
    for (const x of evp(a[1], vp, e)) { yield x; if (++i >= n) break; }
  }
};
PB['first/0'] = function* (e, a, vp) { yield [idx(vp[0], 0), vp[1].concat([0])]; };
PB['last/0'] = function* (e, a, vp) { yield [idx(vp[0], -1), vp[1].concat([-1])]; };


// type selectors: native (hot path for things like `..|numbers`), usable in path mode too
const TYPE_SEL = {
  values: v => v !== null, nulls: v => v === null, booleans: v => typeof v === 'boolean',
  numbers: v => typeof v === 'number', strings: v => typeof v === 'string', arrays: v => Array.isArray(v),
  objects: v => isObj(v), iterables: v => v !== null && typeof v === 'object',
  scalars: v => v === null || typeof v !== 'object',
};
for (const k of Object.keys(TYPE_SEL)) {
  const f = TYPE_SEL[k];
  B[k + '/0'] = function* (e, a, v) { if (f(v)) yield v; };
  PB[k + '/0'] = function* (e, a, vp) { if (f(vp[0])) yield vp; };
}
function* allPaths(v) {
  const st = [];
  const push = (x, p) => {
    if (Array.isArray(x)) for (let i = x.length - 1; i >= 0; i--) st.push([x[i], p.concat([i])]);
    else if (isObj(x)) { const ks = Object.keys(x); for (let i = ks.length - 1; i >= 0; i--) st.push([x[ks[i]], p.concat([ks[i]])]); }
  };
  push(v, []);
  while (st.length) { const [x, p] = st.pop(); yield p; push(x, p); }
}
B['paths/0'] = function* (e, a, v) { yield* allPaths(v); };

// ---------------------------------------------------------------- prelude (written in jq)
const PRELUDE = `
def map_values(f): .[] |= f;
def recurse_down: recurse;
def del(f): delpaths([path(f)]);
def paths(node_filter): . as $dot | paths | select(. as $p | $dot | getpath($p) | node_filter);
def leaf_paths: paths(scalars);
def with_entries(f): to_entries | map(f) | from_entries;
def walk(f): def w: if type == "object" then map_values(w) elif type == "array" then map(w) else . end | f; w;
def pick(pathexps): . as $top | reduce path(pathexps) as $p (null; setpath($p; $top | getpath($p)));
def in(xs): . as $x | xs | has($x);
def inside(xs): . as $x | xs | contains($x);
def add(f): reduce f as $x (null; . + $x);
def combinations: if length == 0 then [] else .[0][] as $x | (.[1:] | combinations) as $w | [$x] + $w end;
def combinations(n): . as $dot | [range(n)] | map($dot) | combinations;
def splits($re): splits($re; null);
def splits($re; flags): split($re; flags) | .[];
def ascii: [.] | implode;
def finites: select(isinfinite or isnan | not);
def normals: select(isnormal);
def fromstream(f): { x: null, e: false } as $init
  | foreach f as $i ($init;
      if .e then $init else . end
      | if $i | length == 2
        then setpath(["e"]; $i[0] | length == 0) | setpath(["x"] + $i[0]; $i[1])
        else setpath(["e"]; $i[0] | length == 1) end;
      if .e then .x else empty end);
`;
let ready = false;
function init() {
  if (ready) return;
  const p = new Parser(PRELUDE);
  while (p.peek().t !== 'eof') {
    const d = p.funcdef();
    const f = { k: 'fn', name: d.name, arity: d.params.length, params: d.params, body: d.body, cenv: null, p: null };
    f.cenv = f;
    P[d.name + '/' + f.arity] = f;
  }
  ready = true;
}

// ---------------------------------------------------------------- public API
function compile(src) { init(); return new Parser(src).program(); }
function* run(ast, input) { yield* ev(ast, input, null); }

globalThis.JQ = { compile, run, JqError };
})();
