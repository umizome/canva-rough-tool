// HTTP サーバー本体。画面（public/）と API を提供する。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config, ROOT } from './config.js';
import { db, newId, getProject, getVariants, getVariant } from './db.js';
import { randomToken } from './secure.js';
import { buildAuthorizeUrl, exchangeCode, resetOAuthCache } from './canva-oauth.js';
import { saveUserTokens } from './canva.js';
import { startProject, retryVariant, refreshImages, commentIntents, getDirections, recoverInterrupted } from './pipeline.js';

const PUBLIC = path.join(ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------- 小さなヘルパー ----------
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'content-type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}
function redirect(res, location, headers = {}) {
  res.writeHead(302, { location, ...headers });
  res.end();
}
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) throw new HttpError(413, '入力が大きすぎます。');
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new HttpError(400, '入力を読み取れませんでした。'); }
}

// ---------- セッション ----------
function getSession(req, res) {
  const sid = parseCookies(req).sid;
  let session = sid ? db.prepare('SELECT * FROM sessions WHERE id = ?').get(sid) : null;
  if (!session) {
    const id = randomToken(24);
    db.prepare('INSERT INTO sessions(id) VALUES (?)').run(id);
    session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
    const secure = config.baseUrl.startsWith('https://') ? '; Secure' : '';
    res.setHeader('set-cookie', `sid=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 90}${secure}`);
  }
  return { ...session };
}
function currentUser(session) {
  if (!session.user_id) return null;
  const u = db.prepare('SELECT id, display_name, tokens_enc FROM users WHERE id = ?').get(session.user_id);
  if (!u) return null;
  return { id: u.id, displayName: u.display_name, loggedIn: config.mock || !!u.tokens_enc };
}
function requireUser(session) {
  const user = currentUser(session);
  if (!user?.loggedIn) throw new HttpError(401, 'Canva にログインしてください。');
  return user;
}

// ---------- 表示用の整形 ----------
function variantView(v) {
  return {
    id: v.id,
    position: v.position,
    directionId: v.direction_id,
    status: v.status,
    designId: v.design_id,
    editUrl: v.edit_url,
    viewUrl: v.view_url,
    pageCount: v.page_count,
    images: v.images_json ? JSON.parse(v.images_json) : [],
    imagesAt: v.images_at,
    memo: v.memo_json ? JSON.parse(v.memo_json) : null,
    commentedAt: v.commented_at,
    error: v.error,
  };
}
function projectView(p, { withVariants = true } = {}) {
  const owner = db.prepare('SELECT display_name FROM users WHERE id = ?').get(p.user_id);
  return {
    id: p.id,
    userId: p.user_id,
    owner: owner?.display_name || '',
    title: p.title,
    brief: JSON.parse(p.brief_json),
    plan: p.plan_json ? JSON.parse(p.plan_json) : null,
    status: p.status,
    error: p.error,
    createdAt: p.created_at,
    variants: withVariants ? getVariants(p.id).map(variantView) : undefined,
  };
}

function validateBrief(b) {
  const s = (v, max) => String(v ?? '').trim().slice(0, max);
  const directions = getDirections().map((d) => d.id);
  const brief = {
    purpose: s(b.purpose, 200),
    audience: s(b.audience, 200),
    message: s(b.message, 100),
    details: s(b.details, 600),
    pageCount: Number(b.pageCount) === 3 ? 3 : 4,
    platform: ['instagram', 'tiktok', 'youtube', 'facebook'].includes(b.platform) ? b.platform : 'instagram',
    directionIds: (Array.isArray(b.directionIds) ? b.directionIds : []).filter((d) => directions.includes(d)).slice(0, 3),
  };
  if (!brief.purpose) throw new HttpError(400, '「何の投稿か」を入力してください。');
  if (!brief.message) throw new HttpError(400, '「一番伝えたい一言」を入力してください。');
  if (brief.directionIds.length < 1) throw new HttpError(400, '見た目の方向性を1つ以上選んでください。');
  return brief;
}

