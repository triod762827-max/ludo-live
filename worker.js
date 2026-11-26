// Ludo Live server: one Durable Object per room code. All rules are enforced here.
export default {
  async fetch(req, env) {
    const m = new URL(req.url).pathname.match(/^\/ws\/([A-Za-z0-9]{3,8})$/);
    if (!m) return new Response('Not found', { status: 404 });
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
    return env.ROOM.get(env.ROOM.idFromName(m[1].toUpperCase())).fetch(req);
  },
};

const SAFE = [0, 8, 13, 21, 26, 34, 39, 47], ORDER = [0, 2, 1, 3], TURN_MS = 20000;
const clean = (v, n) => [...String(v ?? '').replace(/[\u0000-\u001f<>]/g, '')].slice(0, n).join('').trim();

export class Room {
  constructor() { this.socks = new Map(); this.tm = null; this.reset([], 'classic'); }
  reset(players, mode) {
    players.forEach(p => (p.done = false));
    this.s = { ph: 'lobby', mode, players, turn: 0, dice: null, n: 0, six: 0, rank: [], dl: 0,
      msg: 'Waiting for players…', tk: [0, 1, 2, 3].map(() => [-1, -1, -1, -1]) };
  }
  fetch() {
    const [client, srv] = Object.values(new WebSocketPair());
    srv.accept();
    srv.addEventListener('message', e => this.onMsg(srv, e.data));
    const gone = () => {
      const id = this.socks.get(srv); this.socks.delete(srv);
      const s = this.s;
      if (s.ph === 'play' && s.dl && s.players[s.turn].id === id && ![...this.socks.values()].includes(id)) this.arm();
      this.sync();
    };
    srv.addEventListener('close', gone); srv.addEventListener('error', gone);
    return new Response(null, { status: 101, webSocket: client });
  }
  send(ws, o) { try { ws.send(JSON.stringify(o)); } catch {} }
  bc(o, except) { for (const ws of this.socks.keys()) if (ws !== except) this.send(ws, o); }
  sync() { const on = [...this.socks.values()]; for (const [ws, id] of this.socks) this.send(ws, { t: 'state', s: this.s, you: id, on, now: Date.now() }); }
  legal(seat, d) { return this.s.tk[seat].map((p, i) => (p < 0 ? d === 6 : p + d <= 56) ? i : -1).filter(i => i >= 0); }

  arm() { // start the turn clock; offline players are auto-played quickly
    clearTimeout(this.tm); const s = this.s;
    if (s.ph !== 'play') { s.dl = 0; return; }
    const ms = [...this.socks.values()].includes(s.players[s.turn].id) ? TURN_MS : 1200;
    s.dl = Date.now() + ms; this.tm = setTimeout(() => this.auto(), ms);
  }
  after(ms, fn) { clearTimeout(this.tm); this.s.dl = 0; this.tm = setTimeout(fn, ms); }
  next() {
    const s = this.s;
    do { s.turn = (s.turn + 1) % s.players.length; } while (s.players[s.turn].done);
    s.dice = null; s.six = 0; s.msg = s.players[s.turn].name + '’s turn'; this.arm();
  }
  hits(seat, np) {
    const a = (seat * 13 + np) % 52; if (SAFE.includes(a)) return false;
    return this.s.tk.some((t, o) => o !== seat && t.some(q => q >= 0 && q <= 50 && (o * 13 + q) % 52 === a));
  }
  pick() {
    const s = this.s, seat = s.players[s.turn].seat, d = s.dice; let best = -1, bs = -1;
    for (const i of this.legal(seat, d)) {
      const p = s.tk[seat][i], np = p < 0 ? 0 : p + d; let sc = np;
      if (np === 56) sc += 200; if (p < 0) sc += 60; if (np <= 50 && this.hits(seat, np)) sc += 300;
      if (sc > bs) { bs = sc; best = i; }
    }
    return best;
  }
  auto() { if (this.s.ph !== 'play') return; if (this.s.dice === null) this.roll(); else this.move(this.pick()); this.sync(); }

