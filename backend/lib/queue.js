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

const GMAIL_SPECIAL_SENDERS = ['aman@astreait.com', 'manvi@astreait.com'];

function isSpecialGmailSender(email) {
  return GMAIL_SPECIAL_SENDERS.includes(String(email || '').trim().toLowerCase());
}

function makeTransport(settings, password) {
  return nodemailer.createTransport({
    host: settings.smtpHost || 'smtp.gmail.com',
    port: Number(settings.smtpPort || 465),
    secure: Number(settings.smtpPort || 465) === 465,
    requireTLS: Number(settings.smtpPort || 465) !== 465,
    pool: true,
    maxConnections: 3,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    auth: { user: settings.smtpUser, pass: password },
  });
}

function getGmailTransport() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    throw new Error('Gmail SMTP credentials missing. Please define GMAIL_USER and GMAIL_APP_PASSWORD in environment variables.');
  }

  const host = process.env.GMAIL_HOST || 'smtp.gmail.com';
  const port = Number(process.env.GMAIL_PORT || 465);
  const secure = port === 465;

  const fingerprint = sha256([host, port, user, pass].join('|'));
  const cached = transports.get('gmail_special_transport');
  if (cached && cached.fingerprint === fingerprint) return cached.transport;
  if (cached) cached.transport.close();

  const transport = nodemailer.createTransport({
    host,
    port,
    secure,
    requireTLS: !secure,
    pool: true,
    maxConnections: 3,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    auth: { user, pass },
  });

  transports.set('gmail_special_transport', { fingerprint, transport });
  return transport;
}

