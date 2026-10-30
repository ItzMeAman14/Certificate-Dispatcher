import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDown,
  ArrowUp,
  BadgeCheck,
  Copy,
  Eye,
  Heading1,
  Image as ImageIcon,
  LayoutTemplate,
  Minus,
  MousePointerClick,
  MoveVertical,
  Paperclip,
  PenLine,
  RotateCcw,
  Save,
  Trash2,
  Type,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/* -------------------------------------------------------------------------- */
/*                                 Block model                                */
/* -------------------------------------------------------------------------- */

export type Align = 'left' | 'center' | 'right';

export type Block =
  | { id: string; type: 'logo'; align: Align; height: number }
  | { id: string; type: 'heading'; text: string; align: Align; color: string; size: number }
  | { id: string; type: 'text'; text: string; align: Align; color: string; size: number }
  | { id: string; type: 'button'; label: string; url: string; align: Align; bg: string; color: string }
  | { id: string; type: 'image'; url: string; alt: string; width: number; align: Align }
  | { id: string; type: 'callout'; text: string; bg: string; color: string }
  | { id: string; type: 'divider'; color: string }
  | { id: string; type: 'spacer'; height: number };

export type BlockType = Block['type'];

export interface EmailTemplate {
  subject: string;
  html: string; // generated from blocks; this is what the server receives
  blocks: Block[];
}

export interface PreviewSample {
  studentName: string;
  studentEmail: string;
  fileName: string;
}

const uid = () => Math.random().toString(36).slice(2, 10);

const BLOCK_META: Record<BlockType, { label: string; hint: string; icon: LucideIcon }> = {
  logo: { label: 'Logo', hint: 'Company logo', icon: BadgeCheck },
  heading: { label: 'Heading', hint: 'Large title', icon: Heading1 },
  text: { label: 'Text', hint: 'Paragraph or footer', icon: Type },
  button: { label: 'Button', hint: 'Link button', icon: MousePointerClick },
  image: { label: 'Image', hint: 'Picture from a URL', icon: ImageIcon },
  callout: { label: 'Attachment note', hint: 'Highlighted box', icon: Paperclip },
  divider: { label: 'Divider', hint: 'Horizontal line', icon: Minus },
  spacer: { label: 'Spacer', hint: 'Empty space', icon: MoveVertical },
};

const BLOCK_TYPES = Object.keys(BLOCK_META) as BlockType[];

const VARIABLES: { key: string; label: string }[] = [
  { key: 'studentName', label: 'Student name' },
  { key: 'studentEmail', label: 'Student email' },
  { key: 'fileName', label: 'File name' },
  { key: 'hrName', label: 'Signer name' },
  { key: 'companyName', label: 'Company name' },
  { key: 'year', label: 'Year' },
];

function createBlock(type: BlockType): Block {
  const id = uid();
  switch (type) {
    case 'logo':
      return { id, type, align: 'left', height: 40 };
    case 'heading':
      return { id, type, text: 'Congratulations, {{studentName}}!', align: 'left', color: '#0f172a', size: 24 };
    case 'text':
      return { id, type, text: 'Write your message here.', align: 'left', color: '#334155', size: 15 };
    case 'button':
      return { id, type, label: 'Learn more', url: 'https://', align: 'left', bg: '#4f46e5', color: '#ffffff' };
    case 'image':
      return { id, type, url: '', alt: '', width: 100, align: 'center' };
    case 'callout':
      return { id, type, text: '📎 {{fileName}} is attached to this email.', bg: '#eef2ff', color: '#3730a3' };
    case 'divider':
      return { id, type, color: '#e2e8f0' };
    case 'spacer':
      return { id, type, height: 24 };
  }
}

