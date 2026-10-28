// 設定の読み込み。外部ライブラリを使わずに .env を読む。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv(path.join(ROOT, '.env'));

const argv = new Set(process.argv.slice(2));
const port = Number(process.env.PORT || 3000);

export const config = {
  mock: argv.has('--mock') || process.env.MOCK === '1',
  port,
  host: process.env.HOST || '127.0.0.1',
  baseUrl: (process.env.BASE_URL || `http://localhost:${port}`).replace(/\/$/, ''),
  canvaMcpUrl: process.env.CANVA_MCP_URL || 'https://mcp.canva.com/mcp',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  anthropicBaseUrl: (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, ''),
  claudeModel: process.env.CLAUDE_MODEL || 'claude-sonnet-5-5',
  dataDir: process.env.DATA_DIR || path.join(ROOT, 'data'),
};

fs.mkdirSync(config.dataDir, { recursive: true });

// トークン暗号化用の鍵。初回起動時に data/secret.key を自動で作る。
const keyFile = path.join(config.dataDir, 'secret.key');
if (!fs.existsSync(keyFile)) {
  fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
}
config.secretKey = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex');

export function readJsonConfig(name) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'config', name), 'utf8'));
}
