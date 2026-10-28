// 偽物の Canva と Claude を相手に、ログインから絵コンテ3案・動画化メモ・コメントまでを通しで確かめる。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFakeServices } from './fake-services.js';

const fake = await startFakeServices();
const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rough-tool-'));

Object.assign(process.env, {
  PORT: String(PORT),
  HOST: '127.0.0.1',
  BASE_URL: BASE,
  CANVA_MCP_URL: `${fake.origin}/mcp`,
  ANTHROPIC_API_KEY: 'test-key',
  ANTHROPIC_BASE_URL: fake.origin,
  DATA_DIR: dataDir,
  MCP_POLL_MIN_SECONDS: '0',
});

const { server } = await import('../server/index.js');
await new Promise((r) => (server.listening ? r() : server.once('listening', r)));

after(() => {
  server.close();
  fake.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

let cookie = '';
async function api(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    redirect: 'manual',
    headers: { cookie, 'x-requested-with': 'fetch', 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const type = res.headers.get('content-type') || '';
  return { status: res.status, location: res.headers.get('location'), body: type.includes('json') ? await res.json() : await res.text() };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitForProject(id) {
  for (let i = 0; i < 100; i++) {
    const { body } = await api('GET', `/api/projects/${id}`);
    if (['done', 'error'].includes(body.status)) return body;
    await wait(200);
  }
  throw new Error('timeout');
}

test('ログイン前は API が 401 になる', async () => {
  const me = await api('GET', '/api/me');
  assert.equal(me.body.user, null);
  assert.equal(me.body.directions.length, 3);
  const list = await api('GET', '/api/projects');
  assert.equal(list.status, 401);
});

test('Canva ログイン（発見 → 動的登録 → PKCE → トークン）', async () => {
  const start = await api('GET', '/auth/login');
  assert.equal(start.status, 302);
  const authUrl = new URL(start.location);
  assert.equal(authUrl.origin, fake.origin);
  assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authUrl.searchParams.get('resource'), `${fake.origin}/mcp`);
  assert.equal(authUrl.searchParams.get('scope'), 'design:content:read design:content:write');

  const authorize = await fetch(authUrl, { redirect: 'manual' });
  const callback = new URL(authorize.headers.get('location'));
  assert.equal(callback.origin + callback.pathname, `${BASE}/auth/callback`);

  const done = await api('GET', callback.pathname + callback.search);
  assert.equal(done.status, 302);
  assert.equal(done.location, '/');

  const me = await api('GET', '/api/me');
  assert.equal(me.body.user.loggedIn, true);
  assert.equal((await api('POST', '/api/me', { displayName: 'テスト太郎' })).status, 200);
});

test('state が違うコールバックは受け付けない', async () => {
  const bad = await api('GET', '/auth/callback?code=x&state=wrong');
  assert.match(decodeURIComponent(bad.location), /login_error=ログインの確認に失敗/);
});

test('fetch 以外からの書き込みは拒否する', async () => {
  const res = await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { cookie }, body: '{}' });
  assert.equal(res.status, 403);
});

test('入力チェック', async () => {
  const res = await api('POST', '/api/projects', { purpose: '', message: 'x', directionIds: ['pop'] });
  assert.equal(res.status, 400);
});

let projectId;
test('ブリーフから3案の絵コンテと動画化メモができる', async () => {
  const created = await api('POST', '/api/projects', {
    purpose: '地域清掃ボランティアの募集',
    audience: '地域の家族',
    message: 'この川、きれいにしませんか？',
    details: '11月23日 9:00〜11:00 みどり川河川敷',
    pageCount: 4,
    platform: 'instagram',
    directionIds: ['pop', 'trust', 'emotional'],
  });
  assert.equal(created.status, 201);
  projectId = created.body.id;

  const project = await waitForProject(projectId);
  assert.equal(project.status, 'done', JSON.stringify(project));
  assert.equal(project.plan.pages.length, 4);
  assert.equal(project.owner, 'テスト太郎');
  assert.equal(project.variants.length, 3);
  for (const v of project.variants) {
    assert.equal(v.status, 'done', v.error);
    assert.equal(v.images.length, 4);
    assert.equal(v.pageCount, 4);
    assert.match(v.editUrl, /canva\.com/);
    assert.equal(v.memo.pages.length, 4);
    assert.equal(v.memo.total_seconds, 16);
  }
  // Canva に渡した指示文に、構成案のテロップと方向性が入っている
  const briefs = [...fake.state.designs.values()].map((d) => d.brief);
  assert.match(briefs[0], /1ページ目（つかみ）：テロップ「見出し1」/);
  assert.match(briefs[1], /紺・白・グレー/);
});

test('アクセストークンが切れても自動で更新して続けられる', async () => {
  const { body } = await api('GET', `/api/projects/${projectId}`);
  fake.state.expireNextToken = true;
  const res = await api('POST', `/api/variants/${body.variants[0].id}/comment`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(res.body.commentedAt);
  assert.equal(fake.state.refreshCount, 1);
  assert.match(fake.state.comments[0].message_plaintext, /【1ページ目：つかみ】意図1／動き：4秒/);
});

test('案を1つだけ作り直せる', async () => {
  const { body } = await api('GET', `/api/projects/${projectId}`);
  const before = body.variants[1].designId;
  await api('POST', `/api/variants/${body.variants[1].id}/retry`);
  const project = await waitForProject(projectId);
  assert.equal(project.variants[1].status, 'done');
  assert.notEqual(project.variants[1].designId, before);
});

test('一覧と検索', async () => {
  const all = await api('GET', '/api/projects');
  assert.equal(all.body.items.length, 1);
  assert.equal(all.body.items[0].doneCount, 3);
  const hit = await api('GET', `/api/projects?q=${encodeURIComponent('河川敷')}`);
  assert.equal(hit.body.items.length, 1);
  const miss = await api('GET', `/api/projects?q=${encodeURIComponent('存在しない')}`);
  assert.equal(miss.body.items.length, 0);
});
