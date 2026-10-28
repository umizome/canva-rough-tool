// テスト用の偽物サーバー：Canva MCP（OAuth + 動的クライアント登録 + Streamable HTTP）と Claude API を真似る。
import http from 'node:http';
import crypto from 'node:crypto';

export function startFakeServices() {
  const state = {
    clients: new Map(),
    codes: new Map(),
    validTokens: new Set(),
    refreshTokens: new Set(),
    sessions: new Set(),
    designs: new Map(),
    jobs: new Map(),
    comments: [],
    calls: [],
    expireNextToken: false,
    refreshCount: 0,
  };
  let origin;

  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  const readBody = async (req) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8');
  };
  const issueTokens = () => {
    const access = crypto.randomBytes(8).toString('hex');
    const refresh = crypto.randomBytes(8).toString('hex');
    state.validTokens.add(access);
    state.refreshTokens.add(refresh);
    return { access_token: access, refresh_token: refresh, expires_in: 3600, token_type: 'Bearer' };
  };

  function toolCall(name, args) {
    state.calls.push(name);
    const text = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });
    switch (name) {
      case 'create-design': {
        const jobId = crypto.randomUUID();
        const designId = 'D' + crypto.randomBytes(5).toString('hex').toUpperCase();
        const pages = (args.brief.match(/\dページ目/g) || []).length;
        state.designs.set(designId, { brief: args.brief, pages });
        state.jobs.set(jobId, { designId, polls: 0 });
        return text({ job_id: jobId, status: 'pending', continuation_token: 't0', polling_policy: { wait_seconds: 0 } });
      }
      case 'get-create-design-async-job': {
        const job = state.jobs.get(args.job_id);
        job.polls++;
        if (job.polls < 2) return text({ job_id: args.job_id, status: 'in_progress', continuation_token: `t${job.polls}`, polling_policy: { wait_seconds: 0 } });
        return text({ job_id: args.job_id, status: 'completed', design: { id: job.designId, url: 'https://canva.link/x', edit_url: 'https://canva.link/x' } });
      }
      case 'read-design': {
        const d = state.designs.get(args.design_id);
        const lines = [...d.brief.matchAll(/テロップ「(.+?)」/g)].map((m) => m[1]);
        return text({
          design_metadata: { id: args.design_id, title: 'テスト絵コンテ', page_count: d.pages, urls: { edit_url: `https://www.canva.com/d/edit-${args.design_id}`, view_url: `https://www.canva.com/d/view-${args.design_id}` } },
          page_metadata: Array.from({ length: d.pages }, (_, i) => ({ index: i + 1, dimensions: { width: 1080, height: 1920 } })),
          design_content: lines.join('\n'),
        });
      }
      case 'export-design': {
        const d = state.designs.get(args.design_id);
        return text({ job: { id: 'e1', status: 'success', urls: Array.from({ length: d.pages }, (_, i) => `https://export.example/${args.design_id}/${i + 1}.png`) } });
      }
      case 'comment-on-design':
        state.comments.push(args);
        return text({ comment: { id: 'c1' } });
      default:
        return { isError: true, content: [{ type: 'text', text: `unknown tool ${name}` }] };
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    const p = url.pathname;

    if (p === '/.well-known/oauth-protected-resource/mcp') {
      return json(res, 200, { resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ['design:content:read', 'design:content:write'] });
    }
    if (p === '/.well-known/oauth-authorization-server') {
      return json(res, 200, { issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`, code_challenge_methods_supported: ['S256'] });
    }
    if (p === '/register' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const id = 'client-' + crypto.randomBytes(4).toString('hex');
      state.clients.set(id, body);
      return json(res, 201, { client_id: id, ...body });
    }
    if (p === '/authorize') {
      const clientId = url.searchParams.get('client_id');
      const redirectUri = url.searchParams.get('redirect_uri');
      if (!state.clients.get(clientId)?.redirect_uris.includes(redirectUri)) return json(res, 400, { error: 'invalid_request' });
      if (url.searchParams.get('code_challenge_method') !== 'S256') return json(res, 400, { error: 'invalid_request' });
      const code = crypto.randomBytes(6).toString('hex');
      state.codes.set(code, { challenge: url.searchParams.get('code_challenge'), clientId });
      const to = new URL(redirectUri);
      to.searchParams.set('code', code);
      to.searchParams.set('state', url.searchParams.get('state'));
      res.writeHead(302, { location: to.toString() });
      return res.end();
    }
    if (p === '/token' && req.method === 'POST') {
      const form = new URLSearchParams(await readBody(req));
      if (form.get('grant_type') === 'authorization_code') {
        const entry = state.codes.get(form.get('code'));
        const challenge = crypto.createHash('sha256').update(form.get('code_verifier') || '').digest('base64url');
        if (!entry || entry.challenge !== challenge) return json(res, 400, { error: 'invalid_grant' });
        state.codes.delete(form.get('code'));
        return json(res, 200, issueTokens());
      }
      if (form.get('grant_type') === 'refresh_token') {
        if (!state.refreshTokens.has(form.get('refresh_token'))) return json(res, 400, { error: 'invalid_grant' });
        state.refreshCount++;
        return json(res, 200, issueTokens());
      }
      return json(res, 400, { error: 'unsupported_grant_type' });
    }

    if (p === '/mcp' && req.method === 'POST') {
      const token = (req.headers.authorization || '').replace(/^Bearer /, '');
      if (state.expireNextToken && token) {
        state.validTokens.delete(token);
        state.expireNextToken = false;
      }
      if (!state.validTokens.has(token)) {
        res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` });
        return res.end();
      }
      const msg = JSON.parse(await readBody(req));
      if (msg.method === 'initialize') {
        const sid = crypto.randomUUID();
        state.sessions.add(sid);
        return json(res, 200, { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-canva', version: '1' } } }, { 'mcp-session-id': sid });
      }
      if (!state.sessions.has(req.headers['mcp-session-id'])) return json(res, 404, { error: 'session not found' });
      if (msg.id === undefined) { res.writeHead(202); return res.end(); }
      let result;
      if (msg.method === 'tools/list') {
        result = { tools: ['create-design', 'get-create-design-async-job', 'read-design', 'export-design', 'comment-on-design'].map((name) => ({ name, inputSchema: { type: 'object' } })) };
      } else if (msg.method === 'tools/call') {
        result = toolCall(msg.params.name, msg.params.arguments);
      } else {
        return json(res, 200, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not found' } });
      }
      // ツール呼び出しは SSE で返して、SSE の読み取りも確かめる
      if (msg.method === 'tools/call') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {} })}\n\n`);
        res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n\n`);
        return;
      }
      return json(res, 200, { jsonrpc: '2.0', id: msg.id, result });
    }

    // Claude Messages API
    if (p === '/v1/messages' && req.method === 'POST') {
      if (!req.headers['x-api-key']) return json(res, 401, { error: { message: 'no key' } });
      const body = JSON.parse(await readBody(req));
      const tool = body.tools[0].name;
      let input;
      if (tool === 'storyboard_plan') {
        const n = Number(body.messages[0].content.match(/ページ数：(\d)/)[1]);
        input = {
          title: 'テスト投稿',
          pages: Array.from({ length: n }, (_, i) => ({ role: ['つかみ', '内容', '共感', '呼びかけ'][i], headline: `見出し${i + 1}`, subtext: i === 1 ? '11月23日 9:00' : '', visual: '川辺の写真', intent: `意図${i + 1}` })),
        };
      } else {
        const n = Number(body.messages[0].content.match(/ページ数：(\d)/)[1]);
        input = {
          pages: Array.from({ length: n }, (_, i) => ({ page: i + 1, role: 'x', seconds: 4, text_animation: '上昇', visual_animation: 'ズーム', transition: 'ディゾルブ', search_keywords: ['川 清掃'], tip: '' })),
          bgm: { mood: '明るい', search_keywords: ['ウクレレ'] },
        };
      }
      return json(res, 200, { id: 'msg', type: 'message', role: 'assistant', content: [{ type: 'tool_use', id: 't', name: tool, input }], stop_reason: 'tool_use' });
    }

    json(res, 404, { error: 'not found' });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      origin = `http://127.0.0.1:${server.address().port}`;
      resolve({ origin, state, close: () => server.close() });
    });
  });
}