// ---------- ルーティング ----------
async function handle(req, res) {
  const url = new URL(req.url, config.baseUrl);
  const p = url.pathname;
  const method = req.method;

  // 静的ファイル
  if (method === 'GET' && !p.startsWith('/api/') && !p.startsWith('/auth/')) {
    const file = path.normalize(path.join(PUBLIC, p === '/' ? 'index.html' : p));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      return send(res, 404, 'Not found');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    return fs.createReadStream(file).pipe(res);
  }

  // 書き込み系 API は fetch からの呼び出しに限る（簡易的な CSRF 対策）
  if (method !== 'GET' && p.startsWith('/api/') && req.headers['x-requested-with'] !== 'fetch') {
    throw new HttpError(403, '不正なリクエストです。');
  }

  const session = getSession(req, res);

  // ----- ログイン -----
  if (method === 'GET' && p === '/auth/login') {
    if (config.mock) {
      let userId = session.user_id;
      if (!userId) {
        userId = newId();
        db.prepare('INSERT INTO users(id, display_name, tokens_enc) VALUES (?, ?, ?)').run(userId, '', 'mock');
        db.prepare('UPDATE sessions SET user_id = ? WHERE id = ?').run(userId, session.id);
      }
      return redirect(res, '/');
    }
    const state = randomToken(16);
    const verifier = randomToken(48);
    db.prepare('UPDATE sessions SET oauth_state = ?, oauth_verifier = ? WHERE id = ?').run(state, verifier, session.id);
    try {
      return redirect(res, await buildAuthorizeUrl({ state, verifier }));
    } catch (e) {
      console.error('[login]', e);
      return send(res, 502, `Canva のログインを始められませんでした。\n${e.message}\n\nブラウザの「戻る」でアプリに戻ってください。`);
    }
  }

  if (method === 'GET' && p === '/auth/callback') {
    const error = url.searchParams.get('error');
    if (error) return redirect(res, `/#/?login_error=${encodeURIComponent(url.searchParams.get('error_description') || error)}`);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !state || state !== session.oauth_state) {
      return redirect(res, '/#/?login_error=' + encodeURIComponent('ログインの確認に失敗しました。もう一度お試しください。'));
    }
    try {
      const tokens = await exchangeCode(code, session.oauth_verifier);
      let userId = session.user_id;
      if (!userId) {
        userId = newId();
        db.prepare('INSERT INTO users(id) VALUES (?)').run(userId);
      }
      saveUserTokens(userId, tokens);
      db.prepare('UPDATE sessions SET user_id = ?, oauth_state = NULL, oauth_verifier = NULL WHERE id = ?').run(userId, session.id);
      return redirect(res, '/');
    } catch (e) {
      console.error('[callback]', e);
      if (/invalid_client/.test(e.code || '')) resetOAuthCache();
      return redirect(res, '/#/?login_error=' + encodeURIComponent(e.message));
    }
  }

  if (method === 'POST' && p === '/api/logout') {
    if (session.user_id && !config.mock) saveUserTokens(session.user_id, null);
    return send(res, 200, { ok: true });
  }

  // ----- 自分の情報 -----
  if (method === 'GET' && p === '/api/me') {
    const user = currentUser(session);
    return send(res, 200, {
      mock: config.mock,
      claudeReady: config.mock || !!config.anthropicApiKey,
      user: user ? { id: user.id, displayName: user.displayName, loggedIn: user.loggedIn } : null,
      directions: getDirections(),
    });
  }
  if (method === 'POST' && p === '/api/me') {
    const user = requireUser(session);
    const body = await readBody(req);
    const name = String(body.displayName || '').trim().slice(0, 40);
    if (!name) throw new HttpError(400, '名前を入力してください。');
    db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(name, user.id);
    return send(res, 200, { ok: true });
  }

  // ----- 投稿（プロジェクト） -----
  if (method === 'GET' && p === '/api/projects') {
    const user = requireUser(session);
    const scope = url.searchParams.get('scope') === 'mine' ? 'mine' : 'all';
    const q = String(url.searchParams.get('q') || '').trim();
    let sql = 'SELECT * FROM projects';
    const where = [];
    const args = [];
    if (scope === 'mine') { where.push('user_id = ?'); args.push(user.id); }
    if (q) { where.push('(title LIKE ? OR brief_json LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
    if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
    sql += ' ORDER BY created_at DESC LIMIT 100';
    const items = db.prepare(sql).all(...args).map((row) => {
      const view = projectView({ ...row }, { withVariants: false });
      const vs = getVariants(row.id);
      view.variantCount = vs.length;
      view.doneCount = vs.filter((v) => v.status === 'done').length;
      return view;
    });
    return send(res, 200, { items });
  }

  if (method === 'POST' && p === '/api/projects') {
    const user = requireUser(session);
    if (!config.mock && !config.anthropicApiKey) throw new HttpError(500, 'Claude API のキーが設定されていません（.env の ANTHROPIC_API_KEY）。');
    const brief = validateBrief(await readBody(req));
    const id = newId();
    db.prepare('INSERT INTO projects(id, user_id, title, brief_json) VALUES (?, ?, ?, ?)').run(id, user.id, brief.message.slice(0, 30), JSON.stringify(brief));
    brief.directionIds.forEach((dir, i) => {
      db.prepare('INSERT INTO variants(id, project_id, position, direction_id) VALUES (?, ?, ?, ?)').run(newId(), id, i, dir);
    });
    startProject(id);
    return send(res, 201, { id });
  }

  let m;
  if (method === 'GET' && (m = p.match(/^\/api\/projects\/([\w-]+)$/))) {
    requireUser(session);
    const project = getProject(m[1]);
    if (!project) throw new HttpError(404, '見つかりませんでした。');
    return send(res, 200, projectView(project));
  }

  if (method === 'POST' && (m = p.match(/^\/api\/variants\/([\w-]+)\/(retry|comment|refresh-images)$/))) {
    const user = requireUser(session);
    const v = getVariant(m[1]);
    if (!v) throw new HttpError(404, '見つかりませんでした。');
    const project = getProject(v.project_id);
    if (project.user_id !== user.id) throw new HttpError(403, '作った本人だけが操作できます。');
    if (m[2] === 'retry') {
      retryVariant(v.id);
      return send(res, 200, { ok: true });
    }
    if (!v.design_id) throw new HttpError(400, 'まだ絵コンテができていません。');
    if (m[2] === 'comment') {
      await commentIntents(v.id);
      return send(res, 200, variantView(getVariant(v.id)));
    }
    return send(res, 200, variantView(await refreshImages(v.id)));
  }

  throw new HttpError(404, '見つかりませんでした。');
}

recoverInterrupted();

const server = http.createServer(async (req, res) => {
  try {
    await handle(req, res);
  } catch (e) {
    const status = e.status || (e.code === 'login_required' ? 401 : 500);
    if (status >= 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: e.message || 'エラーが発生しました。' });
  }
});

server.listen(config.port, config.host, () => {
  console.log('');
  console.log('  SNS動画ラフ生成ツール が起動しました');
  console.log(`  ブラウザで ${config.baseUrl} を開いてください`);
  if (config.mock) console.log('  （モックモード：Canva と Claude にはつながりません）');
  else if (!config.anthropicApiKey) console.log('  ⚠ .env に ANTHROPIC_API_KEY が入っていません');
  console.log('  終了するには Ctrl + C');
  console.log('');
});

export { server };
