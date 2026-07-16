// db.js — 帳號 / 工作階段 / 登入紀錄 / 遊戲進度 資料庫
//
// 這是一個極簡的 JSON 檔案資料庫，不依賴任何需要編譯的原生套件，
// 在 Render 這類平台上最容易一次部署成功。
//
// ⚠️ 重要：Render 免費方案的檔案系統是「暫時的」，服務重新部署或休眠重啟後
//    這個檔案會被清空 —— 也就是所有玩家帳號、金幣、技能都會不見。
//    正式上線前一定要換成有持久化保證的儲存：
//      (a) Render 付費方案掛一顆 Disk，並把 DB_PATH 環境變數指到該磁碟路徑，或
//      (b) 換成 Postgres 之類的真資料庫。
//    要換的時候只需要改寫這個檔案裡的讀寫實作，
//    下面 module.exports 的介面保持不變，server.js 完全不用動。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.json');
const SESSION_DAYS = 30;
const MAX_LOGIN_RECORDS = 5000;

function emptyDB(){
  return { accounts:{}, sessions:{}, loginRecords:[], games:{} };
}

function load(){
  try{
    const parsed = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    return {
      accounts: parsed.accounts || {},
      sessions: parsed.sessions || {},
      loginRecords: parsed.loginRecords || [],
      games: parsed.games || {}
    };
  }catch(e){
    return emptyDB();
  }
}

let DB = load();
let saveTimer = null;

function save(){
  if(saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(()=>{
    try{
      const tmp = DB_PATH + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(DB, null, 2));
      fs.renameSync(tmp, DB_PATH);   // 原子寫入，避免寫到一半當掉造成檔案損毀
    }catch(e){
      console.error('DB save failed:', e.message);
    }
  }, 150);
}

function genId(prefix){
  return prefix + '_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex');
}

function freshProgress(){
  return {
    coins: 0,           // 🪙 西洋棋貨幣
    ingots: 0,          // 💰 象棋貨幣
    owned: [],          // 西洋棋技能
    equipped: {},       // 西洋棋裝備 (piece -> skillId)
    xqOwned: [],        // 象棋技能
    xqEquipped: {}      // 象棋裝備
  };
}

/* ================= accounts ================= */

// 用 Google 的 sub（Google 帳號的唯一永久 ID）當識別。
// email 可能會被使用者改掉，sub 不會，所以絕對不要拿 email 當主鍵。
function upsertGoogleAccount(profile){
  let acct = Object.values(DB.accounts).find(a => a.googleSub === profile.sub);
  const now = Date.now();
  if(acct){
    acct.email = profile.email || acct.email;
    acct.name = profile.name || acct.name;
    acct.picture = profile.picture || acct.picture;
    acct.lastLoginAt = now;
    acct.loginCount = (acct.loginCount || 0) + 1;
    save();
    return { account: acct, isNew: false };
  }
  const id = genId('acct');
  acct = {
    id,
    googleSub: profile.sub,
    email: profile.email || '',
    name: profile.name || ('玩家' + id.slice(-4)),
    picture: profile.picture || '',
    progress: freshProgress(),
    wins: 0, losses: 0, draws: 0,
    banned: false,
    createdAt: now,
    lastLoginAt: now,
    loginCount: 1
  };
  DB.accounts[id] = acct;
  save();
  return { account: acct, isNew: true };
}

function getAccount(id){ return DB.accounts[id] || null; }
function listAccounts(){
  return Object.values(DB.accounts).sort((a,b)=>(b.lastLoginAt||0)-(a.lastLoginAt||0));
}

function saveProgress(accountId, progress){
  const a = DB.accounts[accountId];
  if(!a) return null;
  const p = a.progress || freshProgress();
  // 只接受已知欄位並做上限保護，避免用戶端亂塞資料進資料庫
  if(Number.isFinite(progress.coins))  p.coins  = Math.max(0, Math.floor(progress.coins));
  if(Number.isFinite(progress.ingots)) p.ingots = Math.max(0, Math.floor(progress.ingots));
  if(Array.isArray(progress.owned))    p.owned    = progress.owned.slice(0,100).map(String);
  if(Array.isArray(progress.xqOwned))  p.xqOwned  = progress.xqOwned.slice(0,100).map(String);
  if(progress.equipped && typeof progress.equipped==='object')     p.equipped   = progress.equipped;
  if(progress.xqEquipped && typeof progress.xqEquipped==='object') p.xqEquipped = progress.xqEquipped;
  a.progress = p;
  save();
  return p;
}

function adjustCurrency(accountId, field, delta){
  const a = DB.accounts[accountId];
  if(!a) return null;
  if(field!=='coins' && field!=='ingots') return null;
  a.progress = a.progress || freshProgress();
  a.progress[field] = Math.max(0, (a.progress[field]||0) + delta);
  save();
  return a;
}

