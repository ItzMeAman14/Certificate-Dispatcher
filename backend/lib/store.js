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

function cleanDatabaseUrl(rawUrl) {
  if (!rawUrl) return rawUrl;
  try {
    const parsed = new URL(rawUrl);
    // Remove unsupported flags that cause SCRAM or SASL handshake hangs with node-postgres
    parsed.searchParams.delete('channel_binding');
    // Ensure sslmode=require for cloud/remote hosts
    const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    if (!isLocal && !parsed.searchParams.has('sslmode')) {
      parsed.searchParams.set('sslmode', 'require');
    }
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

const isProduction = process.env.NODE_ENV === 'production';
const isLocalhost = DATABASE_URL
  ? DATABASE_URL.includes('localhost') || DATABASE_URL.includes('127.0.0.1')
  : false;

if (usePg) {
  const { Pool } = require('pg');

  // Enforce explicit SSL settings:
  // In production, or whenever connecting to a remote host, enforce SSL with rejectUnauthorized: false
  // (required for cloud DBs using SNI / pooler domain certificates like Neon, Supabase, AWS RDS)
  const sslConfig = isLocalhost && !isProduction ? false : { rejectUnauthorized: false };

  pool = new Pool({
    connectionString: cleanDatabaseUrl(DATABASE_URL),
    ssl: sslConfig,
    max: process.env.PG_MAX_POOL ? Number(process.env.PG_MAX_POOL) : 3,
    min: 0,
    idleTimeoutMillis: 4000, // 4s idle connection timeout per spec (avoids Neon pooler terminating dead connections)
    connectionTimeoutMillis: 15000, // 15s connection timeout per spec (survives Neon cold-starts)
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000, // Keep TCP sockets alive across cloud routers/NAT
    allowExitOnIdle: true,
  });

  pool.on('error', (err) => {
    console.error('PG Pool error:', err.message);
  });

  initPromise = initPostgres();
}

function getDbDiagnostics() {
  if (!usePg || !DATABASE_URL) {
    return { mode: 'fileDb', status: 'ready' };
  }
  try {
    const parsed = new URL(DATABASE_URL);
    return {
      mode: 'postgres',
      host: parsed.hostname,
      port: parsed.port || '5432',
      database: parsed.pathname ? parsed.pathname.replace(/^\//, '') : 'default',
      ssl: isLocalhost && !isProduction ? 'disabled' : 'enabled (rejectUnauthorized: false)',
      isPooler: parsed.hostname.includes('pooler') || parsed.port === '6543',
      pool: pool
        ? {
            totalCount: pool.totalCount,
            idleCount: pool.idleCount,
            waitingCount: pool.waitingCount,
          }
        : null,
    };
  } catch {
    return { mode: 'postgres', status: 'unparseable_url' };
  }
}

async function checkDbConnection(timeoutMs = 5000) {
  if (!usePg) {
    return { ok: true, mode: 'fileDb', latencyMs: 0 };
  }
  const startTime = Date.now();
  let client = null;
  let timer = null;
  try {
    const connectPromise = pool.connect();
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const timeoutErr = new Error(`Database ping connection timed out after ${timeoutMs}ms`);
        timeoutErr.code = 'ETIMEDOUT';
        reject(timeoutErr);
      }, timeoutMs);
    });

    client = await Promise.race([connectPromise, timeoutPromise]);
    await client.query('SELECT 1 AS ping');
    const latencyMs = Date.now() - startTime;
    return {
      ok: true,
      latencyMs,
      diagnostics: getDbDiagnostics(),
    };
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    return {
      ok: false,
      latencyMs,
      error: err.message,
      code: err.code || 'TIMEOUT',
      diagnostics: getDbDiagnostics(),
    };
  } finally {
    if (timer) clearTimeout(timer);
    if (client) {
      try {
        client.release();
      } catch (_) {}
    }
  }
}

/**
 * Executes a PostgreSQL query with resilient retry rules:
 * - "timeout exceeded when trying to connect" and "Connection terminated due to connection timeout"
 *   retry up to 2 times with 300 ms backoff for every query (the query never ran).
 * - "Connection terminated unexpectedly" and ECONNRESET retry only for read-only SELECTs.
 * - Never blindly retry INSERT/UPDATE/DELETE.
 */
async function executeQuery(text, params, { isSelect = false } = {}) {
  let attempts = 0;
  while (true) {
    try {
      return await pool.query(text, params);
    } catch (err) {
      attempts++;
      const msg = err && err.message ? String(err.message) : '';
      const code = err && err.code ? String(err.code) : '';

      const isConnectionConnectTimeout =
        msg.includes('timeout exceeded when trying to connect') ||
        msg.includes('Connection terminated due to connection timeout');

      const isConnectionDrop =
        isSelect &&
        (msg.includes('Connection terminated unexpectedly') ||
          code === 'ECONNRESET' ||
          msg.includes('ECONNRESET'));

      if (attempts <= 2 && (isConnectionConnectTimeout || isConnectionDrop)) {
        console.warn(`[PG Retry ${attempts}/2] ${msg} on query. Retrying in 300ms...`);
        await new Promise((resolve) => setTimeout(resolve, 300));
        continue;
      }
      throw err;
    }
  }
}

/**
 * Safely acquire a client from the pool with retry for connection timeouts,
 * run the callback function, and ensure client release in finally.
 */
async function withClient(fn) {
  let attempts = 0;
  while (true) {
    let client = null;
    try {
      client = await pool.connect();
      return await fn(client);
    } catch (err) {
      attempts++;
      const msg = err && err.message ? String(err.message) : '';
      const isConnectionConnectTimeout =
        msg.includes('timeout exceeded when trying to connect') ||
        msg.includes('Connection terminated due to connection timeout');
      if (attempts <= 2 && isConnectionConnectTimeout) {
        console.warn(`[PG Client Retry ${attempts}/2] ${msg}. Retrying in 300ms...`);
        await new Promise((resolve) => setTimeout(resolve, 300));
        continue;
      }
      throw err;
    } finally {
      if (client) {
        try {
          client.release();
        } catch (_) {}
      }
    }
  }
}

