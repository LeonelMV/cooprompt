import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, ChevronDown, EyeOff, Gauge, Layers, Loader2, Monitor, Send, Square, Zap } from 'lucide-react';
import type { ChatSummary, PermissionModeId, TurnInfo, UserItemData } from '@cooprompt/protocol';
import { promptText } from '@cooprompt/protocol';
import { matchCommands, type SlashCommandInfo } from '../../../shared/commands.ts';
import { DEFAULT_EFFORT_CHOICES, EFFORT_LABEL } from '../../../shared/effort.ts';
import { ENGINE_NAME, ENGINE_PERMISSION_MODES, permissionModeFor } from '../../../shared/engines.ts';
import { currentProfileLabel } from '../../../shared/profile-label.ts';
import type { ModelChoice } from '../../../shared/types.ts';
import { call } from '../lib/api.ts';
import { clock, contextShare, PERMISSION_LABEL, tokens } from '../lib/format.ts';
import { useT, type T } from '../lib/i18n.ts';
import { useStore, type ChatViewState } from '../lib/store.ts';
import { composerMode } from '../lib/team.ts';
import { AttachButton, DropOverlay, StagedFiles, useAttachmentDraft } from './ComposerAttachments.tsx';
import { Button } from './ui.tsx';

const modelCache = new Map<string, ModelChoice[]>();
const commandCache = new Map<string, SlashCommandInfo[]>();

const SOURCE_LABEL: Record<SlashCommandInfo['source'], string> = {
  cooprompt: 'CooPrompt',
  builtin: 'built-in',
  custom: 'custom',
  prompt: 'prompt',
  skill: 'skill',
};

/** The session the next message from this computer continues: its last turn that reported context. */
function sessionContext(turns: TurnInfo[], me: string | undefined, deviceId: string | undefined, profileId: string | undefined): TurnInfo | null {
  const mine = turns
    .filter((turn) => turn.requesterId === me && turn.deviceId === deviceId && turn.status !== 'queued' && turn.status !== 'running')
    .sort((a, b) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt));
  const last = mine.find((turn) => contextShare(turn.usage) !== null);
  return last && last.config.profileId === profileId ? last : null;
}

function ContextRing({ turn, t }: { turn: TurnInfo; t: T }) {
  const share = contextShare(turn.usage) ?? 0;
  const usage = turn.usage!;
  const color = share >= 85 ? 'text-bad' : share >= 60 ? 'text-warn' : 'text-dim';
  const circumference = 2 * Math.PI * 6;
  const title = usage.contextWindow
    ? t('Context of your agent session: {used} of {total} tokens ({percent}%). Send /new to start a fresh session.', { used: tokens(usage.contextTokens ?? 0, t), total: tokens(usage.contextWindow, t), percent: share })
    : t('New agent session: nothing in its context yet.');
  return (
    <span className={`flex h-7 items-center gap-1.5 rounded-md px-1.5 text-[11.5px] tabular-nums ${color}`} title={title}>
      <svg viewBox="0 0 16 16" className="size-4 -rotate-90">
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray={`${(share / 100) * circumference} ${circumference}`} strokeLinecap="round" />
      </svg>
      {t('{percent}% context', { percent: share })}
    </span>
  );
}

