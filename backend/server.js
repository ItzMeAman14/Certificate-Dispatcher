'use strict';

require('dotenv').config();

if (process.env.NODE_ENV === 'production') {
  if (!process.env.APP_ENCRYPTION_KEY) {
    console.error('FATAL: APP_ENCRYPTION_KEY is required in production.');
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error('FATAL: DATABASE_URL is required in production.');
    process.exit(1);
  }
}

const dns = require('dns').promises;
const net = require('net');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const nodemailer = require('nodemailer');

const store = require('./lib/store');
const sf = require('./lib/salesforce');
const queue = require('./lib/queue');
const webhook = require('./lib/webhook');
const { HttpError } = require('./lib/errors');
const {
  encrypt,
  decrypt,
  encryptJson,
  hashPassword,
  verifyPassword,
  fakeVerify,
  sha256,
  createLimiter,
} = require('./security');

/* -------------------------------------------------------------------------- */
/*                            Startup Self-Check                              */
/* -------------------------------------------------------------------------- */

const REQUIRED_STORE_METHODS = [
  'cancelCampaignV2',
  'checkDbConnection',
  'claimJobsForProcessing',
  'claimOneJobForProcessing',
  'createCampaignV2',
  'createSession',
  'createUser',
  'deleteSession',
  'findUserByEmail',
  'getCampaign',
  'getCampaignCounts',
  'getCampaignExceptionsForCsv',
  'getCampaignJobs',
  'getDbDiagnostics',
  'getCampaignQueue',
  'getCampaignV2',
  'getDelivery',
  'getDeliveryEvents',
  'getJobEvents',
  'getJobEventsCsv',
  'getOldestSendIn24h',
  'getQuota',
  'getSentStudentIds',
  'getSession',
  'getStudentDeliveries',
  'getTemplate',
  'getUser',
  'hasConsecutiveFailures',
  'insertJobsBatch',
  'lazyCleanup',
  'listCampaignsV2',
  'listDeliveries',
  'logSend',
  'markJobFailedWithEvent',
  'markJobSent',
  'markJobSentWithEvent',
  'reclaimStuckSendingJobs',
  'recordCampaignStateEvent',
  'recordCampaignThrottledEvent',
  'recordDirectDelivery',
  'recordJobEvent',
  'refreshCampaignStats',
  'reserveSend',
  'retryFailedDeliveries',
  'retryFailedJobs',
  'updateCampaignTimingSummary',
  'updateCampaignV2',
  'updateJobStatus',
  'updateUser',
];

const missingStoreMethods = REQUIRED_STORE_METHODS.filter(
  (method) => typeof store[method] !== 'function'
);
if (missingStoreMethods.length > 0) {
  throw new Error(
    `Startup self-check failed: store module is missing required function(s): ${missingStoreMethods.join(', ')}`
  );
}

function sanitizeErrorMessage(msg) {
  if (!msg) return 'Unknown error';
  return String(msg)
    .replace(/(?:password|pass|token|secret|key|bearer|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1: ***')
    .slice(0, 300);
}

function logJobFailure({ campaignId = null, jobId = null, step, error }) {
  const errMsg = error instanceof Error ? error.message : String(error || 'Unknown error');
  const sanitized = sanitizeErrorMessage(errMsg);
  console.error(
    `[Job Error] campaign_id=${campaignId || 'none'} job_id=${jobId || 'none'} step=${step} error="${sanitized}"`
  );
}

/* -------------------------------------------------------------------------- */
/*                                   Config                                   */
/* -------------------------------------------------------------------------- */

const PORT = Number(process.env.PORT || 3000);
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
const ALLOW_SIGNUP = (process.env.ALLOW_SIGNUP || 'true') !== 'false';
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true'; // set true when served over HTTPS
const COOKIE_SAMESITE = (process.env.COOKIE_SAMESITE || 'lax').toLowerCase();
const SESSION_MS = Number(process.env.SESSION_DAYS || 7) * 24 * 60 * 60 * 1000;
const COOKIE_NAME = 'cd_session';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ID_RE = /^[a-zA-Z0-9_\-]{1,64}$/;
const HOST_RE = /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i;
const SMTP_PORTS = [25, 465, 587, 2525];

/* -------------------------------------------------------------------------- */
/*                                   Helpers                                  */
/* -------------------------------------------------------------------------- */

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function text(value, label, { max = 200, required = false } = {}) {
  const out = String(value ?? '').trim();
  if (required && !out) throw new HttpError(400, `${label} is required`);
  if (out.length > max) throw new HttpError(400, `${label} is too long`);
  return out;
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setSessionCookie(res, token, maxAgeMs) {
  const isSecure = COOKIE_SECURE || COOKIE_SAMESITE === 'none';
  const sameSiteValue = COOKIE_SAMESITE === 'none' ? 'None' : (COOKIE_SAMESITE === 'strict' ? 'Strict' : 'Lax');
  const flags = ['HttpOnly', 'Path=/', `SameSite=${sameSiteValue}`, `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
  if (isSecure) flags.push('Secure');
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; ${flags.join('; ')}`);
}

const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function fillTemplate(template, vars) {
  return template.replace(/{{\s*(\w+)\s*}}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match,
  );
}

const wrapEmail = (body) => `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;color:#0f172a">
<div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:8px;padding:32px;line-height:1.6">${body}</div>
</body></html>`;

const htmlToText = (html) =>
  html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|h\d|li|div)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  const v6 = ip.toLowerCase();
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80') || v6.startsWith('::ffff:');
}

async function assertPublicMailHost(host) {
  if (!HOST_RE.test(host)) throw new HttpError(400, 'Mail server must be a host name such as smtp.gmail.com');
  let addresses;
  try {
    addresses = await dns.lookup(host, { all: true });
  } catch {
    throw new HttpError(400, `Could not find the mail server "${host}"`);
  }
  if (!addresses.length || addresses.some((a) => isPrivateIp(a.address))) {
    throw new HttpError(400, 'Mail server must be a public host');
  }
}

/* -------------------------------------------------------------------------- */
/*                               Per-user views                               */
/* -------------------------------------------------------------------------- */

function settingsOf(user) {
  const s = user.settings || {};
  return {
    emailProvider: s.emailProvider || (s.brevoApiKeyEnc ? 'brevo_api' : 'smtp'),
    fromName: s.fromName || '',
    hrName: s.hrName || '',
    smtpUser: s.smtpUser || '',
    fromEmail: s.fromEmail || '',
    dailyLimit: Math.max(0, Number(s.dailyLimit || 0)),
    smtpHost: s.smtpHost || 'smtp.gmail.com',
    smtpPort: s.smtpPort || 465,
    cc: s.cc || '',
    replyTo: s.replyTo || '',
    logoUrl: s.logoUrl || '',
    studentObject: s.studentObject || '',
    nameField: s.nameField || '',
    emailField: s.emailField || '',
    collegeField: s.collegeField || '',
    statusField: s.statusField || '',
    dataSourceSet: Boolean(s.dataSourceSet),
  };
}

const publicSettings = (user) => ({
  ...settingsOf(user),
  hasSmtpPassword: Boolean(user.settings && user.settings.smtpPassEnc),
  hasBrevoApiKey: Boolean(user.settings && user.settings.brevoApiKeyEnc),
});

const connectionOf = (user) =>
  user.connection
    ? { method: user.connection.method, orgName: user.connection.orgName, instanceUrl: user.connection.instanceUrl }
    : null;

const GMAIL_SPECIAL_SENDERS = ['aman@astreait.com', 'manvi@astreait.com'];

function isSpecialGmailSender(email) {
  return GMAIL_SPECIAL_SENDERS.includes(String(email || '').trim().toLowerCase());
}

const emailConfigured = (user) => {
  if (isSpecialGmailSender(user?.email) && process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
    return true;
  }
  const s = user?.settings;
  if (!s) return false;
  const isBrevo = (s.emailProvider || (s.brevoApiKeyEnc ? 'brevo_api' : 'smtp')) === 'brevo_api';
  if (isBrevo) {
    return Boolean(s.brevoApiKeyEnc && (s.fromEmail || s.smtpUser));
  }
  return Boolean(s.smtpUser && s.smtpPassEnc);
};

const meResponse = async (user) => ({
  success: true,
  user: { id: user.id, email: user.email, name: user.name },
  connection: connectionOf(user),
  emailConfigured: emailConfigured(user),
  settings: publicSettings(user),
  quota: await store.getQuota(user),
});

/* -------------------------------------------------------------------------- */
/*                                    Mail                                    */
/* -------------------------------------------------------------------------- */

const transports = new Map();

function makeTransport(settings, password, pooled) {
  return nodemailer.createTransport({
    host: settings.smtpHost,
    port: settings.smtpPort,
    secure: settings.smtpPort === 465,
    requireTLS: settings.smtpPort !== 465,
    pool: pooled,
    maxConnections: 2,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    auth: { user: settings.smtpUser, pass: password },
  });
}

function makeDirectTransport(user, { pooled = false } = {}) {
  if (isSpecialGmailSender(user?.email) && process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
    console.log(`[Server] Using direct Gmail SMTP for sender ${user.email} (pooled=${pooled})`);
    const port = Number(process.env.GMAIL_PORT || 465);
    return nodemailer.createTransport({
      host: process.env.GMAIL_HOST || 'smtp.gmail.com',
      port,
      secure: port === 465,
      requireTLS: port !== 465,
      pool: pooled,
      maxConnections: pooled ? 1 : 1,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    });
  }

  const s = settingsOf(user);
  if (!s.smtpUser || !user.settings?.smtpPassEnc) {
    throw new HttpError(409, 'Set up your sender email in Settings first.', 'NO_EMAIL_SETTINGS');
  }

  const port = Number(s.smtpPort || 465);
  return nodemailer.createTransport({
    host: s.smtpHost || 'smtp.gmail.com',
    port,
    secure: port === 465,
    requireTLS: port !== 465,
    pool: pooled,
    maxConnections: pooled ? 1 : 1,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    auth: {
      user: s.smtpUser,
      pass: decrypt(user.settings.smtpPassEnc),
    },
  });
}

function calculateTimingSummary(timings = [], totalTimeMs = 0, totalSent = 0) {
  const calcP95 = (arr) => {
    if (!arr.length) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.ceil(0.95 * sorted.length) - 1;
    return Math.round(sorted[Math.max(0, idx)] || 0);
  };
  const calcAvg = (arr) => {
    if (!arr.length) return 0;
    const sum = arr.reduce((acc, v) => acc + v, 0);
    return Math.round(sum / arr.length);
  };

  const claims = timings.map((t) => t.claimMs || 0);
  const fileDls = timings.map((t) => t.fileDownloadMs || 0);
  const smtpConnects = timings.map((t) => t.smtpConnectMs || 0);
  const smtpSends = timings.map((t) => t.smtpSendMs || 0);
  const dbWrites = timings.map((t) => t.dbWriteMs || 0);

  const durationMin = totalTimeMs > 0 ? totalTimeMs / 60000 : 0.001;
  const emailsPerMin = totalSent > 0 ? Number((totalSent / durationMin).toFixed(1)) : 0;

  return {
    totalTimeMs,
    emailsPerMin,
    steps: {
      claim: { avgMs: calcAvg(claims), p95Ms: calcP95(claims) },
      fileDownload: { avgMs: calcAvg(fileDls), p95Ms: calcP95(fileDls) },
      smtpConnect: { avgMs: calcAvg(smtpConnects), p95Ms: calcP95(smtpConnects) },
      smtpSend: { avgMs: calcAvg(smtpSends), p95Ms: calcP95(smtpSends) },
      dbWrite: { avgMs: calcAvg(dbWrites), p95Ms: calcP95(dbWrites) },
    },
  };
}

async function downloadJobFile(job, user) {
  if (job.contentVersionId && job.contentVersionId.startsWith('068')) {
    return await sf.withSalesforce(user, (conn) =>
      sf.downloadVersionData(conn, job.contentVersionId)
    );
  }
  const fileData = await sf.withSalesforce(user, (conn) =>
    sf.downloadCertificateFile(conn, job.contentVersionId || job.contentDocumentId)
  );
  return fileData.buffer;
}

function getSenderAddress(user) {
  const s = user?.settings || {};
  if (isSpecialGmailSender(user?.email)) {
    const email = s.smtpUser || process.env.GMAIL_USER || user.email;
    const name = s.fromName || user.name || email;
    return `"${name.replace(/"/g, '')}" <${email}>`;
  }
  const email = s.fromEmail || s.smtpUser || process.env.EMAIL_USER || process.env.SMTP_USER || user.email;
  const name = s.fromName || user.name || email;
  return `"${name.replace(/"/g, '')}" <${email}>`;
}

function getTransport(user) {
  if (!emailConfigured(user)) {
    throw new HttpError(409, 'Set up your sender email in Settings first.', 'NO_EMAIL_SETTINGS');
  }

  if (isSpecialGmailSender(user?.email) && process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
    console.log(`[Server] Using Gmail SMTP for sender ${user.email}`);
    const port = Number(process.env.GMAIL_PORT || 465);
    return nodemailer.createTransport({
      host: process.env.GMAIL_HOST || 'smtp.gmail.com',
      port,
      secure: port === 465,
      requireTLS: port !== 465,
      pool: true,
      maxConnections: 2,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    });
  }

  console.log(`[Server] Using default Brevo/SMTP for sender ${user.email}`);
  const s = settingsOf(user);
  const fingerprint = sha256([s.smtpHost, s.smtpPort, s.smtpUser, user.settings?.smtpPassEnc].join('|'));
  const cached = transports.get(user.id);
  if (cached && cached.fingerprint === fingerprint) return cached.transport;
  if (cached) cached.transport.close();

  const transport = makeTransport(s, decrypt(user.settings.smtpPassEnc), true);
  transports.set(user.id, { fingerprint, transport });
  return transport;
}

/* -------------------------------------------------------------------------- */
/*                                  App setup                                 */
/* -------------------------------------------------------------------------- */

const app = express();
app.disable('x-powered-by');
app.set(
  'trust proxy',
  process.env.TRUST_PROXY === 'true' || Boolean(process.env.RENDER) || process.env.NODE_ENV === 'production' ? 1 : false
);

app.use(
  helmet({
    contentSecurityPolicy: false, // UI is served separately or via API
    crossOriginEmbedderPolicy: false,
  })
);

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  store.lazyCleanup().catch?.(() => {});
  next();
});

