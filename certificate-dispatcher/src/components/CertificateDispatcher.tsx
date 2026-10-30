import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { InputHTMLAttributes } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  File as FileIcon,
  FileCheck2,
  FileText,
  FileX2,
  Inbox,
  Loader2,
  MailCheck,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  Users,
  LogOut,
  PenLine,
  Plug,
  Settings as SettingsIcon,
  X,
  XCircle,
} from 'lucide-react';
import { ApiError, api } from '../api.ts';
import type {
  CampaignProgress,
  ConnectionInfo,
  DeliveriesResponse,
  DeliveryCounts,
  DeliveryRecord,
  DeliveryStatus,
  Me,
  PublicSettings,
} from '../api.ts';
import ConnectSalesforce from './ConnectSalesforce.tsx';
import SettingsModal from './SettingsModal.tsx';
import EmailTemplateEditor, { getDefaultTemplate, normalizeTemplate } from './EmailTemplateEditor.tsx';
import type { EmailTemplate } from './EmailTemplateEditor.tsx';
import Footer from './Footer.tsx';

/* -------------------------------------------------------------------------- */
/*                                    Types                                   */
/* -------------------------------------------------------------------------- */

interface ContentDocumentLinkRecord {
  ContentDocumentId: string;
  ContentDocument: {
    Title: string;
    FileExtension: string;
  };
}

interface Student {
  Id: string;
  Name: string;
  Email__c: string;
  College?: string;
  Status?: string;
  ContentDocumentLinks?: { records: ContentDocumentLinkRecord[] } | null;
}

interface Certificate {
  documentId: string;
  fileName: string;
  extension: string;
}

interface StudentRow {
  student: Student;
  certificate: Certificate | null;
}

type FilterValue = 'all' | 'sent' | 'not_sent' | 'failed' | 'bounced' | 'ready' | 'missing';

/* -------------------------------------------------------------------------- */
/*                                   Helpers                                  */
/* -------------------------------------------------------------------------- */

function toRow(student: Student): StudentRow {
  const record = student.ContentDocumentLinks?.records?.[0];
  if (!record) return { student, certificate: null };

  const { Title, FileExtension } = record.ContentDocument;
  const extension = (FileExtension ?? '').toLowerCase();
  return {
    student,
    certificate: {
      documentId: record.ContentDocumentId,
      fileName: extension ? `${Title}.${extension}` : Title,
      extension,
    },
  };
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/* -------------------------------------------------------------------------- */
/*                              Small UI components                           */
/* -------------------------------------------------------------------------- */

function Checkbox({
  indeterminate = false,
  className = '',
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { indeterminate?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <input
      ref={ref}
      type="checkbox"
      className={`h-4 w-4 cursor-pointer rounded border-slate-300 text-indigo-600 focus:ring-2 focus:ring-indigo-500 focus:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
      {...props}
    />
  );
}

interface MetricCardProps {
  label: string;
  value: number;
  icon: React.ReactNode;
  tone: string;
  loading: boolean;
}

function MetricCard({ label, value, icon, tone, loading }: MetricCardProps) {
  return (
    <div className="flex items-center gap-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg ${tone}`}>
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-sm font-medium text-slate-500">{label}</p>
        {loading ? (
          <div className="mt-1.5 h-7 w-14 animate-pulse rounded bg-slate-200" />
        ) : (
          <p className="text-2xl font-semibold tabular-nums text-slate-900">{value}</p>
        )}
      </div>
    </div>
  );
}

function CertificateBadge({ certificate }: { certificate: Certificate | null }) {
  if (!certificate) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md border border-red-200 bg-red-50 px-2.5 py-1 text-xs font-medium text-red-700">
        <FileX2 className="h-3.5 w-3.5" aria-hidden />
        Missing
      </span>
    );
  }

  const isPdf = certificate.extension === 'pdf';
  return (
    <span
      title={certificate.fileName}
      className="inline-flex max-w-[16rem] items-center gap-1.5 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-700"
    >
      {isPdf ? (
        <FileText className="h-3.5 w-3.5 shrink-0 text-red-500" aria-hidden />
      ) : (
        <FileIcon className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
      )}
      <span className="truncate">{certificate.fileName}</span>
    </span>
  );
}

