// 接続チェック：Canva MCP のログイン情報が取れるか、クライアント登録ができるかを確かめる。
// 使い方：npm run check-canva
import { config } from './config.js';
import { discover, ensureClient } from './canva-oauth.js';

console.log(`Canva MCP: ${config.canvaMcpUrl}`);
console.log(`戻り先URL: ${config.baseUrl}/auth/callback`);
try {
  const meta = await discover({ force: true });
  console.log('✔ ログイン情報を取得できました');
  console.log(`   認可サーバー: ${meta.issuer}`);
  console.log(`   スコープ: ${meta.scopes ? meta.scopes.join(' ') : '（指定なし）'}`);
  const client = await ensureClient(meta);
  console.log(`✔ クライアント登録ができました（client_id: ${client.clientId.slice(0, 8)}…）`);
  console.log('\nこの状態で npm start し、画面の「Canvaにログイン」を押してください。');
} catch (e) {
  console.error(`✘ ${e.message}`);
  process.exitCode = 1;
}
