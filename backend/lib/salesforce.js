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
  if (creds.method === 'access_token') {
    const host = normalizeHost(creds.instanceUrl, 'Instance URL');
    return new jsforce.Connection({ instanceUrl: `https://${host}`, accessToken: creds.accessToken });
  }
  throw new HttpError(400, 'Invalid or unsupported connection method');
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
 * the credentials to store (encrypted).
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
    } else {
      throw new HttpError(400, 'Choose a valid connection method (Client ID & Secret or Access token)');
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
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 401) {
    const err = new Error('Salesforce session expired');
    err.errorCode = 'INVALID_SESSION_ID';
    throw err;
  }
  if (!res.ok) throw new HttpError(502, `Could not download the certificate (Salesforce ${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Downloads the certificate binary and metadata given either a ContentVersionId (068) or ContentDocumentId (069).
 */
async function downloadCertificateFile(conn, certificateId) {
  if (!certificateId) {
    throw new HttpError(400, 'Certificate ID is required to download');
  }

  let versionId = certificateId;
  let fileName = 'certificate.pdf';

  if (certificateId.startsWith('069')) {
    const res = await conn.query(
      `SELECT Id, Title, FileExtension FROM ContentVersion WHERE ContentDocumentId = '${certificateId}' AND IsLatest = true LIMIT 1`
    );
    if (!res.records || res.records.length === 0) {
      throw new HttpError(404, 'No file version found in Salesforce for this certificate document.');
    }
    versionId = res.records[0].Id;
    const ext = (res.records[0].FileExtension || '').toLowerCase();
    fileName = ext ? `${res.records[0].Title}.${ext}` : res.records[0].Title;
  } else if (certificateId.startsWith('068')) {
    try {
      const res = await conn.query(
        `SELECT Id, Title, FileExtension FROM ContentVersion WHERE Id = '${certificateId}' LIMIT 1`
      );
      if (res.records && res.records.length > 0) {
        const ext = (res.records[0].FileExtension || '').toLowerCase();
        fileName = ext ? `${res.records[0].Title}.${ext}` : res.records[0].Title;
      }
    } catch (_) {}
  }

  const buffer = await downloadVersionData(conn, versionId);
  return { buffer, fileName, versionId };
}

async function describeObjects(conn) {
  const res = await conn.describeGlobal();
  const noisySuffixes = ['Share', 'History', 'Feed', 'ChangeEvent', 'Tag', 'Vote'];
  return (res.sobjects || [])
    .filter((o) => {
      if (!o.queryable) return false;
      for (const suffix of noisySuffixes) {
        if (o.name.endsWith(suffix)) return false;
      }
      return true;
    })
    .map((o) => ({
      name: o.name,
      label: o.label || o.name,
      custom: Boolean(o.custom),
    }))
    .sort((a, b) => {
      if (a.custom !== b.custom) return a.custom ? -1 : 1;
      return (a.label || a.name).localeCompare(b.label || b.name);
    });
}

async function describeFields(conn, objectName) {
  if (!IDENT_RE.test(objectName)) {
    throw new HttpError(400, 'Invalid object name.');
  }
  const meta = await conn.describe(objectName);
  const supportsFiles = Boolean(
    meta.childRelationships &&
    meta.childRelationships.some(
      (r) => r.relationshipName === 'ContentDocumentLinks' || r.childSObject === 'ContentDocumentLink'
    )
  );

  const allowedTypes = new Set(['string', 'email', 'picklist', 'phone', 'textarea', 'url', 'combobox']);

  const fields = (meta.fields || [])
    .filter((f) => allowedTypes.has((f.type || '').toLowerCase()))
    .map((f) => ({
      name: f.name,
      label: f.label || f.name,
      type: (f.type || 'string').toLowerCase(),
      nameField: Boolean(f.nameField || f.name === 'Name'),
    }));

  return {
    label: meta.label || objectName,
    supportsFiles,
    fields,
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Bulk resolve students and their attached ContentVersion files in chunks of 150 IDs.
 * Never executes per-email queries.
 */
async function bulkResolveStudentsAndFiles(conn, {
  studentIds = null,
  studentObject,
  nameField = 'Name',
  emailField,
  collegeField = null,
  statusField = null,
}) {
  const isAll = !Array.isArray(studentIds) || studentIds.length === 0;

  // 1. Query students
  const selectCols = ['Id'];
  if (!selectCols.includes(nameField)) selectCols.push(nameField);
  if (!selectCols.includes(emailField)) selectCols.push(emailField);
  if (collegeField && !selectCols.includes(collegeField)) selectCols.push(collegeField);
  if (statusField && !selectCols.includes(statusField)) selectCols.push(statusField);

  let studentRecords = [];
  if (isAll) {
    const soql = `SELECT ${selectCols.join(', ')} FROM ${studentObject} WHERE ${emailField} != null ORDER BY ${nameField}`;
    studentRecords = await queryAll(conn, soql);
  } else {
    const CHUNK_SIZE = 150;
    const studentQueries = [];
    for (let i = 0; i < studentIds.length; i += CHUNK_SIZE) {
      const chunk = studentIds.slice(i, i + CHUNK_SIZE);
      const inClause = chunk.map((id) => `'${String(id).replace(/'/g, "\\'")}'`).join(', ');
      const soql = `SELECT ${selectCols.join(', ')} FROM ${studentObject} WHERE Id IN (${inClause})`;
      studentQueries.push(queryAll(conn, soql));
    }
    const chunkResults = await Promise.all(studentQueries);
    for (const chunkRecords of chunkResults) {
      studentRecords.push(...chunkRecords);
    }
  }

  if (studentRecords.length === 0) return [];

  const allStudentIds = studentRecords.map((r) => r.Id);

  // 2. Query ContentDocumentLinks in chunks of 150 in parallel
  const CHUNK_SIZE = 150;
  const studentToDocMap = new Map();
  const linkQueries = [];

  for (let i = 0; i < allStudentIds.length; i += CHUNK_SIZE) {
    const chunk = allStudentIds.slice(i, i + CHUNK_SIZE);
    const inClause = chunk.map((id) => `'${String(id).replace(/'/g, "\\'")}'`).join(', ');
    const soql = `SELECT ContentDocumentId, LinkedEntityId FROM ContentDocumentLink WHERE LinkedEntityId IN (${inClause})`;
    linkQueries.push(queryAll(conn, soql));
  }
  const linkResults = await Promise.all(linkQueries);
  for (const linkRecords of linkResults) {
    for (const link of linkRecords) {
      if (!studentToDocMap.has(link.LinkedEntityId)) {
        studentToDocMap.set(link.LinkedEntityId, link.ContentDocumentId);
      }
    }
  }

  // 3. Query ContentVersion for all discovered ContentDocumentIds in chunks of 150 in parallel
  const uniqueDocIds = Array.from(new Set(studentToDocMap.values()));
  const docToVersionMap = new Map();
  const versionQueries = [];

  for (let i = 0; i < uniqueDocIds.length; i += CHUNK_SIZE) {
    const chunk = uniqueDocIds.slice(i, i + CHUNK_SIZE);
    const inClause = chunk.map((id) => `'${String(id).replace(/'/g, "\\'")}'`).join(', ');
    const soql = `SELECT Id, ContentDocumentId, Title, FileExtension, IsLatest FROM ContentVersion WHERE ContentDocumentId IN (${inClause}) AND IsLatest = true`;
    versionQueries.push(queryAll(conn, soql));
  }
  const versionResults = await Promise.all(versionQueries);
  for (const versionRecords of versionResults) {
    for (const cv of versionRecords) {
      const ext = (cv.FileExtension || '').toLowerCase();
      const fileName = ext ? `${cv.Title}.${ext}` : cv.Title;
      docToVersionMap.set(cv.ContentDocumentId, {
        versionId: cv.Id,
        title: cv.Title,
        extension: ext,
        fileName,
      });
    }
  }

  // 4. Assemble resolved student items
  const results = [];
  for (const s of studentRecords) {
    const studentId = s.Id;
    const studentName = String(s[nameField] || '').trim();
    const studentEmail = String(s[emailField] || '').trim();
    const college = collegeField ? String(s[collegeField] || '') : '';
    const status = statusField ? String(s[statusField] || '') : '';

    let skippedReason = null;
    if (!studentEmail || !EMAIL_RE.test(studentEmail)) {
      skippedReason = 'invalid_email';
    }

    const docId = studentToDocMap.get(studentId);
    const versionInfo = docId ? docToVersionMap.get(docId) : null;

    if (!skippedReason && (!docId || !versionInfo)) {
      skippedReason = 'no_file';
    }

    results.push({
      studentId,
      studentName,
      studentEmail,
      college,
      status,
      contentDocumentId: docId || null,
      contentVersionId: versionInfo ? versionInfo.versionId : null,
      fileName: versionInfo ? versionInfo.fileName : null,
      skippedReason,
    });
  }

  return results;
}

module.exports = {
  IDENT_RE,
  connectAndVerify,
  invalidate,
  withSalesforce,
  queryAll,
  downloadVersionData,
  downloadCertificateFile,
  describeObjects,
  describeFields,
  bulkResolveStudentsAndFiles,
};
