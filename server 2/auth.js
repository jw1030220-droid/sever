// auth.js — Google 憑證驗證 + 工作階段中介層
//
// 這裡做的是「真正的」驗證：用 google-auth-library 檢查 Google 簽發的
// ID token 的數位簽章、發行者、有效期限，以及 audience 是否等於我們的
// Client ID。前端自己解 JWT 只能「讀取」內容，任何人都能偽造，
// 所以真正的把關一定要在這一層做。

const { OAuth2Client } = require('google-auth-library');
const db = require('./db');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const client = new OAuth2Client(GOOGLE_CLIENT_ID);

function clientIp(req){
  // Render / 多數 PaaS 會走反向代理，真實 IP 在 x-forwarded-for
  const fwd = req.headers['x-forwarded-for'];
  if(fwd) return String(fwd).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || '';
}

async function verifyGoogleCredential(credential){
  if(!GOOGLE_CLIENT_ID){
    throw new Error('伺服器沒有設定 GOOGLE_CLIENT_ID 環境變數');
  }
  const ticket = await client.verifyIdToken({
    idToken: credential,
    audience: GOOGLE_CLIENT_ID
  });
  const p = ticket.getPayload();
  if(!p || !p.sub) throw new Error('憑證內容無效');
  if(p.email && p.email_verified === false) throw new Error('這個 Google 帳號的信箱尚未驗證');
  return {
    sub: p.sub,
    email: p.email || '',
    name: p.name || '',
    picture: p.picture || ''
  };
}

// 需要登入的路由掛這個
function requireAuth(req, res, next){
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if(!token) return res.status(401).json({ error:'not_signed_in' });
  const session = db.getSession(token);
  if(!session) return res.status(401).json({ error:'session_expired' });
  const account = db.getAccount(session.accountId);
  if(!account) return res.status(401).json({ error:'account_missing' });
  if(account.banned) return res.status(403).json({ error:'banned' });
  req.session = session;
  req.account = account;
  next();
}

// 回給前端的帳號資料（不要把 sessions 之類的內部欄位吐出去）
function publicAccount(a){
  return {
    id: a.id,
    name: a.name,
    email: a.email,
    picture: a.picture,
    progress: a.progress || db.freshProgress(),
    wins: a.wins||0, losses: a.losses||0, draws: a.draws||0,
    createdAt: a.createdAt,
    loginCount: a.loginCount||0
  };
}

module.exports = { verifyGoogleCredential, requireAuth, publicAccount, clientIp, GOOGLE_CLIENT_ID };