export function Composer({ chat, view }: { chat: ChatSummary; view: ChatViewState }) {
  const t = useT();
  const { app, providers, toast, set } = useStore();
  const prefs = view.local?.prefs;
  const [text, setText] = useState('');
  const [profileId, setProfileId] = useState<string | null>(null);
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [mode, setMode] = useState<PermissionModeId>('default');
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [models, setModels] = useState<ModelChoice[]>([]);
  const [commands, setCommands] = useState<SlashCommandInfo[] | null>(null);
  const [sending, setSending] = useState(false);
  const [multitask, setMultitask] = useState(false);
  const [teamOnly, setTeamOnly] = useState(false);
  const [picking, setPicking] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const [paletteClosed, setPaletteClosed] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const palette = useRef<HTMLDivElement>(null);
  const lastTyping = useRef(0);
  const draft = useAttachmentDraft(chat.id, chat.isMember);
  const sendable = (text.trim() !== '' || draft.files.length > 0) && draft.adding === 0;
  const teamSupport = app?.teamMessages ?? null;
  const destination = composerMode({ teamOnly, supported: teamSupport, kind: chat.kind });
  const team = destination !== 'agent';

  const defaultMode = app?.defaultPermissionMode ?? 'default';
  useEffect(() => {
    setProfileId(prefs?.profileId ?? providers?.defaultProfileId ?? providers?.profiles[0]?.id ?? null);
    setModel(prefs?.model ?? '');
    setEffort(prefs?.effort ?? '');
    setMode(prefs?.permissionMode ?? defaultMode);
  }, [chat.id, prefs?.profileId, prefs?.model, prefs?.effort, prefs?.permissionMode, defaultMode, providers?.defaultProfileId, providers?.profiles]);

  useEffect(() => {
    setMultitask(prefs?.multitask ?? false);
    setPicking(false);
  }, [chat.id, prefs?.multitask]);

  useEffect(() => {
    setTeamOnly(prefs?.teamOnly ?? false);
  }, [chat.id, prefs?.teamOnly]);

  const profile = providers?.profiles.find((entry) => entry.id === profileId) ?? null;
  const engine = profile?.engine ?? 'claude';

  useEffect(() => {
    if (!profile) return;
    const cached = modelCache.get(profile.id);
    if (cached) {
      setModels(cached);
      return;
    }
    let cancelled = false;
    call('providers.models', profile.id)
      .then((list) => {
        modelCache.set(profile.id, list);
        if (!cancelled) setModels(list);
      })
      .catch(() => setModels([]));
    return () => {
      cancelled = true;
    };
  }, [profile?.id]);

  useEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 280)}px`;
  }, [text]);

  useEffect(() => {
    textarea.current?.focus();
  }, [chat.id]);

  const trigger = team ? null : text.startsWith('/') ? '/' : text.startsWith('$') && engine === 'codex' ? '$' : null;
  const typingName = trigger !== null && !/\s/.test(text);
  const commandKey = profile ? `${chat.id}|${profile.id}` : null;

  useEffect(() => {
    if (!trigger || !commandKey || !profile) return;
    setCommands(commandCache.get(commandKey) ?? null);
    let cancelled = false;
    call('commands.list', { chatId: chat.id, profileId: profile.id })
      .then((list) => {
        commandCache.set(commandKey, list);
        if (!cancelled) setCommands(list);
      })
      .catch(() => {
        if (!cancelled) setCommands((current) => current ?? []);
      });
    return () => {
      cancelled = true;
    };
  }, [trigger !== null, commandKey]);

  const me = app?.user?.id;
  const turns = Object.values(view.turns);
  const mine = turns.filter((turn) => turn.requesterId === me && (turn.status === 'running' || turn.status === 'queued'));
  const running = turns.filter((turn) => turn.status === 'running').sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  const queued = turns.some((turn) => turn.status === 'queued');
  const active = running[0] ?? null;
  // Newest first: ⌘↩ interrupts your own latest turn, or the latest one you may stop.
  const targets = running.filter((turn) => turn.requesterId === me || chat.ownerId === me).reverse();
  const target = targets.find((turn) => turn.requesterId === me) ?? targets[0] ?? null;
  const canInterrupt = target !== null;
  const maxParallel = app?.maxParallelTurns ?? null;
  const parallel = multitask && maxParallel !== null;
  const full = maxParallel !== null && running.length >= maxParallel;
  // The server lets no message skip the line, so one waiting ahead holds a multitask message too.
  const startsNow = !active || (parallel && !full && !queued);
  const devices = app?.devices ?? [];
  const session = sessionContext(turns, me, deviceId ?? app?.deviceId, profile?.id);

  const defaultModel = profile?.model ? undefined : models.find((entry) => entry.isDefault);
  const modelInfo = models.find((entry) => entry.id === (model || profile?.model)) ?? (model ? undefined : defaultModel);
  const effortChoices: { id: string; label?: string; description?: string }[] = modelInfo?.efforts?.length ? modelInfo.efforts : DEFAULT_EFFORT_CHOICES[engine].map((id) => ({ id }));
  const chosenEffort = effortChoices.some((choice) => choice.id === effort) ? effort : '';
  const effortName = (id: string) => t(EFFORT_LABEL[id] ?? effortChoices.find((choice) => choice.id === id)?.label ?? id);
  const chosenMode = permissionModeFor(engine, mode);

  const options = useMemo(() => {
    if (!typingName || paletteClosed || !commands) return [];
    const pool = commands.filter((command) => (command.trigger ?? '/') === trigger);
    return matchCommands(pool, text.slice(1)).slice(0, 50);
  }, [typingName, paletteClosed, commands, trigger, text]);
  const paletteOpen = typingName && !paletteClosed && trigger !== null;
  const typed = trigger === '/' ? /^\/(\S+)\s/.exec(text)?.[1] : undefined;
  const hint = typed ? commands?.find((command) => command.trigger !== '$' && (command.name === typed || command.aliases?.includes(typed))) : undefined;

  useEffect(() => {
    palette.current?.querySelector(`[data-index="${slashIndex}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [slashIndex]);

  const complete = (command: SlashCommandInfo) => {
    setText(`${command.trigger ?? '/'}${command.name} `);
    setSlashIndex(0);
    textarea.current?.focus();
  };

  const toggleMultitask = () => {
    const next = !multitask;
    setMultitask(next);
    useStore.getState().patchView(chat.id, (current) => {
      if (current.local) current.local = { ...current.local, prefs: { ...current.local.prefs, multitask: next } };
    });
    call('chats.setPrefs', chat.id, { multitask: next }).catch((error) => toast('error', error instanceof Error ? error.message : String(error)));
  };

  /** Off always works, so a chat left on team-only can still write to the agent; on needs a server that takes it. */
  const toggleTeam = () => {
    if (chat.kind === 'private') return;
    const next = !teamOnly;
    if (next && teamSupport === false) {
      toast('error', t('This team server can’t take team-only messages yet: whoever hosts it has to update CooPrompt.'));
      return;
    }
    setTeamOnly(next);
    useStore.getState().patchView(chat.id, (current) => {
      if (current.local) current.local = { ...current.local, prefs: { ...current.local.prefs, teamOnly: next } };
    });
    call('chats.setPrefs', chat.id, { teamOnly: next }).catch((error) => toast('error', error instanceof Error ? error.message : String(error)));
    textarea.current?.focus();
  };
  const latestToggleTeam = useRef(toggleTeam);
  latestToggleTeam.current = toggleTeam;

  // ⇧⌘E from anywhere in the chat, except while typing in another field.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey || event.key.toLowerCase() !== 'e') return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target && target !== textarea.current && target.closest('input, textarea, select, [contenteditable="true"]')) return;
      event.preventDefault();
      latestToggleTeam.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const requestOf = (turn: TurnInfo) => {
    const data = view.items[`${turn.id}.prompt`]?.data as UserItemData | undefined;
    return data ? promptText(data) || data.text : '';
  };
  const nameOf = (turn: TurnInfo) => chat.members.find((member) => member.user.id === turn.requesterId)?.user.name ?? t('someone');

  const sendToTeam = async () => {
    const attachments = draft.files.map((file) => file.id);
    setSending(true);
    try {
      await call('chats.sendTeam', { chatId: chat.id, text: text.trim(), ...(attachments.length > 0 ? { attachments } : {}) });
      setText('');
      draft.sent(attachments);
    } catch (error) {
      toast('error', error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  };

  const send = async (interrupt = false, chosen?: TurnInfo) => {
    const value = text.trim();
    if (!sendable || sending || destination === 'blocked') return;
    // Whatever was pressed (⌘↩ included), the mode on screen decides: team-only never reaches an agent.
    if (destination === 'team') return sendToTeam();
    if (!profile) {
      set({ settingsTab: 'models' });
      return;
    }
    const stopping = interrupt ? (chosen ?? target) : null;
    const attachments = draft.files.map((file) => file.id);
    setSending(true);
    setPicking(false);
    try {
      await call('chats.send', {
        chatId: chat.id,
        text: value,
        profileId: profile.id,
        model: model || null,
        effort: chosenEffort || null,
        permissionMode: mode,
        deviceId: deviceId ?? undefined,
        interrupt: stopping !== null,
        interruptTurnId: stopping?.id,
        parallel,
        ...(attachments.length > 0 ? { attachments } : {}),
      });
      setText('');
      draft.sent(attachments);
      setPaletteClosed(false);
    } catch (error) {
      toast('error', error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  };

  if (!chat.isMember) {
    return (
      <div className="border-t border-line-soft px-6 py-4">
        <div className="mx-auto flex max-w-[860px] items-center justify-between gap-4 rounded-xl border border-line bg-panel px-4 py-3">
          <p className="text-[13px] text-dim">{t('You are viewing a company chat. Join to talk to the agent and sync its workspace.')}</p>
          <Button
            variant="primary"
            onClick={() =>
              void call('chats.join', chat.id)
                .then((joined) => set({ chats: { ...useStore.getState().chats, [joined.id]: joined } }))
                .catch((error) => toast('error', error.message))
            }
          >
            {t('Join')}
          </Button>
        </div>
      </div>
    );
  }

  const interruptTitle = !canInterrupt
    ? t('Only whoever started the current turn or the chat owner can interrupt it')
    : targets.length > 1
      ? t('Choose a running turn to stop and send this now, with everything it did so far as context (⌘↩ stops your latest one)')
      : t('Stop the current turn and send this now, with everything done so far as context (⌘↩)');
  const sendTitle = !active
    ? t('Send (Enter)')
    : startsNow
      ? t('Send (Enter): it starts right away, beside the running turns')
      : parallel && full
        ? t('Queue (Enter): {max} turns are running, the most at once; it starts when one finishes', { max: maxParallel })
        : parallel
          ? t('Queue (Enter): it starts after the messages waiting ahead of it')
          : t('Queue (Enter): it runs when the current turn finishes');

  return (
    <div className="px-6 pb-5 pt-2">
      <div className="relative mx-auto max-w-[860px]">
        {paletteOpen && (
          <div className="absolute bottom-full mb-2 w-full max-w-[560px] overflow-hidden rounded-xl border border-line bg-raised shadow-xl">
            <div className="flex items-center gap-2 border-b border-line-soft px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-faint">
              {trigger === '$' ? t('Codex skills') : engine === 'codex' ? t('Commands for Codex') : engine === 'cursor' ? t('Commands for Cursor') : t('Commands for Claude Code')}
              {commands === null && <Loader2 className="size-3 animate-spin" />}
              <span className="ml-auto font-normal normal-case tracking-normal">{t('↑↓ to choose · Tab to complete · Esc to close')}</span>
            </div>
            <div ref={palette} className="max-h-72 overflow-y-auto py-1">
              {commands !== null && options.length === 0 && <p className="px-3 py-2 text-[12.5px] text-faint">{t('No commands match')}</p>}
              {options.map((option, index) => (
                <button
                  key={`${option.trigger ?? '/'}${option.name}`}
                  data-index={index}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    complete(option);
                  }}
                  onMouseEnter={() => setSlashIndex(index)}
                  className={`flex w-full items-baseline gap-2 overflow-hidden px-3 py-1.5 text-left cursor-default ${index === slashIndex ? 'bg-accent/20' : ''}`}
                >
                  <span className="shrink-0 font-mono text-[12.5px] text-ink">
                    {option.trigger ?? '/'}
                    {option.name}
                  </span>
                  {option.argumentHint && (
                    <span className="min-w-0 max-w-[40%] shrink truncate font-mono text-[11.5px] text-faint" title={option.argumentHint}>
                      {option.argumentHint}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate text-[12px] text-dim" title={t(option.description)}>
                    {t(option.description)}
                  </span>
                  <span className="shrink-0 text-[10.5px] text-faint">{t(SOURCE_LABEL[option.source])}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {!paletteOpen && hint && (hint.argumentHint || hint.description) && (
          <div className="absolute bottom-full mb-2 max-w-[560px] truncate rounded-lg border border-line bg-raised px-3 py-1.5 text-[12px] text-dim shadow-lg">
            <span className="font-mono text-ink">/{hint.name}</span> {hint.argumentHint && <span className="font-mono text-faint">{hint.argumentHint}</span>} · {t(hint.description)}
          </div>
        )}
        <DropOverlay draft={draft} />
        <div className={`rounded-2xl border shadow-lg ${team ? 'border-team/55 bg-[#203329] focus-within:border-team' : 'border-line bg-panel focus-within:border-accent/70'}`}>
          {team && (
            <div className="flex items-center gap-1.5 px-4 pt-2.5 text-[12px] font-medium text-team">
              <EyeOff className="size-3.5" /> {t('Team only · the AI won’t see this message')}
            </div>
          )}
          <StagedFiles draft={draft} />
          <textarea
            ref={textarea}
            value={text}
            rows={1}
            onPaste={draft.onPaste}
            onChange={(event) => {
              setText(event.target.value);
              setSlashIndex(0);
              setPaletteClosed(false);
              if (chat.kind !== 'private' && Date.now() - lastTyping.current > 2500) {
                lastTyping.current = Date.now();
                void call('chats.typing', chat.id);
              }
            }}
            onKeyDown={(event) => {
              const enter = event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing;
              if (enter && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void send(true);
                return;
              }
              if (paletteOpen && options.length > 0) {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  setSlashIndex((index) => (index + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length);
                  return;
                }
                const selected = options[slashIndex] ?? options[0];
                if (event.key === 'Tab') {
                  event.preventDefault();
                  complete(selected);
                  return;
                }
                if (enter && ![selected.name, ...(selected.aliases ?? [])].includes(text.slice(1))) {
                  event.preventDefault();
                  complete(selected);
                  return;
                }
              }
              if (paletteOpen && event.key === 'Escape') {
                event.preventDefault();
                setPaletteClosed(true);
                return;
              }
              if (enter) {
                event.preventDefault();
                void send();
              }
            }}
            placeholder={
              team
                ? t('Write to the team — the AI won’t see this')
                : chat.kind === 'private'
                  ? t('Ask the agent anything… (/ for commands and skills)')
                  : t('Write to the agent — everyone sees it live (/ for commands and skills)')
            }
            className={`block max-h-[280px] w-full resize-none bg-transparent px-4 pb-2 text-[14px] leading-relaxed text-ink outline-none placeholder:text-faint ${team ? 'pt-2' : 'pt-3.5'}`}
          />
          <div className="flex flex-wrap items-center gap-1.5 px-2.5 pb-2.5">
            <AttachButton draft={draft} />
            {!team && (
              <>
                <select
                  value={profileId ?? ''}
                  onChange={(event) => setProfileId(event.target.value || null)}
                  className="h-7 max-w-[220px] rounded-md bg-raised px-2 text-[12px] text-dim outline-none"
                  title={t('Model and credentials (from this computer)')}
                >
                  {(providers?.profiles ?? []).length === 0 && <option value="">{t('Set up a model…')}</option>}
                  {(providers?.profiles ?? []).map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {/codex|claude|cursor/i.test(entry.label) ? currentProfileLabel(entry.label) : `${ENGINE_NAME[entry.engine] ?? entry.engine} · ${currentProfileLabel(entry.label)}`}
                    </option>
                  ))}
                </select>
                <input
                  list={`models-${chat.id}`}
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  placeholder={profile?.model || defaultModel?.id || t('default model')}
                  className="h-7 w-36 rounded-md bg-raised px-2 font-mono text-[11.5px] text-dim outline-none placeholder:text-faint"
                  title={t('Model')}
                />
                <datalist id={`models-${chat.id}`}>
                  {models.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.label}
                    </option>
                  ))}
                </datalist>
                {effortChoices.length > 0 && (
                  <label className="flex h-7 items-center gap-1 rounded-md bg-raised pl-2 text-[12px] text-dim" title={t('Reasoning effort: how much the model thinks before answering')}>
                    <Gauge className="size-3.5 shrink-0" />
                    <select value={chosenEffort} onChange={(event) => setEffort(event.target.value)} className="h-7 bg-transparent pr-2 outline-none">
                      <option value="">{modelInfo?.defaultEffort ? t('{level} (default)', { level: effortName(modelInfo.defaultEffort) }) : t('Default effort')}</option>
                      {effortChoices.map((choice) => (
                        <option key={choice.id} value={choice.id} title={choice.description}>
                          {effortName(choice.id)}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <select value={chosenMode} onChange={(event) => setMode(event.target.value as PermissionModeId)} className="h-7 rounded-md bg-raised px-2 text-[12px] text-dim outline-none" title={t('Permissions')}>
                  {ENGINE_PERMISSION_MODES[engine].map((value) => (
                    <option key={value} value={value}>
                      {t(PERMISSION_LABEL[value])}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={toggleMultitask}
                  disabled={maxParallel === null}
                  aria-pressed={parallel}
                  className={`flex h-7 items-center gap-1 rounded-md px-2 text-[12px] cursor-default disabled:opacity-50 ${parallel ? 'bg-accent/20 text-accent' : 'bg-raised text-dim hover:text-ink'}`}
                  title={
                    maxParallel === null
                      ? t('Multitask needs a newer team server: update the CooPrompt that hosts it.')
                      : t('Multitask: your messages start right away, beside the running turns (up to {max} at once), instead of waiting for them', { max: maxParallel })
                  }
                >
                  <Layers className="size-3.5" /> {t('Multitask')}
                </button>
                {devices.length > 1 && (
                  <label className="flex h-7 items-center gap-1 rounded-md bg-raised px-2 text-[12px] text-dim" title={t('Run on another of your connected devices')}>
                    <Monitor className="size-3.5" />
                    <select value={deviceId ?? app?.deviceId ?? ''} onChange={(event) => setDeviceId(event.target.value)} className="bg-transparent outline-none">
                      {devices.map((device) => (
                        <option key={device.deviceId} value={device.deviceId}>
                          {device.deviceId === app?.deviceId ? t('This computer ({name})', { name: device.deviceName }) : device.deviceName}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </>
            )}
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              {/* The Cursor CLI doesn't report how full its session is, so after /new there is nothing to show. */}
              {!team && session && (engine !== 'cursor' || session.usage?.contextWindow) && <ContextRing turn={session} t={t} />}
              {mine.length > 0 && (
                <Button size="sm" variant="ghost" onClick={() => mine.forEach((turn) => void call('turns.cancel', turn.id).catch((error) => toast('error', error.message)))} title={t('Stop my turns')}>
                  <Square className="size-3.5" /> {t('Stop')}
                </Button>
              )}
              {active && !team && (
                <div className="relative">
                  <Button
                    size="sm"
                    onClick={() => (targets.length > 1 ? setPicking(!picking) : void send(true))}
                    disabled={!sendable || sending || !canInterrupt}
                    title={interruptTitle}
                  >
                    <Zap className="size-3.5" /> {t('Interrupt and send')}
                    {targets.length > 1 && <ChevronDown className="size-3" />}
                  </Button>
                  {picking && targets.length > 1 && (
                    <div className="absolute bottom-full right-0 z-20 mb-2 w-96 overflow-hidden rounded-xl border border-line bg-raised py-1 shadow-xl" onMouseLeave={() => setPicking(false)}>
                      <p className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-faint">{t('Which turn do you want to interrupt?')}</p>
                      {targets.map((turn) => (
                        <button
                          key={turn.id}
                          onClick={() => void send(true, turn)}
                          title={requestOf(turn)}
                          className="flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left hover:bg-accent/20 cursor-default"
                        >
                          <span className="text-[12.5px] font-medium text-ink">
                            {turn.requesterId === me ? t('Your turn') : t('{name}’s turn', { name: nameOf(turn) })}
                            <span className="font-normal text-faint"> · {clock(turn.startedAt ?? turn.createdAt, t)}</span>
                          </span>
                          <span className="line-clamp-3 w-full text-[12px] text-dim">{requestOf(turn)}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {chat.kind !== 'private' && (
                <button
                  type="button"
                  onClick={toggleTeam}
                  aria-disabled={teamSupport === false && !teamOnly}
                  aria-pressed={team}
                  className={`flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-medium cursor-default aria-disabled:opacity-50 ${team ? 'bg-team/20 text-team ring-1 ring-team/60' : 'bg-raised text-dim hover:text-ink'}`}
                  title={
                    teamSupport === false && !teamOnly
                      ? t('Team-only messages need a newer team server: update the CooPrompt that hosts it.')
                      : team
                        ? t('Team only is on: your messages go to the people in this chat, never to the AI (⇧⌘E turns it off)')
                        : t('Team only: write to the people in this chat without the AI seeing it (⇧⌘E)')
                  }
                >
                  <EyeOff className="size-3.5" /> {t('Team only')}
                </button>
              )}
              <button
                onClick={() => void send()}
                disabled={!sendable || sending || destination === 'blocked'}
                className={`flex size-8 items-center justify-center rounded-lg transition-colors disabled:bg-raised disabled:text-faint cursor-default ${team ? 'bg-team text-on-team hover:bg-team-hover' : 'bg-accent text-on-accent hover:bg-accent-hover'}`}
                title={team ? t('Send to the team only (Enter)') : sendTitle}
              >
                {sending && draft.files.length > 0 ? <Loader2 className="size-4 animate-spin" /> : team ? <Send className="size-4" /> : <ArrowUp className="size-4" />}
              </button>
            </div>
          </div>
        </div>
        <p className={`mt-1.5 text-center text-[11px] ${destination === 'blocked' ? 'text-warn' : team ? 'text-team' : parallel && active ? 'text-warn' : 'text-faint'}`}>
          {destination === 'blocked'
            ? t('This team server can’t take team-only messages yet: whoever hosts it has to update CooPrompt. Turn off Team only to write to the AI.')
            : team
              ? t('Only the people in this chat see this: no agent gets it, so it costs no tokens. ⇧⌘E goes back to the AI.')
              : parallel
                ? !active
                  ? t('Multitask is on: your messages start right away even while others run, up to {max} at once. Turns running together share this chat’s folder and may edit the same files.', { max: maxParallel })
                  : startsNow
                    ? t('Multitask: Enter starts your message right away, beside the running turns. They share this chat’s folder, so they may edit the same files.')
                    : full
                      ? t('{max} turns are running, the most at once: Enter queues your message until one finishes.', { max: maxParallel })
                      : t('Messages sent earlier are waiting: Enter queues yours after them.')
                : active
                  ? canInterrupt
                    ? t('The agent is working: Enter queues your message and ⌘↩ interrupts it to send yours now.')
                    : t('The agent is working: your message will wait in the queue.')
                  : chat.kind === 'private'
                    ? t('Runs on this computer with your credentials.')
                    : t('Each request runs on the computer of whoever sends it, with their own credentials. Everything else is shared live.')}
        </p>
      </div>
    </div>
  );
}
