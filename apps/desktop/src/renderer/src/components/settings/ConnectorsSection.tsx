import { useCallback, useEffect, useState } from 'react';
import { Download, KeyRound, Pencil, Plug, Plus, Trash2, Zap } from 'lucide-react';
import { CONNECTOR_DIRECTORY, type DirectoryEntry, type LocalEntry, type RemoteEntry } from '../../../../shared/connector-directory.ts';
import { engineName } from '../../../../shared/engines.ts';
import type { ConnectorConfig, ConnectorTransport, ConnectorView, DetectedConnector, DetectedSource } from '../../../../shared/types.ts';
import { call } from '../../lib/api.ts';
import { useT } from '../../lib/i18n.ts';
import { useStore } from '../../lib/store.ts';
import { Badge, Button, Field, IconButton, Input, Select, TextArea, Toggle } from '../ui.tsx';
import { SectionTitle } from './SettingsModal.tsx';

const parsePairs = (text: string, separator: '=' | ':'): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const index = line.indexOf(separator);
    if (index > 0) result[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return result;
};

const localEntries = CONNECTOR_DIRECTORY.filter((entry): entry is LocalEntry => entry.transport === 'stdio');
const remoteEntries = CONNECTOR_DIRECTORY.filter((entry): entry is RemoteEntry => entry.transport !== 'stdio');
const sameCommand = (connector: Pick<ConnectorConfig, 'transport' | 'command' | 'args'>, entry: LocalEntry) =>
  connector.transport === 'stdio' &&
  connector.command === entry.command &&
  (entry.bundled ? entry.args.every((arg, index) => connector.args?.[index] === arg) : (connector.args ?? []).join(' ') === entry.args.join(' '));

const sameUrl = (a?: string, b?: string) => Boolean(a && b && a.replace(/\/+$/, '').toLowerCase() === b.replace(/\/+$/, '').toLowerCase());

const SOURCE_ORDER: DetectedSource[] = ['claude-code', 'codex', 'cursor', 'claude-desktop', 'workspace'];
const SOURCE_NAME: Record<DetectedSource, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  'claude-desktop': 'Claude Desktop',
  workspace: 'Project (.mcp.json)',
};

interface Preset {
  connector: ConnectorConfig;
  headers?: string;
  hint?: string;
}