function defaultBlocks(): Block[] {
  return [
    { id: uid(), type: 'logo', align: 'left', height: 40 },
    { id: uid(), type: 'heading', text: 'Congratulations, {{studentName}}!', align: 'left', color: '#0f172a', size: 24 },
    {
      id: uid(),
      type: 'text',
      text: 'We are pleased to share your certificate with you. Please find it attached to this email.',
      align: 'left',
      color: '#334155',
      size: 15,
    },
    { id: uid(), type: 'callout', text: '📎 {{fileName}} is attached to this email.', bg: '#eef2ff', color: '#3730a3' },
    {
      id: uid(),
      type: 'text',
      text: 'Best regards,\n{{hrName}}\n{{companyName}}',
      align: 'left',
      color: '#334155',
      size: 15,
    },
    { id: uid(), type: 'divider', color: '#e2e8f0' },
    { id: uid(), type: 'text', text: '© {{year}} {{companyName}}', align: 'left', color: '#64748b', size: 12 },
  ];
}

/* -------------------------------------------------------------------------- */
/*                          Safe HTML generation (email)                      */
/* -------------------------------------------------------------------------- */

const esc = (v: string) =>
  v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const multiline = (v: string) => esc(v).replace(/\n/g, '<br>');
const safeColor = (c: string, fallback: string) => (/^#[0-9a-f]{3,8}$/i.test(c) ? c : fallback);
const safeAlign = (a: string): Align => (a === 'center' || a === 'right' ? a : 'left');
const safeLink = (u: string) => (/^(https?:\/\/|mailto:)/i.test(u.trim()) ? esc(u.trim()) : '#');
const safeImage = (u: string) => (/^https?:\/\//i.test(u.trim()) ? esc(u.trim()) : '');
const clamp = (n: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.round(Number(n)) || min));

/** Each block becomes email-safe inline-styled HTML. {{placeholders}} stay in place. */
export function blockToHtml(b: Block): string {
  switch (b.type) {
    case 'logo': {
      const h = clamp(b.height, 16, 160);
      return `<div style="text-align:${safeAlign(b.align)};margin:0 0 20px"><img src="{{logoSrc}}" alt="Company logo" height="${h}" style="height:${h}px;border:0;display:inline-block"></div>`;
    }
    case 'heading':
      return `<h2 style="margin:0 0 12px;font-size:${clamp(b.size, 14, 48)}px;line-height:1.3;color:${safeColor(b.color, '#0f172a')};text-align:${safeAlign(b.align)}">${multiline(b.text)}</h2>`;
    case 'text':
      return `<p style="margin:0 0 16px;font-size:${clamp(b.size, 10, 28)}px;color:${safeColor(b.color, '#334155')};text-align:${safeAlign(b.align)}">${multiline(b.text)}</p>`;
    case 'button':
      return `<div style="text-align:${safeAlign(b.align)};margin:0 0 20px"><a href="${safeLink(b.url)}" style="display:inline-block;padding:12px 24px;background:${safeColor(b.bg, '#4f46e5')};color:${safeColor(b.color, '#ffffff')};text-decoration:none;border-radius:6px;font-weight:bold;font-size:15px">${esc(b.label)}</a></div>`;
    case 'image': {
      const src = safeImage(b.url);
      if (!src) return '';
      return `<div style="text-align:${safeAlign(b.align)};margin:0 0 20px"><img src="${src}" alt="${esc(b.alt)}" style="width:${clamp(b.width, 10, 100)}%;max-width:100%;height:auto;border:0;display:inline-block"></div>`;
    }
    case 'callout':
      return `<div style="margin:0 0 20px;padding:14px 16px;background:${safeColor(b.bg, '#eef2ff')};color:${safeColor(b.color, '#3730a3')};border-radius:6px;font-size:14px">${multiline(b.text)}</div>`;
    case 'divider':
      return `<hr style="border:0;border-top:1px solid ${safeColor(b.color, '#e2e8f0')};margin:20px 0">`;
    case 'spacer': {
      const h = clamp(b.height, 4, 120);
      return `<div style="height:${h}px;line-height:${h}px;font-size:0">&nbsp;</div>`;
    }
  }
}

export const blocksToHtml = (blocks: Block[]) =>
  blocks.map(blockToHtml).filter(Boolean).join('\n');

function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/{{\s*(\w+)\s*}}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match,
  );
}

const SHELL_STYLE =
  'font-family:Arial,Helvetica,sans-serif;color:#0f172a;line-height:1.6';

/* -------------------------------------------------------------------------- */
/*                              Template helpers                              */
/* -------------------------------------------------------------------------- */

const DEFAULT_SUBJECT = 'Your certificate from {{companyName}}';

