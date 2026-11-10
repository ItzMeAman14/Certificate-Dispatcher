import { useState, useEffect } from 'react';
import {
  X,
  Mail,
  Loader2,
  RefreshCw,
  Play,
  CheckCircle2,
  AlertTriangle,
  Clock,
  ArrowRight,
  FolderOpen,
} from 'lucide-react';
import { api, errorText } from '../api.ts';
import type { CampaignV2 } from '../api.ts';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSelectCampaign: (campaign: CampaignV2) => void;
  activeCampaignId?: string | null;
}

export default function CampaignsListModal({
  isOpen,
  onClose,
  onSelectCampaign,
  activeCampaignId,
}: Props) {
  const [campaigns, setCampaigns] = useState<CampaignV2[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchCampaigns = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api<{ success: true; campaigns: CampaignV2[] }>('/api/campaigns');
      setCampaigns(res.campaigns || []);
    } catch (err) {
      setError(errorText(err, 'Failed to load campaigns list.'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      void fetchCampaigns();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'running':
        return (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-700 border border-emerald-200">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
            Running
          </span>
        );
      case 'completed':
        return (
          <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-700 border border-slate-200">
            <CheckCircle2 className="h-3 w-3 text-emerald-600" />
            Completed
          </span>
        );
      case 'paused':
      case 'paused_limit':
      case 'paused_throttled':
      case 'paused_auth':
      case 'paused_salesforce':
        return (
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-700 border border-amber-200">
            <AlertTriangle className="h-3 w-3 text-amber-600" />
            Paused ({status.replace('paused_', '')})
          </span>
        );
      case 'cancelled':
        return (
          <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2.5 py-0.5 text-xs font-semibold text-red-700 border border-red-200">
            Cancelled
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
            {status}
          </span>
        );
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-xs"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex w-full max-w-3xl flex-col max-h-[85vh] rounded-2xl bg-white shadow-2xl overflow-hidden border border-slate-200">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4 bg-slate-50/70">
          <div className="flex items-center gap-2.5">
            <div className="rounded-lg bg-indigo-100 p-2 text-indigo-600">
              <FolderOpen className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-slate-900">Campaigns History</h2>
              <p className="text-xs text-slate-500">
                View, manage, or resume existing and past certificate campaigns
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void fetchCampaigns()}
              disabled={loading}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 cursor-pointer disabled:opacity-50"
              title="Refresh campaigns"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 cursor-pointer"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {error && (
            <div className="mb-4 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-700">
              {error}
            </div>
          )}

          {loading && campaigns.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-slate-400">
              <Loader2 className="h-8 w-8 animate-spin text-indigo-600 mb-2" />
              <p className="text-xs font-medium">Loading campaigns...</p>
            </div>
          ) : campaigns.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center text-slate-500">
              <Mail className="h-10 w-10 text-slate-300 mb-2" />
              <p className="text-sm font-semibold text-slate-700">No campaigns found</p>
              <p className="text-xs text-slate-400 max-w-sm mt-1">
                When you dispatch certificate emails to groups of students, your campaigns will appear here.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {campaigns.map((c) => {
                const isActive = c.id === activeCampaignId;
                const dateStr = new Date(c.createdAt).toLocaleDateString(undefined, {
                  year: 'numeric',
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                });

                return (
                  <div
                    key={c.id}
                    className={`flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-xl border transition ${
                      isActive
                        ? 'border-indigo-300 bg-indigo-50/50 shadow-2xs'
                        : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50/50'
                    }`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className="font-semibold text-sm text-slate-900 truncate">
                          {c.name}
                        </span>
                        {getStatusBadge(c.status)}
                        {isActive && (
                          <span className="rounded bg-indigo-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-indigo-700">
                            Current
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-slate-500 flex items-center gap-3 flex-wrap">
                        <span className="truncate max-w-xs">Subject: {c.subject}</span>
                        <span>•</span>
                        <span className="inline-flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {dateStr}
                        </span>
                      </div>
                      {c.pauseReason && (
                        <p className="mt-1 text-xs text-amber-700">
                          <strong>Note:</strong> {c.pauseReason}
                        </p>
                      )}
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => {
                          onSelectCampaign(c);
                          onClose();
                        }}
                        className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-semibold shadow-xs transition cursor-pointer ${
                          c.status === 'running'
                            ? 'bg-indigo-600 text-white hover:bg-indigo-700'
                            : 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 hover:text-indigo-600'
                        }`}
                      >
                        {c.status === 'running' ? (
                          <>
                            <Play className="h-3.5 w-3.5 fill-current" />
                            <span>View Running</span>
                          </>
                        ) : (
                          <>
                            <span>Open Campaign</span>
                            <ArrowRight className="h-3.5 w-3.5" />
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-slate-200 px-6 py-3.5 bg-slate-50 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100 cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