function ConnectorForm({ initial, preset, onDone }: { initial: ConnectorView | null; preset?: Preset; onDone: () => void }) {
  const t = useT();
  const toast = useStore((state) => state.toast);
  const [connector, setConnector] = useState<ConnectorConfig>(initial ?? preset?.connector ?? { id: '', name: '', enabled: true, transport: 'stdio', command: '', args: [] });
  const [args, setArgs] = useState((initial?.args ?? []).join('\n'));
  const [env, setEnv] = useState('');
  const [headers, setHeaders] = useState(preset?.headers ?? '');
  const [busy, setBusy] = useState(false);
  const argsHint = localEntries.find((entry) => sameCommand(connector, entry))?.argsHint;
  const save = async () => {
    setBusy(true);
    try {
      await call('connectors.save', {
        connector: { ...connector, args: args.split('\n').map((arg) => arg.trim()).filter(Boolean) },
        env: env.trim() ? parsePairs(env, '=') : undefined,
        headers: headers.trim() ? parsePairs(headers, ':') : undefined,
      });
      onDone();
    } catch (error) {
      toast('error', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3 rounded-xl border border-line bg-panel p-4">
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('Name')}>
          <Input value={connector.name} onChange={(event) => setConnector({ ...connector, name: event.target.value })} placeholder="github, notion, postgres…" />
        </Field>
        <Field label={t('Type')}>
          <Select value={connector.transport} onChange={(event) => setConnector({ ...connector, transport: event.target.value as ConnectorTransport })} className="w-full">
            <option value="stdio">Local (stdio)</option>
            <option value="http">{t('Remote (streamable HTTP)')}</option>
            <option value="sse">{t('Remote (SSE)')}</option>
          </Select>
        </Field>
      </div>
      {connector.transport === 'stdio' ? (
        <>
          <Field label={t('Command')}>
            <Input value={connector.command ?? ''} onChange={(event) => setConnector({ ...connector, command: event.target.value })} placeholder="npx" className="font-mono" />
          </Field>
          <Field label={t('Arguments (one per line)')} hint={argsHint ? t(argsHint.help) : undefined}>
            <TextArea rows={3} value={args} onChange={(event) => setArgs(event.target.value)} placeholder={argsHint?.placeholder ?? '-y\n@modelcontextprotocol/server-github'} className="font-mono" />
          </Field>
          <Field label={t('Environment variables (KEY=value per line)')} hint={initial?.envKeys.length ? t('Saved: {keys}. Type new ones to replace them.', { keys: initial.envKeys.join(', ') }) : t('Stored encrypted on this device.')}>
            <TextArea rows={2} value={env} onChange={(event) => setEnv(event.target.value)} placeholder="GITHUB_TOKEN=…" className="font-mono" />
          </Field>
        </>
      ) : (
        <>
          <Field label="URL">
            <Input value={connector.url ?? ''} onChange={(event) => setConnector({ ...connector, url: event.target.value })} placeholder="https://mcp.example.com/mcp" className="font-mono" />
          </Field>
          <Field
            label={t('Headers (Name: value per line)')}
            hint={preset?.hint ?? (initial?.headerKeys.length ? t('Saved: {keys}', { keys: initial.headerKeys.join(', ') }) : t('Optional. For servers that ask you to sign in, save and then use "Connect".'))}
          >
            <TextArea rows={2} value={headers} onChange={(event) => setHeaders(event.target.value)} placeholder="Authorization: Bearer …" className="font-mono" />
          </Field>
        </>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          {t('Cancel')}
        </Button>
        <Button variant="primary" busy={busy} onClick={() => void save()}>
          {t('Save')}
        </Button>
      </div>
    </div>
  );
}

export function ConnectorsSection() {
  const t = useT();
  const toast = useStore((state) => state.toast);
  const [data, setData] = useState<{ connectors: ConnectorView[]; detected: DetectedConnector[] } | null>(null);
  const [editing, setEditing] = useState<ConnectorView | null | 'new'>(null);
  const [preset, setPreset] = useState<Preset | undefined>(undefined);
  const [results, setResults] = useState<Record<string, { ok: boolean; message: string; tools: string[] }>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = useCallback(() => void call('connectors.list').then(setData), []);
  useEffect(refresh, [refresh]);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
    } catch (error) {
      toast('error', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const signIn = (connector: ConnectorView) =>
    run(`oauth:${connector.id}`, async () => {
      toast('info', t('Finish connecting {name} in your browser.', { name: connector.name }));
      await call('connectors.oauth', connector.id);
      toast('info', t('Connected to {name}.', { name: connector.name }));
    });

  const addFromDirectory = (entry: DirectoryEntry) => {
    if (entry.transport === 'stdio') {
      void run(`add:${entry.id}`, async () => {
        const saved = await call('connectors.save', { connector: { id: '', name: entry.id, enabled: true, transport: 'stdio', command: entry.command, args: entry.args, origin: 'Catalog' } });
        toast('info', entry.bundled ? t('Checking {name}…', { name: t(entry.name) }) : t('Setting up {name}… the first time it is downloaded with npx.', { name: t(entry.name) }));
        const result = await call('connectors.test', saved.id);
        setResults((current) => ({ ...current, [saved.id]: result }));
        if (result.ok && entry.setup && !entry.bundled) window.open(entry.setup.url);
      });
      return;
    }
    const connector: ConnectorConfig = { id: '', name: entry.id, enabled: true, transport: entry.transport, url: entry.url, origin: 'Catalog' };
    if (entry.auth === 'token' && entry.token) {
      setPreset({ connector, headers: `${entry.token.header}: ${entry.token.prefix}`, hint: t('Paste your token after "{prefix}". Get it at {where}.', { prefix: entry.token.prefix.trim(), where: entry.token.help }) });
      setEditing('new');
      return;
    }
    void run(`add:${entry.id}`, async () => {
      const saved = await call('connectors.save', { connector });
      if (entry.auth === 'oauth') {
        toast('info', t('Finish connecting {name} in your browser.', { name: entry.name }));
        await call('connectors.oauth', saved.id);
        toast('info', t('Connected to {name}.', { name: entry.name }));
      }
    });
  };

  const catalogButton = (entry: DirectoryEntry) => {
    const added = data?.connectors.some((connector) => (entry.transport === 'stdio' ? sameCommand(connector, entry) : sameUrl(connector.url, entry.url)));
    return added ? (
      <Badge tone="ok">{t('added')}</Badge>
    ) : (
      <Button size="sm" busy={busy === `add:${entry.id}`} onClick={() => addFromDirectory(entry)}>
        <Plus className="size-3.5" /> {t('Add')}
      </Button>
    );
  };

  const importable = data?.detected.filter((detected) => detected.importable).length ?? 0;
  const groups = SOURCE_ORDER.map((source) => ({ source, items: data?.detected.filter((detected) => detected.source === source) ?? [] })).filter((group) => group.items.length > 0);

  return (
    <div className="space-y-7">
      <SectionTitle title={t('MCP connectors')}>
        {t('CooPrompt gives your connectors to every engine: Claude, Codex and Cursor. The ones an engine already loads on its own are not duplicated. Credentials stay on this computer.')}
      </SectionTitle>

      <div className="space-y-2">
        {data?.connectors.map((connector) => (
          <div key={connector.id} className="space-y-2 rounded-xl border border-line-soft bg-panel px-3.5 py-2.5">
            <div className="flex items-center gap-3">
              <Plug className="size-4 text-dim" />
              <div className="min-w-0 flex-1 leading-tight">
                <p className="flex items-center gap-2 text-[13.5px] font-medium">
                  {connector.name} <Badge>{connector.transport}</Badge>
                  {connector.oauth === 'connected' && <Badge tone="ok">{t('Connected')}</Badge>}
                  {connector.origin && <span className="truncate text-[11.5px] font-normal text-faint">{t.message(connector.origin)}</span>}
                </p>
                <p className="truncate font-mono text-[11.5px] text-faint">{connector.transport === 'stdio' ? `${connector.command} ${(connector.args ?? []).join(' ')}` : connector.url}</p>
              </div>
              <Toggle checked={connector.enabled} onChange={(enabled) => void run(`toggle:${connector.id}`, () => call('connectors.save', { connector: { ...connector, enabled } }))} />
              <Button size="sm" busy={busy === `test:${connector.id}`} onClick={() => void run(`test:${connector.id}`, async () => setResults({ ...results, [connector.id]: await call('connectors.test', connector.id) }))}>
                <Zap className="size-3.5" /> {t('Test')}
              </Button>
              {connector.transport !== 'stdio' && (
                <Button size="sm" busy={busy === `oauth:${connector.id}`} onClick={() => void signIn(connector)}>
                  <KeyRound className="size-3.5" /> {t('Connect')}
                </Button>
              )}
              <IconButton
                title={t('Edit')}
                onClick={() => {
                  setPreset(undefined);
                  setEditing(connector);
                }}
              >
                <Pencil className="size-4" />
              </IconButton>
              <IconButton title={t('Delete')} onClick={() => void run(`delete:${connector.id}`, () => call('connectors.delete', connector.id))}>
                <Trash2 className="size-4" />
              </IconButton>
            </div>
            {results[connector.id] && (
              <p className={`text-[12px] ${results[connector.id].ok ? 'text-ok' : 'text-bad'}`}>
                {results[connector.id].message}
                {results[connector.id].tools.length > 0 && <span className="text-faint"> · {results[connector.id].tools.slice(0, 12).join(', ')}</span>}
              </p>
            )}
          </div>
        ))}
        {data && data.connectors.length === 0 && <p className="text-[13px] text-faint">{t('You have not added CooPrompt connectors yet.')}</p>}
      </div>

      {editing ? (
        <ConnectorForm
          key={editing === 'new' ? `new:${preset?.connector.name ?? ''}` : editing.id}
          initial={editing === 'new' ? null : editing}
          preset={editing === 'new' ? preset : undefined}
          onDone={() => {
            setEditing(null);
            setPreset(undefined);
            refresh();
          }}
        />
      ) : (
        <Button
          onClick={() => {
            setPreset(undefined);
            setEditing('new');
          }}
        >
          <Plus className="size-4" /> {t('Add connector')}
        </Button>
      )}

      <div>
        <div className="mb-2 flex items-center gap-3">
          <h4 className="flex-1 text-[13.5px] font-semibold">{t('Import from Claude, Codex and your other apps')}</h4>
          <Button
            size="sm"
            variant="primary"
            disabled={importable === 0}
            busy={busy === 'import-all'}
            onClick={() =>
              void run('import-all', async () => {
                const count = await call('connectors.importAll');
                toast('info', t('Imported {count} connectors.', { count }));
              })
            }
          >
            <Download className="size-3.5" /> {t('Import all ({count})', { count: importable })}
          </Button>
        </div>
        <div className="space-y-4">
          {groups.map((group) => (
            <div key={group.source}>
              <p className="mb-1 text-[11.5px] font-semibold uppercase tracking-wide text-faint">{t(SOURCE_NAME[group.source])}</p>
              <div className="space-y-1">
                {group.items.map((detected) => (
                  <div key={detected.key} className="flex items-center gap-3 rounded-lg px-1 py-1">
                    <div className="min-w-0 flex-1 leading-tight">
                      <p className="text-[13px]">
                        {detected.name} <span className="text-[11.5px] text-faint">· {t.message(detected.origin)}</span>
                      </p>
                      <p className="truncate font-mono text-[11px] text-faint">{detected.transport === 'stdio' ? `${detected.command ?? ''} ${(detected.args ?? []).join(' ')}` : detected.url}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
                      {!detected.enabled && <Badge>{t('off in {app}', { app: t(SOURCE_NAME[detected.source]) })}</Badge>}
                      {detected.missingEnv.length > 0 && (
                        <span title={detected.missingEnv.join('\n')}>
                          <Badge tone="warn">{detected.missingEnv.length === 1 ? t('missing {vars}', { vars: detected.missingEnv[0] }) : t('missing {count} variables', { count: detected.missingEnv.length })}</Badge>
                        </span>
                      )}
                      {detected.nativeFor.map((engine) => (
                        <Badge key={engine} tone="ok">
                          {t('native in {engine}', { engine: engineName(engine) })}
                        </Badge>
                      ))}
                      {detected.imported ? (
                        <Badge>{t('imported')}</Badge>
                      ) : (
                        <Button size="sm" busy={busy === `import:${detected.key}`} onClick={() => void run(`import:${detected.key}`, () => call('connectors.import', detected.key))}>
                          <Download className="size-3.5" /> {t('Import')}
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {data && groups.length === 0 && <p className="text-[13px] text-faint">{t('No MCP configuration found in Claude Code, Claude Desktop, Cursor or Codex.')}</p>}
        </div>
      </div>

      <div>
        <h4 className="mb-1 text-[13.5px] font-semibold">{t('Catalog')}</h4>
        <p className="mb-3 text-[12.5px] text-dim">
          {t('Ready-made connectors. Remote ones open your browser to sign in with your own account; local ones run on this computer, like a browser the agent can drive to test your app.')}
        </p>
        {[
          { title: t('Built into CooPrompt'), entries: localEntries.filter((entry) => entry.bundled) },
          { title: t('On this computer · needs Node.js'), entries: localEntries.filter((entry) => !entry.bundled) },
        ].map((group) => (
          <div key={group.title} className="mb-4">
            <p className="mb-1.5 text-[11.5px] font-semibold uppercase tracking-wide text-faint">{group.title}</p>
            <div className="space-y-2">
              {group.entries.map((entry) => (
                <div key={entry.id} className="flex items-center gap-3 rounded-lg border border-line-soft bg-panel px-3 py-2">
                  <div className="min-w-0 flex-1 leading-tight">
                    <p className="text-[13px] font-medium">{t(entry.name)}</p>
                    <p className="text-[12px] text-dim">
                      {t(entry.description)}
                      {entry.setup && (
                        <>
                          {' '}
                          <a href={entry.setup.url} target="_blank" rel="noreferrer" className="text-accent hover:underline cursor-default">
                            {t(entry.setup.label)}
                          </a>
                        </>
                      )}
                    </p>
                  </div>
                  {catalogButton(entry)}
                </div>
              ))}
            </div>
          </div>
        ))}
        <p className="mb-1.5 text-[11.5px] font-semibold uppercase tracking-wide text-faint">{t('Remote')}</p>
        <div className="grid grid-cols-3 gap-2">
          {remoteEntries.map((entry) => (
            <div key={entry.id} className="flex items-center gap-2 rounded-lg border border-line-soft bg-panel px-3 py-2">
              <div className="min-w-0 flex-1 leading-tight">
                <p className="truncate text-[13px] font-medium">{t(entry.name)}</p>
                <p className="text-[11px] text-faint">{entry.auth === 'oauth' ? t('With your account') : entry.auth === 'open' ? t('No account needed') : t('Personal token')}</p>
              </div>
              {catalogButton(entry)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