  roll() {
    const s = this.s, pl = s.players[s.turn], d = 1 + Math.floor(Math.random() * 6);
    s.n++; s.dice = d; s.six = d === 6 ? s.six + 1 : 0;
    const lg = this.legal(pl.seat, d);
    if (s.six >= 3) { s.msg = pl.name + ' rolled three 6s – turn lost'; this.after(1800, () => { this.next(); this.sync(); }); }
    else if (!lg.length) { s.msg = `${pl.name} rolled ${d} – no move`; this.after(1500, () => { this.next(); this.sync(); }); }
    else {
      s.msg = `${pl.name} rolled ${d}`;
      const uniq = lg.filter((i, k) => lg.findIndex(j => s.tk[pl.seat][j] === s.tk[pl.seat][i]) === k);
      if (uniq.length === 1) this.after(900, () => { this.move(uniq[0]); this.sync(); }); // only one choice: auto-move
      else this.arm();
    }
    this.sync();
  }
  move(i) {
    const s = this.s, pl = s.players[s.turn], seat = pl.seat, d = s.dice;
    if (s.ph !== 'play' || d === null || !this.legal(seat, d).includes(i)) return;
    const p = s.tk[seat][i], np = p < 0 ? 0 : p + d; let cap = false;
    s.tk[seat][i] = np; s.n++;
    if (np <= 50) {
      const a = (seat * 13 + np) % 52;
      if (!SAFE.includes(a)) for (let o = 0; o < 4; o++) if (o !== seat)
        s.tk[o].forEach((q, j) => { if (q >= 0 && q <= 50 && (o * 13 + q) % 52 === a) { s.tk[o][j] = -1; cap = true; } });
    }
    const need = s.mode === 'quick' ? 1 : 4;
    if (s.tk[seat].filter(q => q === 56).length >= need) { pl.done = true; s.rank.push(seat); }
    const left = s.players.filter(x => !x.done);
    if (left.length <= 1) {
      if (left[0]) { left[0].done = true; s.rank.push(left[0].seat); }
      s.ph = 'done'; s.dice = null; s.dl = 0; clearTimeout(this.tm); s.msg = 'Game over!';
    } else if (pl.done) this.next();
    else if (d === 6 || cap || np === 56) {
      s.dice = null; this.arm();
      s.msg = pl.name + (cap ? ' captured a pawn – roll again' : np === 56 ? ' got a pawn home – roll again' : ' rolled a 6 – roll again');
    } else this.next();
    this.sync();
  }

  onMsg(ws, raw) {
    let d; try { d = JSON.parse(raw); } catch { return; }
    const s = this.s;
    if (d.t === 'join') {
      const id = clean(d.id, 16); if (!id) return;
      let p = s.players.find(x => x.id === id);
      if (!p) {
        if (!s.players.length && !d.create) return this.send(ws, { t: 'nope' });
        if (s.ph !== 'lobby' || s.players.length >= 4) return this.send(ws, { t: 'full' });
        p = { id, name: clean(d.name, 14) || 'Player', seat: ORDER[s.players.length], done: false };
        s.players.push(p);
      }
      this.socks.set(ws, id);
      if (s.ph === 'play' && s.players[s.turn] === p) this.arm();
      return this.sync();
    }
    const p = s.players.find(x => x.id === this.socks.get(ws)); if (!p) return;
    const cur = s.ph === 'play' ? s.players[s.turn] : null, host = p === s.players[0];
    if (d.t === 'mode' && host && s.ph === 'lobby' && ['classic', 'quick'].includes(d.m)) { s.mode = d.m; this.sync(); }
    else if (d.t === 'start' && host && s.ph === 'lobby' && s.players.length > 1) {
      s.players.sort((a, b) => a.seat - b.seat); s.ph = 'play'; s.turn = 0; s.msg = s.players[0].name + '’s turn'; this.arm(); this.sync();
    } else if (d.t === 'again' && host && s.ph === 'done') { clearTimeout(this.tm); this.reset(s.players, s.mode); this.sync(); }
    else if (d.t === 'leave') {
      this.socks.delete(ws);
      if (s.ph === 'lobby') { s.players = s.players.filter(x => x !== p); s.players.forEach((x, k) => (x.seat = ORDER[k])); }
      else if (cur === p) this.arm();
      this.sync();
    } else if (d.t === 'roll' && cur === p && s.dice === null) this.roll();
    else if (d.t === 'move' && cur === p) this.move(d.i | 0);
    else if (d.t === 'chat') { const text = clean(d.text, 200); if (text) this.bc({ t: 'chat', seat: p.seat, name: p.name, text }); }
    else if (d.t === 'emoji') this.bc({ t: 'emoji', seat: p.seat, name: p.name, e: clean(d.e, 8) });
    else if (d.t === 'typing') this.bc({ t: 'typing', seat: p.seat, name: p.name }, ws);
  }
}
