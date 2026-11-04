import { useState, type ReactNode } from 'react';
import {
  AppWindow,
  Ban,
  Bot,
  Braces,
  Check,
  ChevronRight,
  FilePen,
  FilePlus2,
  FileText,
  Globe,
  Link2,
  ListTodo,
  Loader2,
  Plug,
  Search,
  Sparkles,
  SquareTerminal,
  Wrench,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import type { ToolItemData, TranscriptItem } from '@cooprompt/protocol';
import { BRAND_ICONS } from '../lib/brand-icons.ts';
import { useT, type T } from '../lib/i18n.ts';
import { describeTool, summarizeActivity, unwrapShell, type ActivityPart, type ToolCategory, type ToolView } from '../lib/tools.ts';
import { AttachmentList } from './Attachments.tsx';

const CATEGORY_ICON: Record<ToolCategory, LucideIcon> = {
  command: SquareTerminal,
  read: FileText,
  edit: FilePen,
  write: FilePlus2,
  search: Search,
  web: Globe,
  fetch: Link2,
  agent: Bot,
  skill: Sparkles,
  plan: ListTodo,
  browser: AppWindow,
  code: Braces,
  service: Plug,
  other: Wrench,
};

const VERB: Partial<Record<ToolCategory, [done: string, running: string]>> = {
  command: ['Ran', 'Running'],
  read: ['Read', 'Reading'],
  edit: ['Edited', 'Editing'],
  write: ['Wrote', 'Writing'],
  search: ['Searched', 'Searching'],
  web: ['Searched the web', 'Searching the web'],
  fetch: ['Opened', 'Opening'],
  plan: ['Updated the plan', 'Updating the plan'],
};

const NOUN: Partial<Record<ToolCategory, string>> = { agent: 'Subagent', skill: 'Skill', browser: 'Browser', code: 'Code' };

export function ToolIcon({ view, className = '' }: { view: ToolView; className?: string }) {
  if (view.brand && BRAND_ICONS[view.brand]) {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
        <path d={BRAND_ICONS[view.brand]} />
      </svg>
    );
  }
  const Icon = CATEGORY_ICON[view.category];
  return <Icon className={className} />;
}

function label(view: ToolView, running: boolean, t: T): string {
  const verb = VERB[view.category];
  if (verb) return t(running ? verb[1] : verb[0]);
  const noun = NOUN[view.category];
  return noun ? t(noun) : view.source;
}