const allowedOrigins = CLIENT_ORIGIN
  .split(',')
  .map((o) => o.trim().replace(/\/+$/, ''))
  .filter(Boolean);

function isOriginAllowed(origin) {
  if (!origin) return true;
  const clean = origin.trim().replace(/\/+$/, '');
  if (allowedOrigins.includes(clean) || allowedOrigins.includes('*')) return true;
  try {
    const url = new URL(clean);
    // Automatically trust Vercel deployments
    if (url.hostname.endsWith('.vercel.app')) return true;
  } catch {
    // ignore invalid URL
  }
  return false;
}

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || isOriginAllowed(origin)) {
        callback(null, true);
      } else {
        callback(null, false);
      }
    },
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Session-Token', 'X-Requested-With'],
    exposedHeaders: ['Set-Cookie'],
  })
);

app.use((req, res, next) => {
  // Extra CSRF guard: state-changing requests must come from the UI's origin.
  // Allow webhooks through.
  if (req.path.startsWith('/api/webhooks')) return next();
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (origin && !isOriginAllowed(origin)) {
    return res.status(403).json({ success: false, error: 'Origin not allowed' });
  }
  next();
});

// JSON body parser with raw body retention for webhook signature validation
app.use(
  express.json({
    limit: '2mb',
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

function extractToken(req) {
  const authHeader = req.headers.authorization;
  if (authHeader && typeof authHeader === 'string') {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match && match[1]) return match[1].trim();
  }
  if (req.headers['x-session-token']) {
    return String(req.headers['x-session-token']).trim();
  }
  if (req.headers.cookie) {
    const cookies = parseCookies(req.headers.cookie);
    if (cookies[COOKIE_NAME]) return cookies[COOKIE_NAME];
  }
  return null;
}

async function currentUser(req) {
  const token = extractToken(req);
  if (!token) return null;
  const session = await store.getSession(sha256(token));
  if (!session || session.expiresAt < Date.now()) return null;
  return await store.getUser(session.userId);
}

const requireAuth = wrap(async (req, _res, next) => {
  const user = await currentUser(req);
  if (!user) throw new HttpError(401, 'Please sign in.', 'UNAUTHENTICATED');
  req.user = user;
  next();
});

/* -------------------------------------------------------------------------- */
/*                                  Auth routes                               */
/* -------------------------------------------------------------------------- */

const loginLimiter = createLimiter({ max: 8, windowMs: 15 * 60_000 });
const signupLimiter = createLimiter({ max: 10, windowMs: 60 * 60_000 });

app.get(['/api/health', '/health'], wrap(async (_req, res) => {
  const dbHealth = await store.checkDbConnection(3000).catch((err) => ({
    ok: false,
    error: err.message,
    diagnostics: store.getDbDiagnostics(),
  }));
  res.json({
    success: true,
    status: dbHealth.ok ? 'healthy' : 'degraded',
    timestamp: Date.now(),
    worker: queue.WORKER_ID,
    database: dbHealth,
  });
}));

app.get('/api/auth/config', (_req, res) => res.json({ success: true, allowSignup: ALLOW_SIGNUP }));

app.post('/api/auth/signup', wrap(async (req, res) => {
  if (!ALLOW_SIGNUP) throw new HttpError(403, 'Sign-ups are disabled on this server.');
  if (!signupLimiter.allowed(req.ip)) throw new HttpError(429, 'Too many sign-ups. Try again later.');
  signupLimiter.fail(req.ip);

  const email = text(req.body?.email, 'Email', { max: 200, required: true }).toLowerCase();
  const password = String(req.body?.password ?? '');
  const name = text(req.body?.name, 'Name', { max: 80 });

  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email address.');
  if (password.length < 8 || password.length > 128) {
    throw new HttpError(400, 'Password must be between 8 and 128 characters.');
  }
  if (await store.findUserByEmail(email)) throw new HttpError(409, 'An account with this email already exists.');

  const user = await store.createUser({ email, name, passwordHash: await hashPassword(password) });
  const token = await store.createSession(user.id, SESSION_MS);
  setSessionCookie(res, token, SESSION_MS);
  res.status(201).json({ success: true, token, ...(await meResponse(user)) });
}));

app.post('/api/auth/login', wrap(async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const password = String(req.body?.password ?? '');
  const key = `${req.ip}|${email}`;

  if (!loginLimiter.allowed(key)) {
    throw new HttpError(429, 'Too many failed attempts. Try again in 15 minutes.');
  }

  let user = null;
  if (EMAIL_RE.test(email)) {
    try {
      user = await store.findUserByEmail(email);
    } catch (dbErr) {
      const diag = store.getDbDiagnostics ? store.getDbDiagnostics() : {};
      console.error('[AUTH DB ERROR]', {
        event: 'auth_db_lookup_failed',
        host: diag.host || 'unknown',
        port: diag.port || 'unknown',
        database: diag.database || 'unknown',
        ssl: diag.ssl || 'unknown',
        errorCode: dbErr?.code || 'UNKNOWN',
        errorMessage: dbErr?.message || 'Database connection error',
        timestamp: new Date().toISOString(),
      });
      throw new HttpError(
        503,
        'Database connection timeout. Please check your database connection or try again in a few moments.',
        'DB_TIMEOUT'
      );
    }
  }

  const ok = user ? await verifyPassword(password, user.passwordHash) : (await fakeVerify(password), false);
  if (!ok) {
    loginLimiter.fail(key);
    throw new HttpError(401, 'Invalid email or password.');
  }

  loginLimiter.clear(key);
  let token = null;
  try {
    token = await store.createSession(user.id, SESSION_MS);
  } catch (dbErr) {
    const diag = store.getDbDiagnostics ? store.getDbDiagnostics() : {};
    console.error('[AUTH SESSION ERROR]', {
      event: 'auth_session_create_failed',
      host: diag.host || 'unknown',
      port: diag.port || 'unknown',
      database: diag.database || 'unknown',
      ssl: diag.ssl || 'unknown',
      errorCode: dbErr?.code || 'UNKNOWN',
      errorMessage: dbErr?.message || 'Database connection error',
      timestamp: new Date().toISOString(),
    });
    throw new HttpError(
      503,
      'Failed to create session due to database timeout. Please try again.',
      'DB_TIMEOUT'
    );
  }
  setSessionCookie(res, token, SESSION_MS);
  res.json({ success: true, token, ...(await meResponse(user)) });
}));

app.post('/api/auth/logout', wrap(async (req, res) => {
  const token = extractToken(req);
  if (token) await store.deleteSession(sha256(token));
  setSessionCookie(res, '', 0);
  res.json({ success: true });
}));

app.get('/api/auth/me', requireAuth, wrap(async (req, res) => res.json(await meResponse(req.user))));

/* -------------------------------------------------------------------------- */
/*                         Salesforce connection routes                       */
/* -------------------------------------------------------------------------- */

app.post('/api/salesforce/connect', requireAuth, wrap(async (req, res) => {
  console.log(`[Salesforce] Connecting for user ${req.user.id} (${req.user.email})...`);
  const { creds, info } = await sf.connectAndVerify(req.body);
  console.log(`[Salesforce] Verified connection to ${info.instanceUrl || 'Salesforce'} for user ${req.user.id}. Saving to database...`);
  const updated = await store.updateUser(req.user.id, {
    connection: { ...info, connectedAt: Date.now(), enc: encryptJson(creds) },
  });
  if (updated) req.user = updated;
  sf.invalidate(req.user.id);
  console.log(`[Salesforce] Connection successfully saved for user ${req.user.id}.`);
  res.json({ success: true, connection: connectionOf(req.user) });
}));

app.delete('/api/salesforce/connection', requireAuth, wrap(async (req, res) => {
  const updated = await store.updateUser(req.user.id, { connection: null });
  if (updated) req.user = updated;
  else req.user.connection = null;
  sf.invalidate(req.user.id);
  res.json({ success: true });
}));

/* -------------------------------------------------------------------------- */
/*                              Settings + template                           */
/* -------------------------------------------------------------------------- */

app.put('/api/settings', requireAuth, wrap(async (req, res) => {
  const b = req.body || {};
  const prev = settingsOf(req.user);
  const existing = req.user.settings || {};

  const emailProvider = b.emailProvider === 'brevo_api' ? 'brevo_api' : 'smtp';
  const newBrevoKey = String(b.brevoApiKey || '').trim();
  const brevoApiKeyEnc = newBrevoKey ? encrypt(newBrevoKey) : existing.brevoApiKeyEnc;

  const next = {
    ...existing,
    emailProvider,
    fromName: text(b.fromName, 'Display name', { max: 80 }),
    hrName: text(b.hrName, 'Sender name', { max: 80 }),
    smtpUser: text(b.smtpUser || '', 'Sender email', { max: 200 }).toLowerCase(),
    fromEmail: b.fromEmail ? text(b.fromEmail, 'From email', { max: 200 }).toLowerCase() : '',
    dailyLimit: Math.max(0, Number(b.dailyLimit || 0)),
    smtpHost: text(b.smtpHost || 'smtp.gmail.com', 'Mail server', { max: 100 }).toLowerCase(),
    smtpPort: Number(b.smtpPort || 465),
    cc: text(b.cc, 'CC', { max: 300 }),
    replyTo: text(b.replyTo, 'Reply-to', { max: 200 }),
    logoUrl: text(b.logoUrl, 'Logo URL', { max: 500 }),
  };

  if (next.fromEmail && !EMAIL_RE.test(next.fromEmail)) throw new HttpError(400, 'From email is not valid.');
  if (next.replyTo && !EMAIL_RE.test(next.replyTo)) throw new HttpError(400, 'Reply-to email is not valid.');
  if (next.cc && !next.cc.split(',').every((e) => EMAIL_RE.test(e.trim()))) {
    throw new HttpError(400, 'CC must be one or more valid emails separated by commas.');
  }
  if (next.logoUrl && !/^https:\/\/[^\s"'<>]+$/i.test(next.logoUrl)) {
    throw new HttpError(400, 'Logo URL must start with https://');
  }

  const newPassword = String(b.smtpPassword || '').replace(/\s+/g, '');
  const smtpPassEnc = newPassword ? encrypt(newPassword) : existing.smtpPassEnc;
  next.smtpPassEnc = smtpPassEnc;
  next.brevoApiKeyEnc = brevoApiKeyEnc;

  if (emailProvider === 'brevo_api') {
    const activeSender = next.fromEmail || next.smtpUser;
    if (!activeSender || !EMAIL_RE.test(activeSender)) {
      throw new HttpError(400, 'A valid verified sender email is required for Brevo API.');
    }
    const rawKey = newBrevoKey || (brevoApiKeyEnc ? decrypt(brevoApiKeyEnc) : '');
    if (!rawKey) {
      throw new HttpError(400, 'Brevo API Key is required (starts with xkeysib-...).');
    }

    // Verify Brevo API key via HTTPS Port 443 (Never blocked by Render!)
    if (newBrevoKey || emailProvider !== prev.emailProvider) {
      try {
        const verifyRes = await fetch('https://api.brevo.com/v3/account', {
          headers: { 'api-key': rawKey },
          signal: AbortSignal.timeout(10_000),
        });
        if (!verifyRes.ok) {
          const body = await verifyRes.json().catch(() => null);
          const reason = body?.message || `HTTP ${verifyRes.status}`;
          throw new HttpError(400, `Brevo rejected the API key: ${reason}`);
        }
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(400, `Could not connect to Brevo API: ${err.message}`);
      }
    }
  } else {
    if (next.smtpUser && !EMAIL_RE.test(next.smtpUser)) throw new HttpError(400, 'Sender email is not valid.');
    if (!SMTP_PORTS.includes(next.smtpPort)) throw new HttpError(400, `Mail port must be one of ${SMTP_PORTS.join(', ')}.`);

    const mailChanged =
      Boolean(newPassword) ||
      next.smtpUser !== prev.smtpUser || next.smtpHost !== prev.smtpHost || next.smtpPort !== prev.smtpPort;
    if (next.smtpUser && smtpPassEnc && mailChanged) {
      await assertPublicMailHost(next.smtpHost);
      const probe = makeTransport(next, newPassword || decrypt(smtpPassEnc), false);
      try {
        await probe.verify();
      } catch (err) {
        throw new HttpError(400, `Could not sign in to the mail server: ${err.message}`);
      } finally {
        probe.close();
      }
    }
  }

  const updated = await store.updateUser(req.user.id, { settings: next });
  if (updated) req.user = updated;
  res.json({
    success: true,
    settings: publicSettings(req.user),
    emailConfigured: emailConfigured(req.user),
    quota: await store.getQuota(req.user),
  });
}));

/* -------------------------------------------------------------------------- */
/*                               Data Source Picker                           */
/* -------------------------------------------------------------------------- */

app.get('/api/salesforce/objects', requireAuth, wrap(async (req, res) => {
  const objects = await sf.withSalesforce(req.user, (conn) => sf.describeObjects(conn));
  res.json({ success: true, objects });
}));

app.get('/api/salesforce/fields', requireAuth, wrap(async (req, res) => {
  const objectName = text(req.query.object, 'Object name', { max: 61, required: true });
  const result = await sf.withSalesforce(req.user, (conn) => sf.describeFields(conn, objectName));
  res.json({ success: true, ...result });
}));

app.put('/api/datasource', requireAuth, wrap(async (req, res) => {
  const b = req.body || {};
  const studentObject = text(b.studentObject, 'Student object', { max: 61, required: true });
  const nameField = text(b.nameField, 'Name field', { max: 61, required: true });
  const emailField = text(b.emailField, 'Email field', { max: 61, required: true });
  const collegeField = b.collegeField ? text(b.collegeField, 'College field', { max: 61 }) : null;
  const statusField = b.statusField ? text(b.statusField, 'Status field', { max: 61 }) : null;

  if (!sf.IDENT_RE.test(studentObject)) throw new HttpError(400, 'Student object must be a valid API name.');
  if (!sf.IDENT_RE.test(nameField)) throw new HttpError(400, 'Name field must be a valid API name.');
  if (!sf.IDENT_RE.test(emailField)) throw new HttpError(400, 'Email field must be a valid API name.');
  if (collegeField && !sf.IDENT_RE.test(collegeField)) throw new HttpError(400, 'College field must be a valid API name.');
  if (statusField && !sf.IDENT_RE.test(statusField)) throw new HttpError(400, 'Status field must be a valid API name.');

  // Validate against Salesforce: confirm object supports files and fields exist
  const meta = await sf.withSalesforce(req.user, async (conn) => {
    return await sf.describeFields(conn, studentObject);
  });

  if (!meta.supportsFiles) {
    throw new HttpError(
      400,
      `Object ${studentObject} does not support file attachments (no ContentDocumentLinks relationship).`
    );
  }

  const findField = (name) => meta.fields.find((f) => f.name.toLowerCase() === name.toLowerCase());

  const canonicalNameObj = findField(nameField);
  if (!canonicalNameObj) throw new HttpError(400, `Field "${nameField}" does not exist on ${studentObject}.`);

  const canonicalEmailObj = findField(emailField);
  if (!canonicalEmailObj) throw new HttpError(400, `Field "${emailField}" does not exist on ${studentObject}.`);

  let canonicalCollege = null;
  if (collegeField) {
    const f = findField(collegeField);
    if (!f) throw new HttpError(400, `Field "${collegeField}" does not exist on ${studentObject}.`);
    canonicalCollege = f.name;
  }

  let canonicalStatus = null;
  if (statusField) {
    const f = findField(statusField);
    if (!f) throw new HttpError(400, `Field "${statusField}" does not exist on ${studentObject}.`);
    canonicalStatus = f.name;
  }

  const existingSettings = req.user.settings || {};
  const nextSettings = {
    ...existingSettings,
    studentObject,
    nameField: canonicalNameObj.name,
    emailField: canonicalEmailObj.name,
    collegeField: canonicalCollege,
    statusField: canonicalStatus,
    dataSourceSet: true,
  };

  const updated = await store.updateUser(req.user.id, { settings: nextSettings });
  if (updated) req.user = updated;

  res.json({ success: true, settings: publicSettings(req.user) });
}));

app.get('/api/template', requireAuth, (req, res) => res.json({ success: true, template: req.user.template }));

app.put('/api/template', requireAuth, wrap(async (req, res) => {
  const { subject, blocks, html } = req.body || {};
  const valid =
    typeof subject === 'string' && subject.length <= 300 &&
    Array.isArray(blocks) && blocks.length <= 100 &&
    blocks.every((b) => b && typeof b === 'object' && typeof b.id === 'string' && typeof b.type === 'string');
  if (!valid || JSON.stringify(blocks).length > 200_000) throw new HttpError(400, 'Invalid template.');
  const updated = await store.updateUser(req.user.id, { template: { subject, blocks, html: typeof html === 'string' ? html : undefined } });
  if (updated) req.user = updated;
  res.json({ success: true });
}));

/* -------------------------------------------------------------------------- */
/*                                Student data                                */
/* -------------------------------------------------------------------------- */

app.get('/api/students', requireAuth, wrap(async (req, res) => {
  const s = req.user.settings || {};
  if (!s.dataSourceSet || !s.studentObject || !s.emailField) {
    throw new HttpError(409, 'Please select a data source first.', 'NO_DATASOURCE');
  }

  const studentObject = s.studentObject;
  const nameField = s.nameField || 'Name';
  const emailField = s.emailField;
  const collegeField = s.collegeField || null;
  const statusField = s.statusField || null;

  // Dedupe columns in SOQL
  const fields = ['Id'];
  if (!fields.includes(nameField)) fields.push(nameField);
  if (!fields.includes(emailField)) fields.push(emailField);
  if (collegeField && !fields.includes(collegeField)) fields.push(collegeField);
  if (statusField && !fields.includes(statusField)) fields.push(statusField);

  const subQuery = `(SELECT ContentDocumentId, ContentDocument.Title, ContentDocument.FileExtension FROM ContentDocumentLinks)`;
  const selectClause = `${fields.join(', ')}, ${subQuery}`;
  const soql = `SELECT ${selectClause} FROM ${studentObject} WHERE ${emailField} != null ORDER BY ${nameField}`;

  const records = await sf.withSalesforce(req.user, (conn) => sf.queryAll(conn, soql));

  const sentMap = req.user.sent || {};
  const data = records.map((r) => {
    const studentId = r.Id;
    const sentRecord = sentMap[studentId];
    return {
      Id: studentId,
      Name: r[nameField] || '',
      Email__c: r[emailField] || '',
      College: collegeField ? (r[collegeField] || '') : '',
      Status: statusField ? (r[statusField] || '') : '',
      SentAt: sentRecord ? sentRecord.at : null,
      ContentDocumentLinks: r.ContentDocumentLinks,
    };
  });

  const quota = await store.getQuota(req.user);

  res.json({ success: true, data, quota });
}));

/* -------------------------------------------------------------------------- */
/*                         Email Deliveries & Tracking                        */
/* -------------------------------------------------------------------------- */

// Paginated email deliveries with filters and search
app.get('/api/deliveries', requireAuth, wrap(async (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(2000, Math.max(1, Number(req.query.limit || 25)));
  const status = String(req.query.status || 'all');
  const search = String(req.query.search || '');
  const campaignId = req.query.campaignId ? String(req.query.campaignId) : null;

  const result = await store.listDeliveries(req.user.id, {
    page,
    limit,
    status,
    search,
    campaignId,
  });

  res.json({ success: true, ...result });
}));

// Student email delivery history
app.get('/api/students/:studentId/history', requireAuth, wrap(async (req, res) => {
  const { studentId } = req.params;
  const deliveries = await store.getStudentDeliveries(req.user.id, studentId);
  res.json({ success: true, data: deliveries });
}));

// Specific delivery details and event audit trail
app.get('/api/deliveries/:id/events', requireAuth, wrap(async (req, res) => {
  const delivery = await store.getDelivery(req.params.id, req.user.id);
  if (!delivery) throw new HttpError(404, 'Delivery record not found.');
  const events = await store.getDeliveryEvents(delivery.id);
  res.json({ success: true, delivery, events });
}));

/* -------------------------------------------------------------------------- */
/*                     Campaigns V2 & Serverless Send Suite                   */
/* -------------------------------------------------------------------------- */

async function executeCampaignBatch(campaignId, user, { budgetMs = 40_000, maxJobs = 999999 } = {}) {
  const campaign = await store.getCampaignV2(campaignId, user.id);
  if (!campaign) throw new HttpError(404, 'Campaign not found');

  if (campaign.status !== 'running') {
    const counts = await store.getCampaignCounts(campaign.id, user.id);
    return {
      success: true,
      campaign,
      counts,
      processed: 0,
      remaining: counts.pending + counts.sending,
      message: `Campaign is currently ${campaign.status}`,
    };
  }

  // 1. Re-claim any jobs left in 'sending' for > 3 minutes where sent_at IS NULL (crashed serverless worker)
  await store.reclaimStuckSendingJobs(campaign.id, 180_000);

  // 2. Prepare sender details and quota
  const ccList = (user.settings?.cc || '')
    .split(',')
    .map((c) => c.trim())
    .filter((c) => EMAIL_RE.test(c));
  const recipientsPerEmail = 1 + ccList.length;
  const dailyLimit = Math.max(0, Number(user.settings?.dailyLimit || 0));
  const fromAddr = getSenderAddress(user);

  const startTime = Date.now();
  const configuredLanes = Math.min(3, Math.max(1, Number(campaign.sendLanes || user.settings?.sendLanes || 2)));

  const sharedState = {
    stopped: false,
    droppedToSingleLane: false,
    pacingDelay: 400,
    cleanSendsCount: 0,
    processedTotal: 0,
    streakCount: 0,
    streakMsg: null,
    timings: [],
  };

  async function handleJobFailure(job, jobErr, step) {
    logJobFailure({ campaignId: campaign.id, jobId: job.id, step, error: jobErr });
    const rawMsg = jobErr?.message || 'Unknown error';
    const msg = sanitizeErrorMessage(rawMsg);
    const code = jobErr?.code || '';
    const respCode = Number(jobErr?.responseCode || 0);

    // Auth failure (permanent, requires user configuration fix)
    if (
      respCode === 535 ||
      code === 'EAUTH' ||
      /invalid login|bad credentials|username and password not accepted/i.test(rawMsg)
    ) {
      sharedState.stopped = true;
      await store.updateJobStatus(job.id, { status: 'pending', lastError: msg });
      await store.recordJobEvent(
        campaign.id,
        job.id,
        job.studentName || 'Student',
        job.studentEmail,
        'auth_error',
        'Gmail login failed. App password update required.'
      );
      await store.updateCampaignV2(campaign.id, user.id, {
        status: 'paused_auth',
        pauseReason: 'Gmail rejected the login. Update the app password in Settings.',
      });
      await store.recordCampaignStateEvent(campaign.id, 'paused', 'Gmail rejected the login. Update app password in Settings.');
      return;
    }

    // Daily user sending quota exceeded (Gmail 550)
    if (
      (respCode === 550 && /5\.4\.5|daily.*quota/i.test(rawMsg)) ||
      /daily user sending quota exceeded|too many recipients/i.test(rawMsg)
    ) {
      sharedState.stopped = true;
      const resumeAt = Date.now() + 24 * 3600 * 1000;
      await store.updateJobStatus(job.id, { status: 'pending', lastError: msg });
      await store.updateCampaignV2(campaign.id, user.id, {
        status: 'paused_limit',
        pauseReason: 'Gmail daily user sending quota exceeded.',
        resumeAt,
      });
      await store.recordCampaignStateEvent(campaign.id, 'paused', 'Gmail daily user sending quota exceeded.');
      return;
    }

    // Salesforce API limit reached
    if (jobErr?.errorCode === 'REQUEST_LIMIT_EXCEEDED') {
      sharedState.stopped = true;
      const now = new Date();
      const midnightUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 5);
      await store.updateJobStatus(job.id, { status: 'pending', lastError: msg });
      await store.updateCampaignV2(campaign.id, user.id, {
        status: 'paused_salesforce',
        pauseReason: 'Salesforce API daily request limit exceeded. Automatically resumes at midnight UTC.',
        resumeAt: midnightUtc,
      });
      await store.recordCampaignStateEvent(campaign.id, 'paused', 'Salesforce API daily request limit exceeded.');
      return;
    }

    // Data timeout check
    const isDataTimeout =
      jobErr?.command === 'DATA' ||
      ((code === 'ETIMEDOUT' || code === 'ESOCKET' || code === 'ECONNRESET') &&
        step === 'smtp' &&
        jobErr?.command === 'DATA');

    if (isDataTimeout && (job.attempts || 0) > 0) {
      await store.updateJobStatus(job.id, {
        status: 'uncertain',
        attempts: (job.attempts || 0) + 1,
        lastError: `Timeout during DATA transfer (${msg}). Check Sent folder.`,
      });
      await store.recordJobEvent(
        campaign.id,
        job.id,
        job.studentName || 'Student',
        job.studentEmail,
        'uncertain',
        `Timeout during DATA transfer. Check Sent folder.`
      );
      return;
    }

    // SMTP throttling response check (421, 450, 451, 452, 454)
    const isThrottling =
      respCode === 421 || respCode === 450 || respCode === 451 || respCode === 452 || respCode === 454;

    if (isThrottling) {
      if (!sharedState.droppedToSingleLane) {
        sharedState.droppedToSingleLane = true;
        sharedState.pacingDelay = 2000;
        await store.recordCampaignThrottledEvent(
          campaign.id,
          `SMTP Throttling (${respCode || msg}): dropping to 1 lane, delay increased to 2000ms`
        );
        await store.updateCampaignV2(campaign.id, user.id, { sendLanes: 1 });
      }
    }

    const isProgrammingError =
      jobErr instanceof TypeError ||
      jobErr instanceof ReferenceError ||
      jobErr instanceof SyntaxError ||
      rawMsg.includes('is not a function') ||
      rawMsg.includes('Cannot read properties');

    const isTransient =
      !isProgrammingError &&
      (code === 'ETIMEDOUT' ||
        code === 'ESOCKETTIMEDOUT' ||
        code === 'ECONNRESET' ||
        code === 'ECONNREFUSED' ||
        code === 'EHOSTUNREACH' ||
        isThrottling ||
        (step === 'salesforce' && (jobErr?.name === 'TimeoutError' || code === 'ENOTFOUND')));

    const attempts = (job.attempts || 0) + 1;
    const backoffMs = attempts === 1 ? 60_000 : attempts === 2 ? 120_000 : 300_000;
    const nextAttemptAt = isTransient && attempts < 3 ? Date.now() + backoffMs : null;

    await store.markJobFailedWithEvent({
      jobId: job.id,
      userId: user.id,
      campaignId: campaign.id,
      studentId: job.studentId,
      studentName: job.studentName,
      studentEmail: job.studentEmail,
      errorMsg: msg,
      isTransient,
      attempts,
      nextAttemptAt,
    });

    if (!isTransient || attempts >= 3) {
      if (msg === sharedState.streakMsg) {
        sharedState.streakCount++;
      } else {
        sharedState.streakMsg = msg;
        sharedState.streakCount = 1;
      }

      const streakTriggered =
        sharedState.streakCount >= 3 || (await store.hasConsecutiveFailures(campaign.id, user.id, msg, 3));

      if (streakTriggered) {
        sharedState.stopped = true;
        const pauseReason = `Paused: 3 consecutive jobs failed with: ${msg}`;
        await store.updateCampaignV2(campaign.id, user.id, {
          status: 'paused',
          pauseReason,
        });
        await store.recordCampaignStateEvent(campaign.id, 'paused', pauseReason);
      }
    }
  }

  async function runLane(laneIndex) {
    const transport = makeDirectTransport(user, { pooled: true });
    let currentJob = null;
    let currentFileBuffer = null;
    let currentJobClaimMs = 0;
    let currentJobDlMs = 0;
    let currentDlError = null;

    try {
      while (
        !sharedState.stopped &&
        Date.now() - startTime < budgetMs &&
        sharedState.processedTotal < maxJobs
      ) {
        if (sharedState.droppedToSingleLane && laneIndex > 0) {
          break;
        }

        // Daily limit rolling quota check
        if (dailyLimit > 0) {
          const quota = await store.getQuota(user);
          if (quota.used + recipientsPerEmail > dailyLimit) {
            sharedState.stopped = true;
            const oldestSend = await store.getOldestSendIn24h(user.id);
            const resumeAt = oldestSend ? oldestSend + 24 * 3600 * 1000 + 1000 : Date.now() + 3600 * 1000;
            await store.updateCampaignV2(campaign.id, user.id, {
              status: 'paused_limit',
              pauseReason: 'Daily sending limit reached. Automatically resumes when rolling quota recovers.',
              resumeAt,
            });
            await store.recordCampaignStateEvent(campaign.id, 'paused', 'Daily sending limit reached.');
            break;
          }
        }

        // Claim current job if not already held
        if (!currentJob) {
          const t0 = Date.now();
          currentJob = await store.claimOneJobForProcessing(campaign.id, user.id);
          currentJobClaimMs = Date.now() - t0;
          if (!currentJob) {
            // No claimable jobs left
            break;
          }

          // Download certificate file from Salesforce
          const tDl0 = Date.now();
          try {
            currentFileBuffer = await downloadJobFile(currentJob, user);
            currentJobDlMs = Date.now() - tDl0;
            currentDlError = null;
          } catch (dlErr) {
            currentJobDlMs = Date.now() - tDl0;
            currentFileBuffer = null;
            currentDlError = dlErr;
          }
        }

        if (sharedState.stopped || Date.now() - startTime >= budgetMs) {
          await store.updateJobStatus(currentJob.id, { status: 'pending' }).catch(() => {});
          currentJob = null;
          break;
        }

        // Prefetch next job: claim next job and download file in parallel with current SMTP send
        let nextJob = null;
        let nextPrefetchPromise = null;
        let nextClaimMs = 0;

        const remainingBudget = budgetMs - (Date.now() - startTime);
        if (
          remainingBudget > 4000 &&
          !sharedState.stopped &&
          sharedState.processedTotal + 1 < maxJobs &&
          (!sharedState.droppedToSingleLane || laneIndex === 0)
        ) {
          const tNextClaim0 = Date.now();
          nextJob = await store.claimOneJobForProcessing(campaign.id, user.id);
          nextClaimMs = Date.now() - tNextClaim0;
          if (nextJob) {
            const tNextDl0 = Date.now();
            nextPrefetchPromise = downloadJobFile(nextJob, user)
              .then((buf) => ({ buf, err: null, dlMs: Date.now() - tNextDl0 }))
              .catch((err) => ({ buf: null, err, dlMs: Date.now() - tNextDl0 }));
          }
        }

        // Send current job
        let smtpSendMs = 0;
        let dbWriteMs = 0;

        if (currentDlError) {
          await handleJobFailure(currentJob, currentDlError, 'salesforce');
        } else {
          const vars = {
            studentName: currentJob.studentName || '',
            Name: currentJob.studentName || '',
            studentEmail: currentJob.studentEmail || '',
            Email: currentJob.studentEmail || '',
            companyName: user.settings?.fromName || '',
            hrName: user.settings?.hrName || '',
            certificateName: currentJob.fileName || 'Certificate',
          };
          const mergedSubject = fillTemplate(campaign.subject || 'Your Certificate', vars);
          const mergedHtml = fillTemplate(campaign.templateHtml || '<p>Your certificate is attached.</p>', vars);

          try {
            const tSend0 = Date.now();
            const info = await transport.sendMail({
              from: fromAddr,
              to: currentJob.studentEmail,
              cc: ccList.length > 0 ? ccList.join(', ') : undefined,
              replyTo: user.settings?.replyTo || undefined,
              subject: mergedSubject,
              html: wrapEmail(mergedHtml),
              text: htmlToText(mergedHtml),
              attachments: [
                {
                  filename: currentJob.fileName || 'certificate.pdf',
                  content: currentFileBuffer,
                },
              ],
            });
            smtpSendMs = Date.now() - tSend0;

            const tDb0 = Date.now();
            await store.markJobSentWithEvent({
              jobId: currentJob.id,
              campaignId: campaign.id,
              userId: user.id,
              studentId: currentJob.studentId,
              studentName: currentJob.studentName,
              studentEmail: currentJob.studentEmail,
              fileName: currentJob.fileName,
              smtpMessageId: info?.messageId || `msg_${Date.now()}`,
              sentAt: Date.now(),
              recipients: recipientsPerEmail,
            });
            dbWriteMs = Date.now() - tDb0;

            sharedState.processedTotal++;
            sharedState.cleanSendsCount++;
            sharedState.streakCount = 0;
            sharedState.streakMsg = null;

            sharedState.timings.push({
              claimMs: currentJobClaimMs,
              fileDownloadMs: currentJobDlMs,
              smtpConnectMs: 0,
              smtpSendMs,
              dbWriteMs,
            });

            // Pacing decay: after 20 clean sends, reduce pacing back towards 400ms
            if (sharedState.cleanSendsCount >= 20 && sharedState.pacingDelay > 400) {
              sharedState.pacingDelay = Math.max(400, sharedState.pacingDelay - 200);
              sharedState.cleanSendsCount = 0;
            }

            console.log(`[LANE ${laneIndex + 1}] ✅ Sent email to ${currentJob.studentEmail} (${smtpSendMs}ms)`);
          } catch (sendErr) {
            await handleJobFailure(currentJob, sendErr, 'smtp');
          }
        }

        // Advance to prefetched nextJob
        if (nextJob) {
          if (sharedState.stopped || Date.now() - startTime >= budgetMs) {
            await store.updateJobStatus(nextJob.id, { status: 'pending' }).catch(() => {});
            currentJob = null;
          } else {
            const prefetched = await nextPrefetchPromise;
            currentJob = nextJob;
            currentJobClaimMs = nextClaimMs;
            currentFileBuffer = prefetched.buf;
            currentDlError = prefetched.err;
            currentJobDlMs = prefetched.dlMs;
          }
        } else {
          currentJob = null;
        }

        // Pacing delay between sends in this lane
        if (!sharedState.stopped && Date.now() - startTime < budgetMs) {
          await new Promise((r) => setTimeout(r, sharedState.pacingDelay));
        }
      }
    } finally {
      if (currentJob) {
        await store.updateJobStatus(currentJob.id, { status: 'pending' }).catch(() => {});
      }
      try {
        transport.close();
      } catch (_) {}
    }
  }

  // Run sending lanes in parallel
  const lanePromises = [];
  for (let l = 0; l < configuredLanes; l++) {
    lanePromises.push(runLane(l));
  }
  await Promise.all(lanePromises);

  // Check campaign completion status
  const counts = await store.getCampaignCounts(campaign.id, user.id);
  const isCompleted = counts.pending === 0 && counts.sending === 0;

  if (isCompleted && campaign.status === 'running') {
    await store.updateCampaignV2(campaign.id, user.id, {
      status: 'completed',
      finishedAt: Date.now(),
    });
    await store.recordCampaignStateEvent(
      campaign.id,
      'completed',
      `Campaign completed: ${counts.sent} sent, ${counts.failed} failed, ${counts.skipped} skipped`
    );
  }

  // Update timing summary
  const updatedCampaign = await store.getCampaignV2(campaign.id, user.id);
  const existingTimings = updatedCampaign?.timingSummary?.timings || [];
  const allTimings = [...existingTimings, ...sharedState.timings].slice(-500);
  const elapsedTotal = Math.max(
    0,
    (updatedCampaign.finishedAt || Date.now()) - (updatedCampaign.startedAt || startTime)
  );
  const timingSummary = calculateTimingSummary(allTimings, elapsedTotal, counts.sent);
  timingSummary.timings = allTimings;
  await store.updateCampaignTimingSummary(campaign.id, user.id, timingSummary);
  updatedCampaign.timingSummary = timingSummary;

  console.log(
    `[BULK BATCH] Campaign "${campaign.name}" (${campaign.id}): Processed in batch: ${sharedState.processedTotal}, Total sent: ${counts.sent}, Remaining: ${counts.pending + counts.sending}, Status: ${updatedCampaign.status}`
  );

  return {
    success: true,
    campaign: updatedCampaign,
    counts,
    processed: sharedState.processedTotal,
    remaining: counts.pending + counts.sending,
    message: updatedCampaign.pauseReason || (isCompleted ? 'Campaign completed' : undefined),
  };
}

// 1. Create a Campaign (bulk Salesforce resolution & job creation)
app.post('/api/campaigns', requireAuth, wrap(async (req, res) => {
  const s = req.user.settings || {};
  if (!s.dataSourceSet || !s.studentObject || !s.emailField) {
    throw new HttpError(409, 'Please select a data source first in Settings.', 'NO_DATASOURCE');
  }
  if (!emailConfigured(req.user)) {
    throw new HttpError(409, 'Please configure your sender email in Settings first.', 'NO_EMAIL_SETTINGS');
  }

  const { name, studentIds, subject, templateHtml, includePreviouslySent = false } = req.body || {};

  const campaignSubject = text(subject || req.user.template?.subject || 'Your Certificate', 'Subject', { max: 300 });
  const campaignName = text(name || `Dispatch ${new Date().toLocaleDateString()}`, 'Campaign Name', { max: 120 });
  const campaignHtml = typeof templateHtml === 'string' ? templateHtml : (req.user.template?.html || '');

  // Bulk resolve students & files via Salesforce in chunks of 150
  const resolved = await sf.withSalesforce(req.user, (conn) =>
    sf.bulkResolveStudentsAndFiles(conn, {
      studentIds: Array.isArray(studentIds) && studentIds.length > 0 ? studentIds : null,
      studentObject: s.studentObject,
      nameField: s.nameField || 'Name',
      emailField: s.emailField,
      collegeField: s.collegeField || null,
      statusField: s.statusField || null,
    })
  );

  if (!resolved.length) {
    throw new HttpError(400, 'No students found matching your selection.');
  }

  // Check previously sent students unless includePreviouslySent is true
  const sentStudentIds = await store.getSentStudentIds(req.user.id);
  const jobsToCreate = [];

  let willSend = 0;
  let skippedNoFile = 0;
  let skippedInvalidEmail = 0;
  let skippedAlreadySent = 0;

  for (const st of resolved) {
    let finalReason = st.skippedReason;
    if (!finalReason && !includePreviouslySent && sentStudentIds.has(st.studentId)) {
      finalReason = 'already_sent';
    }

    if (finalReason) {
      if (finalReason === 'no_file') skippedNoFile++;
      else if (finalReason === 'invalid_email') skippedInvalidEmail++;
      else if (finalReason === 'already_sent') skippedAlreadySent++;
    } else {
      willSend++;
    }

    jobsToCreate.push({
      campaignId: null, // assigned below
      userId: req.user.id,
      studentId: st.studentId,
      studentName: st.studentName,
      studentEmail: st.studentEmail,
      contentDocumentId: st.contentDocumentId,
      contentVersionId: st.contentVersionId,
      fileName: st.fileName,
      status: finalReason ? 'skipped' : 'pending',
      lastError: finalReason || null,
      attempts: 0,
      updatedAt: Date.now(),
    });
  }

  // Create Campaign row with snapshotted subject and html template
  const campaign = await store.createCampaignV2({
    userId: req.user.id,
    name: campaignName,
    subject: campaignSubject,
    templateHtml: campaignHtml,
    status: 'draft',
  });

  // Assign campaignId to all jobs
  for (const j of jobsToCreate) {
    j.campaignId = campaign.id;
  }

  // Insert jobs in batch
  await store.insertJobsBatch(jobsToCreate);

  // Record initial queued and skipped events
  await store.recordCampaignStateEvent(
    campaign.id,
    'queued',
    `Campaign created with ${willSend} recipient(s) queued`
  );
  if (skippedNoFile + skippedInvalidEmail + skippedAlreadySent > 0) {
    await store.recordCampaignStateEvent(
      campaign.id,
      'skipped',
      `${skippedNoFile + skippedInvalidEmail + skippedAlreadySent} student(s) skipped (already sent or missing file/email)`
    );
  }

  // Recipient and duration calculations
  const ccList = (s.cc || '').split(',').map((c) => c.trim()).filter((c) => EMAIL_RE.test(c));
  const recipientsPerEmail = 1 + ccList.length;

  const quota = await store.getQuota(req.user);
  const dailyLimitRemaining = quota.limit > 0 ? Math.max(0, quota.limit - quota.used) : 999999;
  const estimatedDurationSeconds = willSend * 4;

  res.status(201).json({
    success: true,
    campaignId: campaign.id,
    campaign,
    counts: {
      total: resolved.length,
      willSend,
      skipped: {
        noFile: skippedNoFile,
        invalidEmail: skippedInvalidEmail,
        alreadySent: skippedAlreadySent,
        total: skippedNoFile + skippedInvalidEmail + skippedAlreadySent,
      },
    },
    recipientsPerEmail,
    dailyLimitRemaining,
    estimatedDurationSeconds,
  });
}));

// Backward compatibility: POST /api/campaigns/queue
app.post('/api/campaigns/queue', requireAuth, wrap(async (req, res) => {
  const { name, subject, htmlTemplate, items } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    throw new HttpError(400, 'No recipients provided to queue.');
  }

  if (!emailConfigured(req.user)) {
    throw new HttpError(409, 'Please configure your sender email in Settings first.', 'NO_EMAIL_SETTINGS');
  }

  // Handle single item send directly and immediately
  if (items.length === 1) {
    const it = items[0];
    const sId = String(it.studentId || it.Id || '');
    const sEmail = String(it.recipientEmail || it.studentEmail || '').trim();
    const certId = String(it.certificateId || it.contentDocumentId || '');
    const sName = String(it.studentName || it.Name || '');

    if (!ID_RE.test(sId) || !ID_RE.test(certId)) {
      throw new HttpError(400, 'Invalid studentId or certificateId');
    }
    if (!sEmail || !EMAIL_RE.test(sEmail)) {
      throw new HttpError(400, 'Invalid student email address');
    }

    const ccList = (req.user.settings?.cc || '')
      .split(',')
      .map((c) => c.trim())
      .filter((c) => EMAIL_RE.test(c));
    const recipientsPerEmail = 1 + ccList.length;

    await store.reserveSend(req.user.id, recipientsPerEmail);

    let fileData;
    try {
      fileData = await sf.withSalesforce(req.user, (conn) =>
        sf.downloadCertificateFile(conn, certId)
      );
    } catch (sfErr) {
      console.error(`[Queue Single] Salesforce download error for student ${sId}:`, sfErr.message);
      throw new HttpError(502, `Failed to download certificate from Salesforce: ${sfErr.message}`);
    }

    let userTemplate = {};
    if (!subject || !htmlTemplate) {
      try {
        userTemplate = (await store.getTemplate(req.user.id)) || {};
      } catch (tErr) {
        logJobFailure({ step: 'template', error: tErr });
      }
    }
    const templateSubj = subject || userTemplate.subject || 'Your certificate';
    const templateHtmlStr = htmlTemplate || userTemplate.html || '<p>Hello {{studentName}}, your certificate is attached.</p>';

    const vars = {
      studentName: sName,
      Name: sName,
      studentEmail: sEmail,
      Email: sEmail,
      companyName: req.user.settings?.fromName || '',
      hrName: req.user.settings?.hrName || '',
      certificateName: fileData.fileName || 'Certificate',
    };
    const mergedSubject = fillTemplate(templateSubj, vars);
    const mergedHtml = fillTemplate(templateHtmlStr, vars);

    const transport = makeDirectTransport(req.user);
    let info;
    try {
      const fromAddr = getSenderAddress(req.user);

      info = await transport.sendMail({
        from: fromAddr,
        to: sEmail,
        cc: ccList.length > 0 ? ccList.join(', ') : undefined,
        replyTo: req.user.settings?.replyTo || undefined,
        subject: mergedSubject,
        html: wrapEmail(mergedHtml),
        text: htmlToText(mergedHtml),
        attachments: [
          {
            filename: fileData.fileName || 'certificate.pdf',
            content: fileData.buffer,
          },
        ],
      });
    } catch (mailErr) {
      console.error(`[Queue Single] Delivery to ${sEmail} failed:`, mailErr.message);
      throw new HttpError(500, `Failed to send email: ${mailErr.message}`);
    } finally {
      try { transport.close(); } catch (_) {}
    }

    const sentAt = Date.now();
    const smtpMessageId = info?.messageId || `msg_${sentAt}`;
    await store.logSend(req.user.id, recipientsPerEmail, `single_${sId}_${sentAt}`);

    await store.recordDirectDelivery({
      userId: req.user.id,
      studentId: sId,
      studentName: sName,
      recipientEmail: sEmail,
      certificateId: certId,
      certificateName: fileData.fileName,
      subject: mergedSubject,
      status: 'sent',
      smtpMessageId,
      sentAt,
    });

    const freshUser = await store.getUser(req.user.id);
    const updatedQuota = await store.getQuota(freshUser);

    return res.json({
      success: true,
      campaignId: `single_${sId}`,
      queuedCount: 1,
      quota: updatedQuota,
      message: `Certificate email sent to ${sEmail}`,
    });
  }

  // Multiple items: create a campaign and jobs for serverless processing
  const campaignSubject = text(subject || req.user.template?.subject || 'Your Certificate', 'Subject', { max: 300 });
  const campaignName = text(name || `Dispatch ${new Date().toLocaleDateString()}`, 'Campaign Name', { max: 120 });
  const campaignHtml = typeof htmlTemplate === 'string' ? htmlTemplate : (req.user.template?.html || '');

  const campaign = await store.createCampaignV2({
    userId: req.user.id,
    name: campaignName,
    subject: campaignSubject,
    templateHtml: campaignHtml,
    status: 'running',
  });

  const jobsToCreate = items.map((it) => ({
    studentId: String(it.studentId || it.Id || ''),
    studentName: String(it.studentName || it.Name || ''),
    studentEmail: String(it.recipientEmail || it.studentEmail || '').trim().toLowerCase(),
    contentDocumentId: it.certificateId || it.contentDocumentId || null,
    contentVersionId: it.contentVersionId || it.certificateId || null,
    fileName: it.certificateName || it.fileName || 'certificate.pdf',
    status: 'pending',
  }));

  await store.insertJobsBatch(campaign.id, req.user.id, jobsToCreate);

  // Execute initial batch immediately within the HTTP request so serverless container does not sleep mid-batch
  await executeCampaignBatch(campaign.id, req.user, { budgetMs: 15_000, maxJobs: 5 }).catch((err) => {
    console.warn('[Queue] Immediate batch processing warning:', err.message);
  });

  const freshUser = await store.getUser(req.user.id);
  const updatedQuota = await store.getQuota(freshUser);

  res.json({
    success: true,
    campaignId: campaign.id,
    queuedCount: items.length,
    quota: updatedQuota,
    message: `Campaign created and queued for ${items.length} students`,
  });
}));

