import { useState } from 'react';
import { AlertTriangle, Check, Loader2, Mail, Save, Settings as SettingsIcon, Zap, X } from 'lucide-react';
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
    fromEmail: settings.fromEmail || '',
    dailyLimit: settings.dailyLimit ?? 0,
    smtpPassword: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const applyGmailPreset = () => {
    setForm((f) => ({
      ...f,
      smtpHost: 'smtp.gmail.com',
      smtpPort: 465,
      dailyLimit: 0,
    }));
  };

  const applyBrevoPreset = () => {
    setForm((f) => ({
      ...f,
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
            <h2 className="text-base font-semibold text-slate-900">Settings</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>

        <div className="space-y-8 overflow-y-auto px-6 py-5">
          {error && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>{error}</span>
            </div>
          )}

          <Section
            title="Sender email"
            description="Certificates are sent from this mailbox. We test the login before saving."
          >
            {/* Quick-setup Presets */}
            <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3.5">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Quick Setup Provider
              </span>
              <div className="mt-2 flex flex-wrap gap-2.5">
                <button
                  type="button"
                  onClick={applyGmailPreset}
                  className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                    form.smtpHost === 'smtp.gmail.com' && form.smtpPort === 465
                      ? 'border-indigo-500 bg-indigo-50 text-indigo-700'
                      : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  <Mail className="h-3.5 w-3.5" />
                  Gmail (smtp.gmail.com:465)
                  {form.smtpHost === 'smtp.gmail.com' && form.smtpPort === 465 && (
                    <Check className="h-3 w-3 text-indigo-600" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={applyBrevoPreset}
                  className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                    form.smtpHost === 'smtp-relay.brevo.com' && form.smtpPort === 2525
                      ? 'border-indigo-500 bg-indigo-50 text-indigo-700'
                      : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  <Zap className="h-3.5 w-3.5 text-amber-500" />
                  Brevo (Port 2525, Limit 250)
                  {form.smtpHost === 'smtp-relay.brevo.com' && form.smtpPort === 2525 && (
                    <Check className="h-3 w-3 text-indigo-600" />
                  )}
                </button>
              </div>
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
                label="App password"
                hint={
                  form.hasSmtpPassword
                    ? 'A password is saved. Leave empty to keep it.'
                    : 'For Gmail: Google Account → Security → App passwords. For Brevo: SMTP Master Password.'
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
              <Field
                label="Verified sender email (optional)"
                hint="Used as From email header (fromEmail || smtpUser). Required by Brevo if different from login."
              >
                <input
                  type="email"
                  value={form.fromEmail}
                  onChange={(e) => set('fromEmail', e.target.value)}
                  placeholder="verified@yourdomain.com"
                  className={inputCls}
                />
              </Field>
              <Field
                label="Daily send limit"
                hint="Rolling 24h limit (0 = unlimited). Brevo free tier is 300/day (250 recommended)."
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

            <details className="rounded-lg border border-slate-200 px-3 py-2 text-sm">
              <summary className="cursor-pointer font-medium text-slate-700">
                Advanced Mail server settings
              </summary>
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
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
            </details>
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

        <div className="flex justify-end gap-2 border-t border-slate-200 px-6 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:opacity-70"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Save className="h-4 w-4" aria-hidden />}
            {busy ? 'Saving…' : 'Save settings'}
          </button>
        </div>
      </form>
    </div>
  );
}