export function makeTemplate(subject: string, blocks: Block[]): EmailTemplate {
  return { subject, blocks, html: blocksToHtml(blocks) };
}

export const getDefaultTemplate = (): EmailTemplate => makeTemplate(DEFAULT_SUBJECT, defaultBlocks());

function isBlock(value: unknown): value is Block {
  if (!value || typeof value !== 'object') return false;
  const v = value as { id?: unknown; type?: unknown };
  return typeof v.id === 'string' && typeof v.type === 'string' && v.type in BLOCK_META;
}

/** Validates a template received from the server; returns null if it is missing or malformed. */
export function normalizeTemplate(raw: unknown): EmailTemplate | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { subject?: unknown; blocks?: unknown };
  if (typeof r.subject === 'string' && Array.isArray(r.blocks) && r.blocks.every(isBlock)) {
    return makeTemplate(r.subject, r.blocks as Block[]);
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*                            Properties panel pieces                         */
/* -------------------------------------------------------------------------- */

const inputCls =
  'w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-medium text-slate-600">{label}</label>
      {children}
    </div>
  );
}

function AlignControl({ value, onChange }: { value: Align; onChange: (a: Align) => void }) {
  const options: { v: Align; Icon: LucideIcon; label: string }[] = [
    { v: 'left', Icon: AlignLeft, label: 'Align left' },
    { v: 'center', Icon: AlignCenter, label: 'Align center' },
    { v: 'right', Icon: AlignRight, label: 'Align right' },
  ];
  return (
    <div className="inline-flex rounded-lg border border-slate-200 p-0.5">
      {options.map(({ v, Icon, label }) => (
        <button
          key={v}
          type="button"
          aria-label={label}
          aria-pressed={value === v}
          onClick={() => onChange(v)}
          className={`rounded-md p-1.5 ${value === v ? 'bg-slate-900 text-white' : 'text-slate-500 hover:bg-slate-100'}`}
        >
          <Icon className="h-4 w-4" aria-hidden />
        </button>
      ))}
    </div>
  );
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (c: string) => void }) {
  return (
    <Field label={label}>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={safeColor(value, '#000000').slice(0, 7)}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 w-12 cursor-pointer rounded-md border border-slate-200 bg-white p-1"
          aria-label={label}
        />
        <span className="font-mono text-xs text-slate-500">{value}</span>
      </div>
    </Field>
  );
}

function RangeField({
  label,
  value,
  min,
  max,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  unit: string;
  onChange: (n: number) => void;
}) {
  return (
    <Field label={`${label} (${value}${unit})`}>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-indigo-600"
      />
    </Field>
  );
}

type TextEl = HTMLTextAreaElement | HTMLInputElement;

interface PanelProps {
  block: Block;
  onChange: (patch: Record<string, unknown>) => void;
  textRef: React.MutableRefObject<TextEl | null>;
  onInsertVariable: (key: string) => void;
}

