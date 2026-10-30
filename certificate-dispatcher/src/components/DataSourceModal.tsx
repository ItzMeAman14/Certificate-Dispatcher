import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  FileText,
  Loader2,
  Save,
  Search,
  Sparkles,
  X,
} from 'lucide-react';
import { api, errorText, ApiError } from '../api.ts';
import type {
  PublicSettings,
  SalesforceObject,
  SalesforceField,
  DescribeFieldsResponse,
} from '../api.ts';

interface Props {
  currentSettings: PublicSettings;
  onSaved: (settings: PublicSettings) => void;
  onClose: () => void;
  onUnauthorized: () => void;
  isInitialSetup?: boolean;
}

const inputCls =
  'w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30';

export default function DataSourceModal({
  currentSettings,
  onSaved,
  onClose,
  onUnauthorized,
  isInitialSetup = false,
}: Props) {
  const [objects, setObjects] = useState<SalesforceObject[]>([]);
  const [search, setSearch] = useState('');
  const [loadingObjects, setLoadingObjects] = useState(true);
  const [selectedObject, setSelectedObject] = useState<string>(
    currentSettings.studentObject || ''
  );

  const [loadingFields, setLoadingFields] = useState(false);
  const [supportsFiles, setSupportsFiles] = useState(true);
  const [fields, setFields] = useState<SalesforceField[]>([]);

  const [nameField, setNameField] = useState(currentSettings.nameField || '');
  const [emailField, setEmailField] = useState(currentSettings.emailField || '');
  const [collegeField, setCollegeField] = useState(currentSettings.collegeField || '');
  const [statusField, setStatusField] = useState(currentSettings.statusField || '');

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Close on Escape key press
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Load objects on mount
  useEffect(() => {
    let cancelled = false;
    async function loadObjects() {
      setLoadingObjects(true);
      setError(null);
      try {
        const res = await api<{ success: true; objects: SalesforceObject[] }>(
          '/api/salesforce/objects'
        );
        if (cancelled) return;
        setObjects(res.objects || []);

        // Pre-select if nothing selected yet
        if (!selectedObject) {
          const matchStudent = res.objects.find(
            (o) => o.name.toLowerCase() === 'student__c'
          );
          if (matchStudent) {
            setSelectedObject(matchStudent.name);
          } else if (res.objects.length > 0) {
            setSelectedObject(res.objects[0].name);
          }
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) onUnauthorized();
        setError(errorText(err, 'Failed to fetch Salesforce objects.'));
      } finally {
        if (!cancelled) setLoadingObjects(false);
      }
    }
    loadObjects();
    return () => {
      cancelled = true;
    };
  }, []);

  // When selectedObject changes, load fields and perform auto-detection
  useEffect(() => {
    if (!selectedObject) {
      setFields([]);
      return;
    }

    let cancelled = false;
    async function loadFields() {
      setLoadingFields(true);
      setError(null);
      try {
        const res = await api<
          { success: true } & DescribeFieldsResponse
        >(`/api/salesforce/fields?object=${encodeURIComponent(selectedObject)}`);
        if (cancelled) return;

        setSupportsFiles(res.supportsFiles);
        setFields(res.fields || []);

        const availableFields = res.fields || [];

        // 1. Auto-detect Name field
        const existingName = availableFields.find(
          (f) => f.name.toLowerCase() === (currentSettings.nameField || '').toLowerCase()
        );
        if (existingName) {
          setNameField(existingName.name);
        } else {
          const detectedName =
            availableFields.find((f) => f.nameField) ||
            availableFields.find((f) => f.name === 'Name') ||
            availableFields[0];
          if (detectedName) setNameField(detectedName.name);
        }

        // 2. Auto-detect Email field
        const existingEmail = availableFields.find(
          (f) => f.name.toLowerCase() === (currentSettings.emailField || '').toLowerCase()
        );
        if (existingEmail) {
          setEmailField(existingEmail.name);
        } else {
          const detectedEmail =
            availableFields.find((f) => f.type === 'email') ||
            availableFields.find((f) => /email/i.test(f.name));
          if (detectedEmail) setEmailField(detectedEmail.name);
        }

        // 3. Auto-detect College field
        const existingCollege = availableFields.find(
          (f) => f.name.toLowerCase() === (currentSettings.collegeField || '').toLowerCase()
        );
        if (existingCollege) {
          setCollegeField(existingCollege.name);
        } else {
          const detectedCollege = availableFields.find((f) =>
            /universit|college|school/i.test(f.name)
          );
          setCollegeField(detectedCollege ? detectedCollege.name : '');
        }

        // 4. Auto-detect Status field
        const existingStatus = availableFields.find(
          (f) => f.name.toLowerCase() === (currentSettings.statusField || '').toLowerCase()
        );
        if (existingStatus) {
          setStatusField(existingStatus.name);
        } else {
          const detectedStatus = availableFields.find(
            (f) => f.type === 'picklist' && /status/i.test(f.name)
          );
          setStatusField(detectedStatus ? detectedStatus.name : '');
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) onUnauthorized();
        setError(errorText(err, `Failed to load fields for ${selectedObject}.`));
      } finally {
        if (!cancelled) setLoadingFields(false);
      }
    }

    loadFields();
    return () => {
      cancelled = true;
    };
  }, [selectedObject]);

  const filteredObjects = objects.filter(
    (o) =>
      o.name.toLowerCase().includes(search.toLowerCase()) ||
      o.label.toLowerCase().includes(search.toLowerCase())
  );

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedObject || !nameField || !emailField) {
      setError('Please select an object, name field, and email field.');
      return;
    }
    if (!supportsFiles) {
      setError('Selected object does not support file attachments.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const res = await api<{ success: true; settings: PublicSettings }>(
        '/api/datasource',
        {
          method: 'PUT',
          body: {
            studentObject: selectedObject,
            nameField,
            emailField,
            collegeField: collegeField || undefined,
            statusField: statusField || undefined,
          },
        }
      );
      onSaved(res.settings);
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onUnauthorized();
      setError(errorText(err, 'Failed to save data source settings.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Choose where your students are stored"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
              <Database className="h-5 w-5" aria-hidden />
            </div>
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                {isInitialSetup
                  ? 'Choose where your students are stored'
                  : 'Configure Salesforce Data Source'}
              </h2>
              <p className="text-xs text-slate-500">
                Pick the object and map fields so certificates dispatch accurately.
              </p>
            </div>
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

        {/* Scrollable Body */}
        <form
          id="datasource-form"
          onSubmit={handleSave}
          className="flex-1 overflow-y-auto px-6 py-5 space-y-6"
        >
          {error && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>{error}</span>
            </div>
          )}

          {/* Section 1: Object Selector */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-semibold text-slate-800">
                1. Select Student Object
              </label>
              {selectedObject && (
                <span className="text-xs text-indigo-600 font-mono font-medium">
                  Selected: {selectedObject}
                </span>
              )}
            </div>

            {loadingObjects ? (
              <div className="flex items-center justify-center py-8 text-sm text-slate-500">
                <Loader2 className="h-5 w-5 animate-spin mr-2" />
                Fetching Salesforce objects…
              </div>
            ) : (
              <div className="space-y-2">
                <div className="relative">
                  <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                  <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search objects (e.g. Student__c, Contact, Candidate)…"
                    className={`${inputCls} pl-9`}
                  />
                </div>

                <div className="max-h-44 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50/50 p-1.5 grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                  {filteredObjects.length === 0 ? (
                    <div className="col-span-2 py-4 text-center text-xs text-slate-500">
                      No matching objects found.
                    </div>
                  ) : (
                    filteredObjects.map((obj) => {
                      const isSelected = selectedObject === obj.name;
                      return (
                        <button
                          key={obj.name}
                          type="button"
                          onClick={() => setSelectedObject(obj.name)}
                          className={`flex items-center justify-between px-3 py-2 rounded-md text-left transition ${
                            isSelected
                              ? 'bg-indigo-600 text-white font-medium shadow-sm'
                              : 'bg-white hover:bg-slate-100 text-slate-800 border border-slate-200/60'
                          }`}
                        >
                          <div className="truncate mr-2">
                            <span className="block text-xs font-semibold truncate">
                              {obj.label}
                            </span>
                            <span
                              className={`block text-[11px] font-mono truncate ${
                                isSelected ? 'text-indigo-100' : 'text-slate-500'
                              }`}
                            >
                              {obj.name}
                            </span>
                          </div>
                          {obj.custom && (
                            <span
                              className={`shrink-0 text-[10px] uppercase font-bold px-1.5 py-0.5 rounded ${
                                isSelected
                                  ? 'bg-indigo-700 text-indigo-100'
                                  : 'bg-slate-100 text-slate-600'
                              }`}
                            >
                              Custom
                            </span>
                          )}
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Section 2: File Support Check */}
          {selectedObject && !loadingFields && (
            <div>
              {!supportsFiles ? (
                <div className="flex items-start gap-2.5 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
                  <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 mt-0.5" />
                  <div>
                    <span className="font-semibold">Object does not support files:</span>{' '}
                    The selected object (<code className="font-mono">{selectedObject}</code>)
                    does not have the <code className="font-mono">ContentDocumentLinks</code> child
                    relationship required for attached certificates. Please choose another object or
                    enable Files in Salesforce Setup.
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
                  <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
                  <span>
                    <strong>{selectedObject}</strong> supports file attachments via{' '}
                    <code className="font-mono text-[11px]">ContentDocumentLinks</code>.
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Section 3: Field Mappings */}
          {selectedObject && (
            <div className="space-y-4 pt-2 border-t border-slate-200">
              <div className="flex items-center justify-between">
                <label className="text-sm font-semibold text-slate-800 flex items-center gap-1.5">
                  2. Map Fields on <code className="font-mono text-indigo-600">{selectedObject}</code>
                </label>
                <span className="text-[11px] text-slate-500 flex items-center gap-1">
                  <Sparkles className="h-3.5 w-3.5 text-indigo-500" />
                  Auto-detected from schema
                </span>
              </div>

              {loadingFields ? (
                <div className="flex items-center justify-center py-6 text-sm text-slate-500">
                  <Loader2 className="h-5 w-5 animate-spin mr-2" />
                  Inspecting object fields…
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {/* Name field */}
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Student Name Field <span className="text-red-500">*</span>
                    </label>
                    <select
                      required
                      value={nameField}
                      onChange={(e) => setNameField(e.target.value)}
                      className={inputCls}
                    >
                      <option value="">-- Select Name field --</option>
                      {fields.map((f) => (
                        <option key={f.name} value={f.name}>
                          {f.label} ({f.name}) {f.nameField ? '★ Primary' : ''}
                        </option>
                      ))}
                    </select>
                    <p className="mt-1 text-[11px] text-slate-500">
                      Populates recipient name and &#123;&#123;studentName&#125;&#125;.
                    </p>
                  </div>

                  {/* Email field */}
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Student Email Field <span className="text-red-500">*</span>
                    </label>
                    <select
                      required
                      value={emailField}
                      onChange={(e) => setEmailField(e.target.value)}
                      className={inputCls}
                    >
                      <option value="">-- Select Email field --</option>
                      {fields.map((f) => (
                        <option key={f.name} value={f.name}>
                          {f.label} ({f.name}) {f.type === 'email' ? '✉ Email' : `[${f.type}]`}
                        </option>
                      ))}
                    </select>
                    <p className="mt-1 text-[11px] text-slate-500">
                      Destination email for certificate delivery.
                    </p>
                  </div>

                  {/* College field (optional) */}
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      College / University Field (optional)
                    </label>
                    <select
                      value={collegeField}
                      onChange={(e) => setCollegeField(e.target.value)}
                      className={inputCls}
                    >
                      <option value="">-- None (disable College filter) --</option>
                      {fields.map((f) => (
                        <option key={f.name} value={f.name}>
                          {f.label} ({f.name}) [{f.type}]
                        </option>
                      ))}
                    </select>
                    <p className="mt-1 text-[11px] text-slate-500">
                      Enables College column and college filter in student table.
                    </p>
                  </div>

                  {/* Status field (optional) */}
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Status Field (optional)
                    </label>
                    <select
                      value={statusField}
                      onChange={(e) => setStatusField(e.target.value)}
                      className={inputCls}
                    >
                      <option value="">-- None (disable Status filter) --</option>
                      {fields.map((f) => (
                        <option key={f.name} value={f.name}>
                          {f.label} ({f.name}) [{f.type}]
                        </option>
                      ))}
                    </select>
                    <p className="mt-1 text-[11px] text-slate-500">
                      Enables Status column and status filter in student table.
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}
        </form>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-slate-200 px-6 py-4 bg-slate-50/50">
          <div className="text-xs text-slate-500">
            {selectedObject ? (
              <span className="flex items-center gap-1 font-mono">
                <FileText className="h-3.5 w-3.5 text-indigo-500" />
                {selectedObject} → {emailField || 'no email set'}
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              form="datasource-form"
              disabled={
                saving ||
                loadingObjects ||
                loadingFields ||
                !selectedObject ||
                !nameField ||
                !emailField ||
                !supportsFiles
              }
              className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:opacity-60"
            >
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Save className="h-4 w-4" aria-hidden />
              )}
              {saving ? 'Saving…' : 'Save Data Source'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

