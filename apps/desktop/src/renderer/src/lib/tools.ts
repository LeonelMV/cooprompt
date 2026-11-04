import type { ToolItemData, TranscriptItem } from '@cooprompt/protocol';

export type ToolCategory = 'command' | 'read' | 'edit' | 'write' | 'search' | 'web' | 'fetch' | 'agent' | 'skill' | 'plan' | 'browser' | 'code' | 'service' | 'other';

export interface ToolView {
  category: ToolCategory;
  /** Brand key (see brand-icons) of the service behind an MCP tool. */
  brand: string | null;
  /** Service, MCP server or tool name, shown as is. */
  source: string;
  /** Humanized MCP action, e.g. "Fetch PR comments". */
  action: string;
  /** The argument that says what the call was about: command, path, query, title… */
  target: string;
}

const SERVICES: [RegExp, string, string][] = [
  [/_github_/, 'github', 'GitHub'],
  [/_gitlab_/, 'gitlab', 'GitLab'],
  [/_notion_/, 'notion', 'Notion'],
  [/_slack_/, 'slack', 'Slack'],
  [/_confluence_/, 'confluence', 'Confluence'],
  [/_jira_/, 'jira', 'Jira'],
  [/_atlassian_/, 'atlassian', 'Atlassian'],
  [/_figma_/, 'figma', 'Figma'],
  [/_linear_/, 'linear', 'Linear'],
  [/_datadog_/, 'datadog', 'Datadog'],
  [/_sentry_/, 'sentry', 'Sentry'],
  [/_gmail_/, 'gmail', 'Gmail'],
  [/_(google_?drive|gdrive)_/, 'googledrive', 'Google Drive'],
  [/_(google_?calendar|gcal)_/, 'googlecalendar', 'Google Calendar'],
  [/_stripe_/, 'stripe', 'Stripe'],
  [/_vercel_/, 'vercel', 'Vercel'],
  [/_supabase_/, 'supabase', 'Supabase'],
  [/_asana_/, 'asana', 'Asana'],
  [/_airtable_/, 'airtable', 'Airtable'],
  [/_miro_/, 'miro', 'Miro'],
  [/_intercom_/, 'intercom', 'Intercom'],
  [/_posthog_/, 'posthog', 'PostHog'],
  [/_cloudflare_/, 'cloudflare', 'Cloudflare'],
  [/_trello_/, 'trello', 'Trello'],
  [/_docker_/, 'docker', 'Docker'],
  [/_npm_/, 'npm', 'npm'],
  [/_google_/, 'google', 'Google'],
];
const BROWSER = /_(cua|computer|computer_use|browser|browsers|chrome|playwright|puppeteer|browserbase)_/;
const CODE = /_(repl|node_repl|js|javascript|python|jupyter|notebook)_/;

/** `getJiraIssue`, `github.fetch_pr_comments` and `claude_ai_Slack` all become `_word_word_` for matching. */
function words(text: string): string {
  return `_${text
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join('_')}_`;
}

const ACRONYMS = new Set(['pr', 'prs', 'id', 'ids', 'url', 'api', 'sql', 'ci', 'mcp', 'sha', 'ui', 'db', 'pdf', 'csv', 'json', 'html', 'http', 'ai', 'mr']);

export function humanize(name: string): string {
  const parts = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_.\-]+/)
    .filter(Boolean)
    .map((part) => (ACRONYMS.has(part.toLowerCase()) ? part.toUpperCase().replace(/S$/, 's') : part.toLowerCase()));
  const text = parts.join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Codex reports commands inside the login shell that ran them: `/bin/zsh -lc 'ls -la'`. */