function PropertiesPanel({ block, onChange, textRef, onInsertVariable }: PanelProps) {
  const hasText = block.type === 'heading' || block.type === 'text' || block.type === 'callout' || block.type === 'button';

  return (
    <div className="space-y-4">
      {(block.type === 'heading' || block.type === 'text' || block.type === 'callout') && (
        <Field label="Text">
          <textarea
            ref={(el) => {
              textRef.current = el;
            }}
            value={block.text}
            rows={block.type === 'heading' ? 2 : 5}
            onChange={(e) => onChange({ text: e.target.value })}
            className={`${inputCls} resize-y`}
          />
        </Field>
      )}

      {block.type === 'button' && (
        <>
          <Field label="Button label">
            <input
              ref={(el) => {
                textRef.current = el;
              }}
              value={block.label}
              onChange={(e) => onChange({ label: e.target.value })}
              className={inputCls}
            />
          </Field>
          <Field label="Link URL">
            <input
              value={block.url}
              onChange={(e) => onChange({ url: e.target.value })}
              placeholder="https://example.com"
              className={inputCls}
            />
          </Field>
        </>
      )}

      {block.type === 'image' && (
        <>
          <Field label="Image URL (https)">
            <input
              value={block.url}
              onChange={(e) => onChange({ url: e.target.value })}
              placeholder="https://example.com/banner.png"
              className={inputCls}
            />
          </Field>
          <Field label="Alt text">
            <input value={block.alt} onChange={(e) => onChange({ alt: e.target.value })} className={inputCls} />
          </Field>
          <RangeField label="Width" value={block.width} min={10} max={100} unit="%" onChange={(n) => onChange({ width: n })} />
        </>
      )}

      {block.type === 'logo' && (
        <>
          <RangeField label="Height" value={block.height} min={20} max={120} unit="px" onChange={(n) => onChange({ height: n })} />
          <p className="text-xs text-slate-500">The logo image comes from the Logo URL in Settings.</p>
        </>
      )}

      {block.type === 'spacer' && (
        <RangeField label="Height" value={block.height} min={4} max={120} unit="px" onChange={(n) => onChange({ height: n })} />
      )}

      {(block.type === 'heading' || block.type === 'text') && (
        <Field label="Font size">
          <select
            value={block.size}
            onChange={(e) => onChange({ size: Number(e.target.value) })}
            className={inputCls}
          >
            {(block.type === 'heading' ? [20, 24, 28, 32] : [12, 14, 15, 16, 18]).map((s) => (
              <option key={s} value={s}>
                {s}px
              </option>
            ))}
          </select>
        </Field>
      )}

      {(block.type === 'heading' || block.type === 'text') && (
        <ColorField label="Text color" value={block.color} onChange={(c) => onChange({ color: c })} />
      )}

      {block.type === 'callout' && (
        <div className="grid grid-cols-2 gap-3">
          <ColorField label="Background" value={block.bg} onChange={(c) => onChange({ bg: c })} />
          <ColorField label="Text color" value={block.color} onChange={(c) => onChange({ color: c })} />
        </div>
      )}

      {block.type === 'button' && (
        <div className="grid grid-cols-2 gap-3">
          <ColorField label="Button color" value={block.bg} onChange={(c) => onChange({ bg: c })} />
          <ColorField label="Label color" value={block.color} onChange={(c) => onChange({ color: c })} />
        </div>
      )}

      {block.type === 'divider' && (
        <ColorField label="Line color" value={block.color} onChange={(c) => onChange({ color: c })} />
      )}

      {'align' in block && (
        <Field label="Alignment">
          <AlignControl value={block.align} onChange={(a) => onChange({ align: a })} />
        </Field>
      )}

      {hasText && (
        <div>
          <p className="mb-1.5 text-xs font-medium text-slate-600">Insert student detail</p>
          <div className="flex flex-wrap gap-1.5">
            {VARIABLES.map((v) => (
              <button
                key={v.key}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onInsertVariable(v.key)}
                className="rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-100"
              >
                {v.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                                  Builder UI                                */
/* -------------------------------------------------------------------------- */

interface Props {
  initial: EmailTemplate;
  sample: PreviewSample;
  logoUrl: string;
  companyName: string;
  hrName: string;
  onSave: (template: EmailTemplate) => void;
  onClose: () => void;
}

const NEW_BLOCK_MIME = 'application/x-new-block';
const MOVE_BLOCK_MIME = 'application/x-block-id';

export default function EmailTemplateEditor({ initial, sample, logoUrl, companyName, hrName, onSave, onClose }: Props) {
  const [subject, setSubject] = useState(initial.subject);
  const [blocks, setBlocks] = useState<Block[]>(initial.blocks);
  const [selectedId, setSelectedId] = useState<string | null>(initial.blocks[0]?.id ?? null);
  const [view, setView] = useState<'canvas' | 'preview'>('canvas');
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const textRef = useRef<TextEl | null>(null);

  const selectedIndex = blocks.findIndex((b) => b.id === selectedId);
  const selected = selectedIndex >= 0 ? blocks[selectedIndex] : null;

  const vars = useMemo<Record<string, string>>(
    () => ({
      studentName: esc(sample.studentName),
      studentEmail: esc(sample.studentEmail),
      fileName: esc(sample.fileName),
      hrName: esc(hrName || 'Your name'),
      companyName: esc(companyName || 'Your company'),
      year: String(new Date().getFullYear()),
      logoSrc: logoUrl,
    }),
    [sample, logoUrl, hrName, companyName],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /* ------------------------------ Block actions ----------------------------- */

  const insertBlock = (block: Block, index: number) => {
    setBlocks((prev) => {
      const next = [...prev];
      next.splice(Math.min(Math.max(index, 0), next.length), 0, block);
      return next;
    });
    setSelectedId(block.id);
  };

  const moveBlock = (id: string, toIndex: number) => {
    setBlocks((prev) => {
      const from = prev.findIndex((b) => b.id === id);
      if (from === -1) return prev;
      const next = [...prev];
      const [item] = next.splice(from, 1);
      next.splice(from < toIndex ? toIndex - 1 : toIndex, 0, item);
      return next;
    });
  };

  const moveBy = (id: string, delta: -1 | 1) => {
    setBlocks((prev) => {
      const from = prev.findIndex((b) => b.id === id);
      const to = from + delta;
      if (from === -1 || to < 0 || to >= prev.length) return prev;
      const next = [...prev];
      [next[from], next[to]] = [next[to], next[from]];
      return next;
    });
  };

  const duplicateBlock = (id: string) => {
    const index = blocks.findIndex((b) => b.id === id);
    if (index === -1) return;
    insertBlock({ ...blocks[index], id: uid() }, index + 1);
  };

  const deleteBlock = (id: string) => {
    const index = blocks.findIndex((b) => b.id === id);
    const next = blocks.filter((b) => b.id !== id);
    setBlocks(next);
    if (selectedId === id) setSelectedId(next[Math.min(index, next.length - 1)]?.id ?? null);
  };

  const updateBlock = (patch: Record<string, unknown>) => {
    if (!selectedId) return;
    setBlocks((prev) => prev.map((b) => (b.id === selectedId ? ({ ...b, ...patch } as Block) : b)));
  };

  const addFromPalette = (type: BlockType) =>
    insertBlock(createBlock(type), selectedIndex >= 0 ? selectedIndex + 1 : blocks.length);

  const insertVariable = (key: string) => {
    const el = textRef.current;
    if (!el || !selected) return;
    const token = `{{${key}}}`;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    const next = el.value.slice(0, start) + token + el.value.slice(end);
    updateBlock({ [selected.type === 'button' ? 'label' : 'text']: next });
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };

  /* ------------------------------ Drag and drop ----------------------------- */

  const onBlockDragOver = (e: DragEvent<HTMLDivElement>, index: number) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    setDropIndex(e.clientY > rect.top + rect.height / 2 ? index + 1 : index);
  };

  const onCanvasDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDropIndex(blocks.length);
  };

  const onCanvasDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const index = dropIndex ?? blocks.length;
    const newType = e.dataTransfer.getData(NEW_BLOCK_MIME) as BlockType;
    const moveId = e.dataTransfer.getData(MOVE_BLOCK_MIME);

    if (newType && BLOCK_TYPES.includes(newType)) insertBlock(createBlock(newType), index);
    else if (moveId) moveBlock(moveId, index);

    setDropIndex(null);
    setDraggingId(null);
  };

  /* ------------------------------- Save / reset ----------------------------- */

  const handleSave = () => {
    const template = makeTemplate(subject, blocks);
    onSave(template);
  };

  const handleReset = () => {
    const fresh = getDefaultTemplate();
    setSubject(fresh.subject);
    setBlocks(fresh.blocks);
    setSelectedId(fresh.blocks[0]?.id ?? null);
  };

  const finalHtml = useMemo(() => fillTemplate(blocksToHtml(blocks), vars), [blocks, vars]);
  const previewDoc = `<!doctype html><html><body style="margin:0;padding:24px;background:#f1f5f9;${SHELL_STYLE}"><div style="max-width:600px;margin:0 auto;background:#fff;border-radius:8px;padding:32px">${finalHtml}</div></body></html>`;
  const previewSubject = fillTemplate(subject, {
    studentName: sample.studentName,
    studentEmail: sample.studentEmail,
    fileName: sample.fileName,
    hrName: hrName || 'Your name',
    companyName: companyName || 'Your company',
    year: vars.year,
  });

  /* --------------------------------- Render -------------------------------- */

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/50 p-3 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Email template builder"
    >
      <div className="flex h-[94vh] w-full max-w-7xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        {/* Header */}
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 px-5 py-3">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
              <PenLine className="h-5 w-5" aria-hidden />
            </div>
            <h2 className="text-base font-semibold text-slate-900">Email template builder</h2>
          </div>

          <div className="flex min-w-[16rem] flex-1 items-center gap-2 sm:max-w-xl">
            <label htmlFor="tpl-subject" className="shrink-0 text-sm font-medium text-slate-600">
              Subject
            </label>
            <input
              id="tpl-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className={inputCls}
            />
          </div>

          <div className="ml-auto flex items-center gap-2">
            <div className="inline-flex rounded-lg border border-slate-200 p-0.5 text-xs font-medium">
              <button
                type="button"
                onClick={() => setView('canvas')}
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 ${
                  view === 'canvas' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                <LayoutTemplate className="h-3.5 w-3.5" aria-hidden />
                Canvas
              </button>
              <button
                type="button"
                onClick={() => setView('preview')}
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 ${
                  view === 'preview' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                <Eye className="h-3.5 w-3.5" aria-hidden />
                Preview
              </button>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close builder"
              className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"
            >
              <X className="h-5 w-5" aria-hidden />
            </button>
          </div>
        </div>

        {/* Workspace */}
        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[14rem_minmax(0,1fr)_19rem]">
          {/* Palette */}
          <aside className="overflow-y-auto border-b border-slate-200 bg-white p-4 lg:border-b-0 lg:border-r">
            <p className="text-sm font-medium text-slate-900">Blocks</p>
            <p className="mt-0.5 text-xs text-slate-500">Drag onto the canvas, or click to add.</p>
            <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-1">
              {BLOCK_TYPES.map((type) => {
                const { label, hint, icon: Icon } = BLOCK_META[type];
                return (
                  <button
                    key={type}
                    type="button"
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData(NEW_BLOCK_MIME, type);
                      e.dataTransfer.effectAllowed = 'copy';
                    }}
                    onDragEnd={() => setDropIndex(null)}
                    onClick={() => {
                      setView('canvas');
                      addFromPalette(type);
                    }}
                    className="flex cursor-grab items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2 text-left shadow-sm transition hover:border-indigo-300 hover:bg-indigo-50/40 active:cursor-grabbing"
                  >
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-slate-100 text-slate-600">
                      <Icon className="h-4 w-4" aria-hidden />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-slate-800">{label}</span>
                      <span className="block truncate text-xs text-slate-500">{hint}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </aside>

          {/* Canvas / preview */}
          <main className="min-h-[360px] overflow-y-auto bg-slate-100 p-4 sm:p-6">
            {view === 'preview' ? (
              <div className="mx-auto flex h-full max-w-[680px] flex-col">
                <p className="truncate text-xs text-slate-500">
                  Subject: <span className="font-medium text-slate-700">{previewSubject}</span>
                </p>
                <iframe
                  title="Email preview"
                  sandbox=""
                  srcDoc={previewDoc}
                  className="mt-2 w-full flex-1 rounded-lg border border-slate-200 bg-white shadow-sm"
                />
              </div>
            ) : (
              <div
                className="mx-auto max-w-[600px] rounded-lg bg-white p-8 shadow-sm"
                style={{ fontFamily: 'Arial, Helvetica, sans-serif', lineHeight: 1.6, color: '#0f172a' }}
                onDragOver={onCanvasDragOver}
                onDrop={onCanvasDrop}
                onClick={() => setSelectedId(null)}
              >
                {blocks.length === 0 && (
                  <div className="rounded-lg border-2 border-dashed border-slate-300 py-16 text-center text-sm text-slate-500">
                    Drag a block here or click one on the left to start.
                  </div>
                )}

                {blocks.map((block, index) => {
                  const isSelected = block.id === selectedId;
                  const emptyImage = (block.type === 'image' && !block.url.trim()) || (block.type === 'logo' && !logoUrl);
                  return (
                    <div
                      key={block.id}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData(MOVE_BLOCK_MIME, block.id);
                        e.dataTransfer.effectAllowed = 'move';
                        setDraggingId(block.id);
                      }}
                      onDragEnd={() => {
                        setDraggingId(null);
                        setDropIndex(null);
                      }}
                      onDragOver={(e) => onBlockDragOver(e, index)}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedId(block.id);
                      }}
                      className={`group relative -mx-2 cursor-pointer rounded-md px-2 transition ${
                        isSelected ? 'ring-2 ring-indigo-500' : 'hover:ring-2 hover:ring-slate-200'
                      } ${draggingId === block.id ? 'opacity-40' : ''}`}
                    >
                      {dropIndex === index && (
                        <div className="absolute -top-1 inset-x-0 z-10 h-0.5 rounded bg-indigo-500" />
                      )}
                      {dropIndex === blocks.length && index === blocks.length - 1 && (
                        <div className="absolute -bottom-1 inset-x-0 z-10 h-0.5 rounded bg-indigo-500" />
                      )}

                      {isSelected && (
                        <div className="absolute -top-4 right-2 z-20 flex items-center gap-0.5 rounded-lg border border-slate-200 bg-white p-0.5 shadow-md">
                          {[
                            { label: 'Move up', Icon: ArrowUp, run: () => moveBy(block.id, -1), disabled: index === 0 },
                            { label: 'Move down', Icon: ArrowDown, run: () => moveBy(block.id, 1), disabled: index === blocks.length - 1 },
                            { label: 'Duplicate', Icon: Copy, run: () => duplicateBlock(block.id), disabled: false },
                            { label: 'Delete', Icon: Trash2, run: () => deleteBlock(block.id), disabled: false },
                          ].map(({ label, Icon, run, disabled }) => (
                            <button
                              key={label}
                              type="button"
                              aria-label={label}
                              title={label}
                              disabled={disabled}
                              onClick={(e) => {
                                e.stopPropagation();
                                run();
                              }}
                              className={`rounded-md p-1.5 hover:bg-slate-100 disabled:opacity-30 ${
                                label === 'Delete' ? 'text-red-600' : 'text-slate-600'
                              }`}
                            >
                              <Icon className="h-4 w-4" aria-hidden />
                            </button>
                          ))}
                        </div>
                      )}

                      {emptyImage ? (
                        <div className="my-2 flex items-center justify-center gap-2 rounded-md border-2 border-dashed border-slate-300 py-8 text-sm text-slate-500">
                          <ImageIcon className="h-4 w-4" aria-hidden />
                          {block.type === 'logo' ? 'Add your logo URL in Settings' : 'Add an image URL in the panel'}
                        </div>
                      ) : (
                        <div
                          className="pointer-events-none select-none"
                          dangerouslySetInnerHTML={{ __html: fillTemplate(blockToHtml(block), vars) }}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </main>

          {/* Properties */}
          <aside className="overflow-y-auto border-t border-slate-200 bg-white p-4 lg:border-l lg:border-t-0">
            {selected ? (
              <>
                <div className="mb-4 flex items-center gap-2">
                  {(() => {
                    const Icon = BLOCK_META[selected.type].icon;
                    return <Icon className="h-4 w-4 text-slate-500" aria-hidden />;
                  })()}
                  <p className="text-sm font-medium text-slate-900">{BLOCK_META[selected.type].label} settings</p>
                </div>
                <PropertiesPanel
                  key={selected.id}
                  block={selected}
                  onChange={updateBlock}
                  textRef={textRef}
                  onInsertVariable={insertVariable}
                />
              </>
            ) : (
              <div className="py-10 text-center text-sm text-slate-500">
                Select a block on the canvas to edit its text, colors and layout.
              </div>
            )}
            <p className="mt-6 border-t border-slate-100 pt-3 text-xs text-slate-500">
              Canvas shows <span className="font-medium text-slate-700">{sample.studentName}</span> as sample data.
            </p>
          </aside>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-slate-200 px-5 py-3">
          <button
            type="button"
            onClick={handleReset}
            className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100"
          >
            <RotateCcw className="h-4 w-4" aria-hidden />
            Reset to default
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700"
            >
              <Save className="h-4 w-4" aria-hidden />
              Save template
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}