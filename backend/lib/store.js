'use strict';

/**
 * Production-ready Dual-mode Store:
 * 1. PostgreSQL (NeonDB / Production): Active when DATABASE_URL is set.
 *    - Fully relational, indexed, ACID transactional outbox queue.
 *    - Safe migrations with IF NOT EXISTS.
 *    - Persists across restarts, redeployments, and multiple instances.
 * 2. Local File / Memory (Development fallback): Active when DATABASE_URL is not set.
 *    - Allows instant offline local development.
 */

const fs = require('fs');
const path = require('path');
const { DATA_DIR, randomToken, sha256 } = require('../security');
const { HttpError } = require('./errors');

const DATABASE_URL = process.env.DATABASE_URL;
const usePg = Boolean(DATABASE_URL);

let pool = null;
let initPromise = null;

/* -------------------------------------------------------------------------- */
/*                               PostgreSQL Mode                              */
/* -------------------------------------------------------------------------- */

if (usePg) {
  const { Pool } = require('pg');
  const isLocalhost = DATABASE_URL.includes('localhost') || DATABASE_URL.includes('127.0.0.1');

  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: isLocalhost ? false : { rejectUnauthorized: false },
    max: Number(process.env.DB_POOL_MAX || 15),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });

  pool.on('error', (err) => {
    console.error('Unexpected error on idle PostgreSQL client:', err);
  });

  initPromise = initPostgres();
}