function setBanned(accountId, banned){
  const a = DB.accounts[accountId];
  if(!a) return null;
  a.banned = !!banned;
  if(a.banned) revokeAllSessions(accountId);   // 封鎖時立刻把人踢下線
  save();
  return a;
}

function recordResult(accountId, result){
  const a = DB.accounts[accountId];
  if(!a) return null;
  if(result==='win') a.wins = (a.wins||0)+1;
  else if(result==='loss') a.losses = (a.losses||0)+1;
  else a.draws = (a.draws||0)+1;
  save();
  return a;
}

/* ================= sessions ================= */

function createSession(accountId, meta){
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  DB.sessions[token] = {
    token, accountId,
    createdAt: now,
    expiresAt: now + SESSION_DAYS*24*60*60*1000,
    ip: (meta && meta.ip) || '',
    userAgent: (meta && meta.userAgent) || ''
  };
  save();
  return DB.sessions[token];
}

function getSession(token){
  const s = DB.sessions[token];
  if(!s) return null;
  if(Date.now() > s.expiresAt){ delete DB.sessions[token]; save(); return null; }
  return s;
}

function revokeSession(token){
  if(DB.sessions[token]){ delete DB.sessions[token]; save(); return true; }
  return false;
}

function revokeAllSessions(accountId){
  Object.keys(DB.sessions).forEach(t=>{
    if(DB.sessions[t].accountId === accountId) delete DB.sessions[t];
  });
  save();
}

function listSessions(accountId){
  return Object.values(DB.sessions)
    .filter(s=>!accountId || s.accountId===accountId)
    .sort((a,b)=>b.createdAt-a.createdAt);
}

/* ================= login records ================= */

function recordLogin(accountId, meta){
  const rec = {
    id: genId('login'),
    accountId,
    at: Date.now(),
    ip: (meta && meta.ip) || '',
    userAgent: (meta && meta.userAgent) || '',
    method: (meta && meta.method) || 'google',
    isNew: !!(meta && meta.isNew)
  };
  DB.loginRecords.push(rec);
  if(DB.loginRecords.length > MAX_LOGIN_RECORDS){
    DB.loginRecords = DB.loginRecords.slice(-MAX_LOGIN_RECORDS);
  }
  save();
  return rec;
}

function listLoginRecords(opts){
  opts = opts || {};
  let arr = DB.loginRecords.slice().sort((a,b)=>b.at-a.at);
  if(opts.accountId) arr = arr.filter(r=>r.accountId===opts.accountId);
  if(opts.limit) arr = arr.slice(0, opts.limit);
  return arr.map(r=>{
    const a = DB.accounts[r.accountId];
    return { ...r, accountName: a ? a.name : '(已刪除)', accountEmail: a ? a.email : '' };
  });
}

/* ================= games ================= */

function createGame(info){
  const id = genId('g');
  const game = {
    id,
    family: info.family, variant: info.variant, type: info.type,
    players: info.players,
    status:'active', winner:null, moveCount:0,
    startedAt: Date.now(), endedAt:null
  };
  DB.games[id] = game;
  save();
  return game;
}
function endGame(id, winnerInfo){
  const g = DB.games[id];
  if(!g) return null;
  g.status='finished'; g.winner = winnerInfo || null; g.endedAt = Date.now();
  save();
  return g;
}
function bumpMoveCount(id){
  const g = DB.games[id];
  if(!g) return;
  g.moveCount = (g.moveCount||0)+1;
  save();
}
function listGames(limit){
  const arr = Object.values(DB.games).sort((a,b)=>b.startedAt-a.startedAt);
  return limit ? arr.slice(0,limit) : arr;
}
function getGame(id){ return DB.games[id] || null; }

/* ================= stats ================= */

function stats(){
  const accounts = Object.values(DB.accounts);
  const dayAgo = Date.now() - 24*60*60*1000;
  return {
    totalAccounts: accounts.length,
    bannedAccounts: accounts.filter(a=>a.banned).length,
    activeSessions: Object.keys(DB.sessions).length,
    loginsLast24h: DB.loginRecords.filter(r=>r.at > dayAgo).length,
    totalLogins: DB.loginRecords.length,
    totalGames: Object.keys(DB.games).length
  };
}

module.exports = {
  freshProgress,
  upsertGoogleAccount, getAccount, listAccounts, saveProgress, adjustCurrency,
  setBanned, recordResult,
  createSession, getSession, revokeSession, revokeAllSessions, listSessions,
  recordLogin, listLoginRecords,
  createGame, endGame, bumpMoveCount, listGames, getGame,
  stats
};
