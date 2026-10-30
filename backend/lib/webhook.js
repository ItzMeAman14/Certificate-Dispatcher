'use strict';

/**
 * Verified Delivery Webhook Handler:
 * - Cryptographically verifies webhook authorization & signatures.
 * - Idempotently processes delivery, bounce, and failure events.
 * - Resolves delivery records by provider_message_id or delivery_id.
 * - Handles duplicate and out-of-order webhook events safely.
 */

const crypto = require('crypto');
const store = require('./store');
const { HttpError } = require('./errors');

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

/**
 * Verifies webhook secret token or HMAC-SHA256 signature.
 */
function verifyWebhookAuth(req) {
  if (!WEBHOOK_SECRET) {
    // If no secret configured, allow only in development with warning
    if (process.env.NODE_ENV === 'production') {
      throw new HttpError(500, 'WEBHOOK_SECRET is not configured in production.');
    }
    return true;
  }

  // 1. Direct secret header or bearer token
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const customHeader = req.headers['x-webhook-secret'] || req.query.secret;

  if (token === WEBHOOK_SECRET || customHeader === WEBHOOK_SECRET) {
    return true;
  }

  // 2. HMAC-SHA256 signature verification (e.g. X-Webhook-Signature)
  const signature = req.headers['x-webhook-signature'];
  if (signature && req.rawBody) {
    const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET).update(req.rawBody).digest('hex');
    if (crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(hmac))) {
      return true;
    }
  }

  throw new HttpError(401, 'Invalid or missing webhook signature/secret.');
}

/**
 * Normalizes incoming events from standard formats, Resend, SendGrid, or AWS SES.
 */
function normalizeWebhookEvents(body) {
  if (Array.isArray(body)) {
    return body.map(normalizeSingleEvent).filter(Boolean);
  }
  if (body && Array.isArray(body.events)) {
    return body.events.map(normalizeSingleEvent).filter(Boolean);
  }
  const single = normalizeSingleEvent(body);
  return single ? [single] : [];
}

function normalizeSingleEvent(evt) {
  if (!evt || typeof evt !== 'object') return null;

  // Resend format: { type: "email.delivered", data: { email_id, to, ... } }
  if (evt.type && evt.data) {
    const type = evt.type.replace(/^email\./, '');
    return {
      eventType: type === 'delivered' ? 'delivered' : type.includes('bounce') ? 'bounced' : 'failed',
      messageId: evt.data.email_id || evt.data.message_id,
      deliveryId: evt.data.headers?.['X-Certificate-Delivery-Id'] || evt.data.delivery_id,
      recipient: Array.isArray(evt.data.to) ? evt.data.to[0] : evt.data.to,
      providerEventId: evt.id || evt.data.id,
      details: evt.data.reason || evt.data.error || null,
      raw: evt,
    };
  }

  // SendGrid format: { event: "delivered"|"bounce"|"dropped", sg_message_id, email, ... }
  if (evt.event) {
    const eventType =
      evt.event === 'delivered'
        ? 'delivered'
        : evt.event === 'bounce' || evt.event === 'bounced'
        ? 'bounced'
        : evt.event === 'dropped' || evt.event === 'deferred'
        ? 'failed'
        : evt.event;

    return {
      eventType,
      messageId: evt.sg_message_id ? evt.sg_message_id.split('.')[0] : evt.message_id,
      deliveryId: evt.delivery_id || evt['X-Certificate-Delivery-Id'],
      recipient: evt.email,
      providerEventId: evt.sg_event_id || evt.event_id,
      details: evt.reason || evt.response || null,
      raw: evt,
    };
  }

  // Standard generic format: { event, messageId, deliveryId, recipient, ... }
  const status = String(evt.status || evt.event || '').toLowerCase();
  const eventType = status.includes('deliver')
    ? 'delivered'
    : status.includes('bounce')
    ? 'bounced'
    : status.includes('fail')
    ? 'failed'
    : status;

  return {
    eventType,
    messageId: evt.messageId || evt.providerMessageId || evt.id,
    deliveryId: evt.deliveryId,
    recipient: evt.recipient || evt.email,
    providerEventId: evt.eventId || evt.providerEventId,
    details: evt.details || evt.error || evt.reason || null,
    raw: evt,
  };
}

/**
 * Processes delivery status event safely.
 */
async function handleDeliveryEvent(event) {
  const { eventType, messageId, deliveryId, recipient, providerEventId, details, raw } = event;

  // 1. Resolve delivery record
  let delivery = null;
  if (deliveryId) {
    delivery = await store.getDelivery(deliveryId);
  }
  if (!delivery && messageId) {
    delivery = await store.getDeliveryByMessageId(messageId);
  }

  if (!delivery) {
    return { success: false, reason: 'Delivery record not found for this event' };
  }

  // 2. Safe State Transition
  const currentStatus = delivery.status;
  const now = Date.now();
  const patch = {};

  if (eventType === 'delivered') {
    // Do not downgrade if already bounced
    if (currentStatus !== 'bounced') {
      patch.status = 'delivered';
      patch.deliveredAt = now;
    }
  } else if (eventType === 'bounced') {
    patch.status = 'bounced';
    patch.bouncedAt = now;
    patch.errorMessage = typeof details === 'string' ? details : 'Bounced by recipient mail server';
    // Add to suppressions
    await store.addSuppression(delivery.userId, delivery.recipientEmail, 'webhook_bounce');
  } else if (eventType === 'failed') {
    if (currentStatus !== 'delivered') {
      patch.status = 'failed';
      patch.failedAt = now;
      patch.errorMessage = typeof details === 'string' ? details : 'Delivery failed';
    }
  }

  if (Object.keys(patch).length > 0) {
    await store.updateDelivery(delivery.id, patch);
  }

  // 3. Record Audit Event
  await store.recordEmailEvent({
    deliveryId: delivery.id,
    userId: delivery.userId,
    eventType,
    provider: 'webhook',
    providerEventId: providerEventId || `wh-${now}-${Math.random().toString(36).slice(2, 7)}`,
    details,
    payload: raw,
  });

  // 4. Update campaign stats if attached
  if (delivery.campaignId) {
    await store.refreshCampaignStats(delivery.campaignId, delivery.userId);
  }

  return { success: true, deliveryId: delivery.id, status: patch.status || currentStatus };
}

module.exports = {
  verifyWebhookAuth,
  normalizeWebhookEvents,
  handleDeliveryEvent,
};

