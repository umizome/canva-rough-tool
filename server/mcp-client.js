// MCP（Model Context Protocol）の Streamable HTTP クライアント。
// 外部ライブラリを使わず、JSON-RPC を fetch で送る。
const PROTOCOL_VERSION = '2025-06-18';

export class McpError extends Error {
  constructor(message, { code, status, data } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.data = data;
  }
}

function parseSse(text) {
  const messages = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data) continue;
    try { messages.push(JSON.parse(data)); } catch { /* 無視 */ }
  }
  return messages;
}

export class McpClient {
  /**
   * @param {object} opts
   * @param {string} opts.url MCP エンドポイント
   * @param {() => Promise<string>} opts.getToken アクセストークンを返す
   * @param {() => Promise<string>} opts.refreshToken 401 のときに新しいトークンを返す
   */
  constructor({ url, getToken, refreshToken, clientName = 'canva-rough-tool' }) {
    this.url = url;
    this.getToken = getToken;
    this.refreshToken = refreshToken;
    this.clientName = clientName;
    this.sessionId = null;
    this.protocolVersion = PROTOCOL_VERSION;
    this.initialized = false;
    this.nextId = 1;
    this.toolsCache = null;
  }

  async #post(message, { retried = false } = {}) {
    const token = await this.getToken();
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    if (this.initialized) headers['mcp-protocol-version'] = this.protocolVersion;

    let res;
    try {
      res = await fetch(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(120000),
      });
    } catch (e) {
      throw new McpError(`Canva に接続できませんでした：${e.message}`, { code: 'network' });
    }

    if (res.status === 401 && !retried) {
      await this.refreshToken();
      return this.#post(message, { retried: true });
    }
    if (res.status === 401) {
      throw new McpError('Canva のログインが必要です。', { code: 'login_required', status: 401 });
    }
    if (res.status === 404 && this.sessionId && message.method !== 'initialize' && !retried) {
      // セッションが切れたので張り直す
      this.reset();
      await this.initialize();
      return this.#post(message, { retried: true });
    }

    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;

    if (res.status === 202 || message.id === undefined) return null;

    const text = await res.text();
    if (!res.ok) {
      throw new McpError(`Canva からエラーが返りました（${res.status}）：${text.slice(0, 300)}`, { status: res.status });
    }
    const type = res.headers.get('content-type') || '';
    const messages = type.includes('text/event-stream') ? parseSse(text) : [JSON.parse(text)].flat();
    const reply = messages.find((m) => m && m.id === message.id && ('result' in m || 'error' in m));
    if (!reply) throw new McpError('Canva からの応答を読み取れませんでした。', { status: res.status });
    if (reply.error) {
      throw new McpError(reply.error.message || 'Canva でエラーが発生しました。', { code: reply.error.code, data: reply.error.data });
    }
    return reply.result;
  }

  reset() {
    this.sessionId = null;
    this.initialized = false;
  }

  async initialize() {
    const result = await this.#post({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: this.clientName, version: '0.1.0' },
      },
    });
    if (result?.protocolVersion) this.protocolVersion = result.protocolVersion;
    this.initialized = true;
    await this.#post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return result;
  }

  async request(method, params) {
    if (!this.initialized) await this.initialize();
    return this.#post({ jsonrpc: '2.0', id: this.nextId++, method, params });
  }

  async listTools() {
    if (this.toolsCache) return this.toolsCache;
    const tools = [];
    let cursor;
    do {
      const result = await this.request('tools/list', cursor ? { cursor } : {});
      tools.push(...(result?.tools || []));
      cursor = result?.nextCursor;
    } while (cursor);
    this.toolsCache = tools;
    return tools;
  }

  /** ツールを呼び、結果を JSON（読めなければ文字列）で返す */
  async callTool(name, args) {
    const result = await this.request('tools/call', { name, arguments: args });
    const text = (result?.content || [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
    if (result?.isError) {
      throw new McpError(text || `${name} でエラーが発生しました。`, { code: 'tool_error' });
    }
    if (result?.structuredContent) return result.structuredContent;
    try { return JSON.parse(text); } catch { return text; }
  }
}
