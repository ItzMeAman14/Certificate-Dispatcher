'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../lib/store');
const webhook = require('../lib/webhook');
const { randomToken } = require('../security');

test('Store: User creation and retrieval', async () => {
  const email = `test-${Date.now()}@example.com`;
  const user = await store.createUser({
    email,
    name: 'Test Student Admin',
    passwordHash: 'dummy-hash',
  });

  assert.ok(user.id);
  assert.equal(user.email, email);

  const found = await store.findUserByEmail(email);
  assert.ok(found);
  assert.equal(found.id, user.id);
});

test('Store: Session creation, verification, and deletion', async () => {
  const user = await store.createUser({
    email: `session-user-${Date.now()}@example.com`,
    name: 'Session User',
    passwordHash: 'hash',
  });

  const { sha256 } = require('../security');
  const token = await store.createSession(user.id, 60_000);
  assert.ok(token);

  const session = await store.getSession(sha256(token));
  assert.ok(session);
  assert.equal(session.userId, user.id);

  await store.deleteSession(sha256(token));
  const expired = await store.getSession(sha256(token));
  assert.equal(expired, null);
});

test('Store: Atomic creation of deliveries and outbox jobs for bulk recipients', async () => {
  const user = await store.createUser({
    email: `bulk-${Date.now()}@example.com`,
    name: 'Bulk Tester',
    passwordHash: 'hash',
  });

  const campaign = await store.createCampaign({
    userId: user.id,
    name: '500 Students Graduation Campaign',
    subject: 'Your Graduation Certificate',
    totalRecipients: 50,
  });

  assert.equal(campaign.totalRecipients, 50);

  // Generate 50 items
  const items = Array.from({ length: 50 }, (_, i) => ({
    studentId: `STU_${i + 1}`,
    studentName: `Student ${i + 1}`,
    recipientEmail: `student${i + 1}@college.edu`,
    certificateId: `CERT_${i + 1}`,
  }));

  const { deliveries, jobs } = await store.createDeliveriesAndJobsAtomic({
    userId: user.id,
    campaignId: campaign.id,
    items,
    subject: 'Your Graduation Certificate',
  });

  assert.equal(deliveries.length, 50);
  assert.equal(jobs.length, 50);

  // Check listDeliveries pagination and status counts
  const list = await store.listDeliveries(user.id, {
    page: 1,
    limit: 10,
    status: 'all',
    campaignId: campaign.id,
  });

  assert.equal(list.pagination.total, 50);
  assert.equal(list.pagination.totalPages, 5);
  assert.equal(list.data.length, 10);
  assert.equal(list.counts.total, 50);
  assert.equal(list.counts.inProgress, 50);
});

test('Store: Job completion, retry mechanism, and delivery tracking', async () => {
  const user = await store.createUser({
    email: `retry-test-${Date.now()}@example.com`,
    name: 'Retry Tester',
    passwordHash: 'hash',
  });

  const { deliveries, jobs } = await store.createDeliveriesAndJobsAtomic({
    userId: user.id,
    items: [
      {
        studentId: 'STU_FAIL',
        studentName: 'Failing Student',
        recipientEmail: 'fail@example.com',
      },
      {
        studentId: 'STU_SUCCESS',
        studentName: 'Successful Student',
        recipientEmail: 'success@example.com',
      },
    ],
  });

  // Complete first job
  await store.completeJob(jobs[1].id, deliveries[1].id, 'msg-provider-123');
  const successDelivery = await store.getDelivery(deliveries[1].id, user.id);
  assert.equal(successDelivery.status, 'sent');
  assert.equal(successDelivery.providerMessageId, 'msg-provider-123');

  // Fail second job (permanent failure)
  await store.failJob(jobs[0].id, deliveries[0].id, 'Mailbox does not exist (550)', true);
  const failDelivery = await store.getDelivery(deliveries[0].id, user.id);
  assert.equal(failDelivery.status, 'failed');

  // Retry failed deliveries
  const retried = await store.retryFailedDeliveries(user.id, { deliveryIds: [deliveries[0].id] });
  assert.equal(retried, 1);

  const reloaded = await store.getDelivery(deliveries[0].id, user.id);
  assert.equal(reloaded.status, 'queued');
});

test('Webhook: Delivery & bounce event verification and reconciliation', async () => {
  const user = await store.createUser({
    email: `wh-test-${Date.now()}@example.com`,
    name: 'Webhook Tester',
    passwordHash: 'hash',
  });

  const { deliveries } = await store.createDeliveriesAndJobsAtomic({
    userId: user.id,
    items: [
      {
        studentId: 'STU_WH_1',
        studentName: 'Webhook Student',
        recipientEmail: 'webhook@example.com',
      },
    ],
  });

  const deliveryId = deliveries[0].id;
  await store.completeJob('dummy-job', deliveryId, 'msg-ext-999');

  // Verify delivery webhook
  const deliveryResult = await webhook.handleDeliveryEvent({
    eventType: 'delivered',
    messageId: 'msg-ext-999',
    deliveryId,
  });

  assert.equal(deliveryResult.success, true);
  const updated = await store.getDelivery(deliveryId, user.id);
  assert.equal(updated.status, 'delivered');
  assert.ok(updated.deliveredAt);

  // Check event audit trail
  const events = await store.getDeliveryEvents(deliveryId);
  assert.ok(events.length > 0);
  assert.equal(events[events.length - 1].eventType, 'delivered');
});

