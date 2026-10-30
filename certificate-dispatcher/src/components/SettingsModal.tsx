import { useState } from 'react';
import {
  AlertTriangle,
  Check,
  Globe,
  Loader2,
  Mail,
  Save,
  Server,
  Settings as SettingsIcon,
  ShieldCheck,
  Zap,
  X,
} from 'lucide-react';
import { ApiError, api, errorText } from '../api.ts';
import type { PublicSettings } from '../api.ts';

interface Props {
  settings: PublicSettings;
  onSaved: (settings: PublicSettings, emailConfigured: boolean) => void;
  onUnauthorized: () => void;
  onClose: () => void;
}

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

function Section({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
        <p className="text-xs text-slate-500">{description}</p>
      </div>
      {children}
    </section>
  );
}

export default function SettingsModal({ settings, onSaved, onUnauthorized, onClose }: Props) {
  const [form, setForm] = useState({
    ...settings,
    emailProvider: settings.emailProvider || (settings.hasBrevoApiKey ? 'brevo_api' : 'brevo_api'),
    brevoApiKey: '',
    fromEmail: settings.fromEmail || '',
    dailyLimit: settings.dailyLimit ?? 250,
    smtpPassword: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const applyGmailPreset = () => {
    setForm((f) => ({
      ...f,
      emailProvider: 'smtp',
      smtpHost: 'smtp.gmail.com',
      smtpPort: 465,
      dailyLimit: 0,
    }));
  };

  const applyBrevoSmtpPreset = () => {
    setForm((f) => ({
      ...f,
      emailProvider: 'smtp',
      smtpHost: 'smtp-relay.brevo.com',
      smtpPort: 2525,
      dailyLimit: 250,
    }));
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ success: true; settings: PublicSettings; emailConfigured: boolean }>('/api/settings', {
        method: 'PUT',
        body: form,
      });
      onSaved(res.settings, res.emailConfigured);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onUnauthorized();
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
    >
      <form
        onSubmit={save}
        className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
              <SettingsIcon className="h-5 w-5" aria-hidden />
            </div>
            <h2 className="text-base font-semibold text-slate-900">Email & Mailbox Settings</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 cursor-pointer"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>

        <div className="space-y-6 overflow-y-auto px-6 py-5">
          {error && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>{error}</span>
            </div>
          )}

          {/* Delivery Method Selection */}
          <Section
            title="Email Dispatch Method"
            description="Choose how certificates are sent. Brevo REST API is required for Render because Render blocks standard SMTP ports."
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => set('emailProvider', 'brevo_api')}
                className={`relative flex flex-col p-4 text-left rounded-xl border transition cursor-pointer ${
                  form.emailProvider === 'brevo_api'
                    ? 'border-indigo-600 bg-indigo-50/60 ring-2 ring-indigo-500/20'
                    : 'border-slate-200 bg-white hover:bg-slate-50'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Globe className="h-5 w-5 text-indigo-600" />
                    <span className="font-semibold text-slate-900 text-sm">Brevo REST API</span>
                  </div>
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-800">
                    <ShieldCheck className="h-3 w-3" />
                    Render Safe (Port 443)
                  </span>
                </div>
                <p className="mt-2 text-xs text-slate-500 leading-relaxed">
                  Sends via standard HTTPS (Port 443). Bypasses Render port blocking 100% reliably.
                </p>
              </button>

              <button
                type="button"
                onClick={() => set('emailProvider', 'smtp')}
                className={`relative flex flex-col p-4 text-left rounded-xl border transition cursor-pointer ${
                  form.emailProvider === 'smtp'
                    ? 'border-indigo-600 bg-indigo-50/60 ring-2 ring-indigo-500/20'
                    : 'border-slate-200 bg-white hover:bg-slate-50'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Server className="h-5 w-5 text-slate-600" />
                    <span className="font-semibold text-slate-900 text-sm">SMTP Server</span>
                  </div>
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600">
                    Ports 465 / 587
                  </span>
                </div>
                <p className="mt-2 text-xs text-slate-500 leading-relaxed">
                  Direct SMTP relay. Best for local development or hosts with unblocked SMTP.
                </p>
              </button>
            </div>

            {/* Provider Configuration Forms */}
            {form.emailProvider === 'brevo_api' ? (
              <div className="space-y-4 rounded-xl border border-indigo-100 bg-indigo-50/40 p-4">
                <div className="flex items-start gap-2.5 text-xs text-indigo-900">
                  <Zap className="h-4 w-4 shrink-0 text-indigo-600 mt-0.5" />
                  <div>
                    <strong>How to get your Brevo API key:</strong> Log in to Brevo → click your name (top right) →{' '}
                    <strong>SMTP & API</strong> → <strong>API Keys</strong> tab → click <strong>Generate a new API key</strong>.
                    Key starts with <code className="font-mono font-semibold">xkeysib-...</code>.
                  </div>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <Field
                    label="Brevo API Key (v3)"
                    hint={
                      form.hasBrevoApiKey
                        ? 'An API key is saved. Leave empty to keep it.'
                        : 'Starts with xkeysib-...'
                    }
                  >
                    <input
                      type="password"
                      value={form.brevoApiKey}
                      onChange={(e) => set('brevoApiKey', e.target.value)}
                      placeholder={form.hasBrevoApiKey ? '••••••••••••••••' : 'xkeysib-...'}
                      className={inputCls}
                      autoComplete="off"
                    />
                  </Field>

                  <Field
                    label="Verified Sender Email"
                    hint="Must be verified in Brevo (Senders & IP → Senders)."
                  >
                    <input
                      type="email"
                      required
                      value={form.fromEmail || form.smtpUser}
                      onChange={(e) => {
                        set('fromEmail', e.target.value);
                        set('smtpUser', e.target.value);
                      }}
                      placeholder="sender@yourdomain.com"
                      className={inputCls}
                    />
                  </Field>
                </div>

                <Field
                  label="Daily send limit"
                  hint="Emails per rolling 24h. Brevo free plan allows 300/day (250 recommended)."
                >
                  <input
                    type="number"
                    min="0"
                    value={form.dailyLimit}
                    onChange={(e) => set('dailyLimit', Math.max(0, parseInt(e.target.value, 10) || 0))}
                    className={inputCls}
                  />
                </Field>
              </div>
            ) : (
              <div className="space-y-4 rounded-xl border border-slate-200 bg-slate-50/60 p-4">
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={applyGmailPreset}
                    className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition cursor-pointer ${
                      form.smtpHost === 'smtp.gmail.com' && form.smtpPort === 465
                        ? 'border-indigo-500 bg-indigo-50 text-indigo-700'
                        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    <Mail className="h-3.5 w-3.5" />
                    Gmail Preset (465)
                    {form.smtpHost === 'smtp.gmail.com' && form.smtpPort === 465 && (
                      <Check className="h-3 w-3 text-indigo-600" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={applyBrevoSmtpPreset}
                    className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition cursor-pointer ${
                      form.smtpHost === 'smtp-relay.brevo.com' && form.smtpPort === 2525
                        ? 'border-indigo-500 bg-indigo-50 text-indigo-700'
                        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    <Zap className="h-3.5 w-3.5 text-amber-500" />
                    Brevo SMTP Preset (2525)
                    {form.smtpHost === 'smtp-relay.brevo.com' && form.smtpPort === 2525 && (
                      <Check className="h-3 w-3 text-indigo-600" />
                    )}
                  </button>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="SMTP username / email">
                    <input
                      type="email"
                      value={form.smtpUser}
                      onChange={(e) => set('smtpUser', e.target.value)}
                      placeholder="user@example.com"
                      className={inputCls}
                      autoComplete="off"
                    />
                  </Field>
                  <Field
                    label="App password / SMTP Key"
                    hint={
                      form.hasSmtpPassword
                        ? 'A password is saved. Leave empty to keep it.'
                        : 'For Brevo: SMTP Key under SMTP tab. For Gmail: App password.'
                    }
                  >
                    <input
                      type="password"
                      value={form.smtpPassword}
                      onChange={(e) => set('smtpPassword', e.target.value)}
                      placeholder={form.hasSmtpPassword ? '••••••••••••••••' : ''}
                      className={inputCls}
                      autoComplete="new-password"
                    />
                  </Field>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="SMTP host">
                    <input
                      value={form.smtpHost}
                      onChange={(e) => set('smtpHost', e.target.value)}
                      className={inputCls}
                    />
                  </Field>
                  <Field label="Port" hint="465 (SSL), 587 (STARTTLS), 25 or 2525">
                    <input
                      type="number"
                      value={form.smtpPort}
                      onChange={(e) => set('smtpPort', Number(e.target.value))}
                      className={inputCls}
                    />
                  </Field>
                </div>
              </div>
            )}
          </Section>

          <Section
            title="Email details"
            description="Used by the placeholders in your template and on every message."
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Company / display name"
                hint="Shown as the sender name and in {{companyName}}."
              >
                <input
                  value={form.fromName}
                  onChange={(e) => set('fromName', e.target.value)}
                  placeholder="Astrea IT Services"
                  className={inputCls}
                />
              </Field>
              <Field label="Signer name" hint="Fills {{hrName}} in your template.">
                <input
                  value={form.hrName}
                  onChange={(e) => set('hrName', e.target.value)}
                  placeholder="HR Team"
                  className={inputCls}
                />
              </Field>
              <Field label="CC (optional)" hint="Separate several emails with commas.">
                <input
                  value={form.cc}
                  onChange={(e) => set('cc', e.target.value)}
                  placeholder="manager@company.com"
                  className={inputCls}
                />
              </Field>
              <Field label="Reply-to (optional)">
                <input
                  type="email"
                  value={form.replyTo}
                  onChange={(e) => set('replyTo', e.target.value)}
                  className={inputCls}
                />
              </Field>
            </div>
            <Field
              label="Logo URL (optional)"
              hint="A public https:// image link. Used by the Logo block in the template builder."
            >
              <input
                value={form.logoUrl}
                onChange={(e) => set('logoUrl', e.target.value)}
                placeholder="https://company.com/logo.png"
                className={inputCls}
              />
            </Field>
          </Section>
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-200 px-6 py-3 bg-slate-50/50">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:opacity-70 cursor-pointer"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Save className="h-4 w-4" aria-hidden />}
            {busy ? 'Verifying & Saving…' : 'Save settings'}
          </button>
        </div>
      </form>
    </div>
  );
}
