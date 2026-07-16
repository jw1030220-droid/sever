// server.js — 惡搞棋院 帳號 / 進度 / 配對 伺服器 + 後台管理 API
//
// 部署（Render）：
//   Build Command: npm install
//   Start Command: npm start
//   環境變數：
//     GOOGLE_CLIENT_ID = 你的 OAuth 用戶端 ID（必填，要跟前端填的那個一模一樣）
//     ADMIN_PASSWORD   = 後台密碼（必填，不要用預設值）
//     DB_PATH          = 選填，資料檔路徑；掛了 Disk 的話指到磁碟上

const path = require('path');
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const db = require('./db');
const auth = require('./auth');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
const PORT = process.env.PORT || 3000;

const app = express();
app.set('trust proxy', true);
app.use(cors());
app.use(express.json({ limit:'64kb' }));
app.use('/admin', express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin:'*' } });

/* ================= public ================= */

app.get('/', (req,res)=>res.send('惡搞棋院 server is running. Admin: /admin'));
app.get('/api/health', (req,res)=>res.json({
  ok:true,
  googleConfigured: !!auth.GOOGLE_CLIENT_ID,
  time: Date.now()
}));

/* ================= auth ================= */

// 註冊 + 登入是同一個入口：第一次來就自動建帳號，之後就是登入。
app.post('/api/auth/google', async (req,res)=>{
  const { credential } = req.body || {};
  if(!credential) return res.status(400).json({ error:'missing_credential' });
  try{
    const profile = await auth.verifyGoogleCredential(credential);
    const { account, isNew } = db.upsertGoogleAccount(profile);
    if(account.banned) return res.status(403).json({ error:'banned' });

    const meta = { ip: auth.clientIp(req), userAgent: req.headers['user-agent'] || '' };
    const session = db.createSession(account.id, meta);
    db.recordLogin(account.id, { ...meta, method:'google', isNew });

    res.json({
      token: session.token,
      isNew,
      account: auth.publicAccount(account)
    });
  }catch(e){
    console.error('google auth failed:', e.message);
    res.status(401).json({ error:'invalid_credential', message:e.message });
  }
});

app.get('/api/me', auth.requireAuth, (req,res)=>{
  res.json({ account: auth.publicAccount(req.account) });
});

app.post('/api/logout', auth.requireAuth, (req,res)=>{
  db.revokeSession(req.session.token);
  res.json({ ok:true });
});

// 進度存檔。
// 注意：這裡是「相信用戶端」的做法 —— 金幣是前端算完再送上來的，
// 有心人可以改用戶端直接灌金幣。要完全防作弊，得把整個對局規則搬到
// 伺服器上驗證。以目前這種單機為主的休閒遊戲來說算可接受的取捨。
app.post('/api/progress', auth.requireAuth, (req,res)=>{
  const p = db.saveProgress(req.account.id, req.body || {});
  res.json({ progress: p });
});

/* ================= admin ================= */

function requireAdmin(req,res,next){
  if((req.headers['x-admin-password']||'') !== ADMIN_PASSWORD){
    return res.status(401).json({ error:'unauthorized' });
  }
  next();
}

app.post('/api/admin/login', (req,res)=>{
  if((req.body||{}).password === ADMIN_PASSWORD) return res.json({ ok:true });
  res.status(401).json({ ok:false, error:'wrong password' });
});

app.get('/api/admin/stats', requireAdmin, (req,res)=>{
  res.json({ ...db.stats(), onlineSockets: io.engine.clientsCount, activeRooms: Object.keys(rooms).length });
});

app.get('/api/admin/accounts', requireAdmin, (req,res)=>{
  res.json({ accounts: db.listAccounts() });
});

app.get('/api/admin/accounts/:id', requireAdmin, (req,res)=>{
  const a = db.getAccount(req.params.id);
  if(!a) return res.status(404).json({ error:'not found' });
  res.json({
    account: a,
    logins: db.listLoginRecords({ accountId:a.id, limit:50 }),
    sessions: db.listSessions(a.id)
  });
});

app.post('/api/admin/accounts/:id/currency', requireAdmin, (req,res)=>{
  const { field, delta } = req.body || {};
  const d = parseInt(delta);
  if(isNaN(d)) return res.status(400).json({ error:'delta must be a number' });
  const a = db.adjustCurrency(req.params.id, field, d);
  if(!a) return res.status(404).json({ error:'not found or bad field' });
  res.json({ account: a });
});

app.post('/api/admin/accounts/:id/ban', requireAdmin, (req,res)=>{
  const a = db.setBanned(req.params.id, !!(req.body||{}).banned);
  if(!a) return res.status(404).json({ error:'not found' });
  res.json({ account: a });
});

app.post('/api/admin/accounts/:id/kick', requireAdmin, (req,res)=>{
  db.revokeAllSessions(req.params.id);
  res.json({ ok:true });
});

app.get('/api/admin/logins', requireAdmin, (req,res)=>{
  res.json({ logins: db.listLoginRecords({ limit: parseInt(req.query.limit)||200 }) });
});

app.get('/api/admin/games', requireAdmin, (req,res)=>{
  res.json({ games: db.listGames(parseInt(req.query.limit)||100) });
});

