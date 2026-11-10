import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import {
  Activity,
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Download,
  FileCheck2,
  Gauge,
  HelpCircle,
  Layers,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  Search,
  ShieldAlert,
  Timer,
  XCircle,
  Zap,
} from 'lucide-react';
import { api, errorText, API_BASE, getSessionToken } from '../api.ts';
import type {
  CampaignCounts,
  CampaignJob,
  CampaignStatus,
  CampaignV2,
  ProcessCampaignResponse,
  JobEvent,
  EventsSummary,
  CampaignEventsResponse,
  QueueItem,
  CampaignQueueResponse,
} from '../api.ts';

interface Props {
  initialCampaign: CampaignV2;
  onBackToStudents: () => void;
  onOpenSettings?: () => void;
}

function formatDuration(ms: number): string {
  if (ms <= 0) return '0s';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMins = minutes % 60;
  if (hours === 0) return `${minutes}m ${seconds}s`;
  return `${hours}h ${remainingMins}m ${seconds}s`;
}

function formatCountdown(targetMs: number): string {
  const diff = targetMs - Date.now();
  if (diff <= 0) return '0s';
  const totalSeconds = Math.ceil(diff / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m ${seconds}s`;
}

function formatTime(isoStr: string): string {
  try {
    const d = new Date(isoStr);
    return d.toTimeString().split(' ')[0] || isoStr;
  } catch {
    return isoStr;
  }
}

export default function CampaignRunningView({ initialCampaign, onBackToStudents, onOpenSettings }: Props) {
  const [campaign, setCampaign] = useState<CampaignV2>(initialCampaign);
  const [counts, setCounts] = useState<CampaignCounts>(
    initialCampaign.counts || {
      total: 0,
      pending: 0,
      sending: 0,
      sent: 0,
      failed: 0,
      uncertain: 0,
      skipped: 0,
      cancelled: 0,
    }
  );
  const [jobs, setJobs] = useState<CampaignJob[]>([]);
  const [loadingJobs, setLoadingJobs] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  // Live Activity Log state
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [lastEventId, setLastEventId] = useState<number>(0);
  const [activityFilter, setActivityFilter] = useState<'all' | 'sent' | 'failed' | 'waiting'>('all');
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const logContainerRef = useRef<HTMLDivElement | null>(null);

  // Summary and live metrics
  const [summary, setSummary] = useState<EventsSummary | null>(null);
  const [lastEventReceivedAt, setLastEventReceivedAt] = useState<number>(Date.now());
  const [stallWarning, setStallWarning] = useState<boolean>(false);

  // Up Next Queue state
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [queueTotal, setQueueTotal] = useState<number>(0);
  const [queueSearch, setQueueSearch] = useState<string>('');
  const [queueExpanded, setQueueExpanded] = useState<boolean>(true);
  const [queueLoading, setQueueLoading] = useState<boolean>(false);

  // Actions and notices
  const [actionBusy, setActionBusy] = useState(false);
  const [alertNotice, setAlertNotice] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [countdownText, setCountdownText] = useState<string>('');

  // Refs for background loop
  const campaignRef = useRef(campaign);
  campaignRef.current = campaign;
  const isLoopRunningRef = useRef(false);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

  // Screen Wake Lock API
  const requestWakeLock = useCallback(async () => {
    try {
      if ('wakeLock' in navigator && !wakeLockRef.current) {
        wakeLockRef.current = await navigator.wakeLock.request('screen');
      }
    } catch {
      // ignore
    }
  }, []);

  const releaseWakeLock = useCallback(async () => {
    try {
      if (wakeLockRef.current) {
        await wakeLockRef.current.release();
        wakeLockRef.current = null;
      }
    } catch {
      // ignore
    }
  }, []);

  // Load jobs list
  const loadJobs = useCallback(async (cId: string) => {
    setLoadingJobs(true);
    try {
      const res = await api<{ success: true; campaign: CampaignV2; counts: CampaignCounts; jobs: CampaignJob[] }>(
        `/api/campaigns/${cId}`
      );
      setCampaign(res.campaign);
      setCounts(res.counts);
      setJobs(res.jobs || []);
    } catch (err) {
      console.warn('Could not load campaign jobs:', err);
    } finally {
      setLoadingJobs(false);
    }
  }, []);

  // Load "Up Next" Queue
  const loadQueue = useCallback(async (cId: string, qSearch = '') => {
    setQueueLoading(true);
    try {
      const q = qSearch ? `&search=${encodeURIComponent(qSearch)}` : '';
      const res = await api<CampaignQueueResponse>(`/api/campaigns/${cId}/queue?status=pending&limit=20${q}`);
      setQueue(res.queue || []);
      setQueueTotal(res.total || 0);
    } catch (err) {
      console.warn('Could not load queue:', err);
    } finally {
      setQueueLoading(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    void loadJobs(initialCampaign.id);
    void loadQueue(initialCampaign.id);
  }, [initialCampaign.id, loadJobs, loadQueue]);

  // Tab visibility tracker
  const [isTabVisible, setIsTabVisible] = useState(!document.hidden);
  useEffect(() => {
    const handleVisibilityChange = () => {
      setIsTabVisible(!document.hidden);
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  // Poll Live Events every 1.5s
  useEffect(() => {
    if (campaign.status !== 'running' || !isTabVisible) return;

    let timer: ReturnType<typeof setTimeout>;

    const pollEvents = async () => {
      try {
        const res = await api<CampaignEventsResponse>(
          `/api/campaigns/${campaign.id}/events?after=${lastEventId}&limit=200`
        );

        if (res.events && res.events.length > 0) {
          setEvents((prev) => {
            const existingIds = new Set(prev.map((e) => e.id));
            const fresh = res.events.filter((e) => !existingIds.has(e.id));
            if (fresh.length === 0) return prev;
            return [...prev, ...fresh].slice(-500);
          });

          const maxId = Math.max(...res.events.map((e) => e.id));
          if (maxId > lastEventId) {
            setLastEventId(maxId);
          }

          setLastEventReceivedAt(Date.now());
          setStallWarning(false);

          // Update student status live in the jobs table
          setJobs((prevJobs) => {
            if (prevJobs.length === 0) return prevJobs;
            let changed = false;
            const updated = prevJobs.map((j) => {
              const matchedEvent = res.events
                .slice()
                .reverse()
                .find((e) => e.jobId === j.id);
              if (matchedEvent) {
                let newStatus = j.status;
                if (matchedEvent.type === 'sent') newStatus = 'sent';
                else if (matchedEvent.type === 'sending') newStatus = 'sending';
                else if (matchedEvent.type === 'failed') newStatus = 'failed';
                else if (matchedEvent.type === 'retry_scheduled') newStatus = 'pending';
                else if (matchedEvent.type === 'uncertain') newStatus = 'uncertain';

                if (newStatus !== j.status) {
                  changed = true;
                  return { ...j, status: newStatus };
                }
              }
              return j;
            });
            return changed ? updated : prevJobs;
          });
        }

        if (res.summary) {
          setSummary(res.summary);
          setCounts({
            total: res.summary.total,
            pending: res.summary.pending,
            sending: res.summary.sending,
            sent: res.summary.sent,
            failed: res.summary.failed,
            uncertain: res.summary.uncertain,
            skipped: res.summary.skipped,
            cancelled: 0,
          });

          if (res.summary.status !== campaign.status) {
            setCampaign((prev) => ({
              ...prev,
              status: res.summary.status,
              pauseReason: res.summary.pause_reason,
              resumeAt: res.summary.resume_at,
              timingSummary: res.summary.timing_summary,
            }));
          }
        }
      } catch (err) {
        console.warn('[Events Poll] Error fetching events:', err);
      } finally {
        if (campaignRef.current.status === 'running') {
          timer = setTimeout(pollEvents, 1500);
        }
      }
    };

    timer = setTimeout(pollEvents, 1000);
    return () => clearTimeout(timer);
  }, [campaign.id, campaign.status, lastEventId, isTabVisible]);

  // 60-Second Stall Detector
  useEffect(() => {
    if (campaign.status !== 'running') {
      setStallWarning(false);
      return;
    }

    const interval = setInterval(() => {
      const quietMs = Date.now() - lastEventReceivedAt;
      if (quietMs > 60_000 && counts.pending + counts.sending > 0) {
        setStallWarning(true);
      } else {
        setStallWarning(false);
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [campaign.status, lastEventReceivedAt, counts.pending, counts.sending]);

  // Auto-scroll activity feed to bottom
  useEffect(() => {
    if (autoScroll && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [events, autoScroll]);

  // Check scroll position to toggle "Jump to latest"
  const handleLogScroll = () => {
    if (!logContainerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = logContainerRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 40;
    setAutoScroll(isAtBottom);
  };

  const jumpToLatest = () => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
      setAutoScroll(true);
    }
  };

  // The Serverless Processing Loop
  useEffect(() => {
    let cancelled = false;

    const runProcessingLoop = async () => {
      if (isLoopRunningRef.current) return;
      isLoopRunningRef.current = true;
      await requestWakeLock();

      let consecutiveErrors = 0;

      while (!cancelled && campaignRef.current.status === 'running') {
        try {
          const res = await api<ProcessCampaignResponse>(`/api/campaigns/${campaignRef.current.id}/process`, {
            method: 'POST',
            body: { budgetMs: 40_000 },
          });

          consecutiveErrors = 0;
          if (cancelled) break;

          setCampaign(res.campaign);
          setCounts(res.counts);
          setLastEventReceivedAt(Date.now());
          setStallWarning(false);

          // Refresh jobs table and queue
          void loadJobs(campaignRef.current.id);
          void loadQueue(campaignRef.current.id);

          if (res.campaign.status !== 'running') {
            break;
          }

          // Short pacing delay between batches
          await new Promise((resolve) => setTimeout(resolve, 200));
        } catch (err) {
          if (cancelled) break;
          consecutiveErrors++;
          console.error('[Process Loop] Error processing batch:', err);
          if (consecutiveErrors >= 3) {
            setAlertNotice({
              type: 'error',
              text: errorText(err, 'Server error while processing campaign. Processing halted.'),
            });
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 5000));
        }
      }

      isLoopRunningRef.current = false;
      await releaseWakeLock();
    };

    if (campaign.status === 'running') {
      void runProcessingLoop();
    } else {
      void releaseWakeLock();
    }

    return () => {
      cancelled = true;
      void releaseWakeLock();
    };
  }, [campaign.status, loadJobs, loadQueue, requestWakeLock, releaseWakeLock]);

  // Countdown timer for auto-resume
  useEffect(() => {
    if (!campaign.resumeAt || campaign.status === 'completed' || campaign.status === 'cancelled') {
      setCountdownText('');
      return;
    }

    const updateTimer = () => {
      if (!campaign.resumeAt) return;
      if (Date.now() >= campaign.resumeAt) {
        setCountdownText('Ready to resume');
        if (campaign.status.startsWith('paused_')) {
          void handleResume();
        }
      } else {
        setCountdownText(formatCountdown(campaign.resumeAt));
      }
    };

    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    return () => clearInterval(interval);
  }, [campaign.resumeAt, campaign.status]);

  // beforeunload warning
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (campaign.status === 'running') {
        e.preventDefault();
        e.returnValue = 'A campaign is actively dispatching. If you leave, dispatch will pause.';
        return e.returnValue;
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [campaign.status]);

  // Action Handlers
  const handlePause = async () => {
    setActionBusy(true);
    try {
      const res = await api<{ success: true; campaign: CampaignV2; counts: CampaignCounts }>(
        `/api/campaigns/${campaign.id}/pause`,
        { method: 'POST' }
      );
      setCampaign(res.campaign);
      setCounts(res.counts);
      setAlertNotice({ type: 'info', text: 'Campaign paused by user.' });
    } catch (err) {
      setAlertNotice({ type: 'error', text: errorText(err, 'Failed to pause campaign.') });
    } finally {
      setActionBusy(false);
    }
  };

  const handleResume = async () => {
    setActionBusy(true);
    try {
      const res = await api<{ success: true; campaign: CampaignV2; counts: CampaignCounts }>(
        `/api/campaigns/${campaign.id}/resume`,
        { method: 'POST' }
      );
      setCampaign(res.campaign);
      setCounts(res.counts);
      setLastEventReceivedAt(Date.now());
      setStallWarning(false);
      setAlertNotice({ type: 'success', text: 'Campaign resumed. Processing emails...' });
      void loadQueue(campaign.id);
    } catch (err) {
      setAlertNotice({ type: 'error', text: errorText(err, 'Failed to resume campaign.') });
    } finally {
      setActionBusy(false);
    }
  };

  const handleCancel = async () => {
    if (!window.confirm('Are you sure you want to cancel this campaign? Pending emails will not be sent.')) return;
    setActionBusy(true);
    try {
      const res = await api<{ success: true; campaign: CampaignV2; counts: CampaignCounts }>(
        `/api/campaigns/${campaign.id}/cancel`,
        { method: 'POST' }
      );
      setCampaign(res.campaign);
      setCounts(res.counts);
      setAlertNotice({ type: 'info', text: 'Campaign cancelled.' });
    } catch (err) {
      setAlertNotice({ type: 'error', text: errorText(err, 'Failed to cancel campaign.') });
    } finally {
      setActionBusy(false);
    }
  };

  const handleRetryFailed = async () => {
    setActionBusy(true);
    try {
      const res = await api<{ success: true; campaign: CampaignV2; counts: CampaignCounts; retriedCount: number }>(
        `/api/campaigns/${campaign.id}/retry-failed`,
        { method: 'POST' }
      );
      setCampaign(res.campaign);
      setCounts(res.counts);
      setLastEventReceivedAt(Date.now());
      setAlertNotice({
        type: 'success',
        text: `Queued ${res.retriedCount} failed email(s) for retry. Resuming dispatch...`,
      });
      void loadJobs(campaign.id);
      void loadQueue(campaign.id);
    } catch (err) {
      setAlertNotice({ type: 'error', text: errorText(err, 'Failed to retry failed jobs.') });
    } finally {
      setActionBusy(false);
    }
  };

  const handleDownloadEventsCsv = () => {
    const url = `${API_BASE}/api/campaigns/${campaign.id}/events.csv`;
    const token = getSessionToken();
    const fullUrl = token ? `${url}?token=${encodeURIComponent(token)}` : url;
    window.open(fullUrl, '_blank');
  };

  const handleDownloadExceptionsCsv = () => {
    const url = `${API_BASE}/api/campaigns/${campaign.id}/export`;
    const token = getSessionToken();
    const fullUrl = token ? `${url}?token=${encodeURIComponent(token)}` : url;
    window.open(fullUrl, '_blank');
  };

  // Metrics calculations
  const totalActionable = (counts.total || 0) - (counts.skipped || 0);
  const sentCount = counts.sent || 0;
  const progressPercent = totalActionable > 0 ? Math.min(100, Math.round((sentCount / totalActionable) * 100)) : 0;

  const elapsedMs = useMemo(() => {
    if (summary?.elapsed_ms !== undefined) return summary.elapsed_ms;
    const start = campaign.startedAt || campaign.createdAt;
    const end = campaign.finishedAt || Date.now();
    return Math.max(0, end - start);
  }, [summary?.elapsed_ms, campaign.startedAt, campaign.createdAt, campaign.finishedAt]);

  const speedEmailsPerMin = useMemo(() => {
    if (summary?.emails_per_min !== undefined) return summary.emails_per_min;
    if (campaign.timingSummary?.emailsPerMin) return campaign.timingSummary.emailsPerMin;
    const minutes = elapsedMs > 0 ? elapsedMs / 60000 : 0.001;
    return sentCount > 0 ? Number((sentCount / minutes).toFixed(1)) : 0;
  }, [summary?.emails_per_min, campaign.timingSummary?.emailsPerMin, elapsedMs, sentCount]);

  const etaText = useMemo(() => {
    const remaining = counts.pending + counts.sending;
    if (remaining === 0 || campaign.status !== 'running') return '—';
    if (speedEmailsPerMin <= 0) return 'Calculating...';
    const secondsRemaining = Math.round((remaining / (speedEmailsPerMin / 60)));
    return formatDuration(secondsRemaining * 1000);
  }, [counts.pending, counts.sending, campaign.status, speedEmailsPerMin]);

  // Currently sending student info
  const nowSendingInfo = useMemo(() => {
    const activeSendingEvent = events
      .slice()
      .reverse()
      .find((e) => e.type === 'sending');
    if (activeSendingEvent && campaign.status === 'running') {
      return `${activeSendingEvent.studentName} (${activeSendingEvent.studentEmail})`;
    }
    const sendingJob = jobs.find((j) => j.status === 'sending');
    if (sendingJob && campaign.status === 'running') {
      return `${sendingJob.studentName} (${sendingJob.studentEmail})`;
    }
    return null;
  }, [events, jobs, campaign.status]);

  // Filtered Events
  const filteredEvents = useMemo(() => {
    return events.filter((e) => {
      if (activityFilter === 'sent') return e.type === 'sent';
      if (activityFilter === 'failed') return e.type === 'failed' || e.type === 'auth_error';
      if (activityFilter === 'waiting') {
        return e.type === 'sending' || e.type === 'retry_scheduled' || e.type === 'queued' || e.type === 'throttled';
      }
      return true;
    });
  }, [events, activityFilter]);

  // Filtered Jobs
  const filteredJobs = useMemo(() => {
    return jobs.filter((job) => {
      if (statusFilter !== 'all' && job.status !== statusFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        const matchName = job.studentName.toLowerCase().includes(q);
        const matchEmail = job.studentEmail.toLowerCase().includes(q);
        const matchFile = (job.fileName || '').toLowerCase().includes(q);
        if (!matchName && !matchEmail && !matchFile) return false;
      }
      return true;
    });
  }, [jobs, statusFilter, search]);

  const renderStatusChip = (status: CampaignStatus) => {
    switch (status) {
      case 'running':
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-800">
            <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
            Running
          </span>
        );
      case 'completed':
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-indigo-100 px-3 py-1 text-xs font-semibold text-indigo-800">
            <CheckCircle2 className="h-3.5 w-3.5 text-indigo-600" />
            Completed
          </span>
        );
      case 'paused':
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-800">
            <Pause className="h-3.5 w-3.5 text-amber-600" />
            Paused
          </span>
        );
      case 'paused_limit':
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-800">
            <Clock className="h-3.5 w-3.5 text-amber-600" />
            Paused (Daily Quota)
          </span>
        );
      case 'paused_throttled':
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-800">
            <Clock className="h-3.5 w-3.5 text-amber-600" />
            Paused (Mail Throttled)
          </span>
        );
      case 'paused_auth':
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-rose-100 px-3 py-1 text-xs font-semibold text-rose-800">
            <ShieldAlert className="h-3.5 w-3.5 text-rose-600" />
            Paused (SMTP Auth Error)
          </span>
        );
      case 'paused_salesforce':
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-800">
            <Clock className="h-3.5 w-3.5 text-amber-600" />
            Paused (Salesforce Limit)
          </span>
        );
      case 'cancelled':
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
            <XCircle className="h-3.5 w-3.5 text-slate-500" />
            Cancelled
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
            {status}
          </span>
        );
    }
  };

  const renderEventIcon = (type: JobEvent['type']) => {
    switch (type) {
      case 'sent':
        return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 shrink-0 mt-0.5" />;
      case 'sending':
        return <Loader2 className="h-3.5 w-3.5 text-indigo-600 animate-spin shrink-0 mt-0.5" />;
      case 'failed':
      case 'auth_error':
        return <XCircle className="h-3.5 w-3.5 text-rose-600 shrink-0 mt-0.5" />;
      case 'retry_scheduled':
        return <Clock className="h-3.5 w-3.5 text-amber-600 shrink-0 mt-0.5" />;
      case 'throttled':
        return <AlertCircle className="h-3.5 w-3.5 text-orange-600 shrink-0 mt-0.5" />;
      case 'paused':
        return <Pause className="h-3.5 w-3.5 text-amber-600 shrink-0 mt-0.5" />;
      case 'resumed':
        return <Play className="h-3.5 w-3.5 text-emerald-600 shrink-0 mt-0.5" />;
      case 'completed':
        return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-700 shrink-0 mt-0.5" />;
      case 'uncertain':
        return <HelpCircle className="h-3.5 w-3.5 text-purple-600 shrink-0 mt-0.5" />;
      default:
        return <Clock className="h-3.5 w-3.5 text-slate-400 shrink-0 mt-0.5" />;
    }
  };

  return (
    <div className="space-y-6">
      {/* Top Navigation & Controls */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onBackToStudents}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-2xs hover:bg-slate-50 cursor-pointer"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Student List
          </button>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-bold text-slate-900">{campaign.name}</h2>
              {renderStatusChip(campaign.status)}
            </div>
            <p className="text-xs text-slate-500 mt-0.5">
              Subject: <span className="font-medium text-slate-700">{campaign.subject}</span>
              {campaign.sendLanes && campaign.sendLanes > 1 && (
                <span className="ml-2 inline-flex items-center gap-1 rounded bg-indigo-50 px-1.5 py-0.5 font-mono text-[10px] text-indigo-700 font-semibold">
                  <Zap className="h-2.5 w-2.5" /> {campaign.sendLanes} Lanes
                </span>
              )}
            </p>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex flex-wrap items-center gap-2">
          {campaign.status === 'running' && (
            <button
              type="button"
              onClick={handlePause}
              disabled={actionBusy}
              className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3.5 py-2 text-xs font-semibold text-amber-800 shadow-2xs hover:bg-amber-100 cursor-pointer"
            >
              <Pause className="h-3.5 w-3.5" />
              Pause
            </button>
          )}

          {campaign.status.startsWith('paused') && (
            <button
              type="button"
              onClick={handleResume}
              disabled={actionBusy}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white shadow-2xs hover:bg-emerald-700 cursor-pointer"
            >
              <Play className="h-3.5 w-3.5" />
              Resume Now
            </button>
          )}

          {counts.failed > 0 && (
            <button
              type="button"
              onClick={handleRetryFailed}
              disabled={actionBusy}
              className="inline-flex items-center gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2 text-xs font-semibold text-rose-700 shadow-2xs hover:bg-rose-100 cursor-pointer"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Retry {counts.failed} Failed
            </button>
          )}

          <button
            type="button"
            onClick={handleDownloadEventsCsv}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 shadow-2xs hover:bg-slate-50 cursor-pointer"
            title="Download full event log history in CSV format"
          >
            <Download className="h-3.5 w-3.5 text-slate-500" />
            Activity Log (CSV)
          </button>

          {(counts.failed > 0 || counts.uncertain > 0 || counts.skipped > 0) && (
            <button
              type="button"
              onClick={handleDownloadExceptionsCsv}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 shadow-2xs hover:bg-slate-50 cursor-pointer"
              title="Download CSV of skipped, failed, and uncertain emails"
            >
              <Download className="h-3.5 w-3.5 text-slate-500" />
              Exceptions (CSV)
            </button>
          )}

          {campaign.status !== 'completed' && campaign.status !== 'cancelled' && (
            <button
              type="button"
              onClick={handleCancel}
              disabled={actionBusy}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-rose-50 hover:text-rose-700 cursor-pointer"
            >
              Cancel
            </button>
          )}
        </div>
      </div>

      {/* Alert Notices */}
      {alertNotice && (
        <div
          className={`flex items-start gap-2.5 rounded-xl border p-3.5 text-xs ${
            alertNotice.type === 'success'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
              : alertNotice.type === 'error'
              ? 'border-rose-200 bg-rose-50 text-rose-800'
              : 'border-indigo-200 bg-indigo-50 text-indigo-800'
          }`}
        >
          {alertNotice.type === 'success' ? (
            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 mt-0.5" />
          ) : (
            <AlertCircle className="h-4 w-4 shrink-0 text-rose-600 mt-0.5" />
          )}
          <span className="flex-1">{alertNotice.text}</span>
          <button
            type="button"
            onClick={() => setAlertNotice(null)}
            className="text-slate-400 hover:text-slate-600 cursor-pointer"
          >
            <XCircle className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Stall Warning Banner (60s without events while running) */}
      {stallWarning && (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-xs text-amber-950 shadow-2xs">
          <div className="flex items-start gap-2.5">
            <AlertCircle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
            <div>
              <strong className="text-sm font-semibold text-amber-900">Dispatch May Be Stalled</strong>
              <p className="mt-0.5 text-amber-800">
                No progress recorded in the last 60 seconds. The serverless process may have reached its execution limit.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleResume}
            disabled={actionBusy}
            className="rounded-lg bg-amber-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow-2xs hover:bg-amber-700 shrink-0 cursor-pointer"
          >
            Re-trigger Dispatch Loop
          </button>
        </div>
      )}

      {/* State Banners with Resolution Advice */}
      {campaign.status === 'running' && (
        <div className="flex items-center justify-between rounded-xl border border-indigo-200 bg-indigo-50/80 p-4 text-xs text-indigo-950 shadow-2xs">
          <div className="flex items-center gap-2.5">
            <Loader2 className="h-4 w-4 animate-spin text-indigo-600" />
            <div>
              <strong>Dispatching certificates:</strong> Multi-lane serverless worker active with file prefetch. Keep this tab open.
            </div>
          </div>
          <span className="text-[11px] font-medium text-indigo-700">Screen Wake Lock Active</span>
        </div>
      )}

      {campaign.status === 'paused' && (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-950 shadow-2xs">
          <div className="flex items-start gap-2.5">
            <Pause className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
            <div>
              <strong className="text-sm font-semibold text-amber-900">Campaign Paused</strong>
              <p className="mt-0.5 text-amber-800">
                {campaign.pauseReason || 'Campaign was paused by user or consecutive failures.'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleResume}
            className="rounded-lg bg-amber-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow-2xs hover:bg-amber-700 shrink-0 cursor-pointer"
          >
            Resume Campaign
          </button>
        </div>
      )}

      {campaign.status === 'paused_limit' && (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-950 shadow-2xs">
          <div className="flex items-start gap-2.5">
            <Clock className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
            <div>
              <strong className="text-sm font-semibold text-amber-900">Daily Sending Quota Reached</strong>
              <p className="mt-0.5 text-amber-800">
                {campaign.pauseReason || 'Rolling 24-hour mailbox sending limit reached. Emails will not be double-sent.'}
              </p>
              {countdownText && (
                <p className="mt-1 font-semibold text-amber-900">
                  Auto-resuming in: <span className="font-mono text-amber-950">{countdownText}</span>
                </p>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={handleResume}
            className="rounded-lg bg-amber-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow-2xs hover:bg-amber-700 shrink-0 cursor-pointer"
          >
            Resume Now
          </button>
        </div>
      )}

      {campaign.status === 'paused_throttled' && (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-950 shadow-2xs">
          <div className="flex items-start gap-2.5">
            <Clock className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
            <div>
              <strong className="text-sm font-semibold text-amber-900">Mail Server Throttle Cooldown</strong>
              <p className="mt-0.5 text-amber-800">
                {campaign.pauseReason || 'Mail server requested a brief cooldown. Dispatch lane dropped to 1.'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleResume}
            className="rounded-lg bg-amber-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow-2xs hover:bg-amber-700 shrink-0 cursor-pointer"
          >
            Resume Now
          </button>
        </div>
      )}

      {campaign.status === 'paused_auth' && (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 p-4 text-xs text-rose-950 shadow-2xs">
          <div className="flex items-start gap-2.5">
            <ShieldAlert className="h-5 w-5 text-rose-600 shrink-0 mt-0.5" />
            <div>
              <strong className="text-sm font-semibold text-rose-900">SMTP Authentication Failed</strong>
              <p className="mt-0.5 text-rose-800">
                {campaign.pauseReason || 'Gmail rejected your login credentials. Generate a 16-character Google App Password in your Google Account security settings and paste it in Settings.'}
              </p>
            </div>
          </div>
          {onOpenSettings && (
            <button
              type="button"
              onClick={onOpenSettings}
              className="rounded-lg bg-rose-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow-2xs hover:bg-rose-700 shrink-0 cursor-pointer"
            >
              Open Settings
            </button>
          )}
        </div>
      )}

      {campaign.status === 'paused_salesforce' && (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-950 shadow-2xs">
          <div className="flex items-start gap-2.5">
            <Clock className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
            <div>
              <strong className="text-sm font-semibold text-amber-900">Salesforce API Daily Limit Reached</strong>
              <p className="mt-0.5 text-amber-800">
                Salesforce daily API quota exceeded. Automatically resumes at midnight UTC.
              </p>
              {countdownText && (
                <p className="mt-1 font-semibold text-amber-900">
                  Auto-resuming in: <span className="font-mono text-amber-950">{countdownText}</span>
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Progress Panel */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-slate-900">Overall Progress</span>
            <span className="text-xs text-slate-500 font-medium">
              {sentCount} of {totalActionable} sent ({progressPercent}%)
            </span>
          </div>
          <div className="flex items-center gap-4 text-xs text-slate-600 font-medium">
            <span className="inline-flex items-center gap-1">
              <Timer className="h-3.5 w-3.5 text-slate-400" />
              Elapsed: <strong className="font-mono text-slate-800">{formatDuration(elapsedMs)}</strong>
            </span>
            <span className="inline-flex items-center gap-1">
              <Gauge className="h-3.5 w-3.5 text-indigo-500" />
              Speed: <strong className="font-mono text-slate-800">{speedEmailsPerMin} / min</strong>
            </span>
            <span className="inline-flex items-center gap-1">
              <Clock className="h-3.5 w-3.5 text-slate-400" />
              ETA: <strong className="font-mono text-slate-800">{etaText}</strong>
            </span>
          </div>
        </div>

        {/* Progress Bar */}
        <div className="h-3 w-full overflow-hidden rounded-full bg-slate-100">
          <div
            className={`h-full transition-all duration-500 ${
              campaign.status === 'running'
                ? 'bg-gradient-to-r from-indigo-500 to-indigo-600 animate-pulse'
                : campaign.status === 'completed'
                ? 'bg-emerald-500'
                : 'bg-indigo-600'
            }`}
            style={{ width: `${progressPercent}%` }}
          />
        </div>

        {/* Now Sending Indicator */}
        {nowSendingInfo && (
          <div className="mt-3 flex items-center gap-2 rounded-lg bg-indigo-50/70 px-3 py-1.5 text-xs text-indigo-900">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-indigo-600 shrink-0" />
            <span>
              Now sending: <strong className="font-medium text-indigo-950">{nowSendingInfo}</strong>
            </span>
          </div>
        )}

        {/* KPI Cards */}
        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-6">
          <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-3">
            <div className="text-[11px] font-semibold text-slate-500 uppercase">Total</div>
            <div className="mt-1 text-xl font-bold text-slate-900">{counts.total}</div>
          </div>

          <div className="rounded-xl border border-emerald-200 bg-emerald-50/70 p-3">
            <div className="text-[11px] font-semibold text-emerald-700 uppercase">Sent</div>
            <div className="mt-1 text-xl font-bold text-emerald-950">{counts.sent}</div>
          </div>

          <div className="rounded-xl border border-indigo-200 bg-indigo-50/70 p-3">
            <div className="text-[11px] font-semibold text-indigo-700 uppercase">In Flight</div>
            <div className="mt-1 text-xl font-bold text-indigo-950">
              {counts.pending + counts.sending}
            </div>
          </div>

          <div className="rounded-xl border border-rose-200 bg-rose-50/70 p-3">
            <div className="text-[11px] font-semibold text-rose-700 uppercase">Failed</div>
            <div className="mt-1 text-xl font-bold text-rose-950">{counts.failed}</div>
          </div>

          <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-3">
            <div className="text-[11px] font-semibold text-amber-700 uppercase">Uncertain</div>
            <div className="mt-1 text-xl font-bold text-amber-950">{counts.uncertain}</div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3">
            <div className="text-[11px] font-semibold text-slate-600 uppercase">Skipped</div>
            <div className="mt-1 text-xl font-bold text-slate-800">{counts.skipped}</div>
          </div>
        </div>
      </div>

      {/* Completion & Timing Metrics Summary Card */}
      {campaign.status === 'completed' && (
        <div className="rounded-2xl border border-emerald-200 bg-gradient-to-br from-emerald-50/80 to-white p-5 shadow-2xs">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700">
              <CheckCircle2 className="h-6 w-6" />
            </div>
            <div>
              <h3 className="text-base font-bold text-emerald-950">Campaign Completed Successfully</h3>
              <p className="text-xs text-emerald-800">
                Dispatched {counts.sent} certificate(s) in {formatDuration(elapsedMs)} at{' '}
                <strong className="font-semibold">{speedEmailsPerMin} emails/min</strong>.
              </p>
            </div>
          </div>

          {campaign.timingSummary?.steps && (
            <div className="mt-4 pt-4 border-t border-emerald-100">
              <div className="text-xs font-semibold text-slate-700 mb-2">Per-Step Performance Breakdown:</div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 text-xs">
                <div className="rounded-lg bg-white/80 p-2.5 border border-slate-200">
                  <span className="text-[10px] text-slate-500 font-medium uppercase">File Download</span>
                  <div className="font-mono text-slate-900 mt-0.5">
                    Avg: <strong>{campaign.timingSummary.steps.fileDownload.avgMs}ms</strong>
                    <span className="text-slate-400 text-[11px] ml-1.5">(p95: {campaign.timingSummary.steps.fileDownload.p95Ms}ms)</span>
                  </div>
                </div>

                <div className="rounded-lg bg-white/80 p-2.5 border border-slate-200">
                  <span className="text-[10px] text-slate-500 font-medium uppercase">SMTP Dispatch</span>
                  <div className="font-mono text-slate-900 mt-0.5">
                    Avg: <strong>{campaign.timingSummary.steps.smtpSend.avgMs}ms</strong>
                    <span className="text-slate-400 text-[11px] ml-1.5">(p95: {campaign.timingSummary.steps.smtpSend.p95Ms}ms)</span>
                  </div>
                </div>

                <div className="rounded-lg bg-white/80 p-2.5 border border-slate-200">
                  <span className="text-[10px] text-slate-500 font-medium uppercase">DB Claim</span>
                  <div className="font-mono text-slate-900 mt-0.5">
                    Avg: <strong>{campaign.timingSummary.steps.claim.avgMs}ms</strong>
                    <span className="text-slate-400 text-[11px] ml-1.5">(p95: {campaign.timingSummary.steps.claim.p95Ms}ms)</span>
                  </div>
                </div>

                <div className="rounded-lg bg-white/80 p-2.5 border border-slate-200">
                  <span className="text-[10px] text-slate-500 font-medium uppercase">DB State Write</span>
                  <div className="font-mono text-slate-900 mt-0.5">
                    Avg: <strong>{campaign.timingSummary.steps.dbWrite.avgMs}ms</strong>
                    <span className="text-slate-400 text-[11px] ml-1.5">(p95: {campaign.timingSummary.steps.dbWrite.p95Ms}ms)</span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Live Activity Feed */}
      <div className="rounded-2xl border border-slate-200 bg-white shadow-2xs overflow-hidden">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-200 px-5 py-3.5 bg-slate-50/50">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-indigo-600" />
            <h3 className="text-sm font-semibold text-slate-900">Live Activity Feed</h3>
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
              Live Stream
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Filter Chips */}
            <div className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5 text-xs font-medium text-slate-600">
              <button
                type="button"
                onClick={() => setActivityFilter('all')}
                className={`rounded-md px-2.5 py-1 text-xs cursor-pointer ${
                  activityFilter === 'all' ? 'bg-indigo-600 text-white font-semibold' : 'hover:bg-slate-50'
                }`}
              >
                All ({events.length})
              </button>
              <button
                type="button"
                onClick={() => setActivityFilter('sent')}
                className={`rounded-md px-2.5 py-1 text-xs cursor-pointer ${
                  activityFilter === 'sent' ? 'bg-emerald-600 text-white font-semibold' : 'hover:bg-slate-50'
                }`}
              >
                Sent ({counts.sent})
              </button>
              <button
                type="button"
                onClick={() => setActivityFilter('failed')}
                className={`rounded-md px-2.5 py-1 text-xs cursor-pointer ${
                  activityFilter === 'failed' ? 'bg-rose-600 text-white font-semibold' : 'hover:bg-slate-50'
                }`}
              >
                Failed ({counts.failed})
              </button>
              <button
                type="button"
                onClick={() => setActivityFilter('waiting')}
                className={`rounded-md px-2.5 py-1 text-xs cursor-pointer ${
                  activityFilter === 'waiting' ? 'bg-indigo-600 text-white font-semibold' : 'hover:bg-slate-50'
                }`}
              >
                Waiting ({counts.pending + counts.sending})
              </button>
            </div>

            {!autoScroll && (
              <button
                type="button"
                onClick={jumpToLatest}
                className="inline-flex items-center gap-1 rounded-md bg-indigo-50 px-2.5 py-1 text-xs font-semibold text-indigo-700 hover:bg-indigo-100 cursor-pointer shadow-2xs"
              >
                Jump to latest ↓
              </button>
            )}
          </div>
        </div>

        {/* Feed Terminal Box */}
        <div
          ref={logContainerRef}
          onScroll={handleLogScroll}
          aria-live="polite"
          className="max-h-72 overflow-y-auto p-4 font-mono text-xs divide-y divide-slate-100 bg-slate-900/95 text-slate-200"
        >
          {filteredEvents.length === 0 ? (
            <div className="py-8 text-center text-slate-500">
              {events.length === 0 ? 'No events recorded yet. Waiting for dispatch...' : 'No events match the selected filter.'}
            </div>
          ) : (
            filteredEvents.map((ev) => (
              <div key={ev.id} className="py-1.5 flex items-start gap-2 hover:bg-slate-800/50 px-1 rounded transition-colors">
                <span className="text-[10px] text-slate-500 shrink-0 font-mono select-none">
                  [{formatTime(ev.createdAt)}]
                </span>
                {renderEventIcon(ev.type)}
                <span
                  className={`flex-1 break-words ${
                    ev.type === 'sent'
                      ? 'text-emerald-300'
                      : ev.type === 'sending'
                      ? 'text-indigo-300'
                      : ev.type === 'failed' || ev.type === 'auth_error'
                      ? 'text-rose-300'
                      : ev.type === 'throttled' || ev.type === 'retry_scheduled'
                      ? 'text-amber-300'
                      : 'text-slate-300'
                  }`}
                >
                  {ev.message}
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* "Up Next" Waiting Queue (Collapsible) */}
      <div className="rounded-2xl border border-slate-200 bg-white shadow-2xs overflow-hidden">
        <button
          type="button"
          onClick={() => setQueueExpanded(!queueExpanded)}
          className="w-full flex items-center justify-between border-b border-slate-200 px-5 py-3.5 bg-slate-50/50 hover:bg-slate-50 cursor-pointer text-left"
        >
          <div className="flex items-center gap-2">
            <Layers className="h-4 w-4 text-slate-600" />
            <h3 className="text-sm font-semibold text-slate-900">Up Next in Queue</h3>
            <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-medium text-slate-700">
              {queueTotal} waiting
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500 font-medium">
              {queueExpanded ? 'Collapse' : 'Expand'}
            </span>
            {queueExpanded ? <ChevronUp className="h-4 w-4 text-slate-400" /> : <ChevronDown className="h-4 w-4 text-slate-400" />}
          </div>
        </button>

        {queueExpanded && (
          <div className="p-4 space-y-3">
            <div className="flex items-center gap-2 max-w-sm">
              <div className="relative w-full">
                <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-slate-400" />
                <input
                  type="text"
                  value={queueSearch}
                  onChange={(e) => {
                    setQueueSearch(e.target.value);
                    void loadQueue(campaign.id, e.target.value);
                  }}
                  placeholder="Search waiting students..."
                  className="w-full rounded-lg border border-slate-200 bg-white pl-8 pr-3 py-1.5 text-xs text-slate-800 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none"
                />
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-100 bg-slate-50 text-[10px] font-semibold text-slate-500 uppercase">
                  <tr>
                    <th className="px-3 py-2 w-12">Pos</th>
                    <th className="px-3 py-2">Student Name</th>
                    <th className="px-3 py-2">Email</th>
                    <th className="px-3 py-2">Attempt</th>
                    <th className="px-3 py-2">Status / Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {queue.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="py-6 text-center text-slate-400">
                        {queueLoading ? 'Loading waiting queue...' : 'No students currently waiting in queue.'}
                      </td>
                    </tr>
                  ) : (
                    queue.map((item) => (
                      <tr key={item.id} className="hover:bg-slate-50/60">
                        <td className="px-3 py-2 font-mono font-semibold text-indigo-700">#{item.position}</td>
                        <td className="px-3 py-2 font-medium text-slate-900">{item.studentName}</td>
                        <td className="px-3 py-2 text-slate-600">{item.studentEmail}</td>
                        <td className="px-3 py-2 text-slate-500">
                          {item.attempts > 0 ? `Retry #${item.attempts}` : '1st try'}
                        </td>
                        <td className="px-3 py-2 text-slate-500">
                          {item.lastError ? (
                            <span className="text-amber-700 text-[11px]" title={item.lastError}>
                              {item.lastError}
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600">
                              <Clock className="h-2.5 w-2.5" /> Ready
                            </span>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* All Recipients Table */}
      <div className="rounded-2xl border border-slate-200 bg-white shadow-2xs overflow-hidden">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-200 px-5 py-3.5 bg-slate-50/50">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-slate-900">All Recipients</h3>
            <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-medium text-slate-700">
              {filteredJobs.length}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Status Filter */}
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 focus:border-indigo-500 focus:outline-none cursor-pointer"
            >
              <option value="all">All Statuses</option>
              <option value="pending">Pending</option>
              <option value="sending">Sending</option>
              <option value="sent">Sent</option>
              <option value="failed">Failed</option>
              <option value="uncertain">Uncertain</option>
              <option value="skipped">Skipped</option>
            </select>

            {/* Search Input */}
            <div className="relative">
              <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-slate-400" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search recipient..."
                className="rounded-lg border border-slate-200 bg-white pl-8 pr-3 py-1.5 text-xs text-slate-800 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none"
              />
            </div>
          </div>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold text-slate-600 uppercase tracking-wider">
              <tr>
                <th className="px-5 py-3">Student Name</th>
                <th className="px-5 py-3">Email</th>
                <th className="px-5 py-3">Certificate File</th>
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3">Details / Result</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredJobs.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-slate-400">
                    {loadingJobs ? 'Loading recipients...' : 'No recipients match the filter.'}
                  </td>
                </tr>
              ) : (
                filteredJobs.map((job) => {
                  return (
                    <tr key={job.id} className="hover:bg-slate-50/60 transition-colors">
                      <td className="px-5 py-3 font-medium text-slate-900">{job.studentName || '—'}</td>
                      <td className="px-5 py-3 text-slate-600">{job.studentEmail}</td>
                      <td className="px-5 py-3 text-slate-600">
                        {job.fileName ? (
                          <span className="inline-flex items-center gap-1 font-mono text-[11px]">
                            <FileCheck2 className="h-3 w-3 text-emerald-600" />
                            {job.fileName}
                          </span>
                        ) : (
                          <span className="text-slate-400 italic">None</span>
                        )}
                      </td>
                      <td className="px-5 py-3">
                        {job.status === 'sent' && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-800">
                            <CheckCircle2 className="h-2.5 w-2.5" />
                            Sent
                          </span>
                        )}
                        {job.status === 'sending' && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-semibold text-indigo-800">
                            {campaign.status === 'running' ? (
                              <Loader2 className="h-2.5 w-2.5 animate-spin" />
                            ) : (
                              <Clock className="h-2.5 w-2.5" />
                            )}
                            {campaign.status === 'running' ? 'Sending' : 'Interrupted'}
                          </span>
                        )}
                        {job.status === 'pending' && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600">
                            <Clock className="h-2.5 w-2.5" />
                            Pending
                          </span>
                        )}
                        {job.status === 'failed' && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-semibold text-rose-800">
                            <XCircle className="h-2.5 w-2.5" />
                            Failed
                          </span>
                        )}
                        {job.status === 'uncertain' && (
                          <span
                            className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800"
                            title="Transfer timed out; not retried to prevent double sends"
                          >
                            <HelpCircle className="h-2.5 w-2.5" />
                            Uncertain
                          </span>
                        )}
                        {job.status === 'skipped' && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500">
                            Skipped
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-slate-500 max-w-xs truncate">
                        {job.lastError ? (
                          <span className="text-rose-600" title={job.lastError}>
                            {job.lastError}
                          </span>
                        ) : job.smtpMessageId ? (
                          <span className="font-mono text-[10px] text-slate-400 truncate block">
                            ID: {job.smtpMessageId}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