async function initPostgres() {
  try {
    await withClient(async (client) => {
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

        -- Campaigns (Requirement 3: Snapshotted subject & template_html)
        CREATE TABLE IF NOT EXISTS campaigns (
          id VARCHAR(64) PRIMARY KEY,
          user_id VARCHAR(64) NOT NULL,
          name VARCHAR(255) NOT NULL,
          subject TEXT NOT NULL,
          template_html TEXT,
          status VARCHAR(32) NOT NULL DEFAULT 'draft',
          pause_reason TEXT,
          resume_at BIGINT,
          created_at BIGINT NOT NULL,
          started_at BIGINT,
          finished_at BIGINT
        );
        CREATE INDEX IF NOT EXISTS idx_campaigns_user_created ON campaigns(user_id, created_at DESC);

        -- Jobs (Requirement 3: Distinct campaign per student with UNIQUE(campaign_id, student_id))
        CREATE TABLE IF NOT EXISTS jobs (
          id VARCHAR(64) PRIMARY KEY,
          campaign_id VARCHAR(64) NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
          user_id VARCHAR(64) NOT NULL,
          student_id VARCHAR(64) NOT NULL,
          student_name VARCHAR(255) NOT NULL DEFAULT '',
          student_email VARCHAR(255) NOT NULL,
          content_document_id VARCHAR(64),
          content_version_id VARCHAR(64),
          file_name VARCHAR(255),
          status VARCHAR(32) NOT NULL DEFAULT 'pending',
          attempts INT NOT NULL DEFAULT 0,
          last_error TEXT,
          smtp_message_id VARCHAR(255),
          sent_at BIGINT,
          next_attempt_at BIGINT,
          updated_at BIGINT NOT NULL,
          CONSTRAINT uq_campaign_student UNIQUE(campaign_id, student_id)
        );
        CREATE INDEX IF NOT EXISTS idx_jobs_campaign_status ON jobs(campaign_id, status);
        CREATE INDEX IF NOT EXISTS idx_jobs_user_student ON jobs(user_id, student_id);

        -- Send Log (Requirement 3 & 8: Rolling 24h quota enforcement)
        CREATE TABLE IF NOT EXISTS send_log (
          id VARCHAR(64) PRIMARY KEY,
          user_id VARCHAR(64) NOT NULL,
          at BIGINT NOT NULL,
          recipients INT NOT NULL DEFAULT 1,
          job_id VARCHAR(64)
        );
        CREATE INDEX IF NOT EXISTS idx_send_log_user_at ON send_log(user_id, at);

        -- Job Events (Live log: Section B)
        CREATE TABLE IF NOT EXISTS job_events (
          id BIGSERIAL PRIMARY KEY,
          campaign_id VARCHAR(64) NOT NULL,
          job_id VARCHAR(64),
          student_name VARCHAR(255) DEFAULT '',
          student_email VARCHAR(255) DEFAULT '',
          type VARCHAR(32) NOT NULL,
          message TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_job_events_campaign_id ON job_events(campaign_id, id);
        CREATE INDEX IF NOT EXISTS idx_job_events_type ON job_events(type);

        -- Campaigns timing summary and send lanes column additions
        ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS timing_summary JSONB;
        ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS send_lanes INT DEFAULT 2;
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
    });
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

function rowToCampaignV2(row) {
  if (!row) return null;
  let timingSummary = null;
  if (row.timing_summary) {
    timingSummary = typeof row.timing_summary === 'object' ? row.timing_summary : JSON.parse(row.timing_summary);
  } else if (row.timingSummary) {
    timingSummary = typeof row.timingSummary === 'object' ? row.timingSummary : JSON.parse(row.timingSummary);
  }
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    subject: row.subject,
    templateHtml: row.template_html,
    status: row.status,
    pauseReason: row.pause_reason,
    resumeAt: row.resume_at ? Number(row.resume_at) : null,
    createdAt: Number(row.created_at),
    startedAt: row.started_at ? Number(row.started_at) : null,
    finishedAt: row.finished_at ? Number(row.finished_at) : null,
    timingSummary,
    sendLanes: Number(row.send_lanes || row.sendLanes || 2),
  };
}

function rowToJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    campaignId: row.campaign_id,
    userId: row.user_id,
    studentId: row.student_id,
    studentName: row.student_name,
    studentEmail: row.student_email,
    contentDocumentId: row.content_document_id,
    contentVersionId: row.content_version_id,
    fileName: row.file_name,
    status: row.status,
    attempts: Number(row.attempts || 0),
    lastError: row.last_error,
    smtpMessageId: row.smtp_message_id,
    sentAt: row.sent_at ? Number(row.sent_at) : null,
    nextAttemptAt: row.next_attempt_at ? Number(row.next_attempt_at) : null,
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
  campaignsV2: {},
  jobsV2: {},
  sendLog: [],
  jobEvents: [],
  jobEventSeq: 1,
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
  fileDb.campaignsV2 ||= {};
  fileDb.jobsV2 ||= {};
  fileDb.sendLog ||= [];
  fileDb.jobEvents ||= [];
  fileDb.jobEventSeq ||= 1;

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
    const res = await executeQuery('SELECT id, email, data FROM users WHERE id = $1', [id], { isSelect: true });
    if (res.rows[0]) return rowToUser(res.rows[0]);
    const legacy = await executeQuery('SELECT * FROM cd_users WHERE id = $1', [id], { isSelect: true }).catch(() => ({ rows: [] }));
    return rowToUser(legacy.rows[0]);
  }
  return fileDb.users[id] || null;
}