function summary(parts: ActivityPart[], t: T): string {
  const phrases = parts.map(({ category, count: n, source: name }) => {
    switch (category) {
      case 'command':
        return n === 1 ? t('ran a command') : t('ran {n} commands', { n });
      case 'read':
        return n === 1 ? t('read a file') : t('read {n} files', { n });
      case 'edit':
      case 'write':
        return n === 1 ? t('edited a file') : t('edited {n} files', { n });
      case 'search':
        return n === 1 ? t('searched the code') : t('searched the code {n} times', { n });
      case 'web':
        return n === 1 ? t('searched the web') : t('searched the web {n} times', { n });
      case 'fetch':
        return n === 1 ? t('opened a page') : t('opened {n} pages', { n });
      case 'agent':
        return n === 1 ? t('ran a subagent') : t('ran {n} subagents', { n });
      case 'skill':
        return n === 1 ? t('used a skill') : t('used {n} skills', { n });
      case 'plan':
        return t('updated the plan');
      case 'browser':
        return n === 1 ? t('used the browser') : t('used the browser {n} times', { n });
      case 'code':
        return n === 1 ? t('ran code') : t('ran code {n} times', { n });
      default:
        return n === 1 ? t('used {name}', { name }) : t('used {name} {n} times', { name, n });
    }
  });
  const text = new Intl.ListFormat(t.locale, { type: 'conjunction' }).format(phrases);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function pretty(output: string): string {
  const text = output.trim();
  if (!/^[[{]/.test(text)) return output;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return output;
  }
}

function DiffView({ input }: { input: Record<string, unknown> }) {
  const edits = Array.isArray(input.edits) ? (input.edits as { old_string?: string; new_string?: string }[]) : [{ old_string: input.old_string as string, new_string: input.new_string as string }];
  return (
    <div className="space-y-2">
      {edits.map((edit, index) => (
        <pre key={index} className="max-h-72 overflow-auto rounded-lg bg-side p-2.5 font-mono text-[12px] leading-relaxed">
          {(edit.old_string ?? '').split('\n').map((line, i) => (
            <div key={`o${i}`} className="bg-bad/10 text-[#f0a3a3]">
              - {line}
            </div>
          ))}
          {(edit.new_string ?? '').split('\n').map((line, i) => (
            <div key={`n${i}`} className="bg-ok/10 text-[#9ad19f]">
              + {line}
            </div>
          ))}
        </pre>
      ))}
    </div>
  );
}

function Details({ data, nested, renderItem }: { data: ToolItemData; nested: TranscriptItem[]; renderItem: (item: TranscriptItem) => ReactNode }) {
  const t = useT();
  const input = (data.input ?? {}) as Record<string, unknown>;
  const hasInput = Object.keys(input).length > 0;
  return (
    <div className="space-y-2 pb-2 pl-7 pr-2 pt-0.5">
      {(data.name === 'Edit' || data.name === 'MultiEdit') && (input.old_string !== undefined || Array.isArray(input.edits)) ? (
        <DiffView input={input} />
      ) : data.name === 'Bash' ? (
        <pre className="selectable overflow-auto whitespace-pre-wrap rounded-lg bg-side p-2.5 font-mono text-[12px] text-[#e8d3a9]">$ {unwrapShell(String(input.command ?? ''))}</pre>
      ) : data.name === 'Write' && typeof input.content === 'string' ? (
        <pre className="selectable max-h-72 overflow-auto rounded-lg bg-side p-2.5 font-mono text-[12px]">{input.content.split('\n').slice(0, 80).join('\n')}</pre>
      ) : data.name !== 'ApplyPatch' && hasInput ? (
        <div>
          <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-faint">{t('Input')}</p>
          <pre className="selectable max-h-60 overflow-auto rounded-lg bg-side p-2.5 font-mono text-[11.5px] text-dim">{JSON.stringify(data.input, null, 2)}</pre>
        </div>
      ) : null}
      {data.output && (
        <div>
          {data.name !== 'Bash' && <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-faint">{data.status === 'error' ? t('Error') : t('Result')}</p>}
          <pre className={`selectable max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-side p-2.5 font-mono text-[11.5px] ${data.status === 'error' ? 'text-[#f0a3a3]' : 'text-dim'}`}>{pretty(data.output)}</pre>
        </div>
      )}
      {nested.length > 0 && <div className="space-y-1.5 border-l-2 border-line pl-3">{nested.map((child) => renderItem(child))}</div>}
    </div>
  );
}

function Status({ status, interrupted }: { status: ToolItemData['status']; interrupted: boolean }) {
  const t = useT();
  if (interrupted) return <Ban className="size-3.5 shrink-0 text-faint" aria-label={t('Interrupted')} />;
  if (status === 'running') return <Loader2 className="size-3.5 shrink-0 animate-spin text-accent" />;
  if (status === 'error') return <XCircle className="size-3.5 shrink-0 text-bad" />;
  return <Check className="size-3.5 shrink-0 text-ok/80" />;
}

export function ToolRow({ item, nested, turnRunning, renderItem }: { item: TranscriptItem; nested: TranscriptItem[]; turnRunning: boolean; renderItem: (item: TranscriptItem) => ReactNode }) {
  const t = useT();
  const data = item.data as ToolItemData;
  const [open, setOpen] = useState(false);
  const view = describeTool(data.name, data.input);
  const running = data.status === 'running' && turnRunning;
  const interrupted = data.status === 'running' && !turnRunning;
  const failed = data.status === 'error';
  const errorLine = failed ? (data.output ?? '').trim().split('\n').find(Boolean) : undefined;
  return (
    <div className={`rounded-lg ${failed ? 'bg-bad/[0.07]' : ''}`}>
      <button onClick={() => setOpen(!open)} className="group flex w-full items-center gap-2 rounded-lg px-2 py-[5px] text-left hover:bg-white/[0.035] cursor-default">
        <ToolIcon view={view} className={`size-3.5 shrink-0 ${failed ? 'text-[#f0a3a3]' : 'text-dim'}`} />
        <span className="shrink-0 text-[13px] text-ink">{label(view, running, t)}</span>
        {view.action && <span className="shrink-0 text-[13px] text-dim">{view.action}</span>}
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-faint" title={view.target}>
          {view.target}
        </span>
        {nested.length > 0 && <span className="shrink-0 text-[11px] text-faint">{t('{n} steps', { n: nested.length })}</span>}
        {interrupted && <span className="shrink-0 text-[11px] text-faint">{t('Interrupted')}</span>}
        <Status status={data.status} interrupted={interrupted} />
        <ChevronRight className={`size-3.5 shrink-0 text-faint transition ${open ? 'rotate-90' : 'opacity-0 group-hover:opacity-100'}`} />
      </button>
      {errorLine && !open && <p className="selectable truncate pb-1.5 pl-7 pr-2 font-mono text-[11.5px] text-[#f0a3a3]">{errorLine}</p>}
      {data.attachments?.length ? (
        <div className="pb-1.5 pl-7 pr-2">
          <AttachmentList chatId={item.chatId} files={data.attachments} compact />
        </div>
      ) : null}
      {open && <Details data={data} nested={nested} renderItem={renderItem} />}
    </div>
  );
}

/** Consecutive calls collapsed behind a sentence; failures and the call in progress stay in view. */
export function ActivityGroup({
  items,
  live,
  turnRunning,
  childrenOf,
  renderItem,
}: {
  items: TranscriptItem[];
  live: boolean;
  turnRunning: boolean;
  childrenOf: (toolUseId: string) => TranscriptItem[];
  renderItem: (item: TranscriptItem) => ReactNode;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const tools = items.filter((item) => item.kind === 'tool');
  const data = tools.map((item) => item.data as ToolItemData);
  const { parts, failed } = summarizeActivity(data);
  const running = turnRunning && data.some((tool) => tool.status === 'running');
  const icons = [...new Map(data.map((tool) => describeTool(tool.name, tool.input)).map((view) => [view.brand ?? view.category, view])).values()].slice(0, 4);
  const last = tools[tools.length - 1];
  const shown = open ? items : items.filter((item) => (item.data as ToolItemData).status === 'error' || (live && item === last));
  // Screenshots and other media stay in view while the calls that produced them are collapsed.
  const media = tools.filter((item) => !shown.includes(item)).flatMap((item) => (item.data as ToolItemData).attachments ?? []);
  const row = (item: TranscriptItem) =>
    item.kind === 'tool' ? (
      <ToolRow key={item.id} item={item} nested={childrenOf((item.data as ToolItemData).toolUseId)} turnRunning={turnRunning} renderItem={renderItem} />
    ) : (
      <div key={item.id} className="px-2 py-1">
        {renderItem(item)}
      </div>
    );
  return (
    <div className="rounded-xl border border-line-soft bg-panel">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left hover:bg-white/[0.02] cursor-default">
        <ChevronRight className={`size-3.5 shrink-0 text-faint transition-transform ${open ? 'rotate-90' : ''}`} />
        <span className="flex shrink-0 items-center gap-1 text-dim">
          {icons.map((view) => (
            <ToolIcon key={view.brand ?? view.category} view={view} className="size-3.5" />
          ))}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{summary(parts, t)}</span>
        {failed > 0 && <span className="shrink-0 text-[12px] text-[#f0a3a3]">{failed === 1 ? t('1 failed') : t('{n} failed', { n: failed })}</span>}
        <span className="shrink-0 text-[11.5px] text-faint">{t('{n} steps', { n: tools.length })}</span>
        {running ? <Loader2 className="size-3.5 shrink-0 animate-spin text-accent" /> : failed > 0 ? <XCircle className="size-3.5 shrink-0 text-bad" /> : <Check className="size-3.5 shrink-0 text-ok/80" />}
      </button>
      {media.length > 0 && (
        <div className="border-t border-line-soft px-2.5 py-2">
          <AttachmentList chatId={tools[0].chatId} files={media} compact />
        </div>
      )}
      {shown.length > 0 && <div className="space-y-0.5 border-t border-line-soft p-1">{shown.map(row)}</div>}
    </div>
  );
}