/* ================= matchmaking ================= */

const queues = {};
const rooms = {};

function queueKey(f,v,t){ return `${f}:${v}:${t}`; }
function neededPlayers(type){ return type==='2v2' ? 4 : 2; }

function tryMatch(key){
  const q = queues[key];
  if(!q) return;
  const [family, variant, type] = key.split(':');
  const need = neededPlayers(type);
  while(q.length >= need) formRoom(family, variant, type, q.splice(0,need));
}

function formRoom(family, variant, type, group){
  const gameId = 'room_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,6);
  const seats = group.map((e,i)=>({
    socketId: e.socketId, accountId: e.accountId, name: e.name, seat: i,
    team: type==='2v2' ? (i<2 ? 'w':'b') : (i===0 ? 'w':'b')
  }));
  const dbGame = db.createGame({
    family, variant, type,
    players: seats.map(s=>({ accountId:s.accountId, seat:s.seat, team:s.team }))
  });
  rooms[gameId] = { family, variant, type, seats, dbGameId: dbGame.id };

  seats.forEach(s=>{
    const sock = io.sockets.sockets.get(s.socketId);
    if(!sock) return;
    sock.join(gameId);
    sock.data.gameId = gameId;
    sock.emit('queue:matched', {
      gameId, dbGameId: dbGame.id, family, variant, type,
      yourSeat: s.seat, yourTeam: s.team,
      seats: seats.map(x=>({ seat:x.seat, team:x.team, name:x.name }))
    });
  });
}

function seatOf(gameId, socketId){
  const room = rooms[gameId];
  if(!room) return null;
  const s = room.seats.find(x=>x.socketId===socketId);
  return s ? s.seat : null;
}

io.on('connection', (socket)=>{

  // 線上對戰現在也要登入：用 REST 拿到的 session token 換身分
  socket.on('auth', ({ token })=>{
    const session = token && db.getSession(token);
    if(!session){ socket.emit('error', { message:'請先登入' }); return; }
    const account = db.getAccount(session.accountId);
    if(!account || account.banned){ socket.emit('error', { message:'帳號無法使用' }); return; }
    socket.data.accountId = account.id;
    socket.data.name = account.name;
    socket.emit('authed', { account: auth.publicAccount(account) });
  });

  socket.on('queue:join', ({ family, variant, type })=>{
    if(!socket.data.accountId) return socket.emit('error', { message:'請先登入' });
    if(!family || !variant || !type) return socket.emit('error', { message:'缺少配對參數' });
    const key = queueKey(family, variant, type);
    queues[key] = (queues[key]||[]).filter(e=>e.socketId!==socket.id);
    queues[key].push({ socketId:socket.id, accountId:socket.data.accountId, name:socket.data.name });
    socket.emit('queue:waiting', { key, position:queues[key].length });
    tryMatch(key);
  });

  socket.on('queue:leave', ()=>{
    Object.keys(queues).forEach(k=>{ queues[k] = queues[k].filter(e=>e.socketId!==socket.id); });
  });

  socket.on('move', ({ gameId, move })=>{
    if(!gameId || !rooms[gameId]) return;
    db.bumpMoveCount(rooms[gameId].dbGameId);
    socket.to(gameId).emit('move', { move, fromSeat: seatOf(gameId, socket.id) });
  });

  socket.on('duck', ({ gameId, duck })=>{
    if(!gameId || !rooms[gameId]) return;
    socket.to(gameId).emit('duck', { duck, fromSeat: seatOf(gameId, socket.id) });
  });

  socket.on('action', ({ gameId, payload })=>{
    if(!gameId || !rooms[gameId]) return;
    socket.to(gameId).emit('action', { payload, fromSeat: seatOf(gameId, socket.id) });
  });

  socket.on('game:end', ({ gameId, result, winnerTeam })=>{
    if(!gameId || !rooms[gameId]) return;
    const room = rooms[gameId];
    room.seats.forEach(s=>{
      if(!s.accountId) return;
      const isDraw = result==='draw';
      db.recordResult(s.accountId, isDraw ? 'draw' : (winnerTeam && s.team===winnerTeam ? 'win' : 'loss'));
    });
    db.endGame(room.dbGameId, { team: winnerTeam || null, result });
    io.to(gameId).emit('game:ended', { result, winnerTeam });
    delete rooms[gameId];
  });

  socket.on('disconnect', ()=>{
    Object.keys(queues).forEach(k=>{ queues[k] = queues[k].filter(e=>e.socketId!==socket.id); });
    const gameId = socket.data.gameId;
    if(gameId && rooms[gameId]) socket.to(gameId).emit('opponent:left', {});
  });
});

server.listen(PORT, ()=>{
  console.log(`惡搞棋院 server listening on ${PORT}`);
  console.log(`Admin: http://localhost:${PORT}/admin`);
  if(!auth.GOOGLE_CLIENT_ID) console.warn('⚠️  沒有設定 GOOGLE_CLIENT_ID，Google 登入會失敗');
  if(ADMIN_PASSWORD === 'changeme') console.warn('⚠️  ADMIN_PASSWORD 還是預設值，請務必更改');
});