// Real-time campaign progress polling compatibility
app.get('/api/campaigns/:id/progress', requireAuth, wrap(async (req, res) => {
  let c2 = await store.getCampaignV2(req.params.id, req.user.id);
  if (c2 && c2.status === 'running') {
    // Process a small slice (up to 3 jobs, 5s budget) while polling to ensure queue progresses
    await executeCampaignBatch(c2.id, req.user, { budgetMs: 5_000, maxJobs: 3 }).catch((err) => {
      console.warn('[Progress] Polling batch warning:', err.message);
    });
    c2 = await store.getCampaignV2(req.params.id, req.user.id);
  }

  let campaign = await store.refreshCampaignStats(req.params.id, req.user.id);
  if (!campaign) {
    campaign = await store.getCampaign(req.params.id, req.user.id);
  }
  if (!campaign && c2) {
    const counts = await store.getCampaignCounts(c2.id, req.user.id);
    campaign = {
      id: c2.id,
      name: c2.name,
      subject: c2.subject,
      status: c2.status,
      totalRecipients: counts.total,
      queuedCount: counts.pending,
      sentCount: counts.sent,
      failedCount: counts.failed,
      bouncedCount: 0,
      createdAt: c2.createdAt,
      updatedAt: c2.startedAt || c2.createdAt,
    };
  }
  if (!campaign) throw new HttpError(404, 'Campaign not found.');
  res.json({ success: true, campaign });
}));

