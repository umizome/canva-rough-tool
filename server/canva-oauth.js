// Canva MCP サーバーへのログイン（OAuth 2.1 + PKCE + 動的クライアント登録）。
// MCP の認可仕様に沿って、サーバーの情報を自動で調べてからログイン画面に送る。
import { config } from './config.js';
import { getSetting, setSetting, deleteSetting } from './db.js';
import { pkceChallenge } from './secure.js';

const CLIENT_NAME = 'SNS動画ラフ生成ツール（社内用）';
const redirectUri = () => `${config.baseUrl}/auth/callback`;

async function getJson(url, init = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
  if (!res.ok) return null;
  try { return await res.json(); } catch { return null; }
}

function wellKnownUrls(base, name) {
  const u = new URL(base);
  const path = u.pathname.replace(/\/$/, '');
  const urls = [];
  if (path) urls.push(`${u.origin}/.well-known/${name}${path}`);
  urls.push(`${u.origin}/.well-known/${name}`);
  return urls;
}

// MCP エンドポイントに未認証で問い合わせ、401 の WWW-Authenticate から resource_metadata を得る
async function probeResourceMetadataUrl() {
  try {
    const res = await fetch(config.canvaMcpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' }),
      signal: AbortSignal.timeout(20000),
    });
    const header = res.headers.get('www-authenticate') || '';
    const m = header.match(/resource_metadata="([^"]+)"/i);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export async function discover({ force = false } = {}) {
  const cached = getSetting('oauth_meta');
  if (cached && !force && cached.mcpUrl === config.canvaMcpUrl) return cached;

  let resourceMeta = null;
  const hinted = await probeResourceMetadataUrl();
  for (const url of [hinted, ...wellKnownUrls(config.canvaMcpUrl, 'oauth-protected-resource')].filter(Boolean)) {
    resourceMeta = await getJson(url);
    if (resourceMeta) break;
  }

  const issuer = resourceMeta?.authorization_servers?.[0] || new URL(config.canvaMcpUrl).origin;
  let asMeta = null;
  const candidates = [
    ...wellKnownUrls(issuer, 'oauth-authorization-server'),
    ...wellKnownUrls(issuer, 'openid-configuration'),
  ];
  for (const url of candidates) {
    asMeta = await getJson(url);
    if (asMeta?.authorization_endpoint && asMeta?.token_endpoint) break;
    asMeta = null;
  }
  if (!asMeta) {
    throw new Error(`Canva のログイン情報を取得できませんでした（${issuer}）。ネットワーク接続を確認してください。`);
  }

  const meta = {
    mcpUrl: config.canvaMcpUrl,
    resource: resourceMeta?.resource || config.canvaMcpUrl,
    scopes: resourceMeta?.scopes_supported || asMeta.scopes_supported || null,
    issuer: asMeta.issuer || issuer,
    authorizationEndpoint: asMeta.authorization_endpoint,
    tokenEndpoint: asMeta.token_endpoint,
    registrationEndpoint: asMeta.registration_endpoint || null,
  };
  setSetting('oauth_meta', meta);
  return meta;
}

// 動的クライアント登録（DCR）。一度登録したら data/app.db に保存して使い回す。
export async function ensureClient(meta) {
  const cached = getSetting('oauth_client');
  if (cached && cached.issuer === meta.issuer && cached.redirectUri === redirectUri()) return cached;
  if (!meta.registrationEndpoint) {
    throw new Error('Canva がクライアントの自動登録に対応していません。Canva の開発者窓口に、このツールの利用申請をしてください。');
  }
  const res = await fetch(meta.registrationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: CLIENT_NAME,
      redirect_uris: [redirectUri()],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(meta.scopes ? { scope: meta.scopes.join(' ') } : {}),
    }),
    signal: AbortSignal.timeout(20000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.client_id) {
    throw new Error(`Canva へのクライアント登録に失敗しました（${res.status}）：${body.error_description || body.error || '不明なエラー'}`);
  }
  const client = {
    issuer: meta.issuer,
    redirectUri: redirectUri(),
    clientId: body.client_id,
    clientSecret: body.client_secret || null,
  };
  setSetting('oauth_client', client);
  return client;
}

export function resetOAuthCache() {
  deleteSetting('oauth_meta');
  deleteSetting('oauth_client');
}

export async function buildAuthorizeUrl({ state, verifier }) {
  const meta = await discover();
  const client = await ensureClient(meta);
  const url = new URL(meta.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', client.clientId);
  url.searchParams.set('redirect_uri', client.redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', pkceChallenge(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('resource', meta.resource);
  if (meta.scopes) url.searchParams.set('scope', meta.scopes.join(' '));
  return url.toString();
}

async function tokenRequest(params) {
  const meta = await discover();
  const client = await ensureClient(meta);
  const body = new URLSearchParams({ ...params, client_id: client.clientId, resource: meta.resource });
  if (client.clientSecret) body.set('client_secret', client.clientSecret);
  const res = await fetch(meta.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
    signal: AbortSignal.timeout(20000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    const err = new Error(`Canva のトークン取得に失敗しました（${res.status}）：${json.error_description || json.error || '不明なエラー'}`);
    err.code = json.error || 'token_error';
    throw err;
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token || params.refresh_token || null,
    expiresAt: json.expires_in ? Date.now() + (Number(json.expires_in) - 60) * 1000 : null,
  };
}

export function exchangeCode(code, verifier) {
  return tokenRequest({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri() });
}

export function refreshTokens(tokens) {
  if (!tokens?.refreshToken) {
    const err = new Error('Canva のログインの有効期限が切れました。もう一度ログインしてください。');
    err.code = 'login_required';
    throw err;
  }
  return tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken });
}
