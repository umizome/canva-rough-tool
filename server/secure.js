// Canva のトークンを AES-256-GCM で暗号化して保存する。
import crypto from 'node:crypto';
import { config } from './config.js';

export function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', config.secretKey, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
}

export function decrypt(text) {
  if (!text) return null;
  const [iv, tag, data] = text.split('.').map((s) => Buffer.from(s, 'base64url'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', config.secretKey, iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8'));
}

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

export function pkceChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}