// Retry eligible failed deliveries compatibility
app.post('/api/deliveries/retry-failed', requireAuth, wrap(async (req, res) => {
  const { campaignId, deliveryIds } = req.body || {};
  const retriedCount = await store.retryFailedDeliveries(req.user.id, {
    campaignId: campaignId ? String(campaignId) : null,
    deliveryIds: Array.isArray(deliveryIds) ? deliveryIds : null,
  });

  if (campaignId) {
    await store.refreshCampaignStats(campaignId, req.user.id);
  }

  res.json({
    success: true,
    retriedCount,
    message: retriedCount > 0 ? `Queued ${retriedCount} failed email(s) for retry.` : 'No eligible failed emails found to retry.',
  });
}));

// 2. Start Campaign
app.post('/api/campaigns/:id/start', requireAuth, wrap(async (req, res) => {
  const campaign = await store.getCampaignV2(req.params.id, req.user.id);
  if (!campaign) throw new HttpError(404, 'Campaign not found');

  const updated = await store.updateCampaignV2(campaign.id, req.user.id, {
    status: 'running',
    startedAt: campaign.startedAt || Date.now(),
    pauseReason: null,
    resumeAt: null,
  });

  await store.recordCampaignStateEvent(campaign.id, 'started', 'Campaign started');
  const counts = await store.getCampaignCounts(campaign.id, req.user.id);
  res.json({ success: true, campaign: updated, counts });
}));

