'use strict';

/**
 * Production-ready Background Email Queue Worker:
 * - Durable outbox queue backed by NeonDB (PostgreSQL) with local fallback.
 * - Concurrency control & rate limiting (prevents overwhelming SMTP/API providers).
 * - Exponential backoff retry for transient errors (socket errors, 4xx).
 * - Immediate terminal failure for permanent errors (5xx mailbox unknown, invalid syntax).
 * - Idempotent processing: never double-sends.
 * - Graceful shutdown and worker recovery.
 */

const os = require('os');
const store = require('./store');
const sf = require('./salesforce');
const { HttpError } = require('./errors');
const { decrypt, sha256 } = require('../security');
const nodemailer = require('nodemailer');

const WORKER_ID = `${os.hostname()}-${process.pid}-${Date.now().toString(36)}`;
const CONCURRENCY = Math.max(1, Number(process.env.WORKER_CONCURRENCY || 3));
const RATE_LIMIT_PER_SEC = Math.max(1, Number(process.env.EMAIL_RATE_LIMIT_PER_SEC || 5));
const MIN_SEND_INTERVAL_MS = Math.ceil(1000 / RATE_LIMIT_PER_SEC);

let isRunning = false;
let isStopping = false;
let activeJobsCount = 0;
let pollTimer = null;
let lastSendTime = 0;

/* -------------------------------------------------------------------------- */
/*                                Mail Helpers                                */
/* -------------------------------------------------------------------------- */

const transports = new Map(); // userId -> { fingerprint, transport }

function makeTransport(settings, password) {
  return nodemailer.createTransport({
    host: settings.smtpHost || 'smtp.gmail.com',
    port: Number(settings.smtpPort || 465),
    secure: Number(settings.smtpPort || 465) === 465,
    requireTLS: Number(settings.smtpPort || 465) !== 465,
    pool: true,
    maxConnections: 3,
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
    auth: { user: settings.smtpUser, pass: password },
  });
}

function getTransport(user) {
  const s = user.settings || {};
  if (!s.smtpUser || !s.smtpPassEnc) {
    throw new HttpError(409, 'Sender email settings are not configured.', 'NO_EMAIL_SETTINGS');
  }
  const fingerprint = sha256([s.smtpHost, s.smtpPort, s.smtpUser, s.smtpPassEnc].join('|'));
  const cached = transports.get(user.id);
  if (cached && cached.fingerprint === fingerprint) return cached.transport;
  if (cached) cached.transport.close();

  const transport = makeTransport(s, decrypt(s.smtpPassEnc));
  transports.set(user.id, { fingerprint, transport });
  return transport;
}

