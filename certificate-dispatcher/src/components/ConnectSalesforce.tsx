import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, KeyRound, Loader2, Plug, ShieldCheck, Unplug, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api, errorText } from '../api.ts';
import type { ConnectMethod, ConnectionInfo } from '../api.ts';

interface Props {
  current: ConnectionInfo | null;
  onConnected: (connection: ConnectionInfo) => void;
  onDisconnected: () => void;
  onUnauthorized: () => void;
  /** Present when shown as a popup. */
  onClose?: () => void;
  notice?: string;
}

const METHODS: { id: ConnectMethod; title: string; subtitle: string; icon: LucideIcon; badge?: string }[] = [
  { id: 'client_credentials', title: 'Client ID & Secret', subtitle: 'External Client App', icon: ShieldCheck, badge: 'Recommended' },
  { id: 'access_token', title: 'Access token', subtitle: 'From Salesforce CLI', icon: KeyRound },
];

const METHOD_LABEL: Record<ConnectMethod, string> = {
  client_credentials: 'Client ID & Secret',
  access_token: 'Access token',
  password: 'Username & password',
};

const inputCls =
  'w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30';

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1.5 block text-sm font-medium text-slate-700">{label}</label>
      {children}
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

const EMPTY = {
  myDomain: '',
  clientId: '',
  clientSecret: '',
  instanceUrl: '',
  accessToken: '',
};

export default function ConnectSalesforce({ current, onConnected, onDisconnected, onUnauthorized, onClose, notice }: Props) {
  const [method, setMethod] = useState<ConnectMethod>('client_credentials');
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Close on Escape key press
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && onClose) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const set = <K extends keyof typeof EMPTY>(key: K, value: (typeof EMPTY)[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const payload = () => {
    if (method === 'client_credentials') {
      return { method, myDomain: form.myDomain, clientId: form.clientId, clientSecret: form.clientSecret };
    }
    return { method, instanceUrl: form.instanceUrl, accessToken: form.accessToken };
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ success: true; connection: ConnectionInfo }>('/api/salesforce/connect', {
        method: 'POST',
        body: payload(),
      });
      setForm(EMPTY); // never keep secrets in the browser after use
      onConnected(res.connection);
    } catch (err) {
      if (err instanceof Error && 'status' in err && (err as { status: number }).status === 401) onUnauthorized();
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!window.confirm('Disconnect this Salesforce org? Your saved credentials will be deleted.')) return;
    setBusy(true);
    try {
      await api('/api/salesforce/connection', { method: 'DELETE' });
      onDisconnected();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Connect Salesforce org"
      onClick={(e) => {
        if (e.target === e.currentTarget && onClose) onClose();
      }}
    >
      <div className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
              <Plug className="h-5 w-5" aria-hidden />
            </div>
            <div>
              <h2 className="text-base font-semibold text-slate-900">Connect your Salesforce org</h2>
              <p className="text-sm text-slate-500">Your credentials are encrypted and only used for your account.</p>
            </div>
          </div>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"
            >
              <X className="h-5 w-5" aria-hidden />
            </button>
          )}
        </div>

        {/* Scrollable Body */}
        <div className="space-y-5 overflow-y-auto px-6 py-5 flex-1">
          {notice && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>{notice}</span>
            </div>
          )}

          {current && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3">
              <div className="flex items-center gap-2 text-sm text-emerald-900">
                <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
                <span>
                  Connected to <strong>{current.orgName}</strong> via {METHOD_LABEL[current.method]}
                </span>
              </div>
              <button
                type="button"
                onClick={() => void disconnect()}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-300 bg-white px-3 py-1.5 text-xs font-medium text-emerald-900 hover:bg-emerald-100 disabled:opacity-60"
              >
                <Unplug className="h-3.5 w-3.5" aria-hidden />
                Disconnect
              </button>
            </div>
          )}

          <div role="radiogroup" aria-label="Connection method" className="grid gap-2 sm:grid-cols-2">
            {METHODS.map(({ id, title, subtitle, icon: Icon, badge }) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={method === id}
                onClick={() => {
                  setMethod(id);
                  setError(null);
                }}
                className={`relative rounded-lg border p-3 text-left transition ${
                  method === id ? 'border-indigo-500 bg-indigo-50/60 ring-1 ring-indigo-500' : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'
                }`}
              >
                <Icon className={`h-5 w-5 ${method === id ? 'text-indigo-600' : 'text-slate-500'}`} aria-hidden />
                <p className="mt-2 text-sm font-medium text-slate-900">{title}</p>
                <p className="text-xs text-slate-500">{subtitle}</p>
                {badge && (
                  <span className="absolute right-2 top-2 rounded-full bg-indigo-600 px-2 py-0.5 text-[10px] font-semibold text-white">{badge}</span>
                )}
              </button>
            ))}
          </div>

          <form id="connect-salesforce-form" onSubmit={submit} className="space-y-4">
            {error && (
              <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                <span>{error}</span>
              </div>
            )}

            {method === 'client_credentials' && (
              <>
                <div className="rounded-lg bg-slate-50 p-3 text-xs leading-relaxed text-slate-600">
                  In Salesforce: <strong>Setup → External Client Apps Manager → New</strong>. Enable OAuth with the <em>api</em> scope, tick{' '}
                  <em>Enable Client Credentials Flow</em>, and set a <em>Run As</em> user under Policies. Then copy the Consumer Key and Secret.
                </div>
                <Field label="My Domain URL" hint="Setup → My Domain → Current My Domain URL">
                  <input required value={form.myDomain} onChange={(e) => set('myDomain', e.target.value)} placeholder="yourorg.my.salesforce.com" className={inputCls} autoComplete="off" />
                </Field>
                <Field label="Client ID (Consumer Key)">
                  <input required value={form.clientId} onChange={(e) => set('clientId', e.target.value)} className={inputCls} autoComplete="off" />
                </Field>
                <Field label="Client Secret (Consumer Secret)" hint="Saved encrypted so the server can renew the connection automatically.">
                  <input required type="password" value={form.clientSecret} onChange={(e) => set('clientSecret', e.target.value)} className={inputCls} autoComplete="new-password" />
                </Field>
              </>
            )}

            {method === 'access_token' && (
              <>
                <div className="rounded-lg bg-slate-50 p-3 text-xs leading-relaxed text-slate-600">
                  Run <code className="rounded bg-white px-1 py-0.5 font-mono text-[11px]">sf org display --verbose --target-org &lt;alias&gt;</code> and
                  copy the Instance Url and Access Token. Tokens usually expire after a couple of hours, so you will need to reconnect then.
                </div>
                <Field label="Instance URL">
                  <input required value={form.instanceUrl} onChange={(e) => set('instanceUrl', e.target.value)} placeholder="https://yourorg.my.salesforce.com" className={inputCls} autoComplete="off" />
                </Field>
                <Field label="Access token">
                  <input required type="password" value={form.accessToken} onChange={(e) => set('accessToken', e.target.value)} className={inputCls} autoComplete="new-password" />
                </Field>
              </>
            )}
          </form>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 border-t border-slate-200 px-6 py-4 bg-slate-50/50">
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </button>
          )}
          <button
            type="submit"
            form="connect-salesforce-form"
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:opacity-70"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Plug className="h-4 w-4" aria-hidden />}
            {busy ? 'Testing connection…' : current ? 'Reconnect' : 'Connect'}
          </button>
        </div>
      </div>
    </div>
  );
}