// 3. Pause Campaign
app.post('/api/campaigns/:id/pause', requireAuth, wrap(async (req, res) => {
  const campaign = await store.getCampaignV2(req.params.id, req.user.id);
  if (!campaign) throw new HttpError(404, 'Campaign not found');

  const updated = await store.updateCampaignV2(campaign.id, req.user.id, {
    status: 'paused',
    pauseReason: 'Paused by user',
  });

  await store.recordCampaignStateEvent(campaign.id, 'paused', 'Campaign paused by user');
  const counts = await store.getCampaignCounts(campaign.id, req.user.id);
  res.json({ success: true, campaign: updated, counts });
}));

// 4. Resume Campaign
app.post('/api/campaigns/:id/resume', requireAuth, wrap(async (req, res) => {
  const campaign = await store.getCampaignV2(req.params.id, req.user.id);
  if (!campaign) throw new HttpError(404, 'Campaign not found');

  const updated = await store.updateCampaignV2(campaign.id, req.user.id, {
    status: 'running',
    pauseReason: null,
    resumeAt: null,
  });

  await store.recordCampaignStateEvent(campaign.id, 'resumed', 'Campaign resumed by user');
  const counts = await store.getCampaignCounts(campaign.id, req.user.id);
  res.json({ success: true, campaign: updated, counts });
}));

