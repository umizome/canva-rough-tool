// Canva MCP の各ツールを、このアプリで使う形にまとめたもの。
import { config } from './config.js';
import { db } from './db.js';
import { encrypt, decrypt } from './secure.js';
import { McpClient, McpError } from './mcp-client.js';
import { refreshTokens } from './canva-oauth.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIN_POLL_SECONDS = Number(process.env.MCP_POLL_MIN_SECONDS ?? 3);
const clients = new Map(); // userId -> McpClient（セッションを使い回す）

export class LoginRequiredError extends Error {
  constructor(message = 'Canva のログインが必要です。') {
    super(message);
    this.code = 'login_required';
  }
}

function loadTokens(userId) {
  const row = db.prepare('SELECT tokens_enc FROM users WHERE id = ?').get(userId);
  return row ? decrypt(row.tokens_enc) : null;
}
function saveTokens(userId, tokens) {
  db.prepare('UPDATE users SET tokens_enc = ? WHERE id = ?').run(tokens ? encrypt(tokens) : null, userId);
}

export function saveUserTokens(userId, tokens) {
  saveTokens(userId, tokens);
  clients.delete(userId);
}

function clientFor(userId) {
  if (clients.has(userId)) return clients.get(userId);
  let refreshing = null;
  const refresh = async () => {
    if (!refreshing) {
      refreshing = (async () => {
        try {
          const next = await refreshTokens(loadTokens(userId));
          saveTokens(userId, next);
          return next.accessToken;
        } catch (e) {
          saveTokens(userId, null);
          clients.delete(userId);
          throw new LoginRequiredError(e.message);
        } finally {
          setTimeout(() => { refreshing = null; }, 0);
        }
      })();
    }
    return refreshing;
  };
  const client = new McpClient({
    url: config.canvaMcpUrl,
    clientName: 'canva-rough-tool',
    getToken: async () => {
      const t = loadTokens(userId);
      if (!t?.accessToken) throw new LoginRequiredError();
      if (t.expiresAt && Date.now() > t.expiresAt) return refresh();
      return t.accessToken;
    },
    refreshToken: refresh,
  });
  clients.set(userId, client);
  return client;
}

// 応答の中から最初に見つかった key の値を探す（ツールの応答形式の違いに備える）
function findFirst(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (key in obj) return obj[key];
  for (const v of Object.values(obj)) {
    const found = findFirst(v, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

export function canvaFor(userId) {
  const mcp = clientFor(userId);
  const intent = (s) => ({ user_intent: s });

  async function call(name, args) {
    try {
      return await mcp.callTool(name, args);
    } catch (e) {
      if (e instanceof LoginRequiredError || e.code === 'login_required') throw new LoginRequiredError(e.message);
      throw e;
    }
  }

  async function toolNames() {
    const tools = await mcp.listTools();
    return new Set(tools.map((t) => t.name));
  }

  async function waitForCreateJob(first) {
    let { job_id: jobId, continuation_token: token } = first;
    let wait = first.polling_policy?.wait_seconds ?? 15;
    const deadline = Date.now() + 6 * 60 * 1000;
    while (Date.now() < deadline) {
      await sleep(Math.max(wait, MIN_POLL_SECONDS) * 1000 + 500);
      const res = await call('get-create-design-async-job', { job_id: jobId, continuation_token: token, ...intent('絵コンテ生成の進み具合を確認') });
      token = res.continuation_token || token;
      wait = res.polling_policy?.wait_seconds ?? 10;
      if (res.status === 'completed') {
        const id = res.design?.id || findFirst(res, 'design_id');
        if (!id) throw new Error('Canva から絵コンテのIDを受け取れませんでした。');
        return id;
      }
      if (res.status === 'failed' || res.status === 'error' || res.status === 'cancelled') {
        throw new Error(`Canva での生成に失敗しました：${res.error?.message || res.message || res.status}`);
      }
    }
    throw new Error('Canva での生成が6分以内に終わりませんでした。時間をおいて作り直してください。');
  }

  return {
    /** 指示文から縦型の絵コンテを1つ作り、デザインIDを返す */
    async createStoryboard(brief) {
      const names = await toolNames();
      if (names.has('create-design')) {
        const first = await call('create-design', { brief, format: 'Your Story', ...intent('SNS動画ラフ用の縦型絵コンテを作る') });
        if (first.status === 'completed' && first.design?.id) return first.design.id;
        if (!first.job_id) throw new Error(`Canva の応答が想定と違います：${JSON.stringify(first).slice(0, 200)}`);
        return waitForCreateJob(first);
      }
      if (names.has('generate-design') && names.has('create-design-from-candidate')) {
        const gen = await call('generate-design', { query: brief, design_type: 'your_story', ...intent('SNS動画ラフ用の縦型絵コンテを作る') });
        const jobId = findFirst(gen, 'job_id');
        const candidateId = findFirst(gen, 'candidate_id');
        if (!jobId || !candidateId) throw new Error('Canva から絵コンテの候補を受け取れませんでした。');
        const created = await call('create-design-from-candidate', { job_id: jobId, candidate_id: candidateId, ...intent('候補を保存する') });
        const id = findFirst(created, 'id') || findFirst(created, 'design_id');
        if (!id) throw new Error('Canva から絵コンテのIDを受け取れませんでした。');
        return id;
      }
      throw new Error('この Canva アカウントでは、AIでデザインを作るツールが使えません。');
    },

    /** タイトル・ページ数・編集URL・文字を読む */
    async readDesign(designId) {
      const res = await call('read-design', {
        design_id: designId,
        filter: { fields: ['design_metadata', 'page_metadata', 'design_content'] },
        ...intent('絵コンテの内容を読み、動画化メモを作る'),
      });
      const meta = res.design_metadata || {};
      return {
        title: meta.title || '',
        pageCount: meta.page_count || res.page_metadata?.length || null,
        editUrl: meta.urls?.edit_url || null,
        viewUrl: meta.urls?.view_url || null,
        text: typeof res.design_content === 'string' ? res.design_content : JSON.stringify(res.design_content || ''),
      };
    },

    /** 各ページを PNG に書き出し、ページ順のURL（約11時間有効）を返す */
    async exportPages(designId) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const res = await call('export-design', {
          design_id: designId,
          format: { type: 'png', width: 540 },
          ...intent('比較画面に出すため絵コンテを画像にする'),
        });
        const job = res.job || res;
        if (job.status === 'success' && job.urls?.length) return job.urls;
        if (job.status === 'failed') throw new Error(`画像の書き出しに失敗しました：${job.error?.message || ''}`);
        await sleep(5000);
      }
      throw new Error('画像の書き出しが終わりませんでした。');
    },

    async comment(designId, message) {
      return call('comment-on-design', { design_id: designId, message_plaintext: message.slice(0, 1000), ...intent('校正者向けにページの意図をコメントする') });
    },

    async listToolNames() {
      return [...(await toolNames())].sort();
    },
  };
}

export { McpError };
