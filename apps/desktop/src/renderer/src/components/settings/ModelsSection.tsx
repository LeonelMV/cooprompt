import { useEffect, useState } from 'react';
import { KeyRound, Pencil, Plus, Star, Trash2 } from 'lucide-react';
import type { ClaudeSignIn, CursorSignIn, ProviderKind, ProviderPreset, ProviderProfile, ProviderView } from '../../../../shared/types.ts';
import { currentProfileLabel } from '../../../../shared/profile-label.ts';
import { call } from '../../lib/api.ts';
import { engineBadge } from '../../lib/format.ts';
import { useT, type T } from '../../lib/i18n.ts';
import { useStore } from '../../lib/store.ts';
import { Badge, Button, Field, IconButton, Input, Select } from '../ui.tsx';
import { SectionTitle } from './SettingsModal.tsx';

/** Profiles that use the sign-in an engine keeps on this computer instead of a key. */
const SIGN_IN_KINDS: ProviderKind[] = ['claude-login', 'codex-login', 'cursor-login'];

const ENGINE_FIELD: Record<ProviderProfile['engine'], string> = { claude: 'Claude Code (Agent SDK)', codex: 'Codex', cursor: 'Cursor (CLI)' };

function CodexLogin() {
  const t = useT();
  const toast = useStore((state) => state.toast);
  const [status, setStatus] = useState<{ loggedIn: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void call('providers.codexStatus').then(setStatus);
  }, []);
  const login = async () => {
    setBusy(true);
    try {
      setStatus(await call('providers.codexLogin'));
    } catch (error) {
      toast('error', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex items-center gap-3 rounded-lg border border-line-soft bg-inset px-3 py-2">
      <div className="min-w-0 flex-1 text-[12.5px]">
        {status ? (
          <span className={status.loggedIn ? 'text-ok' : 'text-warn'}>{status.loggedIn ? `Codex: ${status.message}` : t('Codex is not signed in on this computer yet')}</span>
        ) : (
          <span className="text-faint">{t('Checking the Codex sign-in…')}</span>
        )}
      </div>
      <Button size="sm" busy={busy} onClick={() => void login()}>
        {status?.loggedIn ? t('Switch account') : t('Sign in to Codex')}
      </Button>
    </div>
  );
}

const PLAN_NAME: Record<string, string> = { pro: 'Pro', max: 'Max', team: 'Team', enterprise: 'Enterprise' };

function claudeMethod(status: ClaudeSignIn, t: T): string {
  if (status.method === 'claude.ai') return status.plan ? t('Claude {plan} plan', { plan: PLAN_NAME[status.plan] ?? status.plan }) : t('Claude subscription');
  if (status.apiKeySource === '/login managed key') return t('Anthropic Console account (API usage billing)');
  if (status.method === 'third_party') return t('Cloud provider: {provider}', { provider: status.provider ?? '' });
  if (status.method === 'oauth_token') return t('OAuth token');
  return t('API key ({source})', { source: status.apiKeySource ?? status.method });
}

/** The account Claude Code uses, with the same facts as its own `claude auth status`. */
const claudeAccount = (status: ClaudeSignIn, t: T): string => [claudeMethod(status, t), status.organization, status.email].filter(Boolean).join(' · ');

function ClaudeLogin() {
  const t = useT();
  const toast = useStore((state) => state.toast);
  const [status, setStatus] = useState<ClaudeSignIn | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void call('providers.claudeStatus').then(setStatus);
  }, []);
  const login = async () => {
    setBusy(true);
    try {
      setStatus(await call('providers.claudeLogin'));
    } catch (error) {
      toast('error', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex items-center gap-3 rounded-lg border border-line-soft bg-inset px-3 py-2">
      <div className="min-w-0 flex-1 text-[12.5px]">
        {status ? (
          <span className={status.loggedIn ? 'text-ok' : 'text-warn'}>{status.loggedIn ? `Claude Code: ${claudeAccount(status, t)}` : t('Claude Code is not signed in on this computer yet')}</span>
        ) : (
          <span className="text-faint">{t('Checking the Claude Code sign-in…')}</span>
        )}
      </div>
      <Button size="sm" busy={busy} onClick={() => void login()}>
        {status?.loggedIn ? t('Switch account') : t('Sign in to Claude')}
      </Button>
    </div>
  );
}

const CURSOR_INSTALL_GUIDE = 'https://cursor.com/docs/cli/installation';

/** The account the Cursor CLI uses, with the same facts as its own `status` and `about`. */
const cursorAccount = (status: CursorSignIn, t: T): string => [status.plan ? t('{plan} plan', { plan: status.plan }) : null, status.email].filter(Boolean).join(' · ') || t('signed in');

function CursorLogin() {
  const t = useT();
  const toast = useStore((state) => state.toast);
  const [status, setStatus] = useState<CursorSignIn | null>(null);
  const [busy, setBusy] = useState(false);
  const check = () => void call('providers.cursorStatus').then(setStatus);
  useEffect(check, []);
  const login = async () => {
    setBusy(true);
    try {
      setStatus(await call('providers.cursorLogin'));
    } catch (error) {
      toast('error', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex items-center gap-3 rounded-lg border border-line-soft bg-inset px-3 py-2">
      <div className="min-w-0 flex-1 text-[12.5px]">
        {!status ? (
          <span className="text-faint">{t('Checking the Cursor sign-in…')}</span>
        ) : !status.installed ? (
          <span className="selectable text-warn">{t('The Cursor CLI is not installed on this computer yet. Follow the installation guide: {url}', { url: CURSOR_INSTALL_GUIDE })}</span>
        ) : (
          <span className={status.loggedIn ? 'text-ok' : 'text-warn'}>{status.loggedIn ? `Cursor: ${cursorAccount(status, t)}` : t('Cursor is not signed in on this computer yet')}</span>
        )}
      </div>
      {status && !status.installed ? (
        <Button size="sm" onClick={check}>
          {t('Check again')}
        </Button>
      ) : (
        <Button size="sm" busy={busy} disabled={!status} onClick={() => void login()}>
          {status?.loggedIn ? t('Switch account') : t('Sign in to Cursor')}
        </Button>
      )}
    </div>
  );
}

function ProfileForm({ initial, preset, onDone }: { initial: ProviderView | null; preset: ProviderPreset | null; onDone: () => void }) {
  const t = useT();
  const { toast, loadProviders } = useStore();
  const [profile, setProfile] = useState<ProviderProfile>(
    initial ? { ...initial, label: currentProfileLabel(initial.label) } : {
      id: '',
      label: preset ? t(preset.label) : t('Model'),
      engine: preset?.engine ?? 'claude',
      kind: preset?.kind ?? 'anthropic',
      baseUrl: preset?.baseUrl,
      model: preset?.model,
      createdAt: 0,
    },
  );
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState<{ id: string; label?: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const needsKey = initial?.needsKey ?? preset?.needsKey ?? true;
  const showBase = profile.kind === 'anthropic-compatible' || profile.kind === 'openai-compatible';

  const save = async (): Promise<ProviderView | null> => {
    setBusy(true);
    try {
      const saved = await call('providers.save', { profile, apiKey: apiKey ? apiKey : undefined });
      setProfile(saved);
      setApiKey('');
      await loadProviders();
      return saved;
    } catch (error) {
      toast('error', error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const loadModels = async () => {
    const saved = await save();
    if (!saved) return;
    try {
      setModels(await call('providers.models', saved.id));
    } catch (error) {
      toast('error', t('Could not list the models: {error}', { error: error instanceof Error ? error.message : String(error) }));
    }
  };

  return (
    <div className="space-y-3 rounded-xl border border-line bg-panel p-4">
      {preset && <p className="text-[12.5px] leading-relaxed text-dim">{t(preset.help)}</p>}
      {profile.kind === 'codex-login' && <CodexLogin />}
      {profile.kind === 'claude-login' && <ClaudeLogin />}
      {profile.kind === 'cursor-login' && <CursorLogin />}
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('Name')}>
          <Input value={profile.label} onChange={(event) => setProfile({ ...profile, label: event.target.value })} />
        </Field>
        <Field label={t('Engine')}>
          <Input readOnly value={ENGINE_FIELD[profile.engine] ?? profile.engine} />
        </Field>
      </div>
      {showBase && (
        <Field label={t('Base URL')}>
          <Input value={profile.baseUrl ?? ''} onChange={(event) => setProfile({ ...profile, baseUrl: event.target.value })} placeholder={profile.kind === 'openai-compatible' ? 'https://my-gateway/v1' : 'https://my-gateway'} />
        </Field>
      )}
      {profile.kind === 'openai-compatible' && (
        <Field label={t('Provider API')}>
          <Select value={profile.wireApi ?? 'responses'} onChange={(event) => setProfile({ ...profile, wireApi: event.target.value as 'responses' | 'chat' })}>
            <option value="responses">Responses API</option>
            <option value="chat">Chat Completions</option>
          </Select>
        </Field>
      )}
      {!SIGN_IN_KINDS.includes(profile.kind) && (
        <Field
          label={needsKey ? t('API key') : t('API key (optional)')}
          hint={initial?.hasKey ? t('A key is already stored on this device. Type another one to replace it.') : t('Stored encrypted on this device. It is never sent to the team server or to other participants.')}
        >
          <Input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={initial?.hasKey ? '••••••••••••' : (preset?.keyHint ?? '')} />
        </Field>
      )}
      <Field label={t('Default model')} hint={t('Empty = the engine’s default model. You can also change it on each message.')}>
        <div className="flex gap-2">
          <Input list="profile-models" value={profile.model ?? ''} onChange={(event) => setProfile({ ...profile, model: event.target.value || undefined })} placeholder={t('e.g. claude-sonnet-5 / gpt-6.1-sol')} className="font-mono" />
          <Button onClick={() => void loadModels()} busy={busy}>
            {t('Load models')}
          </Button>
        </div>
        <datalist id="profile-models">
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label}
            </option>
          ))}
        </datalist>
      </Field>
      {models.length > 0 && <p className="text-[12px] text-ok">{t('{count} models available: pick one in the field.', { count: models.length })}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          {t('Close')}
        </Button>
        <Button variant="primary" busy={busy} onClick={() => void save().then((saved) => saved && onDone())}>
          {t('Save')}
        </Button>
      </div>
    </div>
  );
}

export function ModelsSection() {
  const t = useT();
  const { providers, loadProviders, toast } = useStore();
  const [editing, setEditing] = useState<{ profile: ProviderView | null; preset: ProviderPreset | null } | null>(null);
  const [presetId, setPresetId] = useState('anthropic');
  if (!providers) return null;
  const presetFor = (profile: ProviderView) => providers.presets.find((preset) => preset.kind === profile.kind && preset.engine === profile.engine && (preset.baseUrl ?? '') === (profile.baseUrl ?? '')) ?? null;

  return (
    <div className="space-y-5">
      <SectionTitle title={t('Models & keys')}>
        {t('Each profile pairs an engine (Claude Code, Codex or Cursor) with credentials from this computer. In a multiplayer chat everyone runs their requests with their own profiles: nobody uses someone else’s keys.')}
      </SectionTitle>
      <div className="space-y-2">
        {providers.profiles.map((profile) => (
          <div key={profile.id} className="flex items-center gap-3 rounded-xl border border-line-soft bg-panel px-3.5 py-2.5">
            <div className={`flex size-8 items-center justify-center rounded-lg text-[12px] font-bold ${engineBadge(profile.engine).className}`}>{engineBadge(profile.engine).text}</div>
            <div className="min-w-0 flex-1 leading-tight">
              <p className="flex items-center gap-2 text-[13.5px] font-medium">
                {currentProfileLabel(profile.label)}
                {providers.defaultProfileId === profile.id && <Badge tone="accent">{t('default')}</Badge>}
              </p>
              <p className="truncate text-[12px] text-faint">
                {profile.model ? <span className="font-mono">{profile.model}</span> : t('default model')}
                {profile.baseUrl && ` · ${profile.baseUrl}`}
              </p>
            </div>
            {profile.kind === 'codex-login' ? (
              <Badge>{t('Codex sign-in')}</Badge>
            ) : profile.kind === 'claude-login' ? (
              <Badge>{t('Claude Code sign-in')}</Badge>
            ) : profile.kind === 'cursor-login' ? (
              <Badge>{t('Cursor sign-in')}</Badge>
            ) : profile.hasKey ? (
              <Badge tone="ok">
                <KeyRound className="size-3" /> {t('key saved')}
              </Badge>
            ) : profile.needsKey ? (
              <Badge tone="warn">{t('key missing')}</Badge>
            ) : (
              <Badge>{t('no key')}</Badge>
            )}
            <IconButton title={t('Use by default')} onClick={() => void call('providers.setDefault', profile.id).then(loadProviders)}>
              <Star className="size-4" />
            </IconButton>
            <IconButton title={t('Edit')} onClick={() => setEditing({ profile, preset: presetFor(profile) })}>
              <Pencil className="size-4" />
            </IconButton>
            <IconButton
              title={t('Delete')}
              onClick={() =>
                void call('providers.delete', profile.id)
                  .then(loadProviders)
                  .catch((error) => toast('error', error.message))
              }
            >
              <Trash2 className="size-4" />
            </IconButton>
          </div>
        ))}
        {providers.profiles.length === 0 && <p className="text-[13px] text-faint">{t('No profiles yet. Add at least one to talk to the agent.')}</p>}
      </div>
      {editing ? (
        <ProfileForm key={editing.profile?.id ?? editing.preset?.id} initial={editing.profile} preset={editing.preset} onDone={() => setEditing(null)} />
      ) : (
        <div className="flex gap-2">
          <Select value={presetId} onChange={(event) => setPresetId(event.target.value)} className="flex-1">
            {providers.presets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {t(preset.label)}
              </option>
            ))}
          </Select>
          <Button variant="primary" onClick={() => setEditing({ profile: null, preset: providers.presets.find((preset) => preset.id === presetId) ?? null })}>
            <Plus className="size-4" /> {t('Add')}
          </Button>
        </div>
      )}
    </div>
  );
}