async function initPostgres() {
  try {
    const client = await pool.connect();
    try {
      await client.query(`
        -- Users table (Requirement 5)
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          email TEXT UNIQUE NOT NULL,
          data JSONB NOT NULL DEFAULT '{}'::jsonb
        );

        -- Sessions table (Requirement 5)
        CREATE TABLE IF NOT EXISTS sessions (
          token_hash TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          expires_at BIGINT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

        -- Users (legacy cd_users)
        CREATE TABLE IF NOT EXISTS cd_users (
          id VARCHAR(64) PRIMARY KEY,
          email VARCHAR(255) UNIQUE NOT NULL,
          name VARCHAR(255) DEFAULT '',
          password_hash TEXT NOT NULL,
          created_at BIGINT NOT NULL,
          connection JSONB,
          settings JSONB DEFAULT '{}'::jsonb,
          template JSONB
        );

        -- Sessions
        CREATE TABLE IF NOT EXISTS cd_sessions (
          token_hash VARCHAR(128) PRIMARY KEY,
          user_id VARCHAR(64) NOT NULL REFERENCES cd_users(id) ON DELETE CASCADE,
          expires_at BIGINT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_cd_sessions_expires_at ON cd_sessions(expires_at);

        -- Campaigns (Batches)
        CREATE TABLE IF NOT EXISTS cd_campaigns (
          id VARCHAR(64) PRIMARY KEY,
          user_id VARCHAR(64) NOT NULL REFERENCES cd_users(id) ON DELETE CASCADE,
          name VARCHAR(255) NOT NULL,
          subject TEXT NOT NULL,
          template_html TEXT,
          total_recipients INT NOT NULL DEFAULT 0,
          queued_count INT NOT NULL DEFAULT 0,
          sent_count INT NOT NULL DEFAULT 0,
          delivered_count INT NOT NULL DEFAULT 0,
          failed_count INT NOT NULL DEFAULT 0,
          bounced_count INT NOT NULL DEFAULT 0,
          status VARCHAR(32) NOT NULL DEFAULT 'queued',
          created_at BIGINT NOT NULL,
          updated_at BIGINT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_cd_campaigns_user_created ON cd_campaigns(user_id, created_at DESC);

        -- Email Deliveries (Per student per send)
        CREATE TABLE IF NOT EXISTS cd_email_deliveries (
          id VARCHAR(64) PRIMARY KEY,
          user_id VARCHAR(64) NOT NULL REFERENCES cd_users(id) ON DELETE CASCADE,
          campaign_id VARCHAR(64) REFERENCES cd_campaigns(id) ON DELETE SET NULL,
          student_id VARCHAR(64) NOT NULL,
          student_name VARCHAR(255) NOT NULL DEFAULT '',
          recipient_email VARCHAR(255) NOT NULL,
          certificate_id VARCHAR(64),
          certificate_name VARCHAR(255),
          subject TEXT,
          status VARCHAR(32) NOT NULL DEFAULT 'not_sent',
          provider_message_id VARCHAR(255),
          idempotency_key VARCHAR(128) UNIQUE,
          attempts INT NOT NULL DEFAULT 0,
          max_attempts INT NOT NULL DEFAULT 3,
          error_message TEXT,
          last_error_at BIGINT,
          queued_at BIGINT,
          sent_at BIGINT,
          delivered_at BIGINT,
          failed_at BIGINT,
          bounced_at BIGINT,
          created_at BIGINT NOT NULL,
          updated_at BIGINT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_cd_deliveries_user_id ON cd_email_deliveries(user_id);
        CREATE INDEX IF NOT EXISTS idx_cd_deliveries_campaign_id ON cd_email_deliveries(campaign_id);
        CREATE INDEX IF NOT EXISTS idx_cd_deliveries_student_id ON cd_email_deliveries(student_id);
        CREATE INDEX IF NOT EXISTS idx_cd_deliveries_recipient ON cd_email_deliveries(recipient_email);
        CREATE INDEX IF NOT EXISTS idx_cd_deliveries_status ON cd_email_deliveries(status);
        CREATE INDEX IF NOT EXISTS idx_cd_deliveries_provider_msg ON cd_email_deliveries(provider_message_id);
        CREATE INDEX IF NOT EXISTS idx_cd_deliveries_created_at ON cd_email_deliveries(created_at DESC);

        -- Email Status Events & Audit History
        CREATE TABLE IF NOT EXISTS cd_email_events (
          id VARCHAR(64) PRIMARY KEY,
          delivery_id VARCHAR(64) NOT NULL REFERENCES cd_email_deliveries(id) ON DELETE CASCADE,
          user_id VARCHAR(64) NOT NULL REFERENCES cd_users(id) ON DELETE CASCADE,
          event_type VARCHAR(32) NOT NULL,
          provider VARCHAR(64) NOT NULL DEFAULT 'smtp',
          provider_event_id VARCHAR(255),
          details TEXT,
          payload JSONB,
          created_at BIGINT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_cd_events_delivery ON cd_email_events(delivery_id);
        CREATE INDEX IF NOT EXISTS idx_cd_events_provider_event ON cd_email_events(provider_event_id);

        -- Transactional Outbox Job Queue
        CREATE TABLE IF NOT EXISTS cd_email_jobs (
          id VARCHAR(64) PRIMARY KEY,
          delivery_id VARCHAR(64) NOT NULL REFERENCES cd_email_deliveries(id) ON DELETE CASCADE,
          campaign_id VARCHAR(64) REFERENCES cd_campaigns(id) ON DELETE CASCADE,
          user_id VARCHAR(64) NOT NULL REFERENCES cd_users(id) ON DELETE CASCADE,
          status VARCHAR(32) NOT NULL DEFAULT 'pending',
          run_at BIGINT NOT NULL,
          attempts INT NOT NULL DEFAULT 0,
          max_attempts INT NOT NULL DEFAULT 3,
          locked_at BIGINT,
          locked_by VARCHAR(64),
          last_error TEXT,
          created_at BIGINT NOT NULL,
          updated_at BIGINT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_cd_jobs_runnable ON cd_email_jobs(status, run_at);
        CREATE INDEX IF NOT EXISTS idx_cd_jobs_user ON cd_email_jobs(user_id);

        -- Suppressions (Bounces / Opt-outs)
        CREATE TABLE IF NOT EXISTS cd_suppressions (
          id VARCHAR(64) PRIMARY KEY,
          user_id VARCHAR(64) NOT NULL REFERENCES cd_users(id) ON DELETE CASCADE,
          email VARCHAR(255) NOT NULL,
          reason VARCHAR(64) NOT NULL DEFAULT 'bounce',
          created_at BIGINT NOT NULL,
          UNIQUE (user_id, email)
        );
        CREATE INDEX IF NOT EXISTS idx_cd_suppressions_email ON cd_suppressions(user_id, email);
      `);

      // Sync users from cd_users to users table if needed
      await client.query(`
        INSERT INTO users (id, email, data)
        SELECT id, LOWER(email), jsonb_build_object(
          'name', COALESCE(name, ''),
          'passwordHash', password_hash,
          'createdAt', created_at,
          'connection', connection,
          'settings', COALESCE(settings, '{}'::jsonb),
          'template', template,
          'sent', '{}'::jsonb,
          'sendLog', '[]'::jsonb
        )
        FROM cd_users
        ON CONFLICT (id) DO NOTHING
      `).catch(() => {});

      // Requirement 1: On server startup, set connection = null for any stored user whose method was "password"
      await client.query(`
        UPDATE users
        SET data = jsonb_set(data, '{connection}', 'null'::jsonb)
        WHERE (data->'connection'->>'method') = 'password'
      `).catch(() => {});

      await client.query(`
        UPDATE cd_users
        SET connection = null
        WHERE (connection->>'method') = 'password'
      `).catch(() => {});

      console.log('PostgreSQL schema verified and ready.');
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Failed to initialize PostgreSQL:', err.message);
    throw err;
  }
}

async function migrateFromFileToPg(client) {
  try {
    const file = path.join(DATA_DIR, 'store.json');
    if (!fs.existsSync(file)) return;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const users = Object.values(raw.users || {});
    if (!users.length) return;

    for (const u of users) {
      await client.query(
        `INSERT INTO cd_users (id, email, name, password_hash, created_at, connection, settings, template)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO NOTHING`,
        [
          u.id,
          u.email,
          u.name || '',
          u.passwordHash,
          u.createdAt || Date.now(),
          u.connection ? JSON.stringify(u.connection) : null,
          u.settings ? JSON.stringify(u.settings) : JSON.stringify({}),
          u.template ? JSON.stringify(u.template) : null,
        ]
      );
    }
    console.log(`Auto-migrated ${users.length} existing user(s) from local store.json to PostgreSQL.`);
  } catch (err) {
    console.warn('Could not auto-migrate store.json to PostgreSQL:', err.message);
  }
}

function rowToUser(row) {
  if (!row) return null;
  const d = row.data && typeof row.data === 'object' ? row.data : row;
  return {
    id: row.id,
    email: row.email,
    name: d.name || '',
    passwordHash: d.passwordHash || d.password_hash || '',
    createdAt: Number(d.createdAt || d.created_at || Date.now()),
    connection: d.connection || null,
    settings: d.settings || {},
    template: d.template || null,
    sent: d.sent || {},
    sendLog: Array.isArray(d.sendLog) ? d.sendLog : (Array.isArray(d.send_log) ? d.send_log : []),
  };
}

function rowToDelivery(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    campaignId: row.campaign_id,
    studentId: row.student_id,
    studentName: row.student_name,
    recipientEmail: row.recipient_email,
    certificateId: row.certificate_id,
    certificateName: row.certificate_name,
    subject: row.subject,
    status: row.status,
    providerMessageId: row.provider_message_id,
    idempotencyKey: row.idempotency_key,
    attempts: Number(row.attempts || 0),
    maxAttempts: Number(row.max_attempts || 3),
    errorMessage: row.error_message,
    lastErrorAt: row.last_error_at ? Number(row.last_error_at) : null,
    queuedAt: row.queued_at ? Number(row.queued_at) : null,
    sentAt: row.sent_at ? Number(row.sent_at) : null,
    deliveredAt: row.delivered_at ? Number(row.delivered_at) : null,
    failedAt: row.failed_at ? Number(row.failed_at) : null,
    bouncedAt: row.bounced_at ? Number(row.bounced_at) : null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function rowToCampaign(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    subject: row.subject,
    templateHtml: row.template_html,
    totalRecipients: Number(row.total_recipients || 0),
    queuedCount: Number(row.queued_count || 0),
    sentCount: Number(row.sent_count || 0),
    deliveredCount: Number(row.delivered_count || 0),
    failedCount: Number(row.failed_count || 0),
    bouncedCount: Number(row.bounced_count || 0),
    status: row.status,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/* -------------------------------------------------------------------------- */
/*                               File Mode State                              */
/* -------------------------------------------------------------------------- */

const FILE = path.join(DATA_DIR, 'store.json');
let fileDb = {
  users: {},
  sessions: {},
  campaigns: {},
  deliveries: {},
  events: {},
  jobs: {},
  suppressions: {},
};

function loadFileDb() {
  try {
    fileDb = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  fileDb.users ||= {};
  fileDb.sessions ||= {};
  fileDb.campaigns ||= {};
  fileDb.deliveries ||= {};
  fileDb.events ||= {};
  fileDb.jobs ||= {};
  fileDb.suppressions ||= {};

  let modified = false;
  for (const u of Object.values(fileDb.users)) {
    if (u.connection && u.connection.method === 'password') {
      u.connection = null;
      modified = true;
    }
    if (!u.sent) u.sent = {};
    if (!Array.isArray(u.sendLog)) u.sendLog = [];
  }
  if (modified) persistFileDb();
}

function persistFileDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(fileDb), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

if (!usePg) {
  loadFileDb();
}

/* -------------------------------------------------------------------------- */
/*                               User Management                              */
/* -------------------------------------------------------------------------- */

async function getUser(id) {
  if (usePg) {
    await initPromise;
    const res = await pool.query('SELECT id, email, data FROM users WHERE id = $1', [id]);
    if (res.rows[0]) return rowToUser(res.rows[0]);
    const legacy = await pool.query('SELECT * FROM cd_users WHERE id = $1', [id]).catch(() => ({ rows: [] }));
    return rowToUser(legacy.rows[0]);
  }
  return fileDb.users[id] || null;
}

async function findUserByEmail(email) {
  if (!email) return null;
  const lower = String(email).trim().toLowerCase();
  if (usePg) {
    await initPromise;
    const res = await pool.query('SELECT id, email, data FROM users WHERE LOWER(email) = $1', [lower]);
    if (res.rows[0]) return rowToUser(res.rows[0]);
    const legacy = await pool.query('SELECT * FROM cd_users WHERE LOWER(email) = $1', [lower]).catch(() => ({ rows: [] }));
    return rowToUser(legacy.rows[0]);
  }
  return Object.values(fileDb.users).find((u) => u.email.toLowerCase() === lower) || null;
}

async function createUser({ email, name, passwordHash }) {
  const id = randomToken(12);
  const cleanEmail = String(email).trim().toLowerCase();
  const now = Date.now();
  const data = {
    name: name || '',
    passwordHash,
    createdAt: now,
    connection: null,
    settings: {
      smtpHost: 'smtp.gmail.com',
      smtpPort: 465,
      fromName: name || '',
      hrName: name || '',
      dailyLimit: 0,
      fromEmail: '',
    },
    template: null,
    sent: {},
    sendLog: [],
  };

  if (usePg) {
    await initPromise;
    await pool.query(
      'INSERT INTO users (id, email, data) VALUES ($1, $2, $3)',
      [id, cleanEmail, JSON.stringify(data)]
    );
    await pool.query(
      `INSERT INTO cd_users (id, email, name, password_hash, created_at, connection, settings, template)
       VALUES ($1, $2, $3, $4, $5, null, $6, null)
       ON CONFLICT (id) DO NOTHING`,
      [id, cleanEmail, data.name, data.passwordHash, now, JSON.stringify(data.settings)]
    ).catch(() => {});
    return { id, email: cleanEmail, ...data };
  }

  const user = { id, email: cleanEmail, ...data };
  fileDb.users[id] = user;
  persistFileDb();
  return user;
}

async function updateUser(id, patch) {
  if (usePg) {
    await initPromise;
    const user = await getUser(id);
    if (!user) return null;

    const newEmail = patch.email ? String(patch.email).trim().toLowerCase() : user.email;
    const data = {
      name: patch.name !== undefined ? patch.name : user.name,
      passwordHash: patch.passwordHash !== undefined ? patch.passwordHash : user.passwordHash,
      createdAt: user.createdAt,
      connection: patch.connection !== undefined ? patch.connection : user.connection,
      settings: patch.settings !== undefined ? patch.settings : user.settings,
      template: patch.template !== undefined ? patch.template : user.template,
      sent: patch.sent !== undefined ? patch.sent : user.sent,
      sendLog: patch.sendLog !== undefined ? patch.sendLog : user.sendLog,
    };

    await pool.query(
      'UPDATE users SET email = $1, data = $2 WHERE id = $3',
      [newEmail, JSON.stringify(data), id]
    );

    await pool.query(
      `UPDATE cd_users
       SET email = $1, name = $2, password_hash = $3, connection = $4, settings = $5, template = $6
       WHERE id = $7`,
      [
        newEmail,
        data.name,
        data.passwordHash,
        data.connection ? JSON.stringify(data.connection) : null,
        JSON.stringify(data.settings || {}),
        data.template ? JSON.stringify(data.template) : null,
        id,
      ]
    ).catch(() => {});

    return { id, email: newEmail, ...data };
  }

  const user = fileDb.users[id];
  if (!user) return null;
  Object.assign(user, patch);
  persistFileDb();
  return user;
}

/* -------------------------------------------------------------------------- */
/*                              Session Handling                              */
/* -------------------------------------------------------------------------- */

async function createSession(userId, ttlMs) {
  const token = randomToken(32);
  const tokenHash = sha256(token);
  const expiresAt = Date.now() + ttlMs;

  if (usePg) {
    await initPromise;
    await pool.query(
      `INSERT INTO sessions (token_hash, user_id, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (token_hash) DO UPDATE SET expires_at = $3`,
      [tokenHash, userId, expiresAt]
    );
    await pool.query(
      `INSERT INTO cd_sessions (token_hash, user_id, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (token_hash) DO UPDATE SET expires_at = $3`,
      [tokenHash, userId, expiresAt]
    ).catch(() => {});
    return token;
  }

  fileDb.sessions[tokenHash] = { userId, expiresAt };
  persistFileDb();
  return token;
}

async function getSession(tokenHash) {
  if (usePg) {
    await initPromise;
    const res = await pool.query('SELECT user_id, expires_at FROM sessions WHERE token_hash = $1', [tokenHash]);
    if (res.rows[0]) {
      return {
        userId: res.rows[0].user_id,
        expiresAt: Number(res.rows[0].expires_at),
      };
    }
    const legacy = await pool.query('SELECT user_id, expires_at FROM cd_sessions WHERE token_hash = $1', [tokenHash]).catch(() => ({ rows: [] }));
    if (legacy.rows[0]) {
      return {
        userId: legacy.rows[0].user_id,
        expiresAt: Number(legacy.rows[0].expires_at),
      };
    }
    return null;
  }
  return fileDb.sessions[tokenHash] || null;
}

async function deleteSession(tokenHash) {
  if (usePg) {
    await initPromise;
    await pool.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
    await pool.query('DELETE FROM cd_sessions WHERE token_hash = $1', [tokenHash]).catch(() => {});
    return;
  }
  if (fileDb.sessions[tokenHash]) {
    delete fileDb.sessions[tokenHash];
    persistFileDb();
  }
}

async function pruneSessions() {
  const now = Date.now();
  if (usePg) {
    try {
      await initPromise;
      await pool.query('DELETE FROM sessions WHERE expires_at < $1', [now]);
      await pool.query('DELETE FROM cd_sessions WHERE expires_at < $1', [now]).catch(() => {});
    } catch (err) {
      console.error('Failed to prune sessions in database:', err.message);
    }
    return;
  }

  let changed = false;
  for (const [key, session] of Object.entries(fileDb.sessions)) {
    if (session.expiresAt < now) {
      delete fileDb.sessions[key];
      changed = true;
    }
  }
  if (changed) persistFileDb();
}

/* -------------------------------------------------------------------------- */
/*                        Sent History & Quota Tracking                       */
/* -------------------------------------------------------------------------- */

const inFlightSends = new Map(); // userId -> number

async function recordSent(userId, studentId, { at = Date.now(), to = '', file = '' } = {}) {
  const user = await getUser(userId);
  if (!user) return null;

  const sent = { ...(user.sent || {}) };
  sent[studentId] = { at, to: String(to || ''), file: String(file || '') };

  const twoDaysAgo = Date.now() - 48 * 60 * 60 * 1000;
  const sendLog = [...(user.sendLog || []), at].filter((t) => typeof t === 'number' && t > twoDaysAgo);

  return await updateUser(userId, { sent, sendLog });
}

function getQuota(user) {
  if (!user) return { limit: 0, used: 0, resetsAt: null };
  const limit = Math.max(0, Number(user.settings?.dailyLimit || 0));
  const rolling24h = Date.now() - 24 * 60 * 60 * 1000;
  const sendLog = Array.isArray(user.sendLog) ? user.sendLog : [];
  const validLogs = sendLog.filter((t) => typeof t === 'number' && t > rolling24h);
  const usedCount = validLogs.length;
  const inFlightCount = inFlightSends.get(user.id) || 0;
  const resetsAt = validLogs.length > 0 ? validLogs[0] + 24 * 60 * 60 * 1000 : null;
  return {
    limit,
    used: usedCount + inFlightCount,
    resetsAt,
  };
}

async function reserveSend(userId, count = 1) {
  const user = await getUser(userId);
  if (!user) throw new HttpError(404, 'User not found');
  const limit = Math.max(0, Number(user.settings?.dailyLimit || 0));
  if (limit > 0) {
    const q = getQuota(user);
    if (q.used + count > limit) {
      throw new HttpError(
        429,
        `Daily email limit of ${limit} reached (${q.used} sent or in-flight in last 24h).`,
        'DAILY_LIMIT'
      );
    }
  }
  inFlightSends.set(userId, (inFlightSends.get(userId) || 0) + count);
  return true;
}

function releaseSend(userId, count = 1) {
  const cur = inFlightSends.get(userId) || 0;
  const next = Math.max(0, cur - count);
  if (next <= 0) inFlightSends.delete(userId);
  else inFlightSends.set(userId, next);
}

/* -------------------------------------------------------------------------- */
/*                                 Campaigns                                  */
/* -------------------------------------------------------------------------- */

async function createCampaign({ id, userId, name, subject, templateHtml, totalRecipients }) {
  const campaign = {
    id: id || randomToken(12),
    userId,
    name: name || `Batch ${new Date().toLocaleDateString()}`,
    subject,
    templateHtml: templateHtml || '',
    totalRecipients: Number(totalRecipients || 0),
    queuedCount: Number(totalRecipients || 0),
    sentCount: 0,
    deliveredCount: 0,
    failedCount: 0,
    bouncedCount: 0,
    status: 'queued',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  if (usePg) {
    await initPromise;
    await pool.query(
      `INSERT INTO cd_campaigns
       (id, user_id, name, subject, template_html, total_recipients, queued_count, sent_count, delivered_count, failed_count, bounced_count, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        campaign.id,
        campaign.userId,
        campaign.name,
        campaign.subject,
        campaign.templateHtml,
        campaign.totalRecipients,
        campaign.queuedCount,
        0,
        0,
        0,
        0,
        campaign.status,
        campaign.createdAt,
        campaign.updatedAt,
      ]
    );
    return campaign;
  }

  fileDb.campaigns[campaign.id] = campaign;
  persistFileDb();
  return campaign;
}

async function getCampaign(id, userId) {
  if (usePg) {
    await initPromise;
    const res = await pool.query('SELECT * FROM cd_campaigns WHERE id = $1 AND user_id = $2', [id, userId]);
    return rowToCampaign(res.rows[0]);
  }
  const c = fileDb.campaigns[id];
  return c && c.userId === userId ? c : null;
}

async function updateCampaign(id, userId, patch) {
  const now = Date.now();
  if (usePg) {
    await initPromise;
    const sets = [];
    const vals = [];
    let idx = 1;

    for (const [k, v] of Object.entries(patch)) {
      const col = k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
      sets.push(`${col} = $${idx++}`);
      vals.push(v);
    }
    sets.push(`updated_at = $${idx++}`);
    vals.push(now);

    vals.push(id, userId);
    const res = await pool.query(
      `UPDATE cd_campaigns SET ${sets.join(', ')} WHERE id = $${idx++} AND user_id = $${idx++} RETURNING *`,
      vals
    );
    return rowToCampaign(res.rows[0]);
  }

  const c = fileDb.campaigns[id];
  if (!c || c.userId !== userId) return null;
  Object.assign(c, patch, { updatedAt: now });
  persistFileDb();
  return c;
}

async function refreshCampaignStats(campaignId, userId) {
  if (!campaignId) return null;
  if (usePg) {
    await initPromise;
    const { rows } = await pool.query(
      `SELECT
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE status = 'queued' OR status = 'sending') AS queued,
         COUNT(*) FILTER (WHERE status = 'sent') AS sent,
         COUNT(*) FILTER (WHERE status = 'delivered') AS delivered,
         COUNT(*) FILTER (WHERE status = 'failed') AS failed,
         COUNT(*) FILTER (WHERE status = 'bounced') AS bounced
       FROM cd_email_deliveries
       WHERE campaign_id = $1 AND user_id = $2`,
      [campaignId, userId]
    );

    const s = rows[0] || {};
    const total = Number(s.total || 0);
    const queued = Number(s.queued || 0);
    const sent = Number(s.sent || 0);
    const delivered = Number(s.delivered || 0);
    const failed = Number(s.failed || 0);
    const bounced = Number(s.bounced || 0);

    let status = 'running';
    if (queued === 0) {
      status = failed > 0 || bounced > 0 ? (sent + delivered > 0 ? 'partially_failed' : 'failed') : 'completed';
    }

    return updateCampaign(campaignId, userId, {
      totalRecipients: total,
      queuedCount: queued,
      sentCount: sent,
      deliveredCount: delivered,
      failedCount: failed,
      bouncedCount: bounced,
      status,
    });
  }

  const dels = Object.values(fileDb.deliveries).filter((d) => d.campaignId === campaignId && d.userId === userId);
  const total = dels.length;
  const queued = dels.filter((d) => d.status === 'queued' || d.status === 'sending').length;
  const sent = dels.filter((d) => d.status === 'sent').length;
  const delivered = dels.filter((d) => d.status === 'delivered').length;
  const failed = dels.filter((d) => d.status === 'failed').length;
  const bounced = dels.filter((d) => d.status === 'bounced').length;

  let status = 'running';
  if (queued === 0) {
    status = failed > 0 || bounced > 0 ? (sent + delivered > 0 ? 'partially_failed' : 'failed') : 'completed';
  }

  return updateCampaign(campaignId, userId, {
    totalRecipients: total,
    queuedCount: queued,
    sentCount: sent,
    deliveredCount: delivered,
    failedCount: failed,
    bouncedCount: bounced,
    status,
  });
}

/* -------------------------------------------------------------------------- */
/*                            Email Deliveries                                */
/* -------------------------------------------------------------------------- */

async function createDeliveriesAndJobsAtomic({ userId, campaignId, items, subject }) {
  const now = Date.now();
  const deliveries = [];
  const jobs = [];

  for (const item of items) {
    const deliveryId = randomToken(16);
    const jobId = randomToken(16);
    const idempotencyKey = item.idempotencyKey || `${campaignId || 'direct'}_${item.studentId}_${item.recipientEmail}`;

    const delivery = {
      id: deliveryId,
      userId,
      campaignId: campaignId || null,
      studentId: item.studentId,
      studentName: item.studentName || '',
      recipientEmail: item.recipientEmail.toLowerCase().trim(),
      certificateId: item.certificateId || null,
      certificateName: item.certificateName || null,
      subject: subject || item.subject || 'Your Certificate',
      status: 'queued',
      providerMessageId: null,
      idempotencyKey,
      attempts: 0,
      maxAttempts: 3,
      errorMessage: null,
      lastErrorAt: null,
      queuedAt: now,
      sentAt: null,
      deliveredAt: null,
      failedAt: null,
      bouncedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    const job = {
      id: jobId,
      deliveryId,
      campaignId: campaignId || null,
      userId,
      status: 'pending',
      runAt: now,
      attempts: 0,
      maxAttempts: 3,
      lockedAt: null,
      lockedBy: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };

    deliveries.push(delivery);
    jobs.push(job);
  }

  if (usePg) {
    await initPromise;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      for (let i = 0; i < deliveries.length; i++) {
        const d = deliveries[i];
        const j = jobs[i];

        await client.query(
          `INSERT INTO cd_email_deliveries
           (id, user_id, campaign_id, student_id, student_name, recipient_email, certificate_id, certificate_name, subject, status, idempotency_key, attempts, max_attempts, queued_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
           ON CONFLICT (idempotency_key) DO UPDATE SET
             status = 'queued',
             attempts = 0,
             error_message = null,
             queued_at = $14,
             updated_at = $16
           RETURNING id`,
          [
            d.id,
            d.userId,
            d.campaignId,
            d.studentId,
            d.studentName,
            d.recipientEmail,
            d.certificateId,
            d.certificateName,
            d.subject,
            d.status,
            d.idempotencyKey,
            d.attempts,
            d.maxAttempts,
            d.queuedAt,
            d.createdAt,
            d.updatedAt,
          ]
        );

        await client.query(
          `INSERT INTO cd_email_jobs
           (id, delivery_id, campaign_id, user_id, status, run_at, attempts, max_attempts, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [j.id, d.id, j.campaignId, j.userId, j.status, j.runAt, j.attempts, j.maxAttempts, j.createdAt, j.updatedAt]
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return { deliveries, jobs };
  }

  deliveries.forEach((d) => (fileDb.deliveries[d.id] = d));
  jobs.forEach((j) => (fileDb.jobs[j.id] = j));
  persistFileDb();
  return { deliveries, jobs };
}

async function getDelivery(id, userId) {
  if (usePg) {
    await initPromise;
    const sql = userId
      ? 'SELECT * FROM cd_email_deliveries WHERE id = $1 AND user_id = $2'
      : 'SELECT * FROM cd_email_deliveries WHERE id = $1';
    const params = userId ? [id, userId] : [id];
    const res = await pool.query(sql, params);
    return rowToDelivery(res.rows[0]);
  }
  const d = fileDb.deliveries[id];
  if (!d) return null;
  return (!userId || d.userId === userId) ? d : null;
}

async function getDeliveryByMessageId(messageId) {
  if (!messageId) return null;
  const cleanId = String(messageId).replace(/[<>]/g, '').trim();
  if (usePg) {
    await initPromise;
    const res = await pool.query(
      `SELECT * FROM cd_email_deliveries
       WHERE provider_message_id = $1 OR provider_message_id = $2 OR provider_message_id = $3
       LIMIT 1`,
      [cleanId, `<${cleanId}>`, messageId]
    );
    return rowToDelivery(res.rows[0]);
  }
  return (
    Object.values(fileDb.deliveries).find(
      (d) =>
        d.providerMessageId === cleanId ||
        d.providerMessageId === `<${cleanId}>` ||
        d.providerMessageId === messageId
    ) || null
  );
}

async function updateDelivery(id, patch) {
  const now = Date.now();
  if (usePg) {
    await initPromise;
    const sets = [];
    const vals = [];
    let idx = 1;

    for (const [k, v] of Object.entries(patch)) {
      const col = k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
      sets.push(`${col} = $${idx++}`);
      vals.push(v);
    }
    sets.push(`updated_at = $${idx++}`);
    vals.push(now);

    vals.push(id);
    const res = await pool.query(
      `UPDATE cd_email_deliveries SET ${sets.join(', ')} WHERE id = $${idx++} RETURNING *`,
      vals
    );
    return rowToDelivery(res.rows[0]);
  }

  const d = fileDb.deliveries[id];
  if (!d) return null;
  Object.assign(d, patch, { updatedAt: now });
  persistFileDb();
  return d;
}

async function listDeliveries(userId, { page = 1, limit = 25, status = 'all', search = '', campaignId = null }) {
  const offset = Math.max(0, (page - 1) * limit);

  if (usePg) {
    await initPromise;
    const conditions = ['user_id = $1'];
    const vals = [userId];
    let idx = 2;

    if (campaignId) {
      conditions.push(`campaign_id = $${idx++}`);
      vals.push(campaignId);
    }

    if (status && status !== 'all') {
      if (status === 'sent') {
        conditions.push(`(status = 'sent' OR status = 'delivered')`);
      } else {
        conditions.push(`status = $${idx++}`);
        vals.push(status);
      }
    }

    if (search && search.trim()) {
      const q = `%${search.trim().toLowerCase()}%`;
      conditions.push(`(LOWER(student_name) LIKE $${idx} OR LOWER(recipient_email) LIKE $${idx} OR LOWER(student_id) LIKE $${idx})`);
      vals.push(q);
      idx++;
    }

    const whereClause = conditions.join(' AND ');

    // Total filtered count
    const countRes = await pool.query(`SELECT COUNT(*) AS total FROM cd_email_deliveries WHERE ${whereClause}`, vals);
    const total = Number(countRes.rows[0]?.total || 0);

    // Global counts by status for tabs
    const statusCountsRes = await pool.query(
      `SELECT
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE status = 'sent') AS sent,
         COUNT(*) FILTER (WHERE status = 'delivered') AS delivered,
         COUNT(*) FILTER (WHERE status = 'failed') AS failed,
         COUNT(*) FILTER (WHERE status = 'bounced') AS bounced,
         COUNT(*) FILTER (WHERE status = 'queued' OR status = 'sending') AS in_progress,
         COUNT(*) FILTER (WHERE status = 'not_sent') AS not_sent
       FROM cd_email_deliveries
       WHERE user_id = $1 ${campaignId ? 'AND campaign_id = $2' : ''}`,
      campaignId ? [userId, campaignId] : [userId]
    );
    const sc = statusCountsRes.rows[0] || {};

    // Page items
    const itemsRes = await pool.query(
      `SELECT * FROM cd_email_deliveries
       WHERE ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...vals, limit, offset]
    );

    return {
      data: itemsRes.rows.map(rowToDelivery),
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit) || 1,
      },
      counts: {
        total: Number(sc.total || 0),
        sent: Number(sc.sent || 0),
        delivered: Number(sc.delivered || 0),
        failed: Number(sc.failed || 0),
        bounced: Number(sc.bounced || 0),
        inProgress: Number(sc.in_progress || 0),
        notSent: Number(sc.not_sent || 0),
      },
    };
  }

  // File fallback
  let list = Object.values(fileDb.deliveries).filter((d) => d.userId === userId);
  if (campaignId) list = list.filter((d) => d.campaignId === campaignId);

  const counts = {
    total: list.length,
    sent: list.filter((d) => d.status === 'sent').length,
    delivered: list.filter((d) => d.status === 'delivered').length,
    failed: list.filter((d) => d.status === 'failed').length,
    bounced: list.filter((d) => d.status === 'bounced').length,
    inProgress: list.filter((d) => d.status === 'queued' || d.status === 'sending').length,
    notSent: list.filter((d) => d.status === 'not_sent').length,
  };

  if (status && status !== 'all') {
    if (status === 'sent') {
      list = list.filter((d) => d.status === 'sent' || d.status === 'delivered');
    } else {
      list = list.filter((d) => d.status === status);
    }
  }

  if (search && search.trim()) {
    const q = search.trim().toLowerCase();
    list = list.filter(
      (d) =>
        d.studentName.toLowerCase().includes(q) ||
        d.recipientEmail.toLowerCase().includes(q) ||
        d.studentId.toLowerCase().includes(q)
    );
  }

  list.sort((a, b) => b.createdAt - a.createdAt);
  const total = list.length;
  const paged = list.slice(offset, offset + limit);

  return {
    data: paged,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
    },
    counts,
  };
}

async function getStudentDeliveries(userId, studentId) {
  if (usePg) {
    await initPromise;
    const res = await pool.query(
      `SELECT * FROM cd_email_deliveries
       WHERE user_id = $1 AND student_id = $2
       ORDER BY created_at DESC`,
      [userId, studentId]
    );
    return res.rows.map(rowToDelivery);
  }
  return Object.values(fileDb.deliveries)
    .filter((d) => d.userId === userId && d.studentId === studentId)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/* -------------------------------------------------------------------------- */
/*                               Outbox Queue Jobs                            */
/* -------------------------------------------------------------------------- */

async function fetchRunnableJobs(limit = 5, workerId = 'worker-1') {
  const now = Date.now();
  if (usePg) {
    await initPromise;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // ACID concurrency: FOR UPDATE SKIP LOCKED ensures multiple workers never collide
      const { rows } = await client.query(
        `SELECT j.id, j.delivery_id, j.campaign_id, j.user_id, j.attempts, j.max_attempts,
                d.student_id, d.student_name, d.recipient_email, d.certificate_id, d.certificate_name,
                d.subject, c.template_html
         FROM cd_email_jobs j
         JOIN cd_email_deliveries d ON j.delivery_id = d.id
         LEFT JOIN cd_campaigns c ON j.campaign_id = c.id
         WHERE j.status = 'pending' AND j.run_at <= $1
         ORDER BY j.run_at ASC
         LIMIT $2
         FOR UPDATE OF j SKIP LOCKED`,
        [now, limit]
      );

      if (rows.length > 0) {
        const ids = rows.map((r) => r.id);
        await client.query(
          `UPDATE cd_email_jobs
           SET status = 'processing', locked_at = $1, locked_by = $2, updated_at = $1
           WHERE id = ANY($3::varchar[])`,
          [now, workerId, ids]
        );

        const deliveryIds = rows.map((r) => r.delivery_id);
        await client.query(
          `UPDATE cd_email_deliveries
           SET status = 'sending', updated_at = $1
           WHERE id = ANY($2::varchar[])`,
          [now, deliveryIds]
        );
      }

      await client.query('COMMIT');
      return rows.map((r) => ({
        id: r.id,
        deliveryId: r.delivery_id,
        campaignId: r.campaign_id,
        userId: r.user_id,
        attempts: Number(r.attempts || 0),
        maxAttempts: Number(r.max_attempts || 3),
        studentId: r.student_id,
        studentName: r.student_name,
        recipientEmail: r.recipient_email,
        certificateId: r.certificate_id,
        certificateName: r.certificate_name,
        subject: r.subject,
        templateHtml: r.template_html,
      }));
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // File fallback
  const runnable = [];
  for (const j of Object.values(fileDb.jobs)) {
    if (j.status === 'pending' && j.runAt <= now) {
      j.status = 'processing';
      j.lockedAt = now;
      j.lockedBy = workerId;
      j.updatedAt = now;
      const d = fileDb.deliveries[j.deliveryId];
      if (d) {
        d.status = 'sending';
        d.updatedAt = now;
        const c = d.campaignId ? fileDb.campaigns[d.campaignId] : null;
        runnable.push({
          id: j.id,
          deliveryId: j.deliveryId,
          campaignId: j.campaignId,
          userId: j.userId,
          attempts: j.attempts,
          maxAttempts: j.maxAttempts,
          studentId: d.studentId,
          studentName: d.studentName,
          recipientEmail: d.recipientEmail,
          certificateId: d.certificateId,
          certificateName: d.certificateName,
          subject: d.subject,
          templateHtml: c ? c.templateHtml : null,
        });
      }
      if (runnable.length >= limit) break;
    }
  }
  if (runnable.length > 0) persistFileDb();
  return runnable;
}

async function completeJob(jobId, deliveryId, providerMessageId) {
  const now = Date.now();
  if (usePg) {
    await initPromise;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE cd_email_jobs
         SET status = 'completed', updated_at = $1, locked_at = null, locked_by = null
         WHERE id = $2`,
        [now, jobId]
      );
      await client.query(
        `UPDATE cd_email_deliveries
         SET status = 'sent', provider_message_id = $1, sent_at = $2, updated_at = $2
         WHERE id = $3`,
        [providerMessageId, now, deliveryId]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return;
  }

  const j = fileDb.jobs[jobId];
  if (j) {
    j.status = 'completed';
    j.updatedAt = now;
    j.lockedAt = null;
    j.lockedBy = null;
  }
  const d = fileDb.deliveries[deliveryId];
  if (d) {
    d.status = 'sent';
    d.providerMessageId = providerMessageId;
    d.sentAt = now;
    d.updatedAt = now;
  }
  persistFileDb();
}

async function failJob(jobId, deliveryId, errorMsg, isPermanent = false) {
  const now = Date.now();
  if (usePg) {
    await initPromise;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT attempts, max_attempts FROM cd_email_jobs WHERE id = $1', [jobId]);
      const attempts = (rows[0]?.attempts || 0) + 1;
      const maxAttempts = rows[0]?.max_attempts || 3;
      const shouldRetry = !isPermanent && attempts < maxAttempts;

      if (shouldRetry) {
        // Exponential backoff: 5s, 25s, 125s
        const backoffMs = Math.min(300_000, 5000 * Math.pow(5, attempts - 1));
        const nextRunAt = now + backoffMs;
        await client.query(
          `UPDATE cd_email_jobs
           SET status = 'pending', attempts = $1, run_at = $2, last_error = $3, locked_at = null, locked_by = null, updated_at = $4
           WHERE id = $5`,
          [attempts, nextRunAt, errorMsg, now, jobId]
        );
        await client.query(
          `UPDATE cd_email_deliveries
           SET attempts = $1, error_message = $2, last_error_at = $3, updated_at = $3
           WHERE id = $4`,
          [attempts, errorMsg, now, deliveryId]
        );
      } else {
        await client.query(
          `UPDATE cd_email_jobs
           SET status = 'failed', attempts = $1, last_error = $2, locked_at = null, locked_by = null, updated_at = $3
           WHERE id = $4`,
          [attempts, errorMsg, now, jobId]
        );
        await client.query(
          `UPDATE cd_email_deliveries
           SET status = 'failed', attempts = $1, error_message = $2, failed_at = $3, last_error_at = $3, updated_at = $3
           WHERE id = $4`,
          [attempts, errorMsg, now, deliveryId]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return;
  }

  const j = fileDb.jobs[jobId];
  const d = fileDb.deliveries[deliveryId];
  if (!j || !d) return;

  j.attempts = (j.attempts || 0) + 1;
  const shouldRetry = !isPermanent && j.attempts < (j.maxAttempts || 3);

  if (shouldRetry) {
    const backoffMs = Math.min(300_000, 5000 * Math.pow(5, j.attempts - 1));
    j.status = 'pending';
    j.runAt = now + backoffMs;
    j.lastError = errorMsg;
    j.lockedAt = null;
    j.lockedBy = null;
    j.updatedAt = now;

    d.attempts = j.attempts;
    d.errorMessage = errorMsg;
    d.lastErrorAt = now;
    d.updatedAt = now;
  } else {
    j.status = 'failed';
    j.lastError = errorMsg;
    j.lockedAt = null;
    j.lockedBy = null;
    j.updatedAt = now;

    d.status = 'failed';
    d.attempts = j.attempts;
    d.errorMessage = errorMsg;
    d.failedAt = now;
    d.lastErrorAt = now;
    d.updatedAt = now;
  }
  persistFileDb();
}

async function retryFailedDeliveries(userId, { campaignId = null, deliveryIds = null }) {
  const now = Date.now();
  if (usePg) {
    await initPromise;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const conditions = ["d.user_id = $1 AND (d.status = 'failed' OR d.status = 'bounced')"];
      const vals = [userId];
      let idx = 2;

      if (campaignId) {
        conditions.push(`d.campaign_id = $${idx++}`);
        vals.push(campaignId);
      }
      if (Array.isArray(deliveryIds) && deliveryIds.length > 0) {
        conditions.push(`d.id = ANY($${idx++}::varchar[])`);
        vals.push(deliveryIds);
      }

      const { rows } = await client.query(
        `SELECT d.id, d.campaign_id FROM cd_email_deliveries d WHERE ${conditions.join(' AND ')}`,
        vals
      );

      if (rows.length === 0) {
        await client.query('COMMIT');
        return 0;
      }

      const ids = rows.map((r) => r.id);
      await client.query(
        `UPDATE cd_email_deliveries
         SET status = 'queued', attempts = 0, error_message = null, queued_at = $1, updated_at = $1
         WHERE id = ANY($2::varchar[])`,
        [now, ids]
      );

      // Re-queue existing jobs or insert new pending jobs
      for (const r of rows) {
        const newJobId = randomToken(16);
        await client.query(
          `INSERT INTO cd_email_jobs
           (id, delivery_id, campaign_id, user_id, status, run_at, attempts, max_attempts, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'pending', $5, 0, 3, $5, $5)
           ON CONFLICT (id) DO UPDATE SET status = 'pending', run_at = $5, attempts = 0, last_error = null, updated_at = $5`,
          [newJobId, r.id, r.campaign_id, userId, now]
        );
      }

      await client.query('COMMIT');
      return rows.length;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // File fallback
  let count = 0;
  for (const d of Object.values(fileDb.deliveries)) {
    if (d.userId === userId && (d.status === 'failed' || d.status === 'bounced')) {
      if (campaignId && d.campaignId !== campaignId) continue;
      if (deliveryIds && !deliveryIds.includes(d.id)) continue;

      d.status = 'queued';
      d.attempts = 0;
      d.errorMessage = null;
      d.queuedAt = now;
      d.updatedAt = now;

      const newJobId = randomToken(16);
      fileDb.jobs[newJobId] = {
        id: newJobId,
        deliveryId: d.id,
        campaignId: d.campaignId,
        userId,
        status: 'pending',
        runAt: now,
        attempts: 0,
        maxAttempts: 3,
        lockedAt: null,
        lockedBy: null,
        lastError: null,
        createdAt: now,
        updatedAt: now,
      };
      count++;
    }
  }
  if (count > 0) persistFileDb();
  return count;
}

/* -------------------------------------------------------------------------- */
/*                               Events & Webhooks                            */
/* -------------------------------------------------------------------------- */

async function recordEmailEvent({ deliveryId, userId, eventType, provider = 'smtp', providerEventId = null, details = null, payload = null }) {
  const event = {
    id: randomToken(16),
    deliveryId,
    userId,
    eventType,
    provider,
    providerEventId,
    details: typeof details === 'string' ? details : JSON.stringify(details || {}),
    payload: payload || null,
    createdAt: Date.now(),
  };

  if (usePg) {
    await initPromise;
    await pool.query(
      `INSERT INTO cd_email_events
       (id, delivery_id, user_id, event_type, provider, provider_event_id, details, payload, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        event.id,
        event.deliveryId,
        event.userId,
        event.eventType,
        event.provider,
        event.providerEventId,
        event.details,
        event.payload ? JSON.stringify(event.payload) : null,
        event.createdAt,
      ]
    );
    return event;
  }

  fileDb.events[event.id] = event;
  persistFileDb();
  return event;
}

async function getDeliveryEvents(deliveryId) {
  if (usePg) {
    await initPromise;
    const res = await pool.query(
      'SELECT * FROM cd_email_events WHERE delivery_id = $1 ORDER BY created_at ASC',
      [deliveryId]
    );
    return res.rows;
  }
  return Object.values(fileDb.events)
    .filter((e) => e.deliveryId === deliveryId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/* -------------------------------------------------------------------------- */
/*                                Suppressions                                */
/* -------------------------------------------------------------------------- */

async function isSuppressed(userId, email) {
  if (!email) return false;
  const clean = email.toLowerCase().trim();
  if (usePg) {
    await initPromise;
    const res = await pool.query('SELECT 1 FROM cd_suppressions WHERE user_id = $1 AND email = $2 LIMIT 1', [userId, clean]);
    return Boolean(res.rows.length);
  }
  const key = `${userId}:${clean}`;
  return Boolean(fileDb.suppressions[key]);
}

async function addSuppression(userId, email, reason = 'bounce') {
  if (!email) return;
  const clean = email.toLowerCase().trim();
  const now = Date.now();
  if (usePg) {
    await initPromise;
    await pool.query(
      `INSERT INTO cd_suppressions (id, user_id, email, reason, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, email) DO UPDATE SET reason = $4, created_at = $5`,
      [randomToken(16), userId, clean, reason, now]
    );
    return;
  }
  const key = `${userId}:${clean}`;
  fileDb.suppressions[key] = { userId, email: clean, reason, createdAt: now };
  persistFileDb();
}

module.exports = {
  getUser,
  findUserByEmail,
  createUser,
  updateUser,
  createSession,
  getSession,
  deleteSession,
  pruneSessions,
  createCampaign,
  getCampaign,
  updateCampaign,
  refreshCampaignStats,
  createDeliveriesAndJobsAtomic,
  getDelivery,
  getDeliveryByMessageId,
  updateDelivery,
  listDeliveries,
  getStudentDeliveries,
  fetchRunnableJobs,
  completeJob,
  failJob,
  retryFailedDeliveries,
  recordEmailEvent,
  getDeliveryEvents,
  isSuppressed,
  addSuppression,
  recordSent,
  getQuota,
  reserveSend,
  releaseSend,
};