async function findUserByEmail(email) {
  if (!email) return null;
  const lower = String(email).trim().toLowerCase();
  if (usePg) {
    await initPromise;
    const res = await executeQuery('SELECT id, email, data FROM users WHERE LOWER(email) = $1', [lower], { isSelect: true });
    if (res.rows[0]) return rowToUser(res.rows[0]);
    const legacy = await executeQuery('SELECT * FROM cd_users WHERE LOWER(email) = $1', [lower], { isSelect: true }).catch(() => ({ rows: [] }));
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
    await executeQuery(
      'INSERT INTO users (id, email, data) VALUES ($1, $2, $3)',
      [id, cleanEmail, JSON.stringify(data)]
    );
    await executeQuery(
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

    await executeQuery(
      'UPDATE users SET email = $1, data = $2 WHERE id = $3',
      [newEmail, JSON.stringify(data), id]
    );

    await executeQuery(
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

async function getTemplate(userId) {
  const user = await getUser(userId);
  return user?.template || null;
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
    await executeQuery(
      `INSERT INTO sessions (token_hash, user_id, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (token_hash) DO UPDATE SET expires_at = $3`,
      [tokenHash, userId, expiresAt]
    );
    await executeQuery(
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
    const res = await executeQuery('SELECT user_id, expires_at FROM sessions WHERE token_hash = $1', [tokenHash], { isSelect: true });
    if (res.rows[0]) {
      return {
        userId: res.rows[0].user_id,
        expiresAt: Number(res.rows[0].expires_at),
      };
    }
    const legacy = await executeQuery('SELECT user_id, expires_at FROM cd_sessions WHERE token_hash = $1', [tokenHash], { isSelect: true }).catch(() => ({ rows: [] }));
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
    await executeQuery('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
    await executeQuery('DELETE FROM cd_sessions WHERE token_hash = $1', [tokenHash]).catch(() => {});
    return;
  }
  if (fileDb.sessions[tokenHash]) {
    delete fileDb.sessions[tokenHash];
    persistFileDb();
  }
}

let lastCleanupTime = 0;

/**
 * Lazy cleanup of expired sessions and send_log older than 48 hours.
 * Runs lazily inside requests (throttled to at most once every 5 minutes).
 */
async function lazyCleanup() {
  const now = Date.now();
  if (now - lastCleanupTime < 5 * 60 * 1000) return;
  lastCleanupTime = now;

  const twoDaysAgo = now - 48 * 60 * 60 * 1000;
  if (usePg) {
    try {
      await initPromise;
      await executeQuery('DELETE FROM sessions WHERE expires_at < $1', [now]).catch(() => {});
      await executeQuery('DELETE FROM cd_sessions WHERE expires_at < $1', [now]).catch(() => {});
      await executeQuery('DELETE FROM send_log WHERE at < $1', [twoDaysAgo]).catch(() => {});
    } catch (err) {
      console.warn('[LazyCleanup] PostgreSQL error:', err.message);
    }
    return;
  }

  let changed = false;
  for (const [key, session] of Object.entries(fileDb.sessions || {})) {
    if (session.expiresAt < now) {
      delete fileDb.sessions[key];
      changed = true;
    }
  }
  if (Array.isArray(fileDb.sendLog)) {
    const beforeLen = fileDb.sendLog.length;
    fileDb.sendLog = fileDb.sendLog.filter((l) => l.at >= twoDaysAgo);
    if (fileDb.sendLog.length !== beforeLen) changed = true;
  }
  if (changed) persistFileDb();
}

async function pruneSessions() {
  await lazyCleanup();
}

/* -------------------------------------------------------------------------- */
/*                        Sent History & Quota Tracking                       */
/* -------------------------------------------------------------------------- */

const inFlightSends = new Map(); // userId -> number

async function getRollingRecipientCount(userId) {
  const rolling24h = Date.now() - 24 * 60 * 60 * 1000;
  if (usePg) {
    await initPromise;
    const res = await executeQuery(
      'SELECT COALESCE(SUM(recipients), 0)::int AS total FROM send_log WHERE user_id = $1 AND at > $2',
      [userId, rolling24h],
      { isSelect: true }
    );
    return res.rows[0]?.total || 0;
  }
  const logs = (fileDb.sendLog || []).filter((l) => l.user_id === userId && l.at > rolling24h);
  return logs.reduce((sum, item) => sum + (item.recipients || 1), 0);
}

async function getOldestSendIn24h(userId) {
  const rolling24h = Date.now() - 24 * 60 * 60 * 1000;
  if (usePg) {
    await initPromise;
    const res = await executeQuery(
      'SELECT MIN(at)::bigint AS oldest FROM send_log WHERE user_id = $1 AND at > $2',
      [userId, rolling24h],
      { isSelect: true }
    );
    const val = res.rows[0]?.oldest;
    return val ? Number(val) : null;
  }
  const logs = (fileDb.sendLog || []).filter((l) => l.user_id === userId && l.at > rolling24h);
  if (!logs.length) return null;
  return Math.min(...logs.map((l) => l.at));
}

async function recordSent(userId, studentId, { at = Date.now(), to = '', file = '' } = {}) {
  const user = await getUser(userId);
  if (!user) return null;

  const sent = { ...(user.sent || {}) };
  sent[studentId] = { at, to: String(to || ''), file: String(file || '') };

  const twoDaysAgo = Date.now() - 48 * 60 * 60 * 1000;
  const sendLog = [...(user.sendLog || []), at].filter((t) => typeof t === 'number' && t > twoDaysAgo);

  return await updateUser(userId, { sent, sendLog });
}

async function getQuota(user) {
  if (!user) return { limit: 0, used: 0, resetsAt: null };
  const limit = Math.max(0, Number(user.settings?.dailyLimit || 0));
  const rolling24h = Date.now() - 24 * 60 * 60 * 1000;

  let usedCount = await getRollingRecipientCount(user.id);
  let oldestSend = null;

  // Fallback to user.sendLog array if send_log table has 0 rows (e.g. initial migration or fileDb)
  if (usedCount === 0 && Array.isArray(user.sendLog)) {
    const valid = user.sendLog.filter((t) => typeof t === 'number' && t > rolling24h);
    usedCount = valid.length;
    if (valid.length > 0) oldestSend = Math.min(...valid);
  } else if (usedCount > 0) {
    oldestSend = await getOldestSendIn24h(user.id);
  }

  const inFlightCount = inFlightSends.get(user.id) || 0;
  const resetsAt = oldestSend ? oldestSend + 24 * 60 * 60 * 1000 : null;

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
    const q = await getQuota(user);
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
    await executeQuery(
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
    const res = await executeQuery('SELECT * FROM cd_campaigns WHERE id = $1 AND user_id = $2', [id, userId], { isSelect: true });
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
    const res = await executeQuery(
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
    const { rows } = await executeQuery(
      `SELECT
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE status = 'queued' OR status = 'sending') AS queued,
         COUNT(*) FILTER (WHERE status = 'sent') AS sent,
         COUNT(*) FILTER (WHERE status = 'delivered') AS delivered,
         COUNT(*) FILTER (WHERE status = 'failed') AS failed,
         COUNT(*) FILTER (WHERE status = 'bounced') AS bounced
       FROM cd_email_deliveries
       WHERE campaign_id = $1 AND user_id = $2`,
      [campaignId, userId],
      { isSelect: true }
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
/*                     Campaigns V2 & Serverless Jobs Model                   */
/* -------------------------------------------------------------------------- */

async function createCampaignV2({ id, userId, name, subject, templateHtml, status = 'draft', pauseReason = null, resumeAt = null }) {
  const campaignId = id || randomToken(16);
  const now = Date.now();
  const campaign = {
    id: campaignId,
    userId,
    name: name || `Dispatch ${new Date().toLocaleDateString()}`,
    subject: subject || 'Your certificate',
    templateHtml: templateHtml || '',
    status,
    pauseReason,
    resumeAt,
    createdAt: now,
    startedAt: null,
    finishedAt: null,
  };

  if (usePg) {
    await initPromise;
    await executeQuery(
      `INSERT INTO campaigns (id, user_id, name, subject, template_html, status, pause_reason, resume_at, created_at, started_at, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        campaign.id,
        campaign.userId,
        campaign.name,
        campaign.subject,
        campaign.templateHtml,
        campaign.status,
        campaign.pauseReason,
        campaign.resumeAt,
        campaign.createdAt,
        campaign.startedAt,
        campaign.finishedAt,
      ]
    );
    return campaign;
  }

  fileDb.campaignsV2 ||= {};
  fileDb.campaignsV2[campaignId] = campaign;
  persistFileDb();
  return campaign;
}

async function getCampaignV2(id, userId) {
  if (usePg) {
    await initPromise;
    const res = await executeQuery('SELECT * FROM campaigns WHERE id = $1 AND user_id = $2', [id, userId], { isSelect: true });
    return rowToCampaignV2(res.rows[0]);
  }
  const c = fileDb.campaignsV2?.[id];
  return c && c.userId === userId ? c : null;
}

async function listCampaignsV2(userId) {
  if (usePg) {
    await initPromise;
    const res = await executeQuery(
      `SELECT c.*,
              COUNT(j.id)::int AS total_jobs,
              COUNT(j.id) FILTER (WHERE j.status = 'sent')::int AS sent_count,
              COUNT(j.id) FILTER (WHERE j.status = 'pending' OR j.status = 'sending')::int AS pending_count,
              COUNT(j.id) FILTER (WHERE j.status = 'failed')::int AS failed_count,
              COUNT(j.id) FILTER (WHERE j.status = 'uncertain')::int AS uncertain_count,
              COUNT(j.id) FILTER (WHERE j.status = 'skipped')::int AS skipped_count
       FROM campaigns c
       LEFT JOIN jobs j ON j.campaign_id = c.id
       WHERE c.user_id = $1
       GROUP BY c.id
       ORDER BY c.created_at DESC
       LIMIT 50`,
      [userId],
      { isSelect: true }
    );
    return res.rows.map((r) => ({
      ...rowToCampaignV2(r),
      counts: {
        total: Number(r.total_jobs || 0),
        sent: Number(r.sent_count || 0),
        pending: Number(r.pending_count || 0),
        failed: Number(r.failed_count || 0),
        uncertain: Number(r.uncertain_count || 0),
        skipped: Number(r.skipped_count || 0),
      },
    }));
  }

  const list = Object.values(fileDb.campaignsV2 || {})
    .filter((c) => c.userId === userId)
    .sort((a, b) => b.createdAt - a.createdAt);

  return list.map((c) => {
    const jobs = Object.values(fileDb.jobsV2 || {}).filter((j) => j.campaignId === c.id);
    return {
      ...c,
      counts: {
        total: jobs.length,
        sent: jobs.filter((j) => j.status === 'sent').length,
        pending: jobs.filter((j) => j.status === 'pending' || j.status === 'sending').length,
        failed: jobs.filter((j) => j.status === 'failed').length,
        uncertain: jobs.filter((j) => j.status === 'uncertain').length,
        skipped: jobs.filter((j) => j.status === 'skipped').length,
      },
    };
  });
}

async function updateCampaignV2(id, userId, patch) {
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
    vals.push(id, userId);

    const res = await executeQuery(
      `UPDATE campaigns SET ${sets.join(', ')} WHERE id = $${idx++} AND user_id = $${idx++} RETURNING *`,
      vals
    );
    return rowToCampaignV2(res.rows[0]);
  }

  const c = fileDb.campaignsV2?.[id];
  if (!c || c.userId !== userId) return null;
  Object.assign(c, patch);
  persistFileDb();
  return c;
}

async function cancelCampaignV2(campaignId, userId) {
  const now = Date.now();
  if (usePg) {
    await initPromise;
    await executeQuery(
      `UPDATE jobs SET status = 'cancelled', updated_at = $1 WHERE campaign_id = $2 AND user_id = $3 AND status = 'pending'`,
      [now, campaignId, userId]
    );
    const res = await executeQuery(
      `UPDATE campaigns SET status = 'cancelled', finished_at = $1 WHERE id = $2 AND user_id = $3 RETURNING *`,
      [now, campaignId, userId]
    );
    return rowToCampaignV2(res.rows[0]);
  }

  const c = fileDb.campaignsV2?.[campaignId];
  if (c && c.userId === userId) {
    c.status = 'cancelled';
    c.finishedAt = now;
  }
  for (const job of Object.values(fileDb.jobsV2 || {})) {
    if (job.campaignId === campaignId && job.userId === userId && job.status === 'pending') {
      job.status = 'cancelled';
      job.updatedAt = now;
    }
  }
  persistFileDb();
  return c || null;
}

async function insertJobsBatch(jobList) {
  if (!jobList || !jobList.length) return [];
  const now = Date.now();
  if (usePg) {
    await initPromise;
    const chunkSize = 100;
    for (let i = 0; i < jobList.length; i += chunkSize) {
      const chunk = jobList.slice(i, i + chunkSize);
      const values = [];
      const placeholders = [];
      let pIdx = 1;

      for (const j of chunk) {
        placeholders.push(`($${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++})`);
        values.push(
          j.id || randomToken(16),
          j.campaignId,
          j.userId,
          j.studentId,
          j.studentName || '',
          j.studentEmail,
          j.contentDocumentId || null,
          j.contentVersionId || null,
          j.fileName || null,
          j.status || 'pending',
          Number(j.attempts || 0),
          j.lastError || null,
          j.smtpMessageId || null,
          j.sentAt || null,
          j.nextAttemptAt || null,
          j.updatedAt || now
        );
      }

      const sql = `
        INSERT INTO jobs (
          id, campaign_id, user_id, student_id, student_name, student_email,
          content_document_id, content_version_id, file_name, status, attempts,
          last_error, smtp_message_id, sent_at, next_attempt_at, updated_at
        )
        VALUES ${placeholders.join(', ')}
        ON CONFLICT (campaign_id, student_id) DO NOTHING
      `;
      await executeQuery(sql, values);
    }
    return jobList;
  }

  fileDb.jobsV2 ||= {};
  for (const j of jobList) {
    const key = `${j.campaignId}:${j.studentId}`;
    if (!fileDb.jobsV2[key]) {
      fileDb.jobsV2[key] = {
        id: j.id || randomToken(16),
        ...j,
        attempts: Number(j.attempts || 0),
        updatedAt: j.updatedAt || now,
      };
    }
  }
  persistFileDb();
  return jobList;
}

async function claimJobsForProcessing(campaignId, userId, limit = 3) {
  const now = Date.now();
  if (usePg) {
    await initPromise;
    const res = await executeQuery(
      `WITH claimable AS (
         SELECT id FROM jobs
         WHERE campaign_id = $1 AND user_id = $2 AND status = 'pending'
           AND (next_attempt_at IS NULL OR next_attempt_at <= $3)
         ORDER BY id ASC
         LIMIT $4
         FOR UPDATE SKIP LOCKED
       )
       UPDATE jobs
       SET status = 'sending', updated_at = $3
       WHERE id IN (SELECT id FROM claimable)
       RETURNING *`,
      [campaignId, userId, now, limit]
    );
    return res.rows.map(rowToJob);
  }

  fileDb.jobsV2 ||= {};
  const claimed = [];
  for (const job of Object.values(fileDb.jobsV2)) {
    if (job.campaignId === campaignId && job.userId === userId && job.status === 'pending') {
      if (!job.nextAttemptAt || job.nextAttemptAt <= now) {
        job.status = 'sending';
        job.updatedAt = now;
        claimed.push({ ...job });
        if (claimed.length >= limit) break;
      }
    }
  }
  if (claimed.length > 0) persistFileDb();
  return claimed;
}

async function reclaimStuckSendingJobs(campaignId, maxAgeMs = 180_000) {
  const now = Date.now();
  const cutoff = now - maxAgeMs;
  if (usePg) {
    await initPromise;
    const res = await executeQuery(
      `UPDATE jobs
       SET status = 'pending', updated_at = $1
       WHERE campaign_id = $2 AND status = 'sending' AND sent_at IS NULL AND updated_at < $3
       RETURNING id`,
      [now, campaignId, cutoff]
    );
    return res.rowCount || 0;
  }

  fileDb.jobsV2 ||= {};
  let count = 0;
  for (const job of Object.values(fileDb.jobsV2)) {
    if (job.campaignId === campaignId && job.status === 'sending' && !job.sentAt && job.updatedAt < cutoff) {
      job.status = 'pending';
      job.updatedAt = now;
      count++;
    }
  }
  if (count > 0) persistFileDb();
  return count;
}

async function claimOneJobForProcessing(campaignId, userId) {
  const now = Date.now();
  if (usePg) {
    await initPromise;
    const res = await executeQuery(
      `WITH claimable AS (
         SELECT id FROM jobs
         WHERE campaign_id = $1 AND user_id = $2 AND status = 'pending'
           AND (next_attempt_at IS NULL OR next_attempt_at <= $3)
         ORDER BY id ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       ),
       updated AS (
         UPDATE jobs
         SET status = 'sending', updated_at = $3
         WHERE id IN (SELECT id FROM claimable)
         RETURNING *
       ),
       ins_event AS (
         INSERT INTO job_events (campaign_id, job_id, student_name, student_email, type, message, created_at)
         SELECT u.campaign_id, u.id, u.student_name, u.student_email, 'sending',
                'Sending to ' || u.student_name || ' (' || u.student_email || ')...', NOW()
         FROM updated u
       )
       SELECT * FROM updated`,
      [campaignId, userId, now]
    );
    if (!res.rows || res.rows.length === 0) return null;
    return rowToJob(res.rows[0]);
  }

  fileDb.jobsV2 ||= {};
  for (const job of Object.values(fileDb.jobsV2)) {
    if (job.campaignId === campaignId && job.userId === userId && job.status === 'pending') {
      if (!job.nextAttemptAt || job.nextAttemptAt <= now) {
        job.status = 'sending';
        job.updatedAt = now;
        fileDb.jobEvents ||= [];
        fileDb.jobEventSeq = (fileDb.jobEventSeq || 0) + 1;
        fileDb.jobEvents.push({
          id: fileDb.jobEventSeq,
          campaignId,
          jobId: job.id,
          studentName: job.studentName || 'Student',
          studentEmail: job.studentEmail,
          type: 'sending',
          message: `Sending to ${job.studentName || 'Student'} (${job.studentEmail})...`,
          createdAt: new Date().toISOString(),
        });
        persistFileDb();
        return { ...job };
      }
    }
  }
  return null;
}

async function markJobSentWithEvent({
  jobId,
  userId,
  campaignId,
  studentId,
  studentName,
  studentEmail,
  fileName,
  smtpMessageId,
  sentAt = Date.now(),
  recipients = 1,
}) {
  const sName = studentName || 'Student';
  const sEmail = studentEmail || '';
  const eventMsg = `Sent to ${sName} (${sEmail})`;

  if (usePg) {
    await initPromise;
    const res = await executeQuery(
      `WITH upd AS (
         UPDATE jobs
         SET status = 'sent', smtp_message_id = $1, sent_at = $2, updated_at = $2
         WHERE id = $3 AND user_id = $4
         RETURNING *
       ),
       ins_log AS (
         INSERT INTO send_log (id, user_id, at, recipients, job_id)
         VALUES ($5, $4, $2, $6, $3)
       ),
       ins_event AS (
         INSERT INTO job_events (campaign_id, job_id, student_name, student_email, type, message, created_at)
         VALUES ($7, $3, $8, $9, 'sent', $10, NOW())
       )
       SELECT * FROM upd`,
      [smtpMessageId, sentAt, jobId, userId, randomToken(16), recipients, campaignId, sName, sEmail, eventMsg]
    );
    await recordSent(userId, studentId, { at: sentAt, to: sEmail, file: fileName }).catch(() => {});
    return res.rows[0] ? rowToJob(res.rows[0]) : null;
  }

  fileDb.jobsV2 ||= {};
  const job = Object.values(fileDb.jobsV2).find((j) => j.id === jobId);
  if (job) {
    job.status = 'sent';
    job.smtpMessageId = smtpMessageId;
    job.sentAt = sentAt;
    job.updatedAt = sentAt;
  }
  fileDb.sendLog ||= [];
  fileDb.sendLog.push({ id: randomToken(16), user_id: userId, at: sentAt, recipients, job_id: jobId });
  fileDb.jobEvents ||= [];
  fileDb.jobEventSeq = (fileDb.jobEventSeq || 0) + 1;
  fileDb.jobEvents.push({
    id: fileDb.jobEventSeq,
    campaignId,
    jobId,
    studentName: sName,
    studentEmail: sEmail,
    type: 'sent',
    message: eventMsg,
    createdAt: new Date().toISOString(),
  });
  persistFileDb();
  await recordSent(userId, studentId, { at: sentAt, to: sEmail, file: fileName }).catch(() => {});
  return job ? { ...job } : null;
}

async function markJobFailedWithEvent({
  jobId,
  userId,
  campaignId,
  studentId,
  studentName,
  studentEmail,
  errorMsg,
  isTransient = false,
  attempts = 1,
  nextAttemptAt = null,
}) {
  const now = Date.now();
  const cleanMsg = String(errorMsg || 'Unknown error').replace(/[\r\n]+/g, ' ').slice(0, 500);
  const sName = studentName || 'Student';
  const sEmail = studentEmail || '';

  if (isTransient && attempts < 3) {
    const delayMs = Math.max(1000, (nextAttemptAt || (now + 60_000)) - now);
    const mins = Math.max(1, Math.round(delayMs / 60_000));
    const eventMsg = `Waiting ${mins} min: ${cleanMsg}`;

    if (usePg) {
      await initPromise;
      const res = await executeQuery(
        `WITH upd AS (
           UPDATE jobs
           SET status = 'pending', attempts = $1, last_error = $2, next_attempt_at = $3, updated_at = $4
           WHERE id = $5 AND user_id = $6
           RETURNING *
         ),
         ins_event AS (
           INSERT INTO job_events (campaign_id, job_id, student_name, student_email, type, message, created_at)
           VALUES ($7, $5, $8, $9, 'retry_scheduled', $10, NOW())
         )
         SELECT * FROM upd`,
        [attempts, cleanMsg, nextAttemptAt, now, jobId, userId, campaignId, sName, sEmail, eventMsg]
      );
      return res.rows[0] ? rowToJob(res.rows[0]) : null;
    }

    fileDb.jobsV2 ||= {};
    const job = Object.values(fileDb.jobsV2).find((j) => j.id === jobId);
    if (job) {
      job.status = 'pending';
      job.attempts = attempts;
      job.lastError = cleanMsg;
      job.nextAttemptAt = nextAttemptAt;
      job.updatedAt = now;
    }
    fileDb.jobEvents ||= [];
    fileDb.jobEventSeq = (fileDb.jobEventSeq || 0) + 1;
    fileDb.jobEvents.push({
      id: fileDb.jobEventSeq,
      campaignId,
      jobId,
      studentName: sName,
      studentEmail: sEmail,
      type: 'retry_scheduled',
      message: eventMsg,
      createdAt: new Date().toISOString(),
    });
    persistFileDb();
    return job ? { ...job } : null;
  }

  // Permanent failure or retry limit reached
  const eventMsg = `Could not send to ${sName} (${sEmail}): ${cleanMsg}`;
  if (usePg) {
    await initPromise;
    const res = await executeQuery(
      `WITH upd AS (
         UPDATE jobs
         SET status = 'failed', attempts = $1, last_error = $2, updated_at = $3
         WHERE id = $4 AND user_id = $5
         RETURNING *
       ),
       ins_event AS (
         INSERT INTO job_events (campaign_id, job_id, student_name, student_email, type, message, created_at)
         VALUES ($6, $4, $7, $8, 'failed', $9, NOW())
       )
       SELECT * FROM upd`,
      [attempts, cleanMsg, now, jobId, userId, campaignId, sName, sEmail, eventMsg]
    );
    return res.rows[0] ? rowToJob(res.rows[0]) : null;
  }

  fileDb.jobsV2 ||= {};
  const job = Object.values(fileDb.jobsV2).find((j) => j.id === jobId);
  if (job) {
    job.status = 'failed';
    job.attempts = attempts;
    job.lastError = cleanMsg;
    job.updatedAt = now;
  }
  fileDb.jobEvents ||= [];
  fileDb.jobEventSeq = (fileDb.jobEventSeq || 0) + 1;
  fileDb.jobEvents.push({
    id: fileDb.jobEventSeq,
    campaignId,
    jobId,
    studentName: sName,
    studentEmail: sEmail,
    type: 'failed',
    message: eventMsg,
    createdAt: new Date().toISOString(),
  });
  persistFileDb();
  return job ? { ...job } : null;
}

async function recordJobEvent(arg1, arg2, arg3, arg4, arg5, arg6) {
  let campaignId, jobId, studentName, studentEmail, type, message;
  if (typeof arg1 === 'object' && arg1 !== null) {
    ({ campaignId, jobId = null, studentName = '', studentEmail = '', type, message } = arg1);
  } else {
    campaignId = arg1;
    jobId = arg2 || null;
    studentName = arg3 || '';
    studentEmail = arg4 || '';
    type = arg5;
    message = arg6;
  }
  const cleanMsg = String(message || '').replace(/[\r\n]+/g, ' ');
  if (usePg) {
    await initPromise;
    const res = await executeQuery(
      `INSERT INTO job_events (campaign_id, job_id, student_name, student_email, type, message, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       RETURNING id, campaign_id, job_id, student_name, student_email, type, message, created_at`,
      [campaignId, jobId, studentName, studentEmail, type, cleanMsg]
    );
    const r = res.rows[0];
    return {
      id: Number(r.id),
      campaignId: r.campaign_id,
      jobId: r.job_id,
      studentName: r.student_name,
      studentEmail: r.student_email,
      type: r.type,
      message: r.message,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    };
  }

  fileDb.jobEvents ||= [];
  fileDb.jobEventSeq = (fileDb.jobEventSeq || 0) + 1;
  const ev = {
    id: fileDb.jobEventSeq,
    campaignId,
    jobId,
    studentName,
    studentEmail,
    type,
    message: cleanMsg,
    createdAt: new Date().toISOString(),
  };
  fileDb.jobEvents.push(ev);
  persistFileDb();
  return ev;
}

async function getJobEvents(campaignId, { after = 0, limit = 200 } = {}) {
  const lim = Math.max(1, Math.min(500, Number(limit) || 200));
  const aft = Math.max(0, Number(after) || 0);

  if (usePg) {
    await initPromise;
    const res = await executeQuery(
      `SELECT id, campaign_id, job_id, student_name, student_email, type, message, created_at
       FROM job_events
       WHERE campaign_id = $1 AND id > $2
       ORDER BY id ASC
       LIMIT $3`,
      [campaignId, aft, lim],
      { isSelect: true }
    );
    const list = res.rows.map((r) => ({
      id: Number(r.id),
      campaignId: r.campaign_id,
      jobId: r.job_id,
      studentName: r.student_name,
      studentEmail: r.student_email,
      type: r.type,
      message: r.message,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    }));
    const nextCursor = list.length > 0 ? list[list.length - 1].id : aft;
    list.events = list;
    list.nextCursor = nextCursor;
    return list;
  }

  fileDb.jobEvents ||= [];
  const list = (fileDb.jobEvents || [])
    .filter((e) => e.campaignId === campaignId && Number(e.id) > aft)
    .sort((a, b) => Number(a.id) - Number(b.id))
    .slice(0, lim);
  const nextCursor = list.length > 0 ? list[list.length - 1].id : aft;
  list.events = list;
  list.nextCursor = nextCursor;
  return list;
}

async function getJobEventsCsv(campaignId) {
  let events = [];
  if (usePg) {
    await initPromise;
    const res = await executeQuery(
      `SELECT id, created_at, type, student_name, student_email, message
       FROM job_events
       WHERE campaign_id = $1
       ORDER BY id ASC`,
      [campaignId],
      { isSelect: true }
    );
    events = res.rows.map((r) => ({
      id: Number(r.id),
      time: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      type: r.type,
      studentName: r.student_name || '',
      studentEmail: r.student_email || '',
      message: r.message || '',
    }));
  } else {
    fileDb.jobEvents ||= [];
    events = (fileDb.jobEvents || [])
      .filter((e) => e.campaignId === campaignId)
      .sort((a, b) => Number(a.id) - Number(b.id))
      .map((e) => ({
        id: Number(e.id),
        time: e.createdAt,
        type: e.type,
        studentName: e.studentName || '',
        studentEmail: e.studentEmail || '',
        message: e.message || '',
      }));
  }

  const escapeCsv = (val) => `"${String(val ?? '').replace(/"/g, '""')}"`;
  const header = 'id,time,type,student_name,student_email,message';
  const rows = events.map((e) =>
    [e.id, escapeCsv(e.time), escapeCsv(e.type), escapeCsv(e.studentName), escapeCsv(e.studentEmail), escapeCsv(e.message)].join(',')
  );
  return [header, ...rows].join('\n');
}

async function getCampaignQueue(campaignId, userId, { status = 'pending', offset = 0, limit = 50, search = '' } = {}) {
  const off = Math.max(0, Number(offset) || 0);
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  const sTerm = String(search || '').trim().toLowerCase();

  if (usePg) {
    await initPromise;
    let countSql = `SELECT COUNT(*)::int AS total FROM jobs WHERE campaign_id = $1 AND user_id = $2 AND status = $3`;
    const countParams = [campaignId, userId, status];
    if (sTerm) {
      countSql += ` AND (LOWER(student_name) LIKE $4 OR LOWER(student_email) LIKE $4)`;
      countParams.push(`%${sTerm}%`);
    }
    const countRes = await executeQuery(countSql, countParams, { isSelect: true });
    const total = countRes.rows[0]?.total || 0;

    let queueSql = `
      WITH ranked AS (
        SELECT id, student_name, student_email, status,
               ROW_NUMBER() OVER (ORDER BY id ASC) AS position
        FROM jobs
        WHERE campaign_id = $1 AND user_id = $2 AND status = $3
      )
      SELECT * FROM ranked
    `;
    const queueParams = [campaignId, userId, status];
    if (sTerm) {
      queueSql += ` WHERE (LOWER(student_name) LIKE $4 OR LOWER(student_email) LIKE $4)`;
      queueParams.push(`%${sTerm}%`);
      queueSql += ` ORDER BY position ASC LIMIT $5 OFFSET $6`;
      queueParams.push(lim, off);
    } else {
      queueSql += ` ORDER BY position ASC LIMIT $4 OFFSET $5`;
      queueParams.push(lim, off);
    }

    const qRes = await executeQuery(queueSql, queueParams, { isSelect: true });
    const queue = qRes.rows.map((r) => ({
      id: r.id,
      name: r.student_name || '—',
      studentName: r.student_name || '—',
      email: r.student_email || '',
      studentEmail: r.student_email || '',
      position: Number(r.position),
      status: r.status,
    }));
    return { queue, total };
  }

  const allJobs = Object.values(fileDb.jobsV2 || {})
    .filter((j) => j.campaignId === campaignId && j.userId === userId && j.status === status);

  const matched = sTerm
    ? allJobs.filter((j) => (j.studentName || '').toLowerCase().includes(sTerm) || (j.studentEmail || '').toLowerCase().includes(sTerm))
    : allJobs;

  const total = matched.length;
  const queue = matched.slice(off, off + lim).map((j, idx) => ({
    id: j.id,
    name: j.studentName || '—',
    studentName: j.studentName || '—',
    email: j.studentEmail || '',
    studentEmail: j.studentEmail || '',
    position: off + idx + 1,
    status: j.status,
  }));
  return { queue, total };
}

async function recordCampaignThrottledEvent(campaignId, message = 'Waiting 5 min: Gmail asked us to slow down') {
  return await recordJobEvent({
    campaignId,
    type: 'throttled',
    message,
  });
}

async function recordCampaignStateEvent(campaignId, type, message) {
  return await recordJobEvent({
    campaignId,
    type,
    message,
  });
}

async function updateCampaignTimingSummary(campaignId, userId, timingSummary) {
  if (usePg) {
    await initPromise;
    const res = await executeQuery(
      `UPDATE campaigns SET timing_summary = $1::jsonb WHERE id = $2 AND user_id = $3 RETURNING *`,
      [JSON.stringify(timingSummary), campaignId, userId]
    );
    return res.rows[0] ? rowToCampaignV2(res.rows[0]) : null;
  }
  const c = fileDb.campaignsV2?.[campaignId];
  if (c && c.userId === userId) {
    c.timingSummary = timingSummary;
    persistFileDb();
    return c;
  }
  return null;
}

async function markJobSent({ jobId, userId, studentId, studentEmail, fileName, smtpMessageId, sentAt = Date.now(), recipients = 1 }) {
  if (usePg) {
    await initPromise;
    await executeQuery(
      `UPDATE jobs
       SET status = 'sent', smtp_message_id = $1, sent_at = $2, updated_at = $2
       WHERE id = $3`,
      [smtpMessageId, sentAt, jobId]
    );
    await executeQuery(
      `INSERT INTO send_log (id, user_id, at, recipients, job_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomToken(16), userId, sentAt, recipients, jobId]
    );
  } else {
    fileDb.jobsV2 ||= {};
    const job = Object.values(fileDb.jobsV2).find((j) => j.id === jobId);
    if (job) {
      job.status = 'sent';
      job.smtpMessageId = smtpMessageId;
      job.sentAt = sentAt;
      job.updatedAt = sentAt;
    }
    fileDb.sendLog ||= [];
    fileDb.sendLog.push({ id: randomToken(16), user_id: userId, at: sentAt, recipients, job_id: jobId });
    persistFileDb();
  }
  // Record in user.sent for compatibility
  await recordSent(userId, studentId, { at: sentAt, to: studentEmail, file: fileName }).catch(() => {});
}

async function logSend(userId, recipients = 1, jobId = null, at = Date.now()) {
  if (usePg) {
    await initPromise;
    await executeQuery(
      `INSERT INTO send_log (id, user_id, at, recipients, job_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomToken(16), userId, at, recipients, jobId || null]
    );
  } else {
    fileDb.sendLog ||= [];
    fileDb.sendLog.push({ id: randomToken(16), user_id: userId, at, recipients, job_id: jobId || null });
    persistFileDb();
  }
}

async function updateJobStatus(jobId, { status, attempts, lastError, nextAttemptAt, updatedAt }) {
  const now = updatedAt !== undefined ? updatedAt : Date.now();
  if (usePg) {
    await initPromise;
    const sets = ['updated_at = $1'];
    const vals = [now];
    let idx = 2;

    if (status !== undefined) {
      sets.push(`status = $${idx++}`);
      vals.push(status);
    }
    if (attempts !== undefined) {
      sets.push(`attempts = $${idx++}`);
      vals.push(attempts);
    }
    if (lastError !== undefined) {
      sets.push(`last_error = $${idx++}`);
      vals.push(lastError);
    }
    if (nextAttemptAt !== undefined) {
      sets.push(`next_attempt_at = $${idx++}`);
      vals.push(nextAttemptAt);
    }
    vals.push(jobId);

    const res = await executeQuery(
      `UPDATE jobs SET ${sets.join(', ')} WHERE id = $${idx++} RETURNING *`,
      vals
    );
    return rowToJob(res.rows[0]);
  }

  fileDb.jobsV2 ||= {};
  const job = Object.values(fileDb.jobsV2).find((j) => j.id === jobId);
  if (!job) return null;
  if (status !== undefined) job.status = status;
  if (attempts !== undefined) job.attempts = attempts;
  if (lastError !== undefined) job.lastError = lastError;
  if (nextAttemptAt !== undefined) job.nextAttemptAt = nextAttemptAt;
  job.updatedAt = now;
  persistFileDb();
  return job;
}

async function getCampaignCounts(campaignId, userId) {
  if (usePg) {
    await initPromise;
    const res = await executeQuery(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
         COUNT(*) FILTER (WHERE status = 'sending')::int AS sending,
         COUNT(*) FILTER (WHERE status = 'sent')::int AS sent,
         COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
         COUNT(*) FILTER (WHERE status = 'uncertain')::int AS uncertain,
         COUNT(*) FILTER (WHERE status = 'skipped')::int AS skipped,
         COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled
       FROM jobs
       WHERE campaign_id = $1 AND user_id = $2`,
      [campaignId, userId],
      { isSelect: true }
    );
    const r = res.rows[0] || {};
    return {
      total: Number(r.total || 0),
      pending: Number(r.pending || 0),
      sending: Number(r.sending || 0),
      sent: Number(r.sent || 0),
      failed: Number(r.failed || 0),
      uncertain: Number(r.uncertain || 0),
      skipped: Number(r.skipped || 0),
      cancelled: Number(r.cancelled || 0),
    };
  }

  const jobs = Object.values(fileDb.jobsV2 || {}).filter(
    (j) => j.campaignId === campaignId && j.userId === userId
  );
  return {
    total: jobs.length,
    pending: jobs.filter((j) => j.status === 'pending').length,
    sending: jobs.filter((j) => j.status === 'sending').length,
    sent: jobs.filter((j) => j.status === 'sent').length,
    failed: jobs.filter((j) => j.status === 'failed').length,
    uncertain: jobs.filter((j) => j.status === 'uncertain').length,
    skipped: jobs.filter((j) => j.status === 'skipped').length,
    cancelled: jobs.filter((j) => j.status === 'cancelled').length,
  };
}

async function getCampaignJobs(campaignId, userId, { limit = 50, offset = 0, status = null } = {}) {
  if (usePg) {
    await initPromise;
    const params = [campaignId, userId];
    let whereClause = 'WHERE campaign_id = $1 AND user_id = $2';
    if (status && status !== 'all') {
      params.push(status);
      whereClause += ` AND status = $${params.length}`;
    }
    params.push(limit, offset);
    const sql = `SELECT * FROM jobs ${whereClause} ORDER BY id ASC LIMIT $${params.length - 1} OFFSET $${params.length}`;
    const res = await executeQuery(sql, params, { isSelect: true });
    return res.rows.map(rowToJob);
  }

  let jobs = Object.values(fileDb.jobsV2 || {}).filter(
    (j) => j.campaignId === campaignId && j.userId === userId
  );
  if (status && status !== 'all') {
    jobs = jobs.filter((j) => j.status === status);
  }
  return jobs.slice(offset, offset + limit);
}

async function getCampaignExceptionsForCsv(campaignId, userId) {
  if (usePg) {
    await initPromise;
    const res = await executeQuery(
      `SELECT student_id, student_name, student_email, status, last_error
       FROM jobs
       WHERE campaign_id = $1 AND user_id = $2 AND status IN ('failed', 'uncertain', 'skipped')
       ORDER BY student_name ASC, student_id ASC`,
      [campaignId, userId],
      { isSelect: true }
    );
    return res.rows;
  }

  return Object.values(fileDb.jobsV2 || {})
    .filter(
      (j) =>
        j.campaignId === campaignId &&
        j.userId === userId &&
        ['failed', 'uncertain', 'skipped'].includes(j.status)
    )
    .map((j) => ({
      student_id: j.studentId,
      student_name: j.studentName,
      student_email: j.studentEmail,
      status: j.status,
      last_error: j.lastError || '',
    }));
}

async function retryFailedJobs(campaignId, userId) {
  const now = Date.now();
  if (usePg) {
    await initPromise;
    const res = await executeQuery(
      `UPDATE jobs
       SET status = 'pending', attempts = 0, last_error = NULL, next_attempt_at = NULL, updated_at = $1
       WHERE campaign_id = $2 AND user_id = $3 AND status = 'failed'
       RETURNING id`,
      [now, campaignId, userId]
    );
    return res.rowCount || 0;
  }

  let count = 0;
  for (const job of Object.values(fileDb.jobsV2 || {})) {
    if (job.campaignId === campaignId && job.userId === userId && job.status === 'failed') {
      job.status = 'pending';
      job.attempts = 0;
      job.lastError = null;
      job.nextAttemptAt = null;
      job.updatedAt = now;
      count++;
    }
  }
  if (count > 0) persistFileDb();
  return count;
}

async function hasConsecutiveFailures(campaignId, userId, targetError = null, threshold = 3) {
  if (usePg) {
    await initPromise;
    const res = await executeQuery(
      `SELECT status, last_error FROM jobs
       WHERE campaign_id = $1 AND user_id = $2 AND status IN ('sent', 'failed')
       ORDER BY updated_at DESC, id DESC
       LIMIT $3`,
      [campaignId, userId, threshold],
      { isSelect: true }
    );
    if (res.rows.length < threshold) return false;
    if (targetError) {
      return res.rows.every(
        (r) => r.status === 'failed' && (r.last_error === targetError || (r.last_error && r.last_error.includes(targetError)))
      );
    }
    const firstErr = res.rows[0].last_error;
    return res.rows.every((r) => r.status === 'failed' && r.last_error && r.last_error === firstErr);
  }

  fileDb.jobsV2 ||= {};
  const relevant = Object.values(fileDb.jobsV2)
    .filter(
      (j) => j.campaignId === campaignId && j.userId === userId && (j.status === 'sent' || j.status === 'failed')
    )
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || String(b.id).localeCompare(String(a.id)));

  if (relevant.length < threshold) return false;
  const recent = relevant.slice(0, threshold);
  if (targetError) {
    return recent.every(
      (j) => j.status === 'failed' && (j.lastError === targetError || (j.lastError && j.lastError.includes(targetError)))
    );
  }
  const firstErr = recent[0].lastError;
  return recent.every((j) => j.status === 'failed' && j.lastError && j.lastError === firstErr);
}

async function getSentStudentIds(userId) {
  const sentSet = new Set();
  if (usePg) {
    await initPromise;
    const res = await executeQuery(
      `SELECT DISTINCT student_id FROM jobs WHERE user_id = $1 AND status = 'sent'`,
      [userId],
      { isSelect: true }
    );
    for (const r of res.rows) {
      if (r.student_id) sentSet.add(r.student_id);
    }
  } else {
    for (const j of Object.values(fileDb.jobsV2 || {})) {
      if (j.userId === userId && j.status === 'sent' && j.studentId) {
        sentSet.add(j.studentId);
      }
    }
  }

  // Include user.sent map as well
  const user = await getUser(userId);
  if (user && user.sent && typeof user.sent === 'object') {
    for (const id of Object.keys(user.sent)) {
      sentSet.add(id);
    }
  }
  return sentSet;
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
    const idempotencyKey = item.idempotencyKey || `${userId}_${campaignId || 'direct'}_${item.studentId}_${item.recipientEmail}`;

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
    await withClient(async (client) => {
      await client.query('BEGIN');
      try {
        for (let i = 0; i < deliveries.length; i++) {
          const d = deliveries[i];
          const j = jobs[i];

          const dRes = await client.query(
            `INSERT INTO cd_email_deliveries
             (id, user_id, campaign_id, student_id, student_name, recipient_email, certificate_id, certificate_name, subject, status, idempotency_key, attempts, max_attempts, queued_at, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
             ON CONFLICT (idempotency_key) DO UPDATE SET
               status = 'queued',
               attempts = 0,
               error_message = null,
               queued_at = $14,
               updated_at = $16
             RETURNING id, status`,
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
          const actualDeliveryId = dRes.rows[0]?.id || d.id;
          d.id = actualDeliveryId;

          await client.query(
            `INSERT INTO cd_email_jobs
             (id, delivery_id, campaign_id, user_id, status, run_at, attempts, max_attempts, created_at, updated_at)
             SELECT $1::varchar, $2::varchar, $3::varchar, $4::varchar, $5::varchar, $6::bigint, $7::int, $8::int, $9::bigint, $10::bigint
             WHERE NOT EXISTS (
               SELECT 1 FROM cd_email_jobs
               WHERE delivery_id = $2::varchar AND status IN ('pending', 'processing')
             )`,
            [j.id, actualDeliveryId, j.campaignId, j.userId, j.status, j.runAt, j.attempts, j.maxAttempts, j.createdAt, j.updatedAt]
          );
        }

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    });

    return { deliveries, jobs };
  }

  for (let i = 0; i < deliveries.length; i++) {
    const d = deliveries[i];
    const j = jobs[i];

    const existingD = Object.values(fileDb.deliveries).find(
      (item) => item.idempotencyKey === d.idempotencyKey
    );
    if (existingD) {
      existingD.status = 'queued';
      existingD.attempts = 0;
      existingD.errorMessage = null;
      existingD.queuedAt = now;
      existingD.updatedAt = now;
      deliveries[i] = existingD;
    } else {
      fileDb.deliveries[d.id] = d;
    }

    const targetDeliveryId = deliveries[i].id;
    const activeJob = Object.values(fileDb.jobs).find(
      (item) => item.deliveryId === targetDeliveryId && (item.status === 'pending' || item.status === 'processing')
    );
    if (!activeJob) {
      j.deliveryId = targetDeliveryId;
      fileDb.jobs[j.id] = j;
    }
  }
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
    const res = await executeQuery(sql, params, { isSelect: true });
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
    const res = await executeQuery(
      `SELECT * FROM cd_email_deliveries
       WHERE provider_message_id = $1 OR provider_message_id = $2 OR provider_message_id = $3
       LIMIT 1`,
      [cleanId, `<${cleanId}>`, messageId],
      { isSelect: true }
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
    const res = await executeQuery(
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

async function recordDirectDelivery({
  userId,
  studentId,
  studentName = '',
  recipientEmail,
  certificateId = null,
  certificateName = null,
  subject = 'Your Certificate',
  status = 'sent',
  smtpMessageId = null,
  sentAt = Date.now(),
}) {
  const now = Date.now();
  const deliveryId = randomToken(16);
  const idempotencyKey = `direct_${userId}_${studentId}_${recipientEmail.toLowerCase().trim()}`;

  if (usePg) {
    await initPromise;
    const res = await executeQuery(
      `INSERT INTO cd_email_deliveries
       (id, user_id, campaign_id, student_id, student_name, recipient_email, certificate_id, certificate_name, subject, status, provider_message_id, idempotency_key, attempts, max_attempts, queued_at, sent_at, created_at, updated_at)
       VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, $9, $10, $11, 1, 3, $12, $13, $14, $15)
       ON CONFLICT (idempotency_key) DO UPDATE SET
         status = $9,
         provider_message_id = $10,
         sent_at = $13,
         updated_at = $15
       RETURNING *`,
      [
        deliveryId,
        userId,
        studentId,
        studentName,
        recipientEmail.toLowerCase().trim(),
        certificateId,
        certificateName,
        subject,
        status,
        smtpMessageId,
        idempotencyKey,
        now,
        sentAt,
        now,
        now,
      ]
    );
    return rowToDelivery(res.rows[0]);
  }

  let existing = Object.values(fileDb.deliveries).find((d) => d.idempotencyKey === idempotencyKey);
  if (!existing) {
    existing = {
      id: deliveryId,
      userId,
      campaignId: null,
      studentId,
      studentName,
      recipientEmail: recipientEmail.toLowerCase().trim(),
      certificateId,
      certificateName,
      subject,
      status,
      providerMessageId: smtpMessageId,
      idempotencyKey,
      attempts: 1,
      maxAttempts: 3,
      queuedAt: now,
      sentAt,
      createdAt: now,
      updatedAt: now,
    };
    fileDb.deliveries[deliveryId] = existing;
  } else {
    existing.status = status;
    existing.providerMessageId = smtpMessageId;
    existing.sentAt = sentAt;
    existing.updatedAt = now;
  }
  persistFileDb();
  return existing;
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
    const countRes = await executeQuery(`SELECT COUNT(*) AS total FROM cd_email_deliveries WHERE ${whereClause}`, vals, { isSelect: true });
    const total = Number(countRes.rows[0]?.total || 0);

    // Global counts by status for tabs
    const statusCountsRes = await executeQuery(
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
      campaignId ? [userId, campaignId] : [userId],
      { isSelect: true }
    );
    const sc = statusCountsRes.rows[0] || {};

    // Page items
    const itemsRes = await executeQuery(
      `SELECT * FROM cd_email_deliveries
       WHERE ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...vals, limit, offset],
      { isSelect: true }
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
    const res = await executeQuery(
      `SELECT * FROM cd_email_deliveries
       WHERE user_id = $1 AND student_id = $2
       ORDER BY created_at DESC`,
      [userId, studentId],
      { isSelect: true }
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
    return await withClient(async (client) => {
      await client.query('BEGIN');
      try {
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
      }
    });
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
    await withClient(async (client) => {
      await client.query('BEGIN');
      try {
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
      }
    });
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
    await withClient(async (client) => {
      await client.query('BEGIN');
      try {
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
      }
    });
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
    return await withClient(async (client) => {
      await client.query('BEGIN');
      try {
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
      }
    });
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
    await executeQuery(
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
    const res = await executeQuery(
      'SELECT * FROM cd_email_events WHERE delivery_id = $1 ORDER BY created_at ASC',
      [deliveryId],
      { isSelect: true }
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
    const res = await executeQuery('SELECT 1 FROM cd_suppressions WHERE user_id = $1 AND email = $2 LIMIT 1', [userId, clean], { isSelect: true });
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
    await executeQuery(
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
  checkDbConnection,
  getDbDiagnostics,
  getUser,
  findUserByEmail,
  createUser,
  updateUser,
  getTemplate,
  createSession,
  getSession,
  deleteSession,
  pruneSessions,
  lazyCleanup,
  createCampaign,
  getCampaign,
  updateCampaign,
  refreshCampaignStats,
  createCampaignV2,
  getCampaignV2,
  listCampaignsV2,
  updateCampaignV2,
  cancelCampaignV2,
  insertJobsBatch,
  claimJobsForProcessing,
  claimOneJobForProcessing,
  reclaimStuckSendingJobs,
  markJobSent,
  markJobSentWithEvent,
  markJobFailedWithEvent,
  recordJobEvent,
  getJobEvents,
  getJobEventsCsv,
  getCampaignQueue,
  recordCampaignThrottledEvent,
  recordCampaignStateEvent,
  updateCampaignTimingSummary,
  logSend,
  updateJobStatus,
  getCampaignCounts,
  getCampaignJobs,
  getCampaignExceptionsForCsv,
  retryFailedJobs,
  hasConsecutiveFailures,
  getSentStudentIds,
  getRollingRecipientCount,
  getOldestSendIn24h,
  createDeliveriesAndJobsAtomic,
  getDelivery,
  getDeliveryByMessageId,
  updateDelivery,
  recordDirectDelivery,
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
