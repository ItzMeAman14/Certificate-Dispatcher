'use strict';

const jsforce = require('jsforce');
const { HttpError } = require('./errors');
const { decryptJson } = require('../security');

// Users type these hosts in, and the server calls them, so only real Salesforce domains are accepted.
const SF_HOST_RE = /^(?:[a-z0-9-]+\.)+(?:salesforce\.com|force\.com|salesforce\.mil|salesforce-setup\.com)$/i;
const IDENT_RE = /^[A-Za-z][A-Za-z0-9_]{0,60}$/; // object/field API names (blocks SOQL injection)

function normalizeHost(input, label) {
  const host = String(input || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/[/?#].*$/, '')
    .toLowerCase();
  if (!SF_HOST_RE.test(host)) {
    throw new HttpError(400, `${label} must be a Salesforce domain, e.g. yourorg.my.salesforce.com`);
  }
  return host;
}

function required(value, label, max = 2000) {
  const text = String(value ?? '').trim();
  if (!text) throw new HttpError(400, `${label} is required`);
  if (text.length > max) throw new HttpError(400, `${label} is too long`);
  return text;
}

/* ------------------------------ Authentication ----------------------------- */

async function fetchClientCredentialsToken({ myDomain, clientId, clientSecret }) {
  const res = await fetch(`https://${myDomain}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || !body.access_token) {
    const reason = (body && (body.error_description || body.error)) || `HTTP ${res.status}`;
    throw new HttpError(400, `Salesforce rejected the Client ID/Secret: ${reason}`);
  }
  return body;
}

/** Creates a jsforce connection from (decrypted) stored credentials. */
async function buildConnection(creds) {
  if (creds.method === 'client_credentials') {
    const token = await fetchClientCredentialsToken(creds);
    const host = normalizeHost(token.instance_url, 'Instance URL');
    return new jsforce.Connection({ instanceUrl: `https://${host}`, accessToken: token.access_token });
  }
  // access_token and password both end up as a ready-made session
  const host = normalizeHost(creds.instanceUrl, 'Instance URL');
  return new jsforce.Connection({ instanceUrl: `https://${host}`, accessToken: creds.accessToken });
}

async function verify(conn) {
  try {
    const res = await conn.query('SELECT Name FROM Organization LIMIT 1');
    return res.records[0]?.Name || 'Salesforce org';
  } catch (err) {
    throw new HttpError(400, `Connected, but the test query failed: ${err.message}`);
  }
}

/**
 * Validates what the user typed in the UI, proves it works against Salesforce, and returns
 * the credentials to store (encrypted). Passwords are never stored: only the resulting session.
 */
async function connectAndVerify(input) {
  const method = input && input.method;
  let creds;
  let conn;

  try {
    if (method === 'client_credentials') {
      creds = {
        method,
        myDomain: normalizeHost(input.myDomain, 'My Domain URL'),
        clientId: required(input.clientId, 'Client ID'),
        clientSecret: required(input.clientSecret, 'Client Secret'),
      };
      conn = await buildConnection(creds);
    } else if (method === 'access_token') {
      creds = {
        method,
        instanceUrl: `https://${normalizeHost(input.instanceUrl, 'Instance URL')}`,
        accessToken: required(input.accessToken, 'Access token'),
      };
      conn = await buildConnection(creds);
    } else if (method === 'password') {
      const loginHost = normalizeHost(input.loginHost || 'login.salesforce.com', 'Login URL');
      const username = required(input.username, 'Username', 200);
      const password = required(input.password, 'Password', 200);
      const token = String(input.securityToken || '').trim();
      conn = new jsforce.Connection({ loginUrl: `https://${loginHost}` });
      await conn.login(username, password + token);
      const host = normalizeHost(conn.instanceUrl, 'Instance URL');
      creds = { method, instanceUrl: `https://${host}`, accessToken: conn.accessToken, username };
    } else {
      throw new HttpError(400, 'Choose a connection method');
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, `Salesforce rejected these details: ${err.message}`);
  }

  const orgName = await verify(conn);
  return { creds, info: { method, orgName, instanceUrl: conn.instanceUrl } };
}

/* --------------------------- Per-user connections -------------------------- */

const cache = new Map(); // userId -> Promise<Connection>

const invalidate = (userId) => cache.delete(userId);

function getConnection(user) {
  if (!user.connection) {
    throw new HttpError(409, 'Connect your Salesforce org first.', 'NO_CONNECTION');
  }
  let pending = cache.get(user.id);
  if (!pending) {
    pending = buildConnection(decryptJson(user.connection.enc)).catch((err) => {
      cache.delete(user.id);
      throw err;
    });
    cache.set(user.id, pending);
  }
  return pending;
}

/** Runs fn(conn) for this user's org. Client-credential sessions renew themselves. */
async function withSalesforce(user, fn) {
  try {
    return await fn(await getConnection(user));
  } catch (err) {
    if (err.errorCode === 'INVALID_SESSION_ID') {
      invalidate(user.id);
      if (user.connection && user.connection.method === 'client_credentials') {
        return fn(await getConnection(user));
      }
      throw new HttpError(
        409,
        'Your Salesforce session expired. Reconnect to continue.',
        'SF_SESSION_EXPIRED',
      );
    }
    throw err;
  }
}

/* --------------------------------- Queries --------------------------------- */

async function queryAll(conn, soql) {
  let result = await conn.query(soql);
  const records = [...result.records];
  while (!result.done && result.nextRecordsUrl) {
    result = await conn.queryMore(result.nextRecordsUrl);
    records.push(...result.records);
  }
  return records;
}

async function downloadVersionData(conn, versionId) {
  const url = `${conn.instanceUrl}/services/data/v${conn.version}/sobjects/ContentVersion/${versionId}/VersionData`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${conn.accessToken}` },
    redirect: 'error',
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status === 401) {
    const err = new Error('Salesforce session expired');
    err.errorCode = 'INVALID_SESSION_ID';
    throw err;
  }
  if (!res.ok) throw new HttpError(502, `Could not download the certificate (Salesforce ${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}


async function describeObjects(conn) {
  const res = await conn.describeGlobal();
  return (res.sobjects || [])
    .filter((o) => o.queryable && !o.name.endsWith('ChangeEvent') && !o.name.endsWith('History') && !o.name.endsWith('Feed'))
    .map((o) => ({
      name: o.name,
      label: o.label || o.name,
      custom: Boolean(o.custom),
    }))
    .sort((a, b) => (a.label || a.name).localeCompare(b.label || b.name));
}

async function describeFields(conn, objectName) {
  if (!IDENT_RE.test(objectName)) {
    throw new HttpError(400, 'Invalid object name.');
  }
  const meta = await conn.describe(objectName);
  const supportsFiles = meta.childRelationships
    ? meta.childRelationships.some(
        (r) => r.relationshipName === 'ContentDocumentLinks' || r.childSObject === 'ContentDocumentLink'
      )
    : true;

  const fields = (meta.fields || []).map((f) => ({
    name: f.name,
    label: f.label || f.name,
    type: f.type || 'string',
    nameField: Boolean(f.nameField),
  }));

  return {
    label: meta.label || objectName,
    supportsFiles,
    fields,
  };
}

module.exports = {
  IDENT_RE,
  connectAndVerify,
  invalidate,
  withSalesforce,
  queryAll,
  downloadVersionData,
  describeObjects,
  describeFields,
};