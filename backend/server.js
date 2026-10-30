'use strict';

require('dotenv').config();

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
/*                                   Config                                   */
/* -------------------------------------------------------------------------- */

const PORT = Number(process.env.PORT || 3000);
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
const ALLOW_SIGNUP = (process.env.ALLOW_SIGNUP || 'true') !== 'false';
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true'; // set true when served over HTTPS
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
  const isProd =
    process.env.NODE_ENV === 'production' ||
    Boolean(process.env.RENDER) ||
    COOKIE_SECURE;
  const sameSite = isProd ? 'SameSite=None' : 'SameSite=Lax';
  const flags = ['HttpOnly', 'Path=/', sameSite, `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
  if (isProd) flags.push('Secure');
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
    fromName: s.fromName || '',
    hrName: s.hrName || '',
    smtpUser: s.smtpUser || '',
    smtpHost: s.smtpHost || 'smtp.gmail.com',
    smtpPort: s.smtpPort || 465,
    cc: s.cc || '',
    replyTo: s.replyTo || '',
    logoUrl: s.logoUrl || '',
    studentObject: s.studentObject || 'Student__c',
    emailField: s.emailField || 'Email__c',
  };
}

const publicSettings = (user) => ({
  ...settingsOf(user),
  hasSmtpPassword: Boolean(user.settings && user.settings.smtpPassEnc),
});

const connectionOf = (user) =>
  user.connection
    ? { method: user.connection.method, orgName: user.connection.orgName, instanceUrl: user.connection.instanceUrl }
    : null;

const emailConfigured = (user) => Boolean(user.settings && user.settings.smtpUser && user.settings.smtpPassEnc);

const meResponse = (user) => ({
  success: true,
  user: { id: user.id, email: user.email, name: user.name },
  connection: connectionOf(user),
  emailConfigured: emailConfigured(user),
  settings: publicSettings(user),
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
    connectionTimeout: 15_000,
    auth: { user: settings.smtpUser, pass: password },
  });
}

function getTransport(user) {
  if (!emailConfigured(user)) {
    throw new HttpError(409, 'Set up your sender email in Settings first.', 'NO_EMAIL_SETTINGS');
  }
  const s = settingsOf(user);
  const fingerprint = sha256([s.smtpHost, s.smtpPort, s.smtpUser, user.settings.smtpPassEnc].join('|'));
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

app.get(['/api/health', '/health'], (_req, res) =>
  res.json({ success: true, status: 'healthy', timestamp: Date.now(), worker: queue.WORKER_ID })
);

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
  res.status(201).json({ success: true, token, ...meResponse(user) });
}));

app.post('/api/auth/login', wrap(async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const password = String(req.body?.password ?? '');
  const key = `${req.ip}|${email}`;

  if (!loginLimiter.allowed(key)) {
    throw new HttpError(429, 'Too many failed attempts. Try again in 15 minutes.');
  }

  const user = EMAIL_RE.test(email) ? await store.findUserByEmail(email) : null;
  const ok = user ? await verifyPassword(password, user.passwordHash) : (await fakeVerify(password), false);
  if (!ok) {
    loginLimiter.fail(key);
    throw new HttpError(401, 'Invalid email or password.');
  }

  loginLimiter.clear(key);
  const token = await store.createSession(user.id, SESSION_MS);
  setSessionCookie(res, token, SESSION_MS);
  res.json({ success: true, token, ...meResponse(user) });
}));

app.post('/api/auth/logout', wrap(async (req, res) => {
  const token = extractToken(req);
  if (token) await store.deleteSession(sha256(token));
  setSessionCookie(res, '', 0);
  res.json({ success: true });
}));

app.get('/api/auth/me', requireAuth, (req, res) => res.json(meResponse(req.user)));

/* -------------------------------------------------------------------------- */
/*                         Salesforce connection routes                       */
/* -------------------------------------------------------------------------- */

app.post('/api/salesforce/connect', requireAuth, wrap(async (req, res) => {
  const { creds, info } = await sf.connectAndVerify(req.body);
  const updated = await store.updateUser(req.user.id, {
    connection: { ...info, connectedAt: Date.now(), enc: encryptJson(creds) },
  });
  if (updated) req.user = updated;
  sf.invalidate(req.user.id);
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

  const next = {
    fromName: text(b.fromName, 'Display name', { max: 80 }),
    hrName: text(b.hrName, 'Sender name', { max: 80 }),
    smtpUser: text(b.smtpUser, 'Sender email', { max: 200 }).toLowerCase(),
    smtpHost: text(b.smtpHost || 'smtp.gmail.com', 'Mail server', { max: 100 }).toLowerCase(),
    smtpPort: Number(b.smtpPort || 465),
    cc: text(b.cc, 'CC', { max: 300 }),
    replyTo: text(b.replyTo, 'Reply-to', { max: 200 }),
    logoUrl: text(b.logoUrl, 'Logo URL', { max: 500 }),
    studentObject: text(b.studentObject || 'Student__c', 'Student object', { max: 61 }),
    emailField: text(b.emailField || 'Email__c', 'Email field', { max: 61 }),
  };

  if (next.smtpUser && !EMAIL_RE.test(next.smtpUser)) throw new HttpError(400, 'Sender email is not valid.');
  if (!SMTP_PORTS.includes(next.smtpPort)) throw new HttpError(400, `Mail port must be one of ${SMTP_PORTS.join(', ')}.`);
  if (next.replyTo && !EMAIL_RE.test(next.replyTo)) throw new HttpError(400, 'Reply-to email is not valid.');
  if (next.cc && !next.cc.split(',').every((e) => EMAIL_RE.test(e.trim()))) {
    throw new HttpError(400, 'CC must be one or more valid emails separated by commas.');
  }
  if (next.logoUrl && !/^https:\/\/[^\s"'<>]+$/i.test(next.logoUrl)) {
    throw new HttpError(400, 'Logo URL must start with https://');
  }
  if (!sf.IDENT_RE.test(next.studentObject)) throw new HttpError(400, 'Student object must be an API name like Student__c.');
  if (!sf.IDENT_RE.test(next.emailField)) throw new HttpError(400, 'Email field must be an API name like Email__c.');

  const newPassword = String(b.smtpPassword || '').replace(/\s+/g, '');
  const smtpPassEnc = newPassword ? encrypt(newPassword) : existing.smtpPassEnc;

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

  const updated = await store.updateUser(req.user.id, { settings: { ...next, smtpPassEnc } });
  if (updated) req.user = updated;
  res.json({ success: true, settings: publicSettings(req.user), emailConfigured: emailConfigured(req.user) });
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
  const { studentObject, emailField } = settingsOf(req.user);

  const records = await sf.withSalesforce(req.user, (conn) =>
    sf.queryAll(
      conn,
      `SELECT Id, Name, ${emailField},
         (SELECT ContentDocumentId, ContentDocument.Title, ContentDocument.FileExtension
          FROM ContentDocumentLinks)
       FROM ${studentObject}
       WHERE ${emailField} != null
       ORDER BY Name`,
    ),
  );

  const data = records.map((r) => ({
    Id: r.Id,
    Name: r.Name,
    Email__c: r[emailField],
    ContentDocumentLinks: r.ContentDocumentLinks,
  }));
  res.json({ success: true, data });
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
/*                         Campaign Queueing & Bulk Send                      */
/* -------------------------------------------------------------------------- */

const queueLimiter = createLimiter({ max: 30, windowMs: 60_000 });

// Async queue campaign (processes up to 500+ recipients reliably)
app.post('/api/campaigns/queue', requireAuth, wrap(async (req, res) => {
  if (!queueLimiter.allowed(req.user.id)) {
    throw new HttpError(429, 'Too many requests. Please wait a moment before queueing again.');
  }

  const { name, subject, htmlTemplate, items } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    throw new HttpError(400, 'No recipients provided to queue.');
  }
  if (items.length > 1000) {
    throw new HttpError(400, 'Maximum 1,000 recipients per campaign.');
  }
  if (!emailConfigured(req.user)) {
    throw new HttpError(409, 'Please configure your sender email in Settings first.', 'NO_EMAIL_SETTINGS');
  }

  const campaignSubject = text(subject || 'Your Certificate', 'Subject', { max: 300, required: true });
  const campaignName = text(name || `Dispatch ${new Date().toLocaleDateString()}`, 'Campaign Name', { max: 100 });

  // 1. Create campaign
  const campaign = await store.createCampaign({
    userId: req.user.id,
    name: campaignName,
    subject: campaignSubject,
    templateHtml: typeof htmlTemplate === 'string' ? htmlTemplate : '',
    totalRecipients: items.length,
  });

  // 2. Prepare items with idempotency
  const validItems = items.map((it) => ({
    studentId: String(it.studentId || ''),
    studentName: String(it.studentName || ''),
    recipientEmail: String(it.recipientEmail || it.studentEmail || '').trim().toLowerCase(),
    certificateId: it.certificateId || it.contentDocumentId || null,
    certificateName: it.certificateName || it.fileName || null,
    idempotencyKey: `${campaign.id}_${it.studentId}_${String(it.recipientEmail || it.studentEmail || '').trim().toLowerCase()}`,
  }));

  // 3. Atomically create delivery records and queue jobs
  await store.createDeliveriesAndJobsAtomic({
    userId: req.user.id,
    campaignId: campaign.id,
    items: validItems,
    subject: campaignSubject,
  });

  res.json({
    success: true,
    campaignId: campaign.id,
    queuedCount: validItems.length,
    message: `Successfully queued ${validItems.length} certificate(s) for background dispatch.`,
  });
}));

// Real-time campaign progress polling
app.get('/api/campaigns/:id/progress', requireAuth, wrap(async (req, res) => {
  let campaign = await store.refreshCampaignStats(req.params.id, req.user.id);
  if (!campaign) {
    campaign = await store.getCampaign(req.params.id, req.user.id);
  }
  if (!campaign) throw new HttpError(404, 'Campaign not found.');
  res.json({ success: true, campaign });
}));

// Retry eligible failed emails without resending successful ones
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

/* -------------------------------------------------------------------------- */
/*                            Single Send Compatibility                       */
/* -------------------------------------------------------------------------- */

app.post('/api/send-email', requireAuth, wrap(async (req, res) => {
  const user = req.user;
  const { studentId, studentEmail, studentName, contentDocumentId, subject, htmlTemplate } = req.body || {};

  if (!ID_RE.test(studentId || '') || !ID_RE.test(contentDocumentId || '')) {
    throw new HttpError(400, 'Invalid studentId or contentDocumentId');
  }

  if (!emailConfigured(user)) {
    throw new HttpError(409, 'Set up your sender email in Settings first.', 'NO_EMAIL_SETTINGS');
  }

  // Queue as an individual job for consistent tracking & outbox reliability
  const idempotencyKey = `single_${studentId}_${Date.now()}`;
  const { deliveries } = await store.createDeliveriesAndJobsAtomic({
    userId: user.id,
    campaignId: null,
    items: [
      {
        studentId,
        studentName: studentName || '',
        recipientEmail: studentEmail,
        certificateId: contentDocumentId,
        idempotencyKey,
      },
    ],
    subject: subject || 'Your certificate',
  });

  res.json({
    success: true,
    deliveryId: deliveries[0]?.id,
    message: `Certificate email queued for ${studentEmail}`,
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
/*                               Worker & Server                              */
/* -------------------------------------------------------------------------- */

store.pruneSessions().catch?.((err) => console.error('Prune sessions error:', err));
setInterval(() => {
  store.pruneSessions().catch?.((err) => console.error('Prune sessions error:', err));
}, 60 * 60_000).unref();

// Start background email queue worker
queue.start();

const server = app.listen(PORT, () => {
  console.log(`Certificate Dispatcher API running at http://localhost:${PORT} (UI: ${CLIENT_ORIGIN})`);
  if (!ALLOW_SIGNUP) console.log('Sign-ups are disabled (ALLOW_SIGNUP=false).');
});

// Graceful shutdown handling
const shutdown = async (signal) => {
  console.log(`Received ${signal}. Shutting down gracefully...`);
  server.close(async () => {
    await queue.stop();
    process.exit(0);
  });
  setTimeout(() => {
    console.error('Forcefully exiting after timeout.');
    process.exit(1);
  }, 25_000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