// 5. Cancel Campaign
app.post('/api/campaigns/:id/cancel', requireAuth, wrap(async (req, res) => {
  const updated = await store.cancelCampaignV2(req.params.id, req.user.id);
  if (!updated) throw new HttpError(404, 'Campaign not found');
  await store.recordCampaignStateEvent(req.params.id, 'cancelled', 'Campaign cancelled by user');
  const counts = await store.getCampaignCounts(req.params.id, req.user.id);
  res.json({ success: true, campaign: updated, counts });
}));

// 6. Retry Failed Jobs
app.post('/api/campaigns/:id/retry-failed', requireAuth, wrap(async (req, res) => {
  const campaign = await store.getCampaignV2(req.params.id, req.user.id);
  if (!campaign) throw new HttpError(404, 'Campaign not found');

  const retriedCount = await store.retryFailedJobs(campaign.id, req.user.id);
  const updated = await store.updateCampaignV2(campaign.id, req.user.id, {
    status: 'running',
    pauseReason: null,
    resumeAt: null,
  });

  await store.recordCampaignStateEvent(campaign.id, 'resumed', `Retried ${retriedCount} failed job(s)`);
  const counts = await store.getCampaignCounts(campaign.id, req.user.id);
  res.json({ success: true, campaign: updated, counts, retriedCount });
}));