test('Suppressions: Auto-skip hard-bounced addresses', async () => {
  const user = await store.createUser({
    email: `suppress-${Date.now()}@example.com`,
    name: 'Suppress Tester',
    passwordHash: 'hash',
  });

  const badEmail = 'bounced-student@bad-domain.invalid';
  assert.equal(await store.isSuppressed(user.id, badEmail), false);

  await store.addSuppression(user.id, badEmail, 'hard_bounce');
  assert.equal(await store.isSuppressed(user.id, badEmail), true);
});

test('Store: Duplicate job prevention on multiple rapid queue requests for same delivery', async () => {
  const user = await store.createUser({
    email: `dup-test-${Date.now()}@example.com`,
    name: 'Duplicate Tester',
    passwordHash: 'hash',
  });

  const item = {
    studentId: 'STU_DUP_1',
    studentName: 'Duplicate Test Student',
    recipientEmail: 'dup@example.com',
  };

  // First queue
  const res1 = await store.createDeliveriesAndJobsAtomic({
    userId: user.id,
    items: [item],
  });

  // Second rapid queue with identical item
  const res2 = await store.createDeliveriesAndJobsAtomic({
    userId: user.id,
    items: [item],
  });

  assert.equal(res1.deliveries[0].id, res2.deliveries[0].id);

  const delivery = await store.getDelivery(res1.deliveries[0].id, user.id);
  assert.ok(delivery);
  assert.equal(delivery.status, 'queued');

  // Verify that only 1 job exists in store for this delivery
  const runnable = await store.fetchRunnableJobs(500);
  const matching = runnable.filter((j) => j.deliveryId === delivery.id);
  assert.equal(matching.length, 1);
});

test('Conditional SMTP transport: Special sender whitelist routes to Gmail, others to default', async () => {
  const queue = require('../lib/queue');

  // Verify whitelist check
  assert.equal(queue.isSpecialGmailSender('aman@astreait.com'), true);
  assert.equal(queue.isSpecialGmailSender('Aman@astreait.com'), true);
  assert.equal(queue.isSpecialGmailSender('manvi@astreait.com'), true);
  assert.equal(queue.isSpecialGmailSender('MANVI@ASTREAIT.COM'), true);
  assert.equal(queue.isSpecialGmailSender('other@example.com'), false);

  // Set up mock Gmail env vars
  const origUser = process.env.GMAIL_USER;
  const origPass = process.env.GMAIL_APP_PASSWORD;
  process.env.GMAIL_USER = 'sender@gmail.com';
  process.env.GMAIL_APP_PASSWORD = 'app-password-16';

  try {
    const gmailTransport = queue.getGmailTransport();
    assert.ok(gmailTransport);
    assert.equal(gmailTransport.options.host, 'smtp.gmail.com');
    assert.equal(gmailTransport.options.auth.user, 'sender@gmail.com');
    assert.equal(gmailTransport.options.auth.pass, 'app-password-16');
  } finally {
    process.env.GMAIL_USER = origUser;
    process.env.GMAIL_APP_PASSWORD = origPass;
  }
});

