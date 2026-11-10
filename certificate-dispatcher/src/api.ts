/** Where the Node server runs. Override with VITE_API_URL in a .env file for deployments. */
const rawApiBase: string =
  (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3000';
export const API_BASE: string = rawApiBase.replace(/\/+$/, '');

export type ConnectMethod = 'client_credentials' | 'access_token';

export interface ConnectionInfo {
  method: ConnectMethod;
  orgName: string;
  instanceUrl: string;
}

export interface QuotaInfo {
  limit: number;
  used: number;
  resetsAt: number | null;
}

export interface PublicSettings {
  fromName: string;
  hrName: string;
  smtpUser: string;
  fromEmail: string;
  dailyLimit: number;
  smtpHost: string;
  smtpPort: number;
  hasSmtpPassword: boolean;
  cc: string;
  replyTo: string;
  logoUrl: string;
  studentObject?: string;
  emailField?: string;
  nameField?: string;
  collegeField?: string;
  statusField?: string;
  dataSourceSet?: boolean;
  emailProvider?: 'brevo_api' | 'smtp';
  hasBrevoApiKey?: boolean;
}

export interface Me {
  user: { id: string; email: string; name: string };
  connection: ConnectionInfo | null;
  emailConfigured: boolean;
  settings: PublicSettings;
  quota?: QuotaInfo;
}

export interface SalesforceObject {
  name: string;
  label: string;
  custom: boolean;
}

export interface SalesforceField {
  name: string;
  label: string;
  type: string;
  nameField: boolean;
}

export interface DescribeFieldsResponse {
  label: string;
  supportsFiles: boolean;
  fields: SalesforceField[];
}

export interface ContentDocument {
  Title: string;
  FileExtension: string;
}

export interface ContentDocumentLink {
  ContentDocumentId: string;
  ContentDocument: ContentDocument;
}

export interface Student {
  Id: string;
  Name: string;
  Email__c: string;
  College?: string;
  Status?: string;
  SentAt?: number | null;
  ContentDocumentLinks?: {
    records: ContentDocumentLink[];
  };
}

export type DeliveryStatus =
  | 'not_sent'
  | 'queued'
  | 'sending'
  | 'sent'
  | 'delivered'
  | 'failed'
  | 'bounced';

export interface DeliveryRecord {
  id: string;
  userId: string;
  campaignId?: string | null;
  studentId: string;
  studentName: string;
  recipientEmail: string;
  certificateId?: string | null;
  certificateName?: string | null;
  subject?: string;
  status: DeliveryStatus;
  providerMessageId?: string | null;
  attempts: number;
  maxAttempts: number;
  errorMessage?: string | null;
  lastErrorAt?: number | null;
  queuedAt?: number | null;
  sentAt?: number | null;
  deliveredAt?: number | null;
  failedAt?: number | null;
  bouncedAt?: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface DeliveryCounts {
  total: number;
  sent: number;
  failed: number;
  bounced: number;
  inProgress: number;
  notSent: number;
}

export interface PaginationInfo {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface DeliveriesResponse {
  success: true;
  data: DeliveryRecord[];
  pagination: PaginationInfo;
  counts: DeliveryCounts;
}

export type CampaignStatus =
  | 'draft'
  | 'running'
  | 'paused'
  | 'paused_limit'
  | 'paused_throttled'
  | 'paused_auth'
  | 'paused_salesforce'
  | 'completed'
  | 'cancelled'
  | 'failed';

export interface CampaignCounts {
  total: number;
  willSend?: number;
  pending: number;
  sending: number;
  sent: number;
  failed: number;
  uncertain: number;
  skipped: number;
  cancelled: number;
}

export interface StepTiming {
  avgMs: number;
  p95Ms: number;
}

export interface TimingSummary {
  totalTimeMs: number;
  emailsPerMin: number;
  steps: {
    claim: StepTiming;
    fileDownload: StepTiming;
    smtpConnect: StepTiming;
    smtpSend: StepTiming;
    dbWrite: StepTiming;
  };
  timings?: Array<{
    claimMs: number;
    fileDownloadMs: number;
    smtpConnectMs: number;
    smtpSendMs: number;
    dbWriteMs: number;
  }>;
}

export interface CampaignV2 {
  id: string;
  userId: string;
  name: string;
  subject: string;
  templateHtml: string;
  status: CampaignStatus;
  pauseReason?: string | null;
  resumeAt?: number | null;
  createdAt: number;
  startedAt?: number | null;
  finishedAt?: number | null;
  counts?: CampaignCounts;
  sendLanes?: number;
  timingSummary?: TimingSummary | null;
}

export interface JobEvent {
  id: number;
  campaignId: string;
  jobId: string;
  studentName: string;
  studentEmail: string;
  type:
    | 'queued'
    | 'sending'
    | 'sent'
    | 'retry_scheduled'
    | 'failed'
    | 'uncertain'
    | 'throttled'
    | 'paused'
    | 'resumed'
    | 'cancelled'
    | 'completed'
    | 'skipped'
    | 'auth_error';
  message: string;
  createdAt: string;
}

export interface EventsSummary {
  sent: number;
  failed: number;
  uncertain: number;
  skipped: number;
  sending: number;
  pending: number;
  total: number;
  status: CampaignStatus;
  pause_reason?: string | null;
  resume_at?: number | null;
  elapsed_ms: number;
  emails_per_min: number;
  timing_summary?: TimingSummary | null;
}

export interface CampaignEventsResponse {
  success: true;
  events: JobEvent[];
  nextCursor: number;
  summary: EventsSummary;
}

export interface QueueItem {
  position: number;
  id: string;
  campaignId: string;
  studentId: string;
  studentName: string;
  studentEmail: string;
  status: JobStatus;
  attempts: number;
  lastError?: string | null;
  nextAttemptAt?: number | null;
}

export interface CampaignQueueResponse {
  success: true;
  queue: QueueItem[];
  total: number;
  offset: number;
  limit: number;
}

export type JobStatus =
  | 'pending'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'uncertain'
  | 'skipped'
  | 'cancelled';

export interface CampaignJob {
  id: string;
  campaignId: string;
  userId: string;
  studentId: string;
  studentName: string;
  studentEmail: string;
  contentDocumentId?: string | null;
  contentVersionId?: string | null;
  fileName?: string | null;
  status: JobStatus;
  attempts: number;
  lastError?: string | null;
  smtpMessageId?: string | null;
  sentAt?: number | null;
  nextAttemptAt?: number | null;
  updatedAt: number;
}

export interface CreateCampaignReviewResponse {
  success: true;
  campaignId: string;
  campaign: CampaignV2;
  counts: {
    total: number;
    willSend: number;
    skipped: {
      noFile: number;
      invalidEmail: number;
      alreadySent: number;
      total: number;
    };
  };
  recipientsPerEmail: number;
  dailyLimitRemaining: number;
  estimatedDurationSeconds: number;
}

export interface ProcessCampaignResponse {
  success: true;
  campaign: CampaignV2;
  counts: CampaignCounts;
  processed: number;
  remaining: number;
  message?: string;
}

export interface CampaignProgress {
  id: string;
  name: string;
  subject: string;
  totalRecipients: number;
  queuedCount: number;
  sentCount: number;
  failedCount: number;
  bouncedCount: number;
  status: 'draft' | 'queued' | 'running' | 'completed' | 'partially_failed' | 'failed' | 'cancelled';
  createdAt: number;
  updatedAt: number;
}

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const TOKEN_KEY = 'cd_session_token';

export function getSessionToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setSessionToken(token: string | null): void {
  try {
    if (token) {
      localStorage.setItem(TOKEN_KEY, token);
    } else {
      localStorage.removeItem(TOKEN_KEY);
    }
  } catch {
    // ignore
  }
}

interface Options {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

/** fetch wrapper: sends login cookie & bearer token, parses JSON and throws ApiError with a readable message. */
export async function api<T = { success: true }>(path: string, options: Options = {}): Promise<T> {
  const { method = 'GET', body, signal, headers: customHeaders } = options;

  const reqHeaders: Record<string, string> = { ...customHeaders };
  if (body !== undefined) {
    reqHeaders['Content-Type'] = 'application/json';
  }

  const token = getSessionToken();
  if (token) {
    reqHeaders['Authorization'] = `Bearer ${token}`;
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      credentials: 'include',
      headers: reqHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, `Cannot reach the server at ${API_BASE}. Is it running?`);
  }

  const data = (await res.json().catch(() => null)) as
    | ({ success?: boolean; error?: string; code?: string; token?: string } & Record<string, unknown>)
    | null;

  // Persist session token if returned by the server
  if (data && typeof data === 'object' && typeof data.token === 'string') {
    setSessionToken(data.token);
  }

  if (res.status === 401) {
    setSessionToken(null);
  }

  if (!res.ok || !data || data.success === false) {
    throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`, data?.code);
  }
  return data as T;
}

export const errorText = (err: unknown, fallback = 'Something went wrong.') =>
  err instanceof Error && err.message ? err.message : fallback;
