import { useState, useEffect } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Clock,
  FileCheck,
  FileX,
  Mail,
  MailCheck,
  Send,
  Users,
  X,
  CheckCircle2,
  Loader2,
} from 'lucide-react';
import { api, errorText } from '../api.ts';
import type { CampaignV2, CreateCampaignReviewResponse, PublicSettings, QuotaInfo } from '../api.ts';

interface Props {
  studentIds: string[] | 'all';
  totalSelectedCount: number;
  templateSubject: string;
  templateHtml: string;
  settings: PublicSettings;
  quota?: QuotaInfo;
  userEmail: string;
  onLaunch: (campaign: CampaignV2) => void;
  onClose: () => void;
}

function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds > 0 ? `${seconds}s` : ''}`.trim();
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes > 0 ? `${remainingMinutes}m` : ''}`.trim();
}

export default function CampaignReviewModal({
  studentIds,
  totalSelectedCount,
  templateSubject,
  templateHtml,
  settings,
  quota: _quota,
  userEmail,
  onLaunch,
  onClose,
}: Props) {
  const [campaignName, setCampaignName] = useState(
    `Dispatch ${new Date().toLocaleDateString()} (${totalSelectedCount} students)`
  );
  const [includePreviouslySent, setIncludePreviouslySent] = useState(false);
  const [reviewData, setReviewData] = useState<CreateCampaignReviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Test email state
  const [sendingTest, setSendingTest] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);

  // Launch state
  const [launching, setLaunching] = useState(false);

  // Fetch or re-fetch review data when includePreviouslySent changes
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    api<CreateCampaignReviewResponse>('/api/campaigns', {
      method: 'POST',
      body: {
        name: campaignName,
        studentIds: studentIds === 'all' ? 'all' : studentIds,
        subject: templateSubject,
        templateHtml,
        includePreviouslySent,
      },
    })
      .then((data) => {
        if (active) {
          setReviewData(data);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (active) {
          setError(errorText(err, 'Could not resolve campaign students and files.'));
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [includePreviouslySent]);

  const handleSendTestEmail = async () => {
    setSendingTest(true);
    setTestResult(null);
    try {
      const res = await api<{ success: true; message: string }>('/api/campaigns/test-email', {
        method: 'POST',
        body: {
          campaignId: reviewData?.campaignId,
          subject: templateSubject,
          templateHtml,
        },
      });
      setTestResult({ success: true, message: res.message });
    } catch (err) {
      setTestResult({
        success: false,
        message: errorText(err, 'Failed to send test email. Check mail settings.'),
      });
    } finally {
      setSendingTest(false);
    }
  };

  const handleLaunch = async () => {
    if (!reviewData?.campaignId) return;
    setLaunching(true);
    try {
      const res = await api<{ success: true; campaign: CampaignV2 }>(
        `/api/campaigns/${reviewData.campaignId}/start`,
        { method: 'POST' }
      );
      onLaunch(res.campaign);
    } catch (err) {
      setError(errorText(err, 'Could not start campaign.'));
      setLaunching(false);
    }
  };

  const willSend = reviewData?.counts.willSend || 0;
  const skipped = reviewData?.counts.skipped || { noFile: 0, invalidEmail: 0, alreadySent: 0, total: 0 };
  const recipientsPerEmail = reviewData?.recipientsPerEmail || 1;
  const totalRecipients = willSend * recipientsPerEmail;
  const dailyLimitRemaining = reviewData?.dailyLimitRemaining ?? 999999;
  const exceedsQuota = dailyLimitRemaining < 999999 && totalRecipients > dailyLimitRemaining;
  const estimatedSeconds = reviewData?.estimatedDurationSeconds || willSend * 4;
  const spansAcrossDays = estimatedSeconds > 8 * 3600;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-xs"
      role="dialog"
      aria-modal="true"
    >
      <div className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
              <Send className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-slate-900">Review & Launch Campaign</h2>
              <p className="text-xs text-slate-500">
                Verify recipient counts, attachments, and daily quota safety before dispatching.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 cursor-pointer"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          {error && (
            <div className="flex items-start gap-2.5 rounded-xl border border-rose-200 bg-rose-50 p-3.5 text-xs text-rose-800">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Campaign Name */}
          <div>
            <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1.5">
              Campaign Name
            </label>
            <input
              type="text"
              value={campaignName}
              onChange={(e) => setCampaignName(e.target.value)}
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
              placeholder="e.g. Graduation Dispatch Batch A"
            />
          </div>

          {loading ? (
            <div className="flex flex-col items-center justify-center py-12 text-slate-500">
              <Loader2 className="h-8 w-8 animate-spin text-indigo-600" />
              <p className="mt-3 text-sm font-medium">Resolving Salesforce students & certificates...</p>
              <p className="mt-1 text-xs text-slate-400">Checking attachments and daily quota</p>
            </div>
          ) : (
            <>
              {/* Counts Breakdown Card */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div className="rounded-xl border border-emerald-200 bg-emerald-50/70 p-3.5">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-800">
                    <FileCheck className="h-4 w-4 text-emerald-600" />
                    Will Send
                  </div>
                  <div className="mt-1.5 text-2xl font-bold text-emerald-950">{willSend}</div>
                  <div className="text-[11px] text-emerald-700">Ready with file & email</div>
                </div>

                <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-3.5">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-800">
                    <FileX className="h-4 w-4 text-amber-600" />
                    No Certificate
                  </div>
                  <div className="mt-1.5 text-2xl font-bold text-amber-950">{skipped.noFile}</div>
                  <div className="text-[11px] text-amber-700">Skipped (no file)</div>
                </div>

                <div className="rounded-xl border border-rose-200 bg-rose-50/70 p-3.5">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-rose-800">
                    <Mail className="h-4 w-4 text-rose-600" />
                    Invalid Email
                  </div>
                  <div className="mt-1.5 text-2xl font-bold text-rose-950">{skipped.invalidEmail}</div>
                  <div className="text-[11px] text-rose-700">Skipped (bad syntax)</div>
                </div>

                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-700">
                    <MailCheck className="h-4 w-4 text-slate-500" />
                    Already Sent
                  </div>
                  <div className="mt-1.5 text-2xl font-bold text-slate-900">{skipped.alreadySent}</div>
                  <div className="text-[11px] text-slate-500">In earlier campaign</div>
                </div>
              </div>

              {/* Previously Sent Checkbox */}
              {skipped.alreadySent > 0 && (
                <div className="flex items-center gap-2.5 rounded-xl border border-slate-200 bg-slate-50/80 p-3 text-xs text-slate-700">
                  <input
                    type="checkbox"
                    id="includePrevSent"
                    checked={includePreviouslySent}
                    onChange={(e) => setIncludePreviouslySent(e.target.checked)}
                    className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                  />
                  <label htmlFor="includePrevSent" className="cursor-pointer select-none">
                    <strong>Include previously sent students:</strong> Resend to the {skipped.alreadySent} student(s) who already received their certificate.
                  </label>
                </div>
              )}

              {/* Delivery Speed, Quota & Timing Metrics */}
              <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3 shadow-2xs">
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3 text-xs">
                  <div className="flex items-center gap-2">
                    <Clock className="h-4 w-4 text-slate-400" />
                    <div>
                      <span className="text-slate-500">Estimated Duration:</span>{' '}
                      <strong className="text-slate-900">~{formatDuration(estimatedSeconds)}</strong>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <Users className="h-4 w-4 text-slate-400" />
                    <div>
                      <span className="text-slate-500">Recipients per Email:</span>{' '}
                      <strong className="text-slate-900">{recipientsPerEmail}</strong>{' '}
                      <span className="text-slate-400">({settings.cc ? '1 To + CC' : '1 To'})</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <MailCheck className="h-4 w-4 text-slate-400" />
                    <div>
                      <span className="text-slate-500">Daily Quota Left:</span>{' '}
                      <strong className={exceedsQuota ? 'text-amber-600' : 'text-slate-900'}>
                        {dailyLimitRemaining < 999999 ? `${dailyLimitRemaining} recipients` : 'Unlimited'}
                      </strong>
                    </div>
                  </div>
                </div>

                {/* Quota / Multi-day Warning */}
                {exceedsQuota && (
                  <div className="flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                    <div>
                      <strong>Daily quota notice:</strong> This campaign requires {totalRecipients} recipients, but only {dailyLimitRemaining} remaining in your rolling 24h quota. The dispatcher will send what is allowed, pause safely with <code className="font-mono font-semibold">paused_limit</code>, and automatically resume as your 24h quota recovers.
                    </div>
                  </div>
                )}

                {spansAcrossDays && (
                  <div className="flex items-start gap-2.5 rounded-lg border border-indigo-200 bg-indigo-50 p-3 text-xs text-indigo-900">
                    <Clock className="mt-0.5 h-4 w-4 shrink-0 text-indigo-600" />
                    <div>
                      <strong>Large campaign:</strong> Estimated time exceeds several hours. You can leave this browser tab open, or close it and resume at any time.
                    </div>
                  </div>
                )}
              </div>

              {/* Test Email Section */}
              <div className="rounded-xl border border-indigo-100 bg-indigo-50/40 p-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <h4 className="text-xs font-semibold text-slate-900">Send a Test Email to Myself</h4>
                    <p className="text-xs text-slate-500">
                      Dispatches a sample email to <strong>{userEmail}</strong> with real student variables and certificate attachment to verify formatting.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={handleSendTestEmail}
                    disabled={sendingTest || willSend === 0}
                    className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-indigo-200 bg-white px-3.5 py-1.5 text-xs font-semibold text-indigo-700 shadow-2xs hover:bg-indigo-50 disabled:opacity-50 cursor-pointer shrink-0"
                  >
                    {sendingTest ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Mail className="h-3.5 w-3.5" />}
                    {sendingTest ? 'Sending Test…' : 'Send Test to Me'}
                  </button>
                </div>

                {testResult && (
                  <div
                    className={`mt-2.5 flex items-center gap-2 rounded-lg p-2.5 text-xs ${
                      testResult.success
                        ? 'border border-emerald-200 bg-emerald-50 text-emerald-800'
                        : 'border border-rose-200 bg-rose-50 text-rose-800'
                    }`}
                  >
                    {testResult.success ? (
                      <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
                    ) : (
                      <AlertCircle className="h-4 w-4 shrink-0 text-rose-600" />
                    )}
                    <span>{testResult.message}</span>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2.5 border-t border-slate-200 bg-slate-50/80 px-6 py-3.5">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleLaunch}
            disabled={loading || launching || willSend === 0}
            className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
          >
            {launching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            {launching ? 'Launching…' : `Launch Campaign (${willSend})`}
          </button>
        </div>
      </div>
    </div>
  );
}
