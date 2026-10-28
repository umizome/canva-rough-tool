// SQLite（Node.js 標準の node:sqlite）でデータを保存する。ファイルは data/app.db。
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

export const db = new DatabaseSync(path.join(config.dataDir, 'app.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT '',
  tokens_enc TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  oauth_state TEXT,
  oauth_verifier TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL DEFAULT '',
  brief_json TEXT NOT NULL,
  plan_json TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS variants (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  direction_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  design_id TEXT,
  edit_url TEXT,
  view_url TEXT,
  page_count INTEGER,
  images_json TEXT,
  images_at TEXT,
  design_text TEXT,
  memo_json TEXT,
  commented_at TEXT,
  error TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

export const newId = () => crypto.randomBytes(12).toString('base64url');

// ----- settings -----
export function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : null;
}
export function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}
export function deleteSetting(key) {
  db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}

// ----- projects / variants -----
export function getProject(id) {
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  return p ? { ...p } : null;
}
export function updateProject(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE projects SET ${sets}, updated_at = datetime('now') WHERE id = ?`)
    .run(...keys.map((k) => fields[k]), id);
}
export function getVariants(projectId) {
  return db.prepare('SELECT * FROM variants WHERE project_id = ? ORDER BY position').all(projectId).map((v) => ({ ...v }));
}
export function getVariant(id) {
  const v = db.prepare('SELECT * FROM variants WHERE id = ?').get(id);
  return v ? { ...v } : null;
}
export function updateVariant(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE variants SET ${sets}, updated_at = datetime('now') WHERE id = ?`)
    .run(...keys.map((k) => fields[k]), id);
}
