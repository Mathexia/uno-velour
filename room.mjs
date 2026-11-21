import {getStore} from "@netlify/blobs";

const AL = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', TK = 'abcdefghijklmnopqrstuvwxyz0123456789';
const rnd = (n, s = AL) => Array.from({length: n}, () => s[Math.random() * s.length | 0]).join('');
const shuffle = a => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0; [a[i], a[j]] = [a[j], a[i]] } return a };
const mkDeck = () => { const d = []; for (const c of 'rygb') { d.push(c + '0'); for (let v = 1; v <= 9; v++) d.push(c + v, c + v); for (const s of 'SRD') d.push(c + s, c + s) } for (let i = 0; i < 4; i++) d.push('kW', 'kF'); return shuffle(d) };
const lab = v => ({S: '⊘', R: '⇄', D: '+2', W: '✦', F: '+4'}[v] || v);
const CN = {r: 'Merah', y: 'Kuning', g: 'Hijau', b: 'Biru'};
const TTL = 6 * 3600e3;
const E = (m, s = 400) => Response.json({error: m}, {status: s});
const fail = (s, m) => { throw {s, m} };

function startRound(R) {
  const n = R.hand, d = mkDeck(), h0 = d.splice(0, n), h1 = d.splice(0, n);
  const top = d.splice(d.findIndex(c => c[0] !== 'k' && /\d/.test(c[1])), 1)[0], r = (R.g?.r || 0) + 1;
  R.status = 'playing';
  R.g = {deck: d, disc: [top], h0, h1, color: top[0], turn: r % 2 ? 0 : 1, r, msg: 'Ronde ' + r + ' dimulai'};
  R.p[0].ready = R.p[1].ready = false;
}

function take(g, pl, n) {
  const h = g['h' + pl];
  for (let k = 0; k < n; k++) {
    if (!g.deck.length) { const t = g.disc.pop(); g.deck = shuffle(g.disc); g.disc = [t]; if (!g.deck.length) break }
    h.push(g.deck.pop());
  }
}

function play(R, me, b) {
  const g = R.g, op = 1 - me;
  if (R.status !== 'playing' || g.turn !== me) fail(409, 'Bukan giliranmu');
  const h = g['h' + me], i = +b.i, c = h[i], top = g.disc.at(-1);
  if (!c) fail(400, 'Kartu tidak ada');
  if (!(c[0] === 'k' || c[0] === g.color || c[1] === top[1])) fail(400, 'Kartu tidak cocok');
  if (c[0] === 'k' && !CN[b.col]) fail(400, 'Pilih warna dulu');
  h.splice(i, 1); g.disc.push(c); g.color = c[0] === 'k' ? b.col : c[0];
  const nm = R.p[me].n, on = R.p[op].n, v = c[1];
  let next = op, m = `${nm} main ${lab(v)}`;
  if (v === 'S' || v === 'R') { next = me; m += ` — ${on} dilewati` }
  if (v === 'D') { take(g, op, 2); next = me; m += ` — ${on} ambil 2` }
  if (v === 'F') { take(g, op, 4); next = me; m += ` — ${on} ambil 4` }
  if (c[0] === 'k') m += ` (${CN[b.col]})`;
  g.turn = next; g.msg = m;
  if (!h.length) { g.win = me; g.msg = nm + ' kehabisan kartu'; R.status = 'over'; R.p[me].w++ }
}

// Kartu lawan tidak pernah dikirim ke klien — hanya jumlahnya.
function view(R, me) {
  const o = {status: R.status, hand: R.hand, v: R.v, p: {}};
  for (const i of [0, 1]) if (R.p[i]) o.p[i] = {n: R.p[i].n, ready: R.p[i].ready, w: R.p[i].w};
  const g = R.g;
  if (g) o.g = {disc: [g.disc.at(-1)], color: g.color, turn: g.turn, msg: g.msg, win: g.win, r: g.r, nd: g.deck.length, h: g['h' + me], no: g['h' + (1 - me)].length};
  return o;
}