// Live Activity Events & Summary
app.get('/api/campaigns/:id/events', requireAuth, wrap(async (req, res) => {
  const campaign = await store.getCampaignV2(req.params.id, req.user.id);
  if (!campaign) throw new HttpError(404, 'Campaign not found');

  const after = req.query.after ? Number(req.query.after) : 0;
  const limit = req.query.limit ? Math.min(500, Math.max(1, Number(req.query.limit))) : 200;

  const { events, nextCursor } = await store.getJobEvents(campaign.id, { after, limit });
  const counts = await store.getCampaignCounts(campaign.id, req.user.id);

  const now = Date.now();
  const start = campaign.startedAt ? Number(campaign.startedAt) : now;
  const end = campaign.finishedAt ? Number(campaign.finishedAt) : now;
  const elapsedMs = Math.max(0, end - start);
  const durationMin = elapsedMs > 0 ? elapsedMs / 60000 : 0.001;
  const emailsPerMin = counts.sent > 0 ? Number((counts.sent / durationMin).toFixed(1)) : 0;

  const summary = {
    sent: counts.sent,
    failed: counts.failed,
    uncertain: counts.uncertain,
    skipped: counts.skipped,
    sending: counts.sending,
    pending: counts.pending,
    total: counts.total,
    status: campaign.status,
    pause_reason: campaign.pauseReason,
    resume_at: campaign.resumeAt,
    elapsed_ms: elapsedMs,
    emails_per_min: emailsPerMin,
    timing_summary: campaign.timingSummary || null,
  };

  res.json({ success: true, events, nextCursor, summary });
}));

// Waiting Students Queue
app.get('/api/campaigns/:id/queue', requireAuth, wrap(async (req, res) => {
  const campaign = await store.getCampaignV2(req.params.id, req.user.id);
  if (!campaign) throw new HttpError(404, 'Campaign not found');

  const status = req.query.status || 'pending';
  const offset = req.query.offset ? Math.max(0, Number(req.query.offset)) : 0;
  const limit = req.query.limit ? Math.min(200, Math.max(1, Number(req.query.limit))) : 50;
  const search = req.query.search ? String(req.query.search).trim() : '';

  const result = await store.getCampaignQueue(campaign.id, req.user.id, { status, offset, limit, search });
  res.json({ success: true, ...result });
}));