const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function fillTemplate(template, vars) {
  return template.replace(/{{\s*(\w+)\s*}}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match
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

function isPermanentError(err) {
  if (!err) return false;
  const msg = String(err.message || '').toLowerCase();
  const code = String(err.code || '');
  const responseCode = Number(err.responseCode || 0);

  // 5xx SMTP response codes are permanent rejections (e.g., 550 User unknown)
  if (responseCode >= 500 && responseCode <= 599) return true;
  if (code === 'EENVELOPE' || code === 'EMESSAGE') return true;

  if (
    msg.includes('suppressed') ||
    msg.includes('invalid email') ||
    msg.includes('recipient rejected') ||
    msg.includes('does not exist') ||
    msg.includes('certificate not found') ||
    msg.includes('not attached to the student')
  ) {
    return true;
  }

  return false;
}

/* -------------------------------------------------------------------------- */
/*                                Job Processing                              */
/* -------------------------------------------------------------------------- */

async function processJob(job) {
  activeJobsCount++;
  const { id: jobId, deliveryId, campaignId, userId, studentId, recipientEmail, certificateId } = job;

  try {
    // 1. Suppression check
    const suppressed = await store.isSuppressed(userId, recipientEmail);
    if (suppressed) {
      const reason = 'Recipient email is on suppression list (previous bounce or unsubscribe).';
      await store.failJob(jobId, deliveryId, reason, true);
      await store.recordEmailEvent({
        deliveryId,
        userId,
        eventType: 'suppressed',
        details: reason,
      });
      if (campaignId) await store.refreshCampaignStats(campaignId, userId);
      return;
    }

    // 2. Fetch User & Settings
    const user = await store.getUser(userId);
    if (!user) throw new Error('User account not found.');
    const s = user.settings || {};
    const transport = getTransport(user);

    // 3. Salesforce: verify & download certificate
    const { student, file } = await sf.withSalesforce(user, async (conn) => {
      const emailField = s.emailField || 'Email';
      const studentObject = s.studentObject || 'Contact';

      const [studentRec] = await sf.queryAll(
        conn,
        `SELECT Id, Name, ${emailField} FROM ${studentObject} WHERE Id = '${studentId}' LIMIT 1`
      );
      if (!studentRec) throw new Error(`Student ${studentId} not found in Salesforce`);

      const email = studentRec[emailField];
      if (!email) throw new Error(`Student ${studentId} has no email address`);

      let certId = certificateId;
      if (!certId) {
        const [link] = await sf.queryAll(
          conn,
          `SELECT ContentDocumentId FROM ContentDocumentLink WHERE LinkedEntityId = '${studentId}' LIMIT 1`
        );
        if (!link) throw new Error('Certificate file is not attached to this student');
        certId = link.ContentDocumentId;
      }

      const [version] = await sf.queryAll(
        conn,
        `SELECT Id, Title, FileExtension FROM ContentVersion WHERE ContentDocumentId = '${certId}' AND IsLatest = true LIMIT 1`
      );
      if (!version) throw new Error('Certificate file content not found in Salesforce');

      const content = await sf.downloadVersionData(conn, version.Id);
      const fileName = version.FileExtension ? `${version.Title}.${version.FileExtension}` : version.Title;
      return {
        student: { name: studentRec.Name || 'Student', email },
        file: { fileName, content },
      };
    });

    // 4. Rate-limit pace control
    const now = Date.now();
    const elapsed = now - lastSendTime;
    if (elapsed < MIN_SEND_INTERVAL_MS) {
      await new Promise((resolve) => setTimeout(resolve, MIN_SEND_INTERVAL_MS - elapsed));
    }
    lastSendTime = Date.now();

    // 5. Template and variables
    const companyName = s.fromName || 'our team';
    const year = String(new Date().getFullYear());
    const plainVars = {
      studentName: student.name,
      studentEmail: student.email,
      fileName: file.fileName,
      hrName: s.hrName || s.fromName || '',
      companyName,
      year,
    };
    const htmlVars = Object.fromEntries(Object.entries(plainVars).map(([k, v]) => [k, escapeHtml(v)]));
    htmlVars.logoSrc = s.logoUrl ? escapeHtml(s.logoUrl) : '';

    const bodyTemplate = job.templateHtml || (user.template && user.template.html) || '<p>Please find your certificate attached.</p>';
    const html = wrapEmail(fillTemplate(bodyTemplate, htmlVars).replace(/<img\b[^>]*\bsrc=""[^>]*>/gi, ''));
    const subjectLine = fillTemplate(job.subject || 'Your certificate', plainVars).replace(/[\r\n]+/g, ' ');

    // 6. Send Mail
    const info = await transport.sendMail({
      from: `"${(s.fromName || s.smtpUser).replace(/"/g, '')}" <${s.smtpUser}>`,
      replyTo: s.replyTo || undefined,
      to: student.email,
      cc: s.cc || undefined,
      subject: subjectLine,
      html,
      text: htmlToText(fillTemplate(bodyTemplate, { ...htmlVars, logoSrc: '' })),
      attachments: [{ filename: file.fileName, content: file.content }],
      headers: {
        'X-Certificate-Delivery-Id': deliveryId,
        'X-Campaign-Id': campaignId || '',
      },
    });

    const providerMessageId = (info && (info.messageId || info.response)) || `msg-${Date.now()}`;

    // 7. Success state update (Marked as 'sent' / Accepted by provider)
    await store.completeJob(jobId, deliveryId, providerMessageId);
    await store.recordEmailEvent({
      deliveryId,
      userId,
      eventType: 'sent',
      provider: 'smtp',
      providerEventId: providerMessageId,
      details: `Accepted by mail server: ${info.response || 'OK'}`,
    });

    if (campaignId) {
      await store.refreshCampaignStats(campaignId, userId);
    }
  } catch (err) {
    console.error(`[Queue] Delivery ${deliveryId} to ${recipientEmail} failed:`, err.message);
    const permanent = isPermanentError(err);
    await store.failJob(jobId, deliveryId, err.message, permanent);

    await store.recordEmailEvent({
      deliveryId,
      userId,
      eventType: permanent ? 'failed_permanent' : 'failed_transient',
      details: err.message,
    });

    // If recipient is rejected with a permanent 5xx bounce, add to suppressions
    if (err.responseCode >= 550 && err.responseCode <= 554) {
      await store.addSuppression(userId, recipientEmail, 'hard_bounce');
    }

    if (campaignId) {
      await store.refreshCampaignStats(campaignId, userId);
    }
  } finally {
    activeJobsCount--;
  }
}

/* -------------------------------------------------------------------------- */
/*                               Worker Poller                                */
/* -------------------------------------------------------------------------- */

async function tick() {
  if (isStopping) return;

  try {
    const availableSlots = CONCURRENCY - activeJobsCount;
    if (availableSlots > 0) {
      const jobs = await store.fetchRunnableJobs(availableSlots, WORKER_ID);
      if (jobs.length > 0) {
        jobs.forEach((j) => {
          processJob(j).catch((err) => console.error('[Queue] Unhandled job error:', err));
        });
      }
    }
  } catch (err) {
    console.error('[Queue] Error polling runnable jobs:', err.message);
  } finally {
    if (!isStopping) {
      const delay = activeJobsCount >= CONCURRENCY ? 500 : 1200;
      pollTimer = setTimeout(tick, delay);
    }
  }
}

function start() {
  if (isRunning) return;
  isRunning = true;
  isStopping = false;
  console.log(`[Queue] Background worker ${WORKER_ID} started (Concurrency: ${CONCURRENCY}, Max rate: ${RATE_LIMIT_PER_SEC}/s).`);
  tick();
}

async function stop() {
  if (!isRunning || isStopping) return;
  isStopping = true;
  console.log('[Queue] Worker stopping gracefully, awaiting active jobs to finish...');
  if (pollTimer) clearTimeout(pollTimer);

  const timeoutMs = 20_000;
  const startWait = Date.now();
  while (activeJobsCount > 0 && Date.now() - startWait < timeoutMs) {
    await new Promise((r) => setTimeout(r, 200));
  }

  // Close open SMTP transports
  for (const { transport } of transports.values()) {
    try {
      transport.close();
    } catch {
      // ignore
    }
  }
  transports.clear();

  isRunning = false;
  console.log('[Queue] Worker stopped successfully.');
}

module.exports = {
  start,
  stop,
  WORKER_ID,
};