async function mutate(st, code, fn) {
  for (let k = 0; k < 6; k++) {
    const e = await st.getWithMetadata(code, {type: 'json'});
    if (!e) fail(404, 'Room tidak ditemukan');
    const R = e.data;
    if (Date.now() - R.t > TTL) { await st.delete(code); fail(404, 'Room kedaluwarsa') }
    const out = fn(R);
    R.t = Date.now(); R.v = (R.v || 0) + 1;
    const r = await st.setJSON(code, R, {onlyIfMatch: e.etag});
    if (r?.modified !== false) return out;
  }
  fail(409, 'Server sibuk, coba lagi');
}

async function create(st, name) {
  const tok = rnd(20, TK); let code;
  for (;;) {
    code = rnd(4);
    const r = await st.setJSON(code, {t: Date.now(), v: 1, status: 'lobby', hand: 7, p: {0: {n: name, tok, ready: false, w: 0}}}, {onlyIfNew: true});
    if (r?.modified !== false) break;
  }
  return {code, slot: 0, tok};
}

function join(st, code, name, b) {
  const tok = rnd(20, TK);
  return mutate(st, code, R => {
    for (const i of [0, 1]) if (R.p[i] && b.tok && R.p[i].tok === b.tok) return {code, slot: i, tok: b.tok};
    if (R.status !== 'lobby' || R.p[1]) fail(409, 'Room sudah penuh / sedang main');
    R.p[1] = {n: name, tok, ready: false, w: 0};
    return {code, slot: 1, tok};
  });
}

export default async req => {
  if (req.method !== 'POST') return E('Method not allowed', 405);
  const b = await req.json().catch(() => ({}));
  const st = getStore({name: 'rooms', consistency: 'strong'});
  const A = b.act, name = String(b.name || '').trim().slice(0, 14);
  try {
    if (A === 'create' || A === 'random' || A === 'join') {
      if (!name) return E('Isi nama dulu');
      if (A === 'create') return Response.json(await create(st, name));
      if (A === 'join') return Response.json(await join(st, String(b.code || '').toUpperCase(), name, b));
      const q = await st.get('queue');
      if (q) { try { const d = await join(st, q, name, {}); await st.delete('queue'); return Response.json(d) } catch {} }
      const d = await create(st, name); await st.set('queue', d.code);
      return Response.json(d);
    }
    const code = String(b.code || '').toUpperCase(), me = +b.slot, tok = b.tok;
    if (A === 'get') {
      const e = await st.getWithMetadata(code, {type: 'json'});
      if (!e) return E('Room tidak ditemukan', 404);
      if (e.data.p[me]?.tok !== tok) return E('Sesi tidak valid', 403);
      return Response.json(+b.v === e.data.v ? {same: 1} : view(e.data, me));
    }
    const out = await mutate(st, code, R => {
      if (R.p[me]?.tok !== tok) fail(403, 'Sesi tidak valid');
      if (A === 'hand') {
        const n = +b.n;
        if (me !== 0 || R.status !== 'lobby' || !(n >= 5 && n <= 10)) fail(400, 'Tidak bisa mengubah jumlah kartu');
        R.hand = n;
      } else if (A === 'ready') {
        if (R.status !== 'lobby' || !R.p[1]) fail(400, 'Belum bisa siap');
        R.p[me].ready = !R.p[me].ready;
        if (R.p[0].ready && R.p[1].ready) startRound(R);
      } else if (A === 'play') play(R, me, b);
      else if (A === 'draw') {
        const g = R.g;
        if (R.status !== 'playing' || g.turn !== me) fail(409, 'Bukan giliranmu');
        take(g, me, 1); g.turn = 1 - me; g.msg = R.p[me].n + ' mengambil kartu';
      } else if (A === 'next') {
        if (me !== 0 || R.status !== 'over') fail(400, 'Tidak bisa memulai ronde');
        startRound(R);
      } else if (A === 'leave') {
        if (R.status === 'lobby') { if (me === 1) delete R.p[1]; else return 'del' }
      } else fail(400, 'Aksi tidak dikenal');
    });
    if (out === 'del') { await st.delete(code); const q = await st.get('queue'); if (q === code) await st.delete('queue') }
    return Response.json({ok: 1});
  } catch (e) {
    return E(e.m || 'Terjadi kesalahan server', e.s || 500);
  }
};

export const config = {path: '/api/room'};