function StatusBadge({ record }: { record?: DeliveryRecord | null }) {
  if (!record || record.status === 'not_sent') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">
        <Clock className="h-3 w-3" />
        Not Sent
      </span>
    );
  }

  switch (record.status) {
    case 'queued':
    case 'sending':
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-700">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          {record.status === 'queued' ? 'Queued' : 'Sending...'}
        </span>
      );
    case 'sent':
      return (
        <span
          title={record.sentAt ? `Accepted by mail server at ${new Date(record.sentAt).toLocaleTimeString()}` : 'Sent'}
          className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700"
        >
          <MailCheck className="h-3.5 w-3.5 text-blue-600" />
          Sent (Accepted)
        </span>
      );
    case 'delivered':
      return (
        <span
          title={record.deliveredAt ? `Delivered at ${new Date(record.deliveredAt).toLocaleTimeString()}` : 'Delivered'}
          className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700"
        >
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
          Delivered
        </span>
      );
    case 'bounced':
      return (
        <span
          title={record.errorMessage || 'Bounced by recipient mail server'}
          className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800"
        >
          <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
          Bounced
        </span>
      );
    case 'failed':
      return (
        <span
          title={record.errorMessage || 'Delivery failed'}
          className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2.5 py-1 text-xs font-medium text-red-700"
        >
          <XCircle className="h-3.5 w-3.5 text-red-600" />
          Failed
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">
          Not Sent
        </span>
      );
  }
}

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 6 }).map((_, i) => (
        <tr key={i} className="border-t border-slate-100">
          <td className="px-4 py-4"><div className="h-4 w-4 animate-pulse rounded bg-slate-200" /></td>
          <td className="px-4 py-4"><div className="h-4 w-36 animate-pulse rounded bg-slate-200" /></td>
          <td className="px-4 py-4"><div className="h-4 w-48 animate-pulse rounded bg-slate-200" /></td>
          <td className="px-4 py-4"><div className="h-6 w-40 animate-pulse rounded bg-slate-200" /></td>
          <td className="px-4 py-4"><div className="h-6 w-24 animate-pulse rounded-full bg-slate-200" /></td>
          <td className="px-4 py-4 text-right"><div className="ml-auto h-8 w-28 animate-pulse rounded-lg bg-slate-200" /></td>
        </tr>
      ))}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*                                  Component                                 */
/* -------------------------------------------------------------------------- */

interface Props {
  me: Me;
  onMeChange: (me: Me) => void;
  onSignOut: () => void;
  onUnauthorized: () => void;
}