test('Campaigns V2: Creation, batch jobs insert, atomic claiming, and status counts', async () => {
  const user = await store.createUser({
    email: `camp-user-${Date.now()}@example.com`,
    name: 'Campaign User',
    passwordHash: 'hash',
  });

  const campaign = await store.createCampaignV2({
    userId: user.id,
    name: 'Class of 2026 Batch',
    subject: 'Congratulations {{studentName}}',
    templateHtml: '<p>Dear {{studentName}}, please find attached your certificate.</p>',
    status: 'draft',
  });

  assert.ok(campaign.id);
  assert.equal(campaign.status, 'draft');
  assert.equal(campaign.subject, 'Congratulations {{studentName}}');

  // Insert 10 jobs (8 pending, 2 skipped)
  const jobList = Array.from({ length: 10 }, (_, i) => ({
    campaignId: campaign.id,
    userId: user.id,
    studentId: `STU_${i + 1}`,
    studentName: `Student ${i + 1}`,
    studentEmail: `student${i + 1}@example.com`,
    contentDocumentId: `DOC_${i + 1}`,
    contentVersionId: `VER_${i + 1}`,
    fileName: `Certificate_${i + 1}.pdf`,
    status: i >= 8 ? 'skipped' : 'pending',
    lastError: i >= 8 ? 'no_file' : null,
  }));

  await store.insertJobsBatch(jobList);

  const initialCounts = await store.getCampaignCounts(campaign.id, user.id);
  assert.equal(initialCounts.total, 10);
  assert.equal(initialCounts.pending, 8);
  assert.equal(initialCounts.skipped, 2);

  // Claim batch of 3 jobs
  const claimed = await store.claimJobsForProcessing(campaign.id, user.id, 3);
  assert.equal(claimed.length, 3);
  assert.equal(claimed[0].status, 'sending');

  const afterClaimCounts = await store.getCampaignCounts(campaign.id, user.id);
  assert.equal(afterClaimCounts.pending, 5);
  assert.equal(afterClaimCounts.sending, 3);

  // Mark 1 job as sent with 2 recipients (To + 1 CC)
  await store.markJobSent({
    jobId: claimed[0].id,
    userId: user.id,
    studentId: claimed[0].studentId,
    studentEmail: claimed[0].studentEmail,
    fileName: claimed[0].fileName,
    smtpMessageId: 'smtp-msg-001',
    recipients: 2,
  });

  const afterSentCounts = await store.getCampaignCounts(campaign.id, user.id);
  assert.equal(afterSentCounts.sent, 1);
  assert.equal(afterSentCounts.sending, 2);

  // Reclaim stuck jobs (simulate crashed worker where updated_at was > 3 mins ago)
  claimed[1].updatedAt = Date.now() - 200_000;
  await store.updateJobStatus(claimed[1].id, { updatedAt: Date.now() - 200_000 });
  const reclaimed = await store.reclaimStuckSendingJobs(campaign.id, 180_000);
  assert.equal(reclaimed >= 1, true);

  // Check rolling quota
  const rollingCount = await store.getRollingRecipientCount(user.id);
  assert.equal(rollingCount, 2);
});

test('Campaigns V2: Failure retry, exceptions CSV export, and cancellation', async () => {
  const user = await store.createUser({
    email: `csv-user-${Date.now()}@example.com`,
    name: 'Exceptions User',
    passwordHash: 'hash',
  });

  const campaign = await store.createCampaignV2({
    userId: user.id,
    name: 'Exception Test Campaign',
    subject: 'Cert',
    templateHtml: '<p>Cert</p>',
    status: 'running',
  });

  const jobList = [
    {
      campaignId: campaign.id,
      userId: user.id,
      studentId: 'STU_FAIL_1',
      studentName: 'Failing Student',
      studentEmail: 'fail1@example.com',
      status: 'failed',
      lastError: 'Mail server refused connection',
    },
    {
      campaignId: campaign.id,
      userId: user.id,
      studentId: 'STU_UNCERTAIN_1',
      studentName: 'Uncertain Student',
      studentEmail: 'uncertain1@example.com',
      status: 'uncertain',
      lastError: 'DATA timeout',
    },
    {
      campaignId: campaign.id,
      userId: user.id,
      studentId: 'STU_SKIPPED_1',
      studentName: 'Skipped Student',
      studentEmail: 'skipped1@example.com',
      status: 'skipped',
      lastError: 'invalid_email',
    },
  ];

  await store.insertJobsBatch(jobList);

  const exceptions = await store.getCampaignExceptionsForCsv(campaign.id, user.id);
  assert.equal(exceptions.length, 3);
  assert.ok(exceptions.some((e) => e.status === 'failed'));
  assert.ok(exceptions.some((e) => e.status === 'uncertain'));
  assert.ok(exceptions.some((e) => e.status === 'skipped'));

  // Retry failed jobs
  const retried = await store.retryFailedJobs(campaign.id, user.id);
  assert.equal(retried, 1);

  const counts = await store.getCampaignCounts(campaign.id, user.id);
  assert.equal(counts.failed, 0);
  assert.equal(counts.pending, 1);

  // Cancel campaign
  const cancelled = await store.cancelCampaignV2(campaign.id, user.id);
  assert.equal(cancelled.status, 'cancelled');
});

test('Direct Delivery: Record individual certificate email delivery', async () => {
  const user = await store.createUser({
    email: `single-send-${Date.now()}@example.com`,
    name: 'Direct Send Admin',
    passwordHash: 'hash',
  });

  const studentId = 'STU_DIRECT_101';
  const recipientEmail = 'student.direct@college.edu';
  const delivery = await store.recordDirectDelivery({
    userId: user.id,
    studentId,
    studentName: 'Alice Direct',
    recipientEmail,
    certificateId: '069XX000001',
    certificateName: 'Certificate_Alice.pdf',
    subject: 'Your Graduation Certificate',
    status: 'sent',
    smtpMessageId: '<msg_direct_123@example.com>',
    sentAt: Date.now(),
  });

  assert.ok(delivery.id);
  assert.equal(delivery.status, 'sent');
  assert.equal(delivery.studentId, studentId);
  assert.equal(delivery.recipientEmail, recipientEmail);
  assert.ok(delivery.sentAt);

  // Verify listDeliveries includes it with sent status
  const list = await store.listDeliveries(user.id, { status: 'all' });
  assert.ok(list.data.some((d) => d.studentId === studentId && d.status === 'sent'));
});