function getTransport(user) {
  const s = user?.settings || {};
  if (s.smtpUser && s.smtpPassEnc) {
    const fingerprint = sha256([s.smtpHost, s.smtpPort, s.smtpUser, s.smtpPassEnc].join('|'));
    const cached = transports.get(user.id);
    if (cached && cached.fingerprint === fingerprint) return cached.transport;
    if (cached) cached.transport.close();

    const transport = makeTransport(s, decrypt(s.smtpPassEnc));
    transports.set(user.id, { fingerprint, transport });
    return transport;
  }

  // Fallback to system-level default SMTP environment variables if provided
  const defaultHost = process.env.EMAIL_HOST || process.env.SMTP_HOST || 'smtp-relay.brevo.com';
  const defaultPort = Number(process.env.EMAIL_PORT || process.env.SMTP_PORT || 587);
  const defaultUser = process.env.EMAIL_USER || process.env.SMTP_USER;
  const defaultPass = process.env.EMAIL_PASS || process.env.SMTP_PASS || process.env.EMAIL_PASSWORD;

  if (defaultUser && defaultPass) {
    const fingerprint = sha256([defaultHost, defaultPort, defaultUser, defaultPass].join('|'));
    const cached = transports.get('system_default_smtp');
    if (cached && cached.fingerprint === fingerprint) return cached.transport;
    if (cached) cached.transport.close();

    const transport = nodemailer.createTransport({
      host: defaultHost,
      port: defaultPort,
      secure: defaultPort === 465,
      requireTLS: defaultPort !== 465,
      pool: true,
      maxConnections: 3,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
      auth: { user: defaultUser, pass: defaultPass },
    });
    transports.set('system_default_smtp', { fingerprint, transport });
    return transport;
  }

  throw new HttpError(409, 'Sender email settings are not configured.', 'NO_EMAIL_SETTINGS');
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

async function processJob(job, stepIndex = 1, totalSteps = 1) {
  activeJobsCount++;
  const { id: jobId, deliveryId, campaignId, userId, studentId, recipientEmail, certificateId } = job;

  try {
    // 0. Double-send check: verify delivery has not already been completed
    const delivery = await store.getDelivery(deliveryId, userId);
    if (delivery && (delivery.status === 'sent' || delivery.status === 'delivered')) {
      console.warn(`[Queue] Delivery ${deliveryId} is already '${delivery.status}'. Skipping duplicate send.`);
      await store.completeJob(jobId, deliveryId, delivery.providerMessageId || 'already-sent');
      return true;
    }

    // Guard against rapid duplicate sends to the same student within 30 seconds (race-condition protection)
    let user = await store.getUser(userId);
    const recentSent = user?.sent?.[studentId];
    if (recentSent && (Date.now() - Number(recentSent.at || 0) < 30_000)) {
      console.warn(`[Queue] Student ${studentId} was already sent an email ${Math.round((Date.now() - recentSent.at) / 1000)}s ago. Skipping duplicate send.`);
      await store.completeJob(jobId, deliveryId, 'duplicate-cooldown-skipped');
      return true;
    }

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
      console.error(`[STEP 3/${totalSteps}] ❌ Failed: ${recipientEmail} is on suppression list.`);
      return false;
    }

    // 2. Fetch User & Settings
    if (!user) user = await store.getUser(userId);
    if (!user) throw new Error('User account not found.');
    const s = user.settings || {};

    const isGmailSender = isSpecialGmailSender(user.email);
    let transport = null;
    let isBrevoApi = false;

    if (isGmailSender) {
      transport = getGmailTransport();
    } else {
      isBrevoApi = (s.emailProvider || (s.brevoApiKeyEnc ? 'brevo_api' : 'smtp')) === 'brevo_api';
      if (!isBrevoApi) {
        transport = getTransport(user);
      }
    }

    // 3. Salesforce: verify & download certificate
    console.log(`[STEP 1/${totalSteps}] Fetching PDF attachment for ${recipientEmail || studentId}...`);
    const { student, file } = await sf.withSalesforce(user, async (conn) => {
      const emailField = s.emailField || 'Email__c';
      const nameField = s.nameField || 'Name';
      const studentObject = s.studentObject || 'Student__c';

      const [studentRec] = await sf.queryAll(
        conn,
        `SELECT Id, ${nameField}, ${emailField} FROM ${studentObject} WHERE Id = '${studentId}' LIMIT 1`
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
        student: { name: studentRec[nameField] || 'Student', email },
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
    console.log(`[STEP 2/${totalSteps}] Transporter dispatching email to ${student.email}...`);
    let providerMessageId = `msg-${Date.now()}`;
    let responseDetails = 'OK';

    if (isGmailSender) {
      console.log(`[Queue] Using Gmail SMTP for sender ${user.email}`);
      const fromAddress = process.env.GMAIL_USER || user.email;
      const fromName = s.fromName || user.name || fromAddress;

      const studentEmailLower = student.email.trim().toLowerCase();
      let filteredCc = undefined;
      if (s.cc) {
        const seenCc = new Set([studentEmailLower]);
        const ccArray = [];
        for (const c of s.cc.split(',')) {
          const email = c.trim();
          const emailLower = email.toLowerCase();
          if (emailLower && !seenCc.has(emailLower)) {
            seenCc.add(emailLower);
            ccArray.push(email);
          }
        }
        if (ccArray.length > 0) {
          filteredCc = ccArray.join(', ');
        }
      }

      try {
        const info = await transport.sendMail({
          from: `"${fromName.replace(/"/g, '')}" <${fromAddress}>`,
          replyTo: s.replyTo || undefined,
          to: student.email,
          cc: filteredCc,
          subject: subjectLine,
          html,
          text: htmlToText(fillTemplate(bodyTemplate, { ...htmlVars, logoSrc: '' })),
          attachments: [{ filename: file.fileName, content: file.content }],
          headers: {
            'X-Certificate-Delivery-Id': deliveryId,
            'X-Campaign-Id': campaignId || '',
          },
        });

        providerMessageId = (info && (info.messageId || info.response)) || `gmail-${Date.now()}`;
        responseDetails = `Accepted by Gmail SMTP: ${info.response || 'OK'}`;
      } catch (err) {
        throw new Error(`Gmail SMTP dispatch failed for ${user.email}: ${err.message}`);
      }
    } else if (isBrevoApi) {
      console.log(`[Queue] Using default Brevo REST API for sender ${user.email}`);
      const apiKey = decrypt(s.brevoApiKeyEnc || s.smtpPassEnc);
      const fromAddress = s.fromEmail || s.smtpUser;
      const fromName = s.fromName || fromAddress;

      const payload = {
        sender: { name: fromName, email: fromAddress },
        to: [{ email: student.email, name: student.name }],
        subject: subjectLine,
        htmlContent: html,
        textContent: htmlToText(fillTemplate(bodyTemplate, { ...htmlVars, logoSrc: '' })),
        attachment: [
          {
            name: file.fileName,
            content: Buffer.isBuffer(file.content)
              ? file.content.toString('base64')
              : Buffer.from(file.content).toString('base64'),
          },
        ],
        headers: {
          'X-Certificate-Delivery-Id': deliveryId,
          'X-Campaign-Id': campaignId || '',
        },
      };

      if (s.replyTo) {
        payload.replyTo = { email: s.replyTo };
      }
      if (s.cc) {
        const studentEmailLower = student.email.trim().toLowerCase();
        const seenCc = new Set([studentEmailLower]);
        const ccList = [];
        for (const c of s.cc.split(',')) {
          const email = c.trim().toLowerCase();
          if (email && !seenCc.has(email)) {
            seenCc.add(email);
            ccList.push({ email });
          }
        }
        if (ccList.length > 0) payload.cc = ccList;
      }

      try {
        const apiRes = await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'api-key': apiKey,
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(30_000),
        });

        const apiData = await apiRes.json().catch(() => null);
        if (!apiRes.ok) {
          const errMsg = apiData?.message || `HTTP ${apiRes.status} from Brevo API`;
          throw new Error(`Brevo API send rejected: ${errMsg}`);
        }

        providerMessageId = apiData?.messageId || `brevo-${Date.now()}`;
        responseDetails = 'Accepted by Brevo REST API (HTTPS)';
      } catch (err) {
        throw new Error(`Brevo REST API dispatch failed for ${user.email}: ${err.message}`);
      }
    } else {
      console.log(`[Queue] Using default Brevo SMTP for sender ${user.email}`);
      const fromAddress = s.fromEmail || s.smtpUser || process.env.EMAIL_USER || process.env.SMTP_USER;
      const studentEmailLower = student.email.trim().toLowerCase();
      let filteredCc = undefined;
      if (s.cc) {
        const seenCc = new Set([studentEmailLower]);
        const ccArray = [];
        for (const c of s.cc.split(',')) {
          const email = c.trim();
          const emailLower = email.toLowerCase();
          if (emailLower && !seenCc.has(emailLower)) {
            seenCc.add(emailLower);
            ccArray.push(email);
          }
        }
        if (ccArray.length > 0) {
          filteredCc = ccArray.join(', ');
        }
      }

      try {
        const info = await transport.sendMail({
          from: `"${(s.fromName || fromAddress).replace(/"/g, '')}" <${fromAddress}>`,
          replyTo: s.replyTo || undefined,
          to: student.email,
          cc: filteredCc,
          subject: subjectLine,
          html,
          text: htmlToText(fillTemplate(bodyTemplate, { ...htmlVars, logoSrc: '' })),
          attachments: [{ filename: file.fileName, content: file.content }],
          headers: {
            'X-Certificate-Delivery-Id': deliveryId,
            'X-Campaign-Id': campaignId || '',
          },
        });

        providerMessageId = (info && (info.messageId || info.response)) || `msg-${Date.now()}`;
        responseDetails = `Accepted by mail server: ${info.response || 'OK'}`;
      } catch (err) {
        throw new Error(`Default SMTP dispatch failed for ${user.email}: ${err.message}`);
      }
    }

    // 7. Success state update (Marked as 'sent' / Accepted by provider)
    await store.completeJob(jobId, deliveryId, providerMessageId);
    await store.recordSent(userId, studentId, {
      at: Date.now(),
      to: student.email,
      file: file.fileName,
    });
    await store.recordEmailEvent({
      deliveryId,
      userId,
      eventType: 'sent',
      provider: isGmailSender ? 'gmail_smtp' : (isBrevoApi ? 'brevo_api' : 'smtp'),
      providerEventId: providerMessageId,
      details: responseDetails,
    });

    if (campaignId) {
      await store.refreshCampaignStats(campaignId, userId);
    }

    console.log(`[STEP 3/${totalSteps}] ✅ Sent: Certificate email successfully dispatched to ${student.email} (MessageId: ${providerMessageId})`);
    return true;
  } catch (err) {
    console.error(`[STEP 3/${totalSteps}] ❌ Failed: Delivery ${deliveryId} to ${recipientEmail} failed:`, err.message);
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
    return false;
  } finally {
    store.releaseSend(userId, 1);
    activeJobsCount--;
  }
}

async function processJobsSequentially(jobs) {
  if (!jobs || jobs.length === 0) return { processed: 0, sent: 0, failed: 0 };
  const total = jobs.length;
  console.log(`[BULK START] Total count initialized: ${total} job(s) in queue batch.`);

  let sentCount = 0;
  let failedCount = 0;
  let current = 0;

  for (const job of jobs) {
    current++;
    try {
      const ok = await processJob(job, current, total);
      if (ok) sentCount++;
      else failedCount++;
    } catch (iterationErr) {
      failedCount++;
      console.error(`[STEP 3/${total}] ❌ Failed: Unhandled iteration exception for ${job.recipientEmail || job.studentId}: ${iterationErr.message}`);
    }

    // Rate-limiting delay (300-500ms pause) between sends to prevent memory leaks and SMTP rate-limit bans
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  console.log(`[BULK COMPLETE] Final summary: Total: ${total}, Sent: ${sentCount}, Failed: ${failedCount}`);
  return { processed: total, sent: sentCount, failed: failedCount };
}

/* -------------------------------------------------------------------------- */
/*                               Worker Poller                                */
/* -------------------------------------------------------------------------- */

// Rule 1: No background timers outside requests. The queue poller and all
// setTimeout loops have been removed. Email sending is demand-driven via
// /api/campaigns/:id/process with time-budgeted execution.
async function tick() {
  return;
}

function start() {
  // Rule 1: Background queue poller removed. Nothing runs outside requests.
  return;
}

async function stop() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  isRunning = false;
  isStopping = true;

  // Close open SMTP transports
  for (const { transport } of transports.values()) {
    try {
      transport.close();
    } catch {
      // ignore
    }
  }
  transports.clear();
}

module.exports = {
  start,
  stop,
  WORKER_ID,
  isSpecialGmailSender,
  getGmailTransport,
  getTransport,
  processJob,
  processJobsSequentially,
};

