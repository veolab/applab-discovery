import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from '../../db/index.js';

const SECRET_KEY_PATH = join(DATA_DIR, 'secrets.key');
const ALGO = 'aes-256-gcm';

function getOrCreateLocalSecretKey(): Buffer {
  if (existsSync(SECRET_KEY_PATH)) {
    const key = readFileSync(SECRET_KEY_PATH);
    if (key.length === 32) return key;
  }

  mkdirSync(DATA_DIR, { recursive: true });
  const key = randomBytes(32);
  writeFileSync(SECRET_KEY_PATH, key, { mode: 0o600 });
  return key;
}

export function encryptLocalSecret(plainText: string): string {
  const key = getOrCreateLocalSecretKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

export function decryptLocalSecret(encoded: string): string {
  if (typeof encoded !== 'string' || !encoded.trim()) return '';
  if (!encoded.startsWith('v1:')) {
    // Backward-compatible fallback if any plaintext rows ever exist.
    return encoded;
  }

  const parts = encoded.split(':');
  if (parts.length !== 4) {
    throw new Error('Invalid secret payload');
  }

  const [, ivB64, tagB64, dataB64] = parts;
  const key = getOrCreateLocalSecretKey();
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');

  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(data), decipher.final()]);
  return plain.toString('utf8');
}