export function unwrapShell(command: string): string {
  const match = /^(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(command.trim());
  return match ? (match[1] === "'" ? match[2].replace(/'\\''/g, "'") : match[2]) : command;
}

export function shortPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : path;
}

const pick = (input: Record<string, unknown>, ...keys: string[]): string => {
  for (const key of keys) if (typeof input[key] === 'string' && input[key]) return String(input[key]);
  return '';
};

/** Up to three argument values, with long hashes shortened and numbers that look like references marked. */
function argumentPreview(input: Record<string, unknown>): string {
  const values: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (values.length >= 3) break;
    if (typeof value === 'number') values.push(/number|^num$|^n$/i.test(key) ? `#${value}` : String(value));
    else if (typeof value === 'string' && value.trim()) {
      const text = value.trim().split('\n')[0];
      values.push(/^[0-9a-f]{12,}$/i.test(text) ? text.slice(0, 7) : text.length > 80 ? `${text.slice(0, 80)}…` : text);
    }
  }
  return values.join(' · ');
}

function service(server: string, tool: string): ToolView {
  const text = words(`${server} ${tool}`);
  const known = SERVICES.find(([pattern]) => pattern.test(text));
  const category: ToolCategory = BROWSER.test(text) ? 'browser' : known ? 'service' : CODE.test(text) ? 'code' : 'service';
  // `github.fetch_pr_comments` on a shared apps server, or `notion-search` from a Notion plugin.
  const ownName = known ? new RegExp(`^${known[1]}[._-]+`, 'i') : null;
  const action = humanize(ownName ? tool.replace(ownName, '') : tool);
  return { category, brand: known && category === 'service' ? known[1] : null, source: known?.[2] ?? server, action, target: '' };
}

export function describeTool(name: string, rawInput: unknown): ToolView {
  const input = rawInput && typeof rawInput === 'object' ? (rawInput as Record<string, unknown>) : {};
  const view = (category: ToolCategory, target: string): ToolView => ({ category, brand: null, source: name, action: '', target });
  switch (name) {
    case 'Bash':
      return view('command', unwrapShell(pick(input, 'command')).trim().split('\n')[0]);
    case 'Read':
      return view('read', shortPath(pick(input, 'file_path', 'path')));
    case 'Write':
      return view('write', shortPath(pick(input, 'file_path', 'path')));
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return view('edit', shortPath(pick(input, 'file_path', 'notebook_path')));
    case 'ApplyPatch': {
      const changes = Array.isArray(input.changes) ? (input.changes as { path?: string; kind?: string }[]) : [];
      const first = changes[0]?.path ? shortPath(changes[0].path) : '';
      return view(changes.length > 0 && changes.every((change) => change.kind === 'add') ? 'write' : 'edit', changes.length > 1 ? `${first} +${changes.length - 1}` : first);
    }
    case 'Grep':
    case 'Glob':
    case 'SemanticSearch':
      return view('search', pick(input, 'pattern', 'query'));
    case 'LS':
      return view('search', shortPath(pick(input, 'path')));
    case 'WebSearch':
      return view('web', pick(input, 'query'));
    case 'WebFetch':
      return view('fetch', pick(input, 'url').replace(/^https?:\/\//, ''));
    case 'Task':
    case 'Agent':
      return view('agent', pick(input, 'description', 'prompt'));
    case 'Skill':
      return view('skill', pick(input, 'skill', 'command', 'name'));
    case 'TodoWrite':
    case 'ExitPlanMode':
      return view('plan', '');
    case 'CreatePlan':
      return view('plan', pick(input, 'name'));
  }
  if (name.startsWith('mcp__')) {
    const [, server = '', ...rest] = name.split('__');
    const described = service(server, rest.join('__'));
    return { ...described, target: pick(input, 'title', 'description') || argumentPreview(input) };
  }
  return view('other', pick(input, 'description', 'title', 'path', 'query', 'command', 'name') || argumentPreview(input));
}

export type ActivityBlock = { kind: 'item'; item: TranscriptItem } | { kind: 'group'; id: string; items: TranscriptItem[] };

/** Runs of two or more tool calls (with the reasoning between them) collapse into one block. */
export function groupActivity(items: TranscriptItem[]): ActivityBlock[] {
  const blocks: ActivityBlock[] = [];
  let run: TranscriptItem[] = [];
  const flush = () => {
    if (run.filter((item) => item.kind === 'tool').length >= 2) blocks.push({ kind: 'group', id: run[0].id, items: run });
    else blocks.push(...run.map((item): ActivityBlock => ({ kind: 'item', item })));
    run = [];
  };
  for (const item of items) {
    if (item.kind === 'tool' || item.kind === 'thinking') run.push(item);
    else {
      flush();
      blocks.push({ kind: 'item', item });
    }
  }
  flush();
  return blocks;
}

export interface ActivityPart {
  category: ToolCategory;
  /** Service or tool name for `service` and `other`. */
  source?: string;
  count: number;
}

/** What a group of calls did, biggest share first; files count once however often they were touched. */
export function summarizeActivity(tools: ToolItemData[]): { parts: ActivityPart[]; failed: number; running: number } {
  const parts = new Map<string, ActivityPart & { targets: Set<string> }>();
  for (const tool of tools) {
    const view = describeTool(tool.name, tool.input);
    const category = view.category === 'write' ? 'edit' : view.category;
    const source = category === 'service' || category === 'other' ? view.source : undefined;
    const key = `${category}:${source ?? ''}`;
    const part = parts.get(key) ?? { category, source, count: 0, targets: new Set<string>() };
    part.count++;
    if (view.target) part.targets.add(view.target);
    parts.set(key, part);
  }
  const fileCategories = new Set<ToolCategory>(['read', 'edit']);
  return {
    parts: [...parts.values()]
      .map(({ targets, ...part }) => (fileCategories.has(part.category) && targets.size > 0 ? { ...part, count: targets.size } : part))
      .sort((a, b) => b.count - a.count),
    failed: tools.filter((tool) => tool.status === 'error').length,
    running: tools.filter((tool) => tool.status === 'running').length,
  };
}
