'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const DATA_DIR = path.join(__dirname, '..', 'data');

/* ----------------------------- Encryption key ----------------------------- */

function loadKey() {
  const fromEnv = process.env.APP_ENCRYPTION_KEY;
  if (fromEnv) {
    if (!/^[0-9a-f]{64}$/i.test(fromEnv)) {
      throw new Error('APP_ENCRYPTION_KEY must be 64 hex characters (32 bytes).');
    }
    return Buffer.from(fromEnv, 'hex');
  }

  // Development convenience: generate a key file once. Use APP_ENCRYPTION_KEY in production.
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const keyFile = path.join(DATA_DIR, 'secret.key');
  if (fs.existsSync(keyFile)) return Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex');

  const key = crypto.randomBytes(32);
  fs.writeFileSync(keyFile, key.toString('hex'), { mode: 0o600 });
  console.warn('APP_ENCRYPTION_KEY is not set, so data/secret.key was generated. Set the env var in production.');
  return key;
}

const KEY = loadKey();

/** AES-256-GCM. Output format: v1.<iv>.<tag>.<ciphertext> (base64url). */
function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), data.toString('base64url')].join('.');
}

function decrypt(payload) {
  const [version, iv, tag, data] = String(payload).split('.');
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('Unsupported encrypted format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}

const encryptJson = (value) => encrypt(JSON.stringify(value));
const decryptJson = (payload) => JSON.parse(decrypt(payload));

/* -------------------------------- Passwords -------------------------------- */

const SCRYPT = { N: 16384, r: 8, p: 1 };

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

async function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts[0] !== 'scrypt' || parts.length !== 6) return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64url');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64url'), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
  });
  return crypto.timingSafeEqual(actual, expected);
}

let dummyHash = null;
/** Burn the same time as a real check so unknown emails can't be detected by timing. */
async function fakeVerify(password) {
  dummyHash ||= await hashPassword('not-a-real-password');
  await verifyPassword(password, dummyHash);
}

/* --------------------------------- Helpers --------------------------------- */

const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

/** Tiny in-memory limiter: block after `max` failures within `windowMs`. */
function createLimiter({ max, windowMs }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.reset < now) hits.delete(key);
  }, 60_000).unref();

  return {
    allowed(key) {
      const entry = hits.get(key);
      return !entry || entry.reset < Date.now() || entry.count < max;
    },
    fail(key) {
      const now = Date.now();
      const entry = hits.get(key);
      if (!entry || entry.reset < now) hits.set(key, { count: 1, reset: now + windowMs });
      else entry.count += 1;
    },
    clear(key) {
      hits.delete(key);
    },
  };
}

module.exports = {
  DATA_DIR,
  encrypt,
  decrypt,
  encryptJson,
  decryptJson,
  hashPassword,
  verifyPassword,
  fakeVerify,
  randomToken,
  sha256,
  createLimiter,
};