// Export All Events CSV
app.get('/api/campaigns/:id/events.csv', requireAuth, wrap(async (req, res) => {
  const campaign = await store.getCampaignV2(req.params.id, req.user.id);
  if (!campaign) throw new HttpError(404, 'Campaign not found');

  const csv = await store.getJobEventsCsv(campaign.id);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="campaign-${campaign.id}-events.csv"`);
  res.send(csv);
}));

// 7. List User Campaigns
app.get('/api/campaigns', requireAuth, wrap(async (req, res) => {
  const campaigns = await store.listCampaignsV2(req.user.id);
  res.json({ success: true, campaigns });
}));

// 8. Campaign Details & Jobs
app.get('/api/campaigns/:id', requireAuth, wrap(async (req, res) => {
  const campaign = await store.getCampaignV2(req.params.id, req.user.id);
  if (!campaign) throw new HttpError(404, 'Campaign not found');
  const counts = await store.getCampaignCounts(campaign.id, req.user.id);
  const jobs = await store.getCampaignJobs(campaign.id, req.user.id, { limit: 100 });
  res.json({ success: true, campaign, counts, jobs });
}));

// 9. Export Exceptions CSV (failed, uncertain, skipped)
app.get('/api/campaigns/:id/export', requireAuth, wrap(async (req, res) => {
  const campaign = await store.getCampaignV2(req.params.id, req.user.id);
  if (!campaign) throw new HttpError(404, 'Campaign not found');

  const exceptions = await store.getCampaignExceptionsForCsv(campaign.id, req.user.id);

  const header = 'student_id,student_name,student_email,status,last_error\n';
  const rows = exceptions.map((e) =>
    [
      `"${String(e.student_id || '').replace(/"/g, '""')}"`,
      `"${String(e.student_name || '').replace(/"/g, '""')}"`,
      `"${String(e.student_email || '').replace(/"/g, '""')}"`,
      `"${String(e.status || '').replace(/"/g, '""')}"`,
      `"${String(e.last_error || '').replace(/"/g, '""')}"`,
    ].join(',')
  );

  const csv = header + rows.join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="campaign-${campaign.id}-exceptions.csv"`);
  res.send(csv);
}));

// 10. Test Email Endpoint (Sends a sample email with real Salesforce file to sender's own email)
app.post(['/api/campaigns/:id/test-email', '/api/campaigns/test-email'], requireAuth, wrap(async (req, res) => {
  if (!emailConfigured(req.user)) {
    throw new HttpError(409, 'Please configure your sender email in Settings first.', 'NO_EMAIL_SETTINGS');
  }

  const { campaignId, studentId, subject, templateHtml } = req.body || {};
  const activeCampaignId = req.params.id || campaignId;

  let testSubject = subject;
  let testHtml = templateHtml;
  let studentName = 'Sample Student';
  let studentEmail = req.user.email;
  let fileName = 'Certificate.pdf';
  let contentVersionId = null;

  if (activeCampaignId) {
    const campaign = await store.getCampaignV2(activeCampaignId, req.user.id);
    if (campaign) {
      testSubject = testSubject || campaign.subject;
      testHtml = testHtml || campaign.templateHtml;
    }
    const jobs = await store.getCampaignJobs(activeCampaignId, req.user.id, { limit: 10 });
    const sampleJob = jobs.find((j) => j.contentVersionId) || jobs[0];
    if (sampleJob) {
      studentName = sampleJob.studentName || studentName;
      fileName = sampleJob.fileName || fileName;
      contentVersionId = sampleJob.contentVersionId;
    }
  }

  if (!testSubject) testSubject = req.user.template?.subject || 'Your Certificate';
  if (!testHtml) testHtml = req.user.template?.html || '<p>Congratulations {{studentName}}!</p>';

  const vars = {
    studentName,
    Name: studentName,
    studentEmail: req.user.email,
    Email: req.user.email,
    companyName: req.user.settings?.fromName || 'Astrea IT',
    hrName: req.user.settings?.hrName || 'HR Team',
    certificateName: fileName,
  };

  const mergedSubject = `[TEST] ${fillTemplate(testSubject, vars)}`;
  const mergedHtml = fillTemplate(testHtml, vars);

  let fileBuffer = Buffer.from('Mock Certificate Preview File');
  if (contentVersionId) {
    try {
      fileBuffer = await sf.withSalesforce(req.user, (conn) =>
        sf.downloadVersionData(conn, contentVersionId)
      );
    } catch (err) {
      console.warn('Could not download SF version for test email, using mock buffer:', err.message);
    }
  }

  const transport = makeDirectTransport(req.user);
  try {
    const fromAddr = req.user.settings?.fromName
      ? `"${req.user.settings.fromName}" <${req.user.settings.smtpUser}>`
      : req.user.settings?.smtpUser;

    await transport.sendMail({
      from: fromAddr,
      to: req.user.email,
      subject: mergedSubject,
      html: wrapEmail(mergedHtml),
      text: htmlToText(mergedHtml),
      attachments: [{ filename: fileName, content: fileBuffer }],
    });
  } finally {
    transport.close();
  }

  res.json({
    success: true,
    message: `Test email successfully sent to ${req.user.email}`,
  });
}));

// 11. Core Serverless Dispatch Handler: POST /api/campaigns/:id/process
app.post('/api/campaigns/:id/process', requireAuth, wrap(async (req, res) => {
  const budgetMs = req.body?.budgetMs ? Math.min(55_000, Math.max(1000, Number(req.body.budgetMs))) : 40_000;
  const maxJobs = req.body?.maxJobs ? Number(req.body.maxJobs) : 999999;
  const result = await executeCampaignBatch(req.params.id, req.user, { budgetMs, maxJobs });
  res.json(result);
}));

/* -------------------------------------------------------------------------- */
/*                            Single Send Compatibility                       */
/* -------------------------------------------------------------------------- */

app.post('/api/send-email', requireAuth, wrap(async (req, res) => {
  const user = req.user;
  const { studentId, studentEmail, studentName, contentDocumentId, subject, htmlTemplate } = req.body || {};

  if (!ID_RE.test(studentId || '') || !ID_RE.test(contentDocumentId || '')) {
    throw new HttpError(400, 'Invalid studentId or contentDocumentId');
  }

  if (!studentEmail || !EMAIL_RE.test(studentEmail)) {
    throw new HttpError(400, 'Invalid student email address');
  }

  if (!emailConfigured(user)) {
    throw new HttpError(409, 'Set up your sender email in Settings first.', 'NO_EMAIL_SETTINGS');
  }

  const ccList = (user.settings?.cc || '')
    .split(',')
    .map((c) => c.trim())
    .filter((c) => EMAIL_RE.test(c));
  const recipientsPerEmail = 1 + ccList.length;

  // Check quota & reserve send
  await store.reserveSend(user.id, recipientsPerEmail);

  // Template handling: prioritize body, fall back to saved template; failed lookup never blocks send
  let userTemplate = {};
  if (!subject || !htmlTemplate) {
    try {
      userTemplate = (await store.getTemplate(user.id)) || {};
    } catch (tErr) {
      logJobFailure({ step: 'template', error: tErr });
    }
  }

  const templateSubj = subject || userTemplate.subject || 'Your certificate';
  const templateHtmlStr = htmlTemplate || userTemplate.html || '<p>Hello {{studentName}}, your certificate is attached.</p>';

  // Download certificate from Salesforce (30s timeout)
  let fileData;
  try {
    fileData = await sf.withSalesforce(user, (conn) =>
      sf.downloadCertificateFile(conn, contentDocumentId)
    );
  } catch (sfErr) {
    logJobFailure({ step: 'salesforce', error: sfErr });
    throw new HttpError(502, `Failed to download certificate from Salesforce: ${sfErr.message}`);
  }

  let mergedSubject;
  let mergedHtml;
  try {
    const vars = {
      studentName: studentName || '',
      Name: studentName || '',
      studentEmail,
      Email: studentEmail,
      companyName: user.settings?.fromName || '',
      hrName: user.settings?.hrName || '',
      certificateName: fileData.fileName || 'Certificate',
    };
    mergedSubject = fillTemplate(templateSubj, vars);
    mergedHtml = fillTemplate(templateHtmlStr, vars);
  } catch (tErr) {
    logJobFailure({ step: 'template', error: tErr });
    throw new HttpError(400, `Template error: ${tErr.message}`);
  }

  const transport = makeDirectTransport(user);
  let info;
  try {
    const fromAddr = getSenderAddress(user);

    info = await transport.sendMail({
      from: fromAddr,
      to: studentEmail,
      cc: ccList.length > 0 ? ccList.join(', ') : undefined,
      replyTo: user.settings?.replyTo || undefined,
      subject: mergedSubject,
      html: wrapEmail(mergedHtml),
      text: htmlToText(mergedHtml),
      attachments: [
        {
          filename: fileData.fileName || 'certificate.pdf',
          content: fileData.buffer,
        },
      ],
    });
  } catch (mailErr) {
    logJobFailure({ step: 'smtp', error: mailErr });
    throw new HttpError(500, `Failed to send email: ${mailErr.message}`);
  } finally {
    try { transport.close(); } catch (_) {}
  }

  const sentAt = Date.now();
  const smtpMessageId = info?.messageId || `msg_${sentAt}`;
  await store.logSend(user.id, recipientsPerEmail, `single_${studentId}_${sentAt}`);

  const deliveryRecord = await store.recordDirectDelivery({
    userId: user.id,
    studentId,
    studentName: studentName || '',
    recipientEmail: studentEmail,
    certificateId: contentDocumentId,
    certificateName: fileData.fileName,
    subject: mergedSubject,
    status: 'sent',
    smtpMessageId,
    sentAt,
  });

  const freshUser = await store.getUser(user.id);
  const quota = await store.getQuota(freshUser);

  res.json({
    success: true,
    deliveryId: deliveryRecord?.id || `single_${studentId}_${sentAt}`,
    sentAt,
    quota,
    message: `Certificate email sent to ${studentEmail}`,
  });
}));

/* -------------------------------------------------------------------------- */
/*                         Delivery Webhooks Handler                          */
/* -------------------------------------------------------------------------- */

app.post('/api/webhooks/delivery', wrap(async (req, res) => {
  webhook.verifyWebhookAuth(req);

  const events = webhook.normalizeWebhookEvents(req.body);
  const results = [];

  for (const evt of events) {
    try {
      const res = await webhook.handleDeliveryEvent(evt);
      results.push(res);
    } catch (err) {
      console.error('[Webhook] Failed to process event:', err.message);
      results.push({ success: false, error: err.message });
    }
  }

  res.json({ success: true, processed: results.length, results });
}));

/* -------------------------------------------------------------------------- */
/*                                Error handling                              */
/* -------------------------------------------------------------------------- */

app.use((_req, res) => res.status(404).json({ success: false, error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  console.error(`${req.method} ${req.path} failed:`, err.message || err);
  if (err.type === 'entity.too.large') return res.status(413).json({ success: false, error: 'Request is too large.' });

  const known = err instanceof HttpError;
  const showMessage = known || err.errorCode || err.responseCode || (typeof err.code === 'string' && err.code.startsWith('E'));
  res.status(known ? err.status : 500).json({
    success: false,
    error: showMessage ? err.message : 'Unexpected server error.',
    code: known ? err.code : undefined,
  });
});

/* -------------------------------------------------------------------------- */
/*                               Server Export                                */
/* -------------------------------------------------------------------------- */

app.executeCampaignBatch = executeCampaignBatch;
module.exports = app;
module.exports.config = {
  maxDuration: 60,
};

if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`Certificate Dispatcher API running at http://localhost:${PORT} (UI: ${CLIENT_ORIGIN})`);
    if (!ALLOW_SIGNUP) console.log('Sign-ups are disabled (ALLOW_SIGNUP=false).');
  });

  const shutdown = async (signal) => {
    console.log(`Received ${signal}. Shutting down gracefully...`);
    server.close(() => process.exit(0));
    setTimeout(() => {
      console.error('Forcefully exiting after timeout.');
      process.exit(1);
    }, 25_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
