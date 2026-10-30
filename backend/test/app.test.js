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

