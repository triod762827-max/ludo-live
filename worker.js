// Ludo server: one Durable Object per room code. Rules are enforced here.
export default {
  async fetch(req, env) {
    const m = new URL(req.url).pathname.match(/^\/ws\/([A-Za-z0-9]{3,8})$/);
    if (!m) return new Response('Not found', { status: 404 });
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
    return env.ROOM.get(env.ROOM.idFromName(m[1].toUpperCase())).fetch(req);
  },
};

const SAFE = [0, 8, 13, 21, 26, 34, 39, 47], ORDER = [0, 2, 1, 3];
const clean = (v, n) => [...String(v ?? '').replace(/[\u0000-\u001f<>]/g, '')].slice(0, n).join('').trim();

export class Room {
  constructor() {
    this.socks = new Map();
    this.s = { ph: 'lobby', players: [], turn: 0, dice: null, n: 0, win: null, msg: 'Waiting for players…',
      tk: [0, 1, 2, 3].map(() => [-1, -1, -1, -1]) };
  }
  fetch() {
    const [client, srv] = Object.values(new WebSocketPair());
    srv.accept();
    srv.addEventListener('message', e => this.onMsg(srv, e.data));
    srv.addEventListener('close', () => this.socks.delete(srv));
    srv.addEventListener('error', () => this.socks.delete(srv));
    return new Response(null, { status: 101, webSocket: client });
  }
  send(ws, o) { try { ws.send(JSON.stringify(o)); } catch {} }
  bc(o, except) { for (const ws of this.socks.keys()) if (ws !== except) this.send(ws, o); }
  sync() { for (const [ws, id] of this.socks) this.send(ws, { t: 'state', s: this.s, you: id }); }
  legal(seat, d) { return this.s.tk[seat].map((p, i) => (p < 0 ? d === 6 : p + d <= 56) ? i : -1).filter(i => i >= 0); }
  next() { const s = this.s; s.turn = (s.turn + 1) % s.players.length; s.dice = null; s.msg = s.players[s.turn].name + '’s turn'; }

  onMsg(ws, raw) {
    let d; try { d = JSON.parse(raw); } catch { return; }
    const s = this.s;
    if (d.t === 'join') {
      const id = clean(d.id, 16); if (!id) return;
      let p = s.players.find(x => x.id === id);
      if (!p) {
        if (!s.players.length && !d.create) return this.send(ws, { t: 'nope' });
        if (s.ph !== 'lobby' || s.players.length >= 4) return this.send(ws, { t: 'full' });
        p = { id, name: clean(d.name, 14) || 'Player', seat: ORDER[s.players.length] };
        s.players.push(p);
      }
      this.socks.set(ws, id);
      return this.sync();
    }
    const p = s.players.find(x => x.id === this.socks.get(ws)); if (!p) return;
    const cur = s.ph === 'play' ? s.players[s.turn] : null;
    if (d.t === 'start' && p === s.players[0] && s.ph === 'lobby' && s.players.length > 1) {
      s.players.sort((a, b) => a.seat - b.seat); s.ph = 'play'; s.turn = 0; s.msg = s.players[0].name + '’s turn'; this.sync();
    } else if (d.t === 'roll' && cur === p && s.dice === null) this.roll();
    else if (d.t === 'move' && cur === p) this.move(d.i | 0);
    else if (d.t === 'chat') { const text = clean(d.text, 200); if (text) this.bc({ t: 'chat', seat: p.seat, name: p.name, text }); }
    else if (d.t === 'emoji') this.bc({ t: 'emoji', seat: p.seat, name: p.name, e: clean(d.e, 8) });
    else if (d.t === 'typing') this.bc({ t: 'typing', seat: p.seat, name: p.name }, ws);
  }
  roll() {
    const s = this.s, pl = s.players[s.turn], d = 1 + Math.floor(Math.random() * 6), n = ++s.n;
    s.dice = d;
    if (!this.legal(pl.seat, d).length) {
      s.msg = `${pl.name} rolled ${d} – no moves`; this.sync();
      setTimeout(() => { if (s.n === n && s.ph === 'play') { this.next(); s.n++; this.sync(); } }, 1600);
    } else { s.msg = `${pl.name} rolled ${d}`; this.sync(); }
  }
  move(i) {
    const s = this.s, pl = s.players[s.turn], seat = pl.seat, d = s.dice;
    if (d === null || !this.legal(seat, d).includes(i)) return;
    const np = s.tk[seat][i] < 0 ? 0 : s.tk[seat][i] + d; let cap = false; s.n++;
    s.tk[seat][i] = np;
    if (np <= 50) {
      const a = (seat * 13 + np) % 52;
      if (!SAFE.includes(a)) for (let o = 0; o < 4; o++) if (o !== seat)
        s.tk[o].forEach((q, j) => { if (q >= 0 && q <= 50 && (o * 13 + q) % 52 === a) { s.tk[o][j] = -1; cap = true; } });
    }
    if (s.tk[seat].every(q => q === 56)) { s.ph = 'done'; s.win = pl.name; s.msg = pl.name + ' wins! 🎉'; }
    else if (d === 6 || cap) { s.dice = null; s.msg = pl.name + (cap ? ' captured a piece – go again' : ' rolled a 6 – go again'); }
    else this.next();
    this.sync();
  }
  }