export default function CertificateDispatcher({ me, onMeChange, onSignOut, onUnauthorized }: Props) {
  const [students, setStudents] = useState<Student[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadErrorCode, setLoadErrorCode] = useState<string | null>(null);
  const [alertNotice, setAlertNotice] = useState<{ type: 'error' | 'success'; text: string } | null>(null);

  // Deliveries map from NeonDB: studentId -> DeliveryRecord
  const [deliveriesMap, setDeliveriesMap] = useState<Record<string, DeliveryRecord>>({});
  const [counts, setCounts] = useState<DeliveryCounts>({
    total: 0,
    sent: 0,
    failed: 0,
    bounced: 0,
    inProgress: 0,
    notSent: 0,
  });

  // Filter & Search Controls
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<FilterValue>('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Campaign background queue state
  const [activeCampaign, setActiveCampaign] = useState<CampaignProgress | null>(null);
  const [isQueueing, setIsQueueing] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);

  // Modals
  const [template, setTemplate] = useState<EmailTemplate>(getDefaultTemplate);
  const [templateReady, setTemplateReady] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirmAllOpen, setConfirmAllOpen] = useState(false);

  /* ------------------------------ Data loading ----------------------------- */

  const loadDeliveries = useCallback(async () => {
    try {
      const res = await api<DeliveriesResponse>('/api/deliveries?limit=1000');
      const map: Record<string, DeliveryRecord> = {};
      for (const d of res.data) {
        const cur = map[d.studentId];
        const dScore = Math.max(d.updatedAt || 0, d.createdAt || 0);
        const curScore = cur ? Math.max(cur.updatedAt || 0, cur.createdAt || 0) : -1;
        if (!cur || dScore > curScore) {
          map[d.studentId] = d;
        }
      }
      setDeliveriesMap(map);
      setCounts(res.counts);
    } catch (err) {
      console.warn('Could not load deliveries:', err);
    }
  }, []);

  const loadStudents = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setLoadError(null);
      setLoadErrorCode(null);
      try {
        const [sfRes] = await Promise.all([
          api<{ success: true; data: Student[] }>('/api/students', { signal }),
          loadDeliveries(),
        ]);
        setStudents(sfRes.data);

        // Keep selections for students that exist and have certificates
        const selectable = new Set(sfRes.data.filter((st) => toRow(st).certificate).map((st) => st.Id));
        setSelectedIds((prev) => new Set([...prev].filter((id) => selectable.has(id))));
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (err instanceof ApiError && err.status === 401) {
          onUnauthorized();
          return;
        }
        setLoadError(errorMessage(err, 'Could not load students.'));
        setLoadErrorCode(err instanceof ApiError ? (err.code ?? null) : null);
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [onUnauthorized, loadDeliveries],
  );

  const connected = Boolean(me.connection);

  useEffect(() => {
    if (!connected) {
      setStudents([]);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    void loadStudents(controller.signal);
    return () => controller.abort();
  }, [connected, loadStudents]);

  // Load saved email template from server
  useEffect(() => {
    const controller = new AbortController();
    api<{ success: true; template: unknown }>('/api/template', { signal: controller.signal })
      .then((res) => {
        const saved = normalizeTemplate(res.template);
        if (saved) setTemplate(saved);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) onUnauthorized();
      })
      .finally(() => {
        if (!controller.signal.aborted) setTemplateReady(true);
      });
    return () => controller.abort();
  }, [onUnauthorized]);

  // Active campaign progress polling
  useEffect(() => {
    if (
      !activeCampaign ||
      activeCampaign.status === 'completed' ||
      activeCampaign.status === 'partially_failed' ||
      activeCampaign.status === 'failed'
    ) {
      return;
    }

    let isSubscribed = true;

    const poll = async () => {
      try {
        const res = await api<{ success: true; campaign: CampaignProgress }>(
          `/api/campaigns/${activeCampaign.id}/progress`
        );
        if (!isSubscribed) return;

        setActiveCampaign(res.campaign);
        await loadDeliveries();

        if (
          res.campaign.status === 'completed' ||
          res.campaign.status === 'partially_failed' ||
          res.campaign.status === 'failed'
        ) {
          await loadDeliveries();
          setAlertNotice({
            type: res.campaign.failedCount > 0 ? 'error' : 'success',
            text: `Campaign finished: ${res.campaign.sentCount} sent, ${res.campaign.failedCount} failed.`,
          });
        }
      } catch (err) {
        console.error('Error polling campaign progress:', err);
      }
    };

    // Fast initial check (800ms) for snappy feedback on single or small batch sends
    const initialTimer = setTimeout(() => {
      void poll();
    }, 800);

    const interval = setInterval(() => {
      void poll();
    }, 1500);

    return () => {
      isSubscribed = false;
      clearTimeout(initialTimer);
      clearInterval(interval);
    };
  }, [activeCampaign?.id, activeCampaign?.status, loadDeliveries]);

  // Auto-dismiss completed campaign banner after 5 seconds
  useEffect(() => {
    if (!activeCampaign) return;
    const isFinished =
      activeCampaign.status === 'completed' ||
      activeCampaign.status === 'partially_failed' ||
      activeCampaign.status === 'failed';
    if (!isFinished) return;

    const timer = setTimeout(() => {
      setActiveCampaign(null);
    }, 5000);
    return () => clearTimeout(timer);
  }, [activeCampaign?.id, activeCampaign?.status]);

  /* ------------------------------ Derived rows ----------------------------- */

  const rows = useMemo<StudentRow[]>(() => students.map(toRow), [students]);

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(({ student, certificate }) => {
      const del = deliveriesMap[student.Id];
      const status: DeliveryStatus = del ? del.status : 'not_sent';

      // Status filters
      if (filter === 'sent' && status !== 'sent') return false;
      if (filter === 'not_sent' && status !== 'not_sent') return false;
      if (filter === 'failed' && status !== 'failed') return false;
      if (filter === 'bounced' && status !== 'bounced') return false;
      if (filter === 'ready' && (!certificate || status === 'sent')) return false;
      if (filter === 'missing' && certificate) return false;

      // Text search
      if (!q) return true;
      return (
        student.Name?.toLowerCase().includes(q) ||
        student.Email__c?.toLowerCase().includes(q) ||
        student.College?.toLowerCase().includes(q) ||
        student.Id?.toLowerCase().includes(q)
      );
    });
  }, [rows, deliveriesMap, filter, search]);

  // Pagination
  const totalItems = filteredRows.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pagedRows = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return filteredRows.slice(start, start + pageSize);
  }, [filteredRows, currentPage, pageSize]);

  // Selection
  const selectableVisible = useMemo(() => pagedRows.filter((r) => r.certificate), [pagedRows]);
  const selectedVisibleCount = selectableVisible.filter((r) => selectedIds.has(r.student.Id)).length;
  const allVisibleSelected = selectableVisible.length > 0 && selectedVisibleCount === selectableVisible.length;
  const someVisibleSelected = selectedVisibleCount > 0 && !allVisibleSelected;

  const readyToSendAll = useMemo(
    () =>
      rows.filter((r) => {
        const d = deliveriesMap[r.student.Id];
        return (
          r.certificate &&
          (!d || (d.status !== 'sent' && d.status !== 'delivered' && d.status !== 'sending' && d.status !== 'queued'))
        );
      }),
    [rows, deliveriesMap]
  );

  const failedItems = useMemo(
    () =>
      rows.filter((r) => {
        const d = deliveriesMap[r.student.Id];
        return d && (d.status === 'failed' || d.status === 'bounced');
      }),
    [rows, deliveriesMap]
  );

  /* -------------------------------- Actions -------------------------------- */

  const handleManualRefresh = async () => {
    setRefreshing(true);
    await loadDeliveries();
    setRefreshing(false);
  };

  /** Scale to 500 students: queues jobs in NeonDB background worker */
  const queueCampaign = async (targets: StudentRow[]) => {
    if (targets.length === 0) return;
    setIsQueueing(true);
    setAlertNotice(null);

    try {
      const items = targets.map((t) => ({
        studentId: t.student.Id,
        studentName: t.student.Name,
        recipientEmail: t.student.Email__c,
        certificateId: t.certificate?.documentId,
        certificateName: t.certificate?.fileName,
      }));

      const res = await api<{ success: true; campaignId: string; queuedCount: number; message: string }>(
        '/api/campaigns/queue',
        {
          method: 'POST',
          body: {
            name: `Dispatch ${new Date().toLocaleDateString()} (${items.length} students)`,
            subject: template.subject,
            htmlTemplate: template.html,
            items,
          },
        }
      );

      // Start progress tracking
      setActiveCampaign({
        id: res.campaignId,
        name: `Dispatch (${items.length} students)`,
        subject: template.subject,
        totalRecipients: items.length,
        queuedCount: items.length,
        sentCount: 0,
        failedCount: 0,
        bouncedCount: 0,
        status: 'queued',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      setAlertNotice({
        type: 'success',
        text: `Queued ${items.length} certificate(s) for background sending. Background worker is actively dispatching.`,
      });

      // Clear selections for queued students
      setSelectedIds((prev) => {
        const next = new Set(prev);
        targets.forEach((t) => next.delete(t.student.Id));
        return next;
      });

      await loadDeliveries();
    } catch (err) {
      setAlertNotice({
        type: 'error',
        text: errorMessage(err, 'Failed to queue campaign. Please check mail settings.'),
      });
    } finally {
      setIsQueueing(false);
    }
  };

  const handleRetryFailed = async () => {
    setIsRetrying(true);
    try {
      const res = await api<{ success: true; retriedCount: number; message: string }>(
        '/api/deliveries/retry-failed',
        {
          method: 'POST',
          body: {},
        }
      );
      setAlertNotice({
        type: 'success',
        text: res.message,
      });
      await loadDeliveries();
    } catch (err) {
      setAlertNotice({
        type: 'error',
        text: errorMessage(err, 'Could not retry failed emails.'),
      });
    } finally {
      setIsRetrying(false);
    }
  };

  const sendSelected = () => {
    const targets = rows.filter(
      (r) => r.certificate && selectedIds.has(r.student.Id)
    );
    void queueCampaign(targets);
  };

  const sendAll = () => {
    setConfirmAllOpen(false);
    void queueCampaign(readyToSendAll);
  };

  const toggleOne = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleAllVisible = () =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) selectableVisible.forEach((r) => next.delete(r.student.Id));
      else selectableVisible.forEach((r) => next.add(r.student.Id));
      return next;
    });

  const canSend = me.emailConfigured && templateReady;

  const saveTemplate = async (next: EmailTemplate) => {
    setTemplate(next);
    setEditorOpen(false);
    try {
      await api('/api/template', { method: 'PUT', body: { subject: next.subject, blocks: next.blocks, html: next.html } });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onUnauthorized();
      else setAlertNotice({ type: 'error', text: `Failed to save template: ${errorMessage(err, 'unknown error')}` });
    }
  };

  const handleConnected = (connection: ConnectionInfo) => {
    const wasConnected = Boolean(me.connection);
    onMeChange({ ...me, connection });
    setConnectionOpen(false);
    if (wasConnected) void loadStudents();
  };

  const handleDisconnected = () => {
    onMeChange({ ...me, connection: null });
    setConnectionOpen(false);
    setStudents([]);
    setSelectedIds(new Set());
  };

  const handleSettingsSaved = (settings: PublicSettings, emailConfigured: boolean) => {
    const dataSourceChanged =
      settings.studentObject !== me.settings.studentObject || settings.emailField !== me.settings.emailField;
    onMeChange({ ...me, settings, emailConfigured });
    setSettingsOpen(false);
    if (dataSourceChanged && me.connection) void loadStudents();
  };

  /* ---------------------------------- JSX ---------------------------------- */

  const topBar = (
    <div className="border-b border-slate-200 bg-white shadow-xs">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-2.5 sm:px-6 lg:px-8">
        <button
          type="button"
          onClick={() => setConnectionOpen(true)}
          className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-100 cursor-pointer"
        >
          <span className={`h-2 w-2 rounded-full ${me.connection ? 'bg-emerald-500' : 'bg-amber-500'}`} aria-hidden />
          {me.connection ? `Connected: ${me.connection.orgName}` : 'Connect Salesforce'}
          <Plug className="h-3.5 w-3.5 text-slate-400" aria-hidden />
        </button>
        <div className="flex items-center gap-1 sm:gap-2">
          <span className="hidden max-w-[14rem] truncate text-xs text-slate-500 sm:inline">{me.user.email}</span>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100"
          >
            <SettingsIcon className="h-4 w-4" aria-hidden />
            Settings
          </button>
          <button
            type="button"
            onClick={onSignOut}
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100"
          >
            <LogOut className="h-4 w-4" aria-hidden />
            Sign out
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen flex-col bg-slate-50">
      {topBar}

      <div className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6 lg:px-8">
        {/* Header and Bulk Action Buttons */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">Certificate Dispatcher</h1>
            <p className="mt-1 text-sm text-slate-500">
              Reliably dispatch certificates to up to 500 students with persistent NeonDB delivery tracking.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleManualRefresh}
              disabled={refreshing || loading}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50"
              title="Refresh delivery status from NeonDB"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin text-indigo-600' : ''}`} />
              Refresh
            </button>

            <button
              type="button"
              onClick={() => setEditorOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50"
            >
              <PenLine className="h-3.5 w-3.5 text-indigo-600" />
              Edit Template
            </button>

            {failedItems.length > 0 && (
              <button
                type="button"
                onClick={handleRetryFailed}
                disabled={isRetrying || isQueueing || !canSend}
                className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 shadow-sm hover:bg-red-100 disabled:opacity-50"
              >
                <RotateCcw className={`h-3.5 w-3.5 ${isRetrying ? 'animate-spin' : ''}`} />
                Retry {failedItems.length} Failed
              </button>
            )}

            <button
              type="button"
              onClick={sendSelected}
              disabled={selectedIds.size === 0 || isQueueing || !canSend}
              className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              <Send className="h-3.5 w-3.5" />
              Send Selected ({selectedIds.size})
            </button>

            <button
              type="button"
              onClick={() => setConfirmAllOpen(true)}
              disabled={readyToSendAll.length === 0 || isQueueing || !canSend}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              Send All Ready ({readyToSendAll.length})
            </button>
          </div>
        </div>

        {/* Alerts / Progress Banner */}
        <div className="mt-4 space-y-3">
          {activeCampaign && (() => {
            const isFinished =
              activeCampaign.status === 'completed' ||
              activeCampaign.status === 'partially_failed' ||
              activeCampaign.status === 'failed';
            const isSuccess = activeCampaign.status === 'completed' && activeCampaign.failedCount === 0;

            return (
              <div
                className={`rounded-xl border p-4 text-sm transition-all duration-300 ${
                  isSuccess
                    ? 'border-emerald-200 bg-emerald-50/70 text-emerald-950'
                    : isFinished
                    ? 'border-amber-200 bg-amber-50/70 text-amber-950'
                    : 'border-indigo-200 bg-indigo-50/70 text-indigo-950'
                }`}
              >
                <div className="flex items-center justify-between font-medium">
                  <span className="inline-flex items-center gap-2">
                    {isFinished ? (
                      isSuccess ? (
                        <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                      ) : (
                        <AlertTriangle className="h-4 w-4 text-amber-600" />
                      )
                    ) : (
                      <Loader2 className="h-4 w-4 animate-spin text-indigo-600" />
                    )}
                    {isFinished
                      ? isSuccess
                        ? `Dispatch Finished: ${activeCampaign.name}`
                        : `Dispatch Finished with Issues: ${activeCampaign.name}`
                      : `Background Dispatching Campaign: ${activeCampaign.name}`}
                  </span>
                  <div className="flex items-center gap-3">
                    <span className="tabular-nums font-semibold">
                      {activeCampaign.sentCount} / {activeCampaign.totalRecipients} processed
                    </span>
                    <button
                      type="button"
                      onClick={() => setActiveCampaign(null)}
                      className="rounded-md p-1 text-slate-400 hover:bg-black/5 hover:text-slate-600 transition cursor-pointer"
                      title="Dismiss banner"
                      aria-label="Dismiss banner"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                </div>
                <div
                  className={`mt-2 h-2.5 overflow-hidden rounded-full ${
                    isSuccess ? 'bg-emerald-100' : isFinished ? 'bg-amber-100' : 'bg-indigo-100'
                  }`}
                >
                  <div
                    className={`h-full rounded-full transition-all duration-300 ${
                      isSuccess ? 'bg-emerald-600' : isFinished ? 'bg-amber-600' : 'bg-indigo-600'
                    }`}
                    style={{
                      width: `${Math.min(
                        100,
                        ((activeCampaign.sentCount + activeCampaign.failedCount) /
                          Math.max(1, activeCampaign.totalRecipients)) *
                          100
                      )}%`,
                    }}
                  />
                </div>
                <div
                  className={`mt-2 flex flex-wrap gap-4 text-xs ${
                    isSuccess ? 'text-emerald-800' : isFinished ? 'text-amber-800' : 'text-indigo-800'
                  }`}
                >
                  <span>Sent: {activeCampaign.sentCount}</span>
                  <span>Queued: {activeCampaign.queuedCount}</span>
                  {activeCampaign.failedCount > 0 && (
                    <span className="font-semibold text-red-600">Failed: {activeCampaign.failedCount}</span>
                  )}
                </div>
              </div>
            );
          })()}

          {alertNotice && (
            <div
              className={`flex items-start gap-3 rounded-xl border p-4 text-sm ${
                alertNotice.type === 'error'
                  ? 'border-red-200 bg-red-50 text-red-800'
                  : 'border-emerald-200 bg-emerald-50 text-emerald-800'
              }`}
            >
              <div className="flex-1">{alertNotice.text}</div>
              <button
                type="button"
                onClick={() => setAlertNotice(null)}
                className="rounded-md p-1 text-slate-500 hover:bg-slate-200/50"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}

          {loadError && (
            <div role="alert" className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="flex-1">
                <p className="font-medium">Couldn’t load students</p>
                <p className="mt-0.5 text-red-700">{loadError}</p>
              </div>
              <button
                type="button"
                onClick={() =>
                  loadErrorCode === 'NO_CONNECTION' || loadErrorCode === 'SF_SESSION_EXPIRED'
                    ? setConnectionOpen(true)
                    : void loadStudents()
                }
                className="rounded-md px-2 py-1 text-xs font-semibold text-red-800 underline hover:no-underline"
              >
                {loadErrorCode === 'NO_CONNECTION' || loadErrorCode === 'SF_SESSION_EXPIRED' ? 'Reconnect' : 'Try again'}
              </button>
            </div>
          )}
        </div>

        {/* KPI Cards */}
        <section className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4" aria-label="Key metrics">
          <MetricCard
            label="Total Students"
            value={students.length}
            loading={loading && students.length === 0}
            tone="bg-slate-100 text-slate-600"
            icon={<Users className="h-5 w-5" />}
          />
          <MetricCard
            label="Certificates Ready"
            value={readyToSendAll.length}
            loading={loading && students.length === 0}
            tone="bg-indigo-50 text-indigo-600"
            icon={<FileCheck2 className="h-5 w-5" />}
          />
          <MetricCard
            label="Sent"
            value={counts.sent}
            loading={false}
            tone="bg-blue-50 text-blue-600"
            icon={<MailCheck className="h-5 w-5" />}
          />
        </section>

        {/* Filter Tabs & Search Controls */}
        <section className="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          {/* Status Filter Tabs */}
          <div className="border-b border-slate-200 bg-slate-50/60 px-4 pt-3">
            <div className="flex flex-wrap gap-2 text-xs font-medium">
              {[
                { id: 'all', label: 'All', count: students.length },
                { id: 'sent', label: 'Sent', count: counts.sent },
                { id: 'not_sent', label: 'Not Sent', count: counts.notSent },
                { id: 'failed', label: 'Failed', count: counts.failed },
                { id: 'bounced', label: 'Bounced', count: counts.bounced },
                { id: 'ready', label: 'Ready to Send', count: readyToSendAll.length },
                { id: 'missing', label: 'Missing Certificate', count: rows.filter((r) => !r.certificate).length },
              ].map((tab) => {
                const active = filter === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => {
                      setFilter(tab.id as FilterValue);
                      setPage(1);
                    }}
                    className={`inline-flex items-center gap-1.5 border-b-2 px-3 py-2 transition-colors ${
                      active
                        ? 'border-indigo-600 font-semibold text-indigo-700'
                        : 'border-transparent text-slate-600 hover:border-slate-300 hover:text-slate-900'
                    }`}
                  >
                    {tab.label}
                    <span
                      className={`rounded-full px-1.5 py-0.5 text-[11px] tabular-nums ${
                        active ? 'bg-indigo-100 text-indigo-700' : 'bg-slate-200 text-slate-600'
                      }`}
                    >
                      {tab.count}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Search & Page Size Bar */}
          <div className="flex flex-col gap-3 border-b border-slate-200 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative w-full sm:max-w-md">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="search"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
                placeholder="Search by student name, email, or ID..."
                className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
              />
            </div>

            <div className="flex items-center justify-end gap-3 text-xs text-slate-600">
              <span>Show per page:</span>
              <select
                value={pageSize}
                onChange={(e) => {
                  setPageSize(Number(e.target.value));
                  setPage(1);
                }}
                className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 focus:border-indigo-500 focus:outline-none"
              >
                <option value={10}>10</option>
                <option value={25}>25</option>
                <option value={50}>50</option>
                <option value={100}>100</option>
              </select>
            </div>
          </div>

          {/* Students Table */}
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs font-semibold text-slate-500">
                <tr>
                  <th scope="col" className="w-12 px-4 py-3">
                    <Checkbox
                      checked={allVisibleSelected}
                      indeterminate={someVisibleSelected}
                      onChange={toggleAllVisible}
                      disabled={loading || selectableVisible.length === 0}
                      aria-label="Select visible students"
                    />
                  </th>
                  <th scope="col" className="px-4 py-3">Student Name</th>
                  <th scope="col" className="px-4 py-3">Email Address</th>
                  <th scope="col" className="px-4 py-3">Certificate</th>
                  <th scope="col" className="px-4 py-3">Delivery Status (NeonDB)</th>
                  <th scope="col" className="px-4 py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {loading && students.length === 0 ? (
                  <SkeletonRows />
                ) : pagedRows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-16 text-center">
                      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-400">
                        <Inbox className="h-6 w-6" />
                      </div>
                      <p className="mt-3 text-sm font-medium text-slate-900">No matching records found</p>
                      <p className="mt-1 text-sm text-slate-500">
                        Try resetting your search or filter criteria.
                      </p>
                      {(search || filter !== 'all') && (
                        <button
                          type="button"
                          onClick={() => {
                            setSearch('');
                            setFilter('all');
                            setPage(1);
                          }}
                          className="mt-4 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50"
                        >
                          Clear filters
                        </button>
                      )}
                    </td>
                  </tr>
                ) : (
                  pagedRows.map(({ student, certificate }) => {
                    const record = deliveriesMap[student.Id];
                    const isSelected = selectedIds.has(student.Id);
                    const isQueuedOrSending = record?.status === 'queued' || record?.status === 'sending';

                    return (
                      <tr
                        key={student.Id}
                        className={`transition-colors ${
                          isSelected ? 'bg-indigo-50/50' : 'hover:bg-slate-50/70'
                        }`}
                      >
                        <td className="px-4 py-3.5">
                          <Checkbox
                            checked={isSelected}
                            onChange={() => toggleOne(student.Id)}
                            disabled={!certificate || isQueuedOrSending}
                            aria-label={`Select ${student.Name}`}
                          />
                        </td>
                        <td className="whitespace-nowrap px-4 py-3.5 font-medium text-slate-900">
                          <div>{student.Name}</div>
                          {student.College && <div className="text-xs font-normal text-slate-500">{student.College}</div>}
                        </td>
                        <td className="px-4 py-3.5 text-slate-600">{student.Email__c}</td>
                        <td className="px-4 py-3.5">
                          <CertificateBadge certificate={certificate} />
                        </td>
                        <td className="px-4 py-3.5">
                          <StatusBadge record={record} />
                          {record?.errorMessage && (
                            <p className="mt-1 max-w-[14rem] truncate text-xs text-red-600" title={record.errorMessage}>
                              {record.errorMessage}
                            </p>
                          )}
                        </td>
                        <td className="px-4 py-3.5 text-right">
                          <button
                            type="button"
                            onClick={() => certificate && void queueCampaign([{ student, certificate }])}
                            disabled={!certificate || isQueuedOrSending || !canSend}
                            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium shadow-xs transition ${
                              record?.status === 'sent'
                                ? 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                                : record?.status === 'failed' || record?.status === 'bounced'
                                ? 'border border-red-200 bg-red-50 text-red-700 hover:bg-red-100'
                                : 'bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-slate-200 disabled:text-slate-400'
                            }`}
                          >
                            <Send className="h-3 w-3" />
                            {record?.status === 'sent'
                              ? 'Resend'
                              : record?.status === 'failed' || record?.status === 'bounced'
                              ? 'Retry'
                              : 'Send'}
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Table Pagination Bar */}
          <div className="flex flex-col items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-500 sm:flex-row">
            <div>
              Showing {totalItems === 0 ? 0 : (currentPage - 1) * pageSize + 1} to{' '}
              {Math.min(currentPage * pageSize, totalItems)} of {totalItems} students
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={currentPage <= 1}
                className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 font-medium text-slate-700 shadow-xs hover:bg-slate-50 disabled:opacity-40"
              >
                <ChevronLeft className="h-4 w-4" />
                Previous
              </button>
              <span className="px-2 font-medium">
                Page {currentPage} of {totalPages}
              </span>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={currentPage >= totalPages}
                className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 font-medium text-slate-700 shadow-xs hover:bg-slate-50 disabled:opacity-40"
              >
                Next
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        </section>
      </div>

      {/* Confirmation Modal */}
      {confirmAllOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-xs">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <h3 className="text-lg font-bold text-slate-900">Dispatch Certificates to All Students</h3>
            <p className="mt-2 text-sm text-slate-600">
              Are you sure you want to queue background sending for{' '}
              <strong className="text-slate-900">{readyToSendAll.length} students</strong>?
            </p>
            <p className="mt-2 text-xs text-slate-500">
              The jobs will be processed safely in the background with rate limiting. You can monitor live progress on this screen.
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setConfirmAllOpen(false)}
                className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={sendAll}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700"
              >
                Start Dispatching
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Template Editor Modal */}
      {editorOpen && (
        <EmailTemplateEditor
          initial={template}
          sample={{
            studentName: rows[0]?.student.Name || 'Student Name',
            studentEmail: rows[0]?.student.Email__c || 'student@example.com',
            fileName: rows[0]?.certificate?.fileName || 'Certificate.pdf',
          }}
          logoUrl={me.settings.logoUrl || ''}
          companyName={me.settings.fromName || 'Institution'}
          hrName={me.settings.hrName || 'Coordinator'}
          onSave={saveTemplate}
          onClose={() => setEditorOpen(false)}
        />
      )}

      {/* Salesforce Connection Modal */}
      {connectionOpen && (
        <ConnectSalesforce
          current={me.connection}
          onConnected={handleConnected}
          onDisconnected={handleDisconnected}
          onUnauthorized={onUnauthorized}
          onClose={() => setConnectionOpen(false)}
        />
      )}

      {/* Settings Modal */}
      {settingsOpen && (
        <SettingsModal
          settings={me.settings}
          onSaved={handleSettingsSaved}
          onUnauthorized={onUnauthorized}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {/* Required Footer Branding */}
      <Footer />
    </div>
  );
}