test('Salesforce: downloadCertificateFile exports correctly', () => {
  const sf = require('../lib/salesforce');
  assert.equal(typeof sf.downloadCertificateFile, 'function');
  assert.equal(typeof sf.bulkResolveStudentsAndFiles, 'function');
});

function requestPipe(app, { method, path, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const http = require('node:http');
    const pipeName = `\\\\.\\pipe\\test-pipe-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const server = http.createServer(app);
    server.listen(pipeName, () => {
      const payload = body ? JSON.stringify(body) : null;
      const reqHeaders = { ...headers };
      if (payload) {
        reqHeaders['Content-Type'] = 'application/json';
        reqHeaders['Content-Length'] = Buffer.byteLength(payload);
      }
      const req = http.request(
        { socketPath: pipeName, path, method, headers: reqHeaders },
        (res) => {
          let resBody = '';
          res.on('data', (c) => (resBody += c));
          res.on('end', () => {
            server.close();
            try {
              resolve({ status: res.statusCode, body: JSON.parse(resBody) });
            } catch {
              resolve({ status: res.statusCode, body: resBody });
            }
          });
        }
      );
      req.on('error', (err) => {
        server.close();
        reject(err);
      });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

test('Acceptance Check: Single email send works and failed template lookup does not block send', async () => {
  const app = require('../server');
  const sf = require('../lib/salesforce');
  const nodemailer = require('nodemailer');
  const { encrypt } = require('../security');

  const user = await store.createUser({
    email: `single-send-${Date.now()}@example.com`,
    name: 'Single Sender',
    passwordHash: 'hash',
  });

  await store.updateUser(user.id, {
    settings: {
      smtpHost: 'smtp.gmail.com',
      smtpPort: 465,
      smtpUser: 'sender@gmail.com',
      smtpPassEnc: encrypt('valid-app-password'),
      fromName: 'Cert Team',
      replyTo: 'support@example.com',
      dailyLimit: 100,
    },
  });

  const token = await store.createSession(user.id, 60_000);

  const origWithSalesforce = sf.withSalesforce;
  sf.withSalesforce = async (u, fn) => fn({});

  const origDownload = sf.downloadCertificateFile;
  sf.downloadCertificateFile = async () => ({
    fileName: 'SampleCert.pdf',
    buffer: Buffer.from('pdf data'),
    versionId: '068Test',
  });

  const origCreateTransport = nodemailer.createTransport;
  let sentMailOptions = null;
  nodemailer.createTransport = () => ({
    sendMail: async (opts) => {
      sentMailOptions = opts;
      return { messageId: '<msg_single_test@example.com>' };
    },
    close: () => {},
  });

  try {
    // 1. Send with template provided in body
    const res1 = await requestPipe(app, {
      method: 'POST',
      path: '/api/send-email',
      headers: {
        authorization: `Bearer ${token}`,
      },
      body: {
        studentId: 'STU_1001',
        studentName: 'Alice Test',
        studentEmail: 'alice@example.com',
        contentDocumentId: '069Document123',
        subject: 'Custom Body Subject for {{studentName}}',
        htmlTemplate: '<p>Custom HTML for {{studentName}}</p>',
      },
    });
    assert.equal(res1.status, 200);
    assert.equal(res1.body.success, true);
    assert.ok(sentMailOptions.subject.includes('Alice Test'));
    assert.ok(sentMailOptions.html.includes('Custom HTML for Alice Test'));

    // 2. Send without subject/htmlTemplate AND simulate store.getTemplate failure
    const origGetTemplate = store.getTemplate;
    store.getTemplate = async () => {
      throw new Error('Database template connection timed out');
    };

    const res2 = await requestPipe(app, {
      method: 'POST',
      path: '/api/send-email',
      headers: {
        authorization: `Bearer ${token}`,
      },
      body: {
        studentId: 'STU_1002',
        studentName: 'Bob Test',
        studentEmail: 'bob@example.com',
        contentDocumentId: '069Document456',
      },
    });
    assert.equal(res2.status, 200);
    assert.equal(res2.body.success, true);
    assert.ok(sentMailOptions.subject.length > 0);
    assert.ok(sentMailOptions.html.includes('Bob Test'));

    store.getTemplate = origGetTemplate;
  } finally {
    sf.withSalesforce = origWithSalesforce;
    sf.downloadCertificateFile = origDownload;
    nodemailer.createTransport = origCreateTransport;
  }
});

test('Acceptance Check: Wrong SMTP password ends as paused_auth within seconds and leaves jobs pending', async () => {
  const app = require('../server');
  const sf = require('../lib/salesforce');
  const nodemailer = require('nodemailer');
  const { encrypt } = require('../security');

  const user = await store.createUser({
    email: `auth-fail-${Date.now()}@example.com`,
    name: 'Auth Fail User',
    passwordHash: 'hash',
  });

  const updatedUser = await store.updateUser(user.id, {
    settings: {
      smtpHost: 'smtp.gmail.com',
      smtpPort: 465,
      smtpUser: 'badpass@gmail.com',
      smtpPassEnc: encrypt('wrong-app-password'),
      fromName: 'Auth Test',
      dailyLimit: 500,
    },
  });

  const campaign = await store.createCampaignV2({
    userId: user.id,
    name: '5 Students Wrong Password Campaign',
    subject: 'Cert for {{studentName}}',
    templateHtml: '<p>Cert</p>',
    status: 'running',
  });

  const jobs = Array.from({ length: 5 }, (_, i) => ({
    campaignId: campaign.id,
    userId: user.id,
    studentId: `STU_AUTH_${i + 1}`,
    studentName: `Student ${i + 1}`,
    studentEmail: `student${i + 1}@example.com`,
    contentDocumentId: `DOC_${i + 1}`,
    contentVersionId: `068VER_${i + 1}`,
    fileName: `Cert_${i + 1}.pdf`,
    status: 'pending',
  }));
  await store.insertJobsBatch(jobs);

  const origWithSalesforce = sf.withSalesforce;
  sf.withSalesforce = async (u, fn) => fn({});

  const origDownload = sf.downloadVersionData;
  sf.downloadVersionData = async () => Buffer.from('pdf');

  const origCreateTransport = nodemailer.createTransport;
  nodemailer.createTransport = () => ({
    sendMail: async () => {
      const err = new Error('Invalid login: 535-5.7.8 Username and Password not accepted');
      err.code = 'EAUTH';
      err.responseCode = 535;
      throw err;
    },
    close: () => {},
  });

  try {
    const data = await app.executeCampaignBatch(campaign.id, updatedUser, { budgetMs: 5_000, maxJobs: 10 });
    assert.equal(data.success, true);
    assert.equal(data.campaign.status, 'paused_auth');
    assert.equal(data.campaign.pauseReason, 'Gmail rejected the login. Update the app password in Settings.');

    const counts = await store.getCampaignCounts(campaign.id, user.id);
    assert.equal(counts.failed, 0);
    assert.equal(counts.pending, 5);
  } finally {
    sf.withSalesforce = origWithSalesforce;
    sf.downloadVersionData = origDownload;
    nodemailer.createTransport = origCreateTransport;
  }
});

test('Acceptance Check: TypeError in send path marks job failed immediately with error message', async () => {
  const app = require('../server');
  const sf = require('../lib/salesforce');
  const nodemailer = require('nodemailer');
  const { encrypt } = require('../security');

  const user = await store.createUser({
    email: `typeerror-test-${Date.now()}@example.com`,
    name: 'TypeError Test User',
    passwordHash: 'hash',
  });

  const updatedUser = await store.updateUser(user.id, {
    settings: {
      smtpHost: 'smtp.gmail.com',
      smtpPort: 465,
      smtpUser: 'tester@gmail.com',
      smtpPassEnc: encrypt('password'),
      dailyLimit: 500,
    },
  });

  const campaign = await store.createCampaignV2({
    userId: user.id,
    name: 'TypeError Campaign',
    subject: 'Cert for {{studentName}}',
    templateHtml: '<p>Cert</p>',
    status: 'running',
  });

  await store.insertJobsBatch([
    {
      campaignId: campaign.id,
      userId: user.id,
      studentId: 'STU_TYPEERROR',
      studentName: 'Type Error Student',
      studentEmail: 'typeerror@example.com',
      contentVersionId: '068VER_TE',
      status: 'pending',
    },
  ]);

  const origWithSalesforce = sf.withSalesforce;
  sf.withSalesforce = async (u, fn) => fn({});

  const origDownload = sf.downloadVersionData;
  sf.downloadVersionData = async () => Buffer.from('pdf');

  const origCreateTransport = nodemailer.createTransport;
  nodemailer.createTransport = () => ({
    sendMail: async () => {
      throw new TypeError('Cannot read properties of undefined (reading sendMailInternal)');
    },
    close: () => {},
  });

  try {
    const data = await app.executeCampaignBatch(campaign.id, updatedUser, { budgetMs: 5_000, maxJobs: 10 });
    assert.equal(data.success, true);

    const jobs = await store.getCampaignJobs(campaign.id, user.id);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].status, 'failed');
    assert.ok(jobs[0].lastError.includes('Cannot read properties of undefined'));
  } finally {
    sf.withSalesforce = origWithSalesforce;
    sf.downloadVersionData = origDownload;
    nodemailer.createTransport = origCreateTransport;
  }
});

test('Acceptance Check: 3 consecutive jobs failing with same error pause campaign with reason', async () => {
  const app = require('../server');
  const sf = require('../lib/salesforce');
  const nodemailer = require('nodemailer');
  const { encrypt } = require('../security');

  const user = await store.createUser({
    email: `streak-test-${Date.now()}@example.com`,
    name: 'Streak User',
    passwordHash: 'hash',
  });

  const updatedUser = await store.updateUser(user.id, {
    settings: {
      smtpHost: 'smtp.gmail.com',
      smtpPort: 465,
      smtpUser: 'streak@gmail.com',
      smtpPassEnc: encrypt('password'),
      dailyLimit: 500,
    },
  });

  const campaign = await store.createCampaignV2({
    userId: user.id,
    name: 'Streak Failure Campaign',
    subject: 'Cert',
    templateHtml: '<p>Cert</p>',
    status: 'running',
  });

  const jobs = Array.from({ length: 4 }, (_, i) => ({
    campaignId: campaign.id,
    userId: user.id,
    studentId: `STU_STREAK_${i + 1}`,
    studentName: `Student ${i + 1}`,
    studentEmail: `student${i + 1}@example.com`,
    contentVersionId: `068VER_STREAK_${i + 1}`,
    status: 'pending',
  }));
  await store.insertJobsBatch(jobs);

  const origWithSalesforce = sf.withSalesforce;
  sf.withSalesforce = async (u, fn) => fn({});

  const origDownload = sf.downloadVersionData;
  sf.downloadVersionData = async () => Buffer.from('pdf');

  const origCreateTransport = nodemailer.createTransport;
  nodemailer.createTransport = () => ({
    sendMail: async () => {
      const err = new Error('550 5.1.1 User unknown / Invalid recipient');
      err.responseCode = 550;
      throw err;
    },
    close: () => {},
  });

  try {
    const data = await app.executeCampaignBatch(campaign.id, updatedUser, { budgetMs: 5_000, maxJobs: 10 });
    assert.equal(data.success, true);
    assert.equal(data.campaign.status, 'paused');
    assert.ok(data.campaign.pauseReason.includes('3 consecutive jobs failed'));
    assert.ok(data.campaign.pauseReason.includes('550 5.1.1'));
  } finally {
    sf.withSalesforce = origWithSalesforce;
    sf.downloadVersionData = origDownload;
    nodemailer.createTransport = origCreateTransport;
  }
});





test('Bulk sending: Sequential loop isolates individual errors, updates status to failed, and completes remaining sends', async () => {
  const app = require('../server');
  const sf = require('../lib/salesforce');
  const nodemailer = require('nodemailer');
  const { encrypt } = require('../security');

  const user = await store.createUser({
    email: `bulk-seq-${Date.now()}@example.com`,
    name: 'Bulk Sequence Admin',
    passwordHash: 'hash',
  });

  await store.updateUser(user.id, {
    settings: {
      smtpHost: 'smtp.gmail.com',
      smtpPort: 465,
      smtpUser: 'bulk@gmail.com',
      smtpPassEnc: encrypt('password'),
      fromName: 'Bulk Admin',
      dailyLimit: 500,
    },
  });

  const updatedUser = await store.getUser(user.id);

  const campaign = await store.createCampaignV2({
    userId: user.id,
    name: 'Sequential Processing Campaign',
    subject: 'Cert for {{studentName}}',
    templateHtml: '<p>Hi {{studentName}}</p>',
    status: 'running',
  });

  const jobs = [
    {
      campaignId: campaign.id,
      userId: user.id,
      studentId: 'STU_SEQ_1',
      studentName: 'Alice',
      studentEmail: 'alice@example.com',
      contentVersionId: '068VER_ALICE',
      status: 'pending',
    },
    {
      campaignId: campaign.id,
      userId: user.id,
      studentId: 'STU_SEQ_2',
      studentName: 'Bob',
      studentEmail: 'bob@example.com',
      contentVersionId: '068VER_BOB',
      status: 'pending',
    },
    {
      campaignId: campaign.id,
      userId: user.id,
      studentId: 'STU_SEQ_3',
      studentName: 'Charlie',
      studentEmail: 'charlie@example.com',
      contentVersionId: '068VER_CHARLIE',
      status: 'pending',
    },
  ];
  await store.insertJobsBatch(jobs);

  const origWithSalesforce = sf.withSalesforce;
  sf.withSalesforce = async (u, fn) => fn({});

  const origDownload = sf.downloadVersionData;
  sf.downloadVersionData = async (conn, id) => {
    if (id === '068VER_BOB') {
      throw new Error('Certificate not found in Salesforce for Bob');
    }
    return Buffer.from('pdf');
  };

  const sentEmails = [];
  const origCreateTransport = nodemailer.createTransport;
  nodemailer.createTransport = () => ({
    sendMail: async (opts) => {
      sentEmails.push(opts.to);
      return { messageId: `mock-msg-${Date.now()}` };
    },
    close: () => {},
  });

  try {
    const data = await app.executeCampaignBatch(campaign.id, updatedUser, { budgetMs: 10_000, maxJobs: 10 });
    assert.equal(data.success, true);
    assert.equal(data.processed, 2); // 2 sent successfully

    // Verify Bob failed isolated without halting Charlie
    assert.deepEqual(sentEmails, ['alice@example.com', 'charlie@example.com']);

    const finalCounts = await store.getCampaignCounts(campaign.id, user.id);
    assert.equal(finalCounts.sent, 2);
    assert.equal(finalCounts.failed, 1);
    assert.equal(finalCounts.pending, 0);

    const jobsRes = await store.getCampaignJobs(campaign.id, user.id, { limit: 10 });
    const bobJob = (jobsRes.jobs || jobsRes).find((j) => j.studentId === 'STU_SEQ_2');
    assert.ok(bobJob);
    assert.equal(bobJob.status, 'failed');
    assert.ok(bobJob.lastError.includes('Certificate not found'));
  } finally {
    sf.withSalesforce = origWithSalesforce;
    sf.downloadVersionData = origDownload;
    nodemailer.createTransport = origCreateTransport;
  }
});

test('Acceptance Check: Multi-lane fast dispatch with timing summary on 20 students', async () => {
  const app = require('../server');
  const sf = require('../lib/salesforce');
  const nodemailer = require('nodemailer');
  const { encrypt } = require('../security');

  const user = await store.createUser({
    email: `multilane-${Date.now()}@example.com`,
    name: 'MultiLane User',
    passwordHash: 'hash',
  });

  const updatedUser = await store.updateUser(user.id, {
    settings: {
      smtpHost: 'smtp.gmail.com',
      smtpPort: 465,
      smtpUser: 'multilane@gmail.com',
      smtpPassEnc: encrypt('password'),
      dailyLimit: 2000,
    },
  });

  const campaign = await store.createCampaignV2({
    userId: user.id,
    name: '20 Students Speed Test',
    subject: 'Cert for {{studentName}}',
    templateHtml: '<p>Cert</p>',
    status: 'running',
    sendLanes: 2,
  });

  const jobs = Array.from({ length: 20 }, (_, i) => ({
    campaignId: campaign.id,
    userId: user.id,
    studentId: `STU_ML_${i + 1}`,
    studentName: `Student ${i + 1}`,
    studentEmail: `student${i + 1}@example.com`,
    contentDocumentId: `DOC_ML_${i + 1}`,
    contentVersionId: `068VER_ML_${i + 1}`,
    fileName: `Cert_${i + 1}.pdf`,
    status: 'pending',
  }));
  await store.insertJobsBatch(jobs);

  const origWithSalesforce = sf.withSalesforce;
  sf.withSalesforce = async (u, fn) => fn({});

  const origDownload = sf.downloadVersionData;
  sf.downloadVersionData = async () => Buffer.from('pdf');

  const origCreateTransport = nodemailer.createTransport;
  const dispatched = [];
  nodemailer.createTransport = () => ({
    sendMail: async (opts) => {
      dispatched.push(opts.to);
      return { messageId: `msg-${Date.now()}-${Math.random()}` };
    },
    close: () => {},
  });

  try {
    const t0 = Date.now();
    const result = await app.executeCampaignBatch(campaign.id, updatedUser, { budgetMs: 15_000, maxJobs: 20 });
    const elapsedMs = Date.now() - t0;

    assert.equal(result.success, true);
    assert.equal(result.processed, 20);
    assert.equal(dispatched.length, 20);

    const counts = await store.getCampaignCounts(campaign.id, user.id);
    assert.equal(counts.sent, 20);
    assert.equal(counts.pending, 0);

    // Verify timing summary
    const updatedCampaign = await store.getCampaignV2(campaign.id, user.id);
    assert.ok(updatedCampaign.timingSummary);
    assert.ok(updatedCampaign.timingSummary.steps);
    assert.ok(updatedCampaign.timingSummary.emailsPerMin > 0);

    // Verify events recorded
    const { events } = await store.getJobEvents(campaign.id, { after: 0, limit: 100 });
    assert.ok(events.length >= 20);
    const sentEvents = events.filter((e) => e.type === 'sent');
    assert.equal(sentEvents.length, 20);
  } finally {
    sf.withSalesforce = origWithSalesforce;
    sf.downloadVersionData = origDownload;
    nodemailer.createTransport = origCreateTransport;
  }
});

test('Acceptance Check: SMTP 421 throttling drops lanes to 1 and records throttled event', async () => {
  const app = require('../server');
  const sf = require('../lib/salesforce');
  const nodemailer = require('nodemailer');
  const { encrypt } = require('../security');

  const user = await store.createUser({
    email: `throttle-${Date.now()}@example.com`,
    name: 'Throttle User',
    passwordHash: 'hash',
  });

  const updatedUser = await store.updateUser(user.id, {
    settings: {
      smtpHost: 'smtp.gmail.com',
      smtpPort: 465,
      smtpUser: 'throttle@gmail.com',
      smtpPassEnc: encrypt('password'),
      dailyLimit: 2000,
    },
  });

  const campaign = await store.createCampaignV2({
    userId: user.id,
    name: 'Throttled Campaign',
    subject: 'Cert',
    templateHtml: '<p>Cert</p>',
    status: 'running',
    sendLanes: 2,
  });

  await store.insertJobsBatch([
    {
      campaignId: campaign.id,
      userId: user.id,
      studentId: 'STU_THR_1',
      studentName: 'Student 1',
      studentEmail: 'stu1@example.com',
      contentVersionId: '068VER_THR_1',
      status: 'pending',
    },
    {
      campaignId: campaign.id,
      userId: user.id,
      studentId: 'STU_THR_2',
      studentName: 'Student 2',
      studentEmail: 'stu2@example.com',
      contentVersionId: '068VER_THR_2',
      status: 'pending',
    },
  ]);

  const origWithSalesforce = sf.withSalesforce;
  sf.withSalesforce = async (u, fn) => fn({});
  const origDownload = sf.downloadVersionData;
  sf.downloadVersionData = async () => Buffer.from('pdf');

  const origCreateTransport = nodemailer.createTransport;
  let attempts = 0;
  nodemailer.createTransport = () => ({
    sendMail: async () => {
      attempts++;
      if (attempts === 1) {
        const err = new Error('421 4.7.0 Try again later, closing connection');
        err.responseCode = 421;
        throw err;
      }
      return { messageId: `msg-${Date.now()}` };
    },
    close: () => {},
  });

  try {
    const result = await app.executeCampaignBatch(campaign.id, updatedUser, { budgetMs: 5_000, maxJobs: 2 });
    assert.equal(result.success, true);

    // Verify campaign dropped to 1 lane
    const updated = await store.getCampaignV2(campaign.id, user.id);
    assert.equal(updated.sendLanes, 1);

    // Verify throttled event was recorded
    const { events } = await store.getJobEvents(campaign.id, { after: 0, limit: 100 });
    const throttledEvent = events.find((e) => e.type === 'throttled');
    assert.ok(throttledEvent);
    assert.ok(throttledEvent.message.includes('421'));
  } finally {
    sf.withSalesforce = origWithSalesforce;
    sf.downloadVersionData = origDownload;
    nodemailer.createTransport = origCreateTransport;
  }
});

test('Acceptance Check: Live Log Endpoints (events cursor, queue, CSV export)', async () => {
  const user = await store.createUser({
    email: `livelog-${Date.now()}@example.com`,
    name: 'LiveLog User',
    passwordHash: 'hash',
  });

  const campaign = await store.createCampaignV2({
    userId: user.id,
    name: 'Live Log Campaign',
    subject: 'Cert',
    templateHtml: '<p>Cert</p>',
    status: 'running',
  });

  await store.insertJobsBatch([
    {
      campaignId: campaign.id,
      userId: user.id,
      studentId: 'STU_LL_1',
      studentName: 'Alice Anderson',
      studentEmail: 'alice.anderson@example.com',
      status: 'pending',
    },
    {
      campaignId: campaign.id,
      userId: user.id,
      studentId: 'STU_LL_2',
      studentName: 'Bob Brown',
      studentEmail: 'bob.brown@example.com',
      status: 'pending',
    },
  ]);

  // Record events
  await store.recordCampaignStateEvent(campaign.id, 'started', 'Campaign started');
  await store.recordJobEvent(campaign.id, 'job1', 'Alice Anderson', 'alice.anderson@example.com', 'sent', 'Sent to Alice');

  // Test 1: getJobEvents
  const eventsRes = await store.getJobEvents(campaign.id, { after: 0, limit: 10 });
  assert.ok(eventsRes.events.length >= 2);
  const firstId = eventsRes.events[0].id;

  const cursorRes = await store.getJobEvents(campaign.id, { after: firstId, limit: 10 });
  assert.equal(cursorRes.events.length, eventsRes.events.length - 1);

  // Test 2: getCampaignQueue
  const queueRes = await store.getCampaignQueue(campaign.id, user.id, { status: 'pending', offset: 0, limit: 10 });
  assert.equal(queueRes.total, 2);
  assert.equal(queueRes.queue[0].position, 1);
  assert.equal(queueRes.queue[0].studentName, 'Alice Anderson');
  assert.equal(queueRes.queue[1].position, 2);
  assert.equal(queueRes.queue[1].studentName, 'Bob Brown');

  // Search queue
  const searchRes = await store.getCampaignQueue(campaign.id, user.id, { search: 'Brown' });
  assert.equal(searchRes.queue.length, 1);
  assert.equal(searchRes.queue[0].studentName, 'Bob Brown');

  // Test 3: getJobEventsCsv
  const csv = await store.getJobEventsCsv(campaign.id);
  assert.ok(csv.startsWith('id,time,type,student_name,student_email,message'));
  assert.ok(csv.includes('Alice Anderson'));
  assert.ok(csv.includes('Campaign started'));
});

test('Acceptance Check: Database pre-flight health check and diagnostic sanitizer', async () => {
  const diag = store.getDbDiagnostics();
  assert.ok(diag);
  assert.ok(diag.mode === 'postgres' || diag.mode === 'fileDb');
  // Verify credentials are never leaked in diagnostics
  assert.equal(diag.password, undefined);
  assert.equal(diag.user, undefined);

  const health = await store.checkDbConnection(3000);
  assert.ok(health);
  assert.equal(typeof health.ok, 'boolean');
});
