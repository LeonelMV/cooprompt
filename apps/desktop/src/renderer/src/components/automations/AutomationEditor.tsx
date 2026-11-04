import { useEffect, useMemo, useState } from 'react';
import { FolderOpen, MessageSquare } from 'lucide-react';
import type { AutomationSchedule, PermissionModeId } from '@cooprompt/protocol';
import { scheduleError, upcomingRuns } from '@cooprompt/protocol';
import { DEFAULT_EFFORT_CHOICES, EFFORT_LABEL } from '../../../../shared/effort.ts';
import { currentProfileLabel } from '../../../../shared/profile-label.ts';
import type { ModelChoice } from '../../../../shared/types.ts';
import { call } from '../../lib/api.ts';
import { ACCESS, duration, LOCAL_TIME_ZONE, TIME_LIMITS, weekdayNames, when } from '../../lib/automations.ts';
import { useT } from '../../lib/i18n.ts';
import { useStore } from '../../lib/store.ts';
import { Button, Field, Input, Modal, Select, TextArea, Toggle } from '../ui.tsx';

type Preset = 'interval' | 'daily' | 'weekdays' | 'weekly' | 'cron';

const PRESETS: { id: Preset; label: string }[] = [
  { id: 'interval', label: 'Every few minutes or hours' },
  { id: 'daily', label: 'Every day' },
  { id: 'weekdays', label: 'Weekdays (Monday to Friday)' },
  { id: 'weekly', label: 'On some days of the week' },
  { id: 'cron', label: 'Custom (cron)' },
];

const WEEKDAYS = [1, 2, 3, 4, 5];
/** Monday first, as calendars here show it. */
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

function initialPreset(schedule: AutomationSchedule | undefined): Preset {
  if (!schedule) return 'daily';
  if (schedule.kind === 'weekly') return [...schedule.days].sort().join() === WEEKDAYS.join() ? 'weekdays' : 'weekly';
  return schedule.kind;
}

export function AutomationEditor() {
  const t = useT();
  const { app, providers, chats, automationEditor, set, toast } = useStore();
  const editing = automationEditor?.automation ?? null;
  const limits = app?.automations ?? { minIntervalMinutes: 15, maxRunMinutes: 240 };
  const schedule0 = editing?.schedule;

  const [name, setName] = useState(editing?.name ?? '');
  const [instructions, setInstructions] = useState(editing?.instructions ?? '');
  const [target, setTarget] = useState<'own' | 'chat'>(editing || automationEditor?.chatId ? 'chat' : 'own');
  const [chatId, setChatId] = useState(editing?.chatId ?? automationEditor?.chatId ?? '');
  const [folder, setFolder] = useState<string | null>(null);
  const [preset, setPreset] = useState<Preset>(initialPreset(schedule0));
  const [amount, setAmount] = useState(schedule0?.kind === 'interval' ? (schedule0.minutes % 60 === 0 ? schedule0.minutes / 60 : schedule0.minutes) : 1);
  const [unit, setUnit] = useState<'minutes' | 'hours'>(schedule0?.kind === 'interval' && schedule0.minutes % 60 !== 0 ? 'minutes' : 'hours');
  const [time, setTime] = useState(schedule0 && 'time' in schedule0 ? schedule0.time : '09:00');
  const [days, setDays] = useState<number[]>(schedule0?.kind === 'weekly' ? schedule0.days : [1]);
  const [expression, setExpression] = useState(schedule0?.kind === 'cron' ? schedule0.expression : '0 9 * * 1-5');
  const [profileId, setProfileId] = useState<string | null>(editing?.config.profileId ?? providers?.defaultProfileId ?? providers?.profiles[0]?.id ?? null);
  const [model, setModel] = useState(editing?.config.model ?? '');
  const [effort, setEffort] = useState(editing?.config.effort ?? '');
  const [mode, setMode] = useState<PermissionModeId>(editing?.config.permissionMode ?? 'plan');
  const [fresh, setFresh] = useState(editing?.fresh ?? true);
  const [freshTouched, setFreshTouched] = useState(Boolean(editing));
  const [timeLimit, setTimeLimit] = useState(editing?.timeLimitMinutes ?? 20);
  const [deviceId, setDeviceId] = useState(editing?.deviceId ?? app?.deviceId ?? '');
  const [enabled, setEnabled] = useState(editing?.enabled ?? true);
  const [models, setModels] = useState<ModelChoice[]>([]);
  const [busy, setBusy] = useState(false);

  const close = () => set({ automationEditor: null });
  const profiles = providers?.profiles ?? [];
  const profile = profiles.find((entry) => entry.id === profileId) ?? profiles.find((entry) => entry.id === providers?.defaultProfileId) ?? profiles[0] ?? null;
  const engine = profile?.engine ?? 'claude';
  const memberChats = Object.values(chats)
    .filter((chat) => chat.isMember)
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  const devices = app?.devices ?? [];
  const names = weekdayNames(t);

  useEffect(() => {
    if (!profile) return;
    let cancelled = false;
    call('providers.models', profile.id)
      .then((list) => !cancelled && setModels(list))
      .catch(() => !cancelled && setModels([]));
    return () => {
      cancelled = true;
    };
  }, [profile?.id]);

  const chooseTarget = (value: 'own' | 'chat') => {
    setTarget(value);
    if (!freshTouched) setFresh(value === 'own');
  };

  const schedule: AutomationSchedule = useMemo(() => {
    switch (preset) {
      case 'interval':
        return { kind: 'interval', minutes: Math.round(amount * (unit === 'hours' ? 60 : 1)) };
      case 'daily':
        return { kind: 'daily', time };
      case 'weekdays':
        return { kind: 'weekly', days: WEEKDAYS, time };
      case 'weekly':
        return { kind: 'weekly', days, time };
      case 'cron':
        return { kind: 'cron', expression };
    }
  }, [preset, amount, unit, time, days, expression]);
  const problem = scheduleError(schedule, LOCAL_TIME_ZONE, limits.minIntervalMinutes, Date.now());
  // An unchanged interval keeps counting from when it was first chosen.
  const previewed = schedule.kind === 'interval' && schedule0?.kind === 'interval' && schedule0.minutes === schedule.minutes ? schedule0 : schedule;
  const upcoming = problem ? [] : upcomingRuns(previewed, LOCAL_TIME_ZONE, Date.now(), 3);

  const defaultModel = profile?.model ? undefined : models.find((entry) => entry.isDefault);
  const modelInfo = models.find((entry) => entry.id === (model || profile?.model)) ?? (model ? undefined : defaultModel);
  const effortChoices = modelInfo?.efforts?.length ? modelInfo.efforts : (DEFAULT_EFFORT_CHOICES[engine] ?? []).map((id) => ({ id, description: undefined }));
  const chosenEffort = effortChoices.some((choice) => choice.id === effort) ? effort : '';
  const access = ACCESS.find((entry) => entry.mode === mode) ?? ACCESS[0];
  const missing = !name.trim() ? t('Give it a name') : !instructions.trim() ? t('Write what it should do') : target === 'chat' && !chatId ? t('Choose the chat it posts in') : !profile ? t('Set up a model first') : problem ? t.message(problem) : null;

  const save = async () => {
    if (missing || !profile) return;
    setBusy(true);
    try {
      const saved = await call('automations.save', {
        id: editing?.id,
        name: name.trim(),
        instructions: instructions.trim(),
        target: target === 'own' ? { kind: 'own', folder } : { kind: 'chat', chatId },
        schedule,
        profileId: profile.id,
        model: model.trim() || null,
        effort: chosenEffort || null,
        permissionMode: mode,
        fresh,
        timeLimitMinutes: timeLimit,
        enabled,
        deviceId: deviceId || undefined,
      });
      set({ automationEditor: null, automations: { ...useStore.getState().automations, [saved.id]: saved } });
      toast('info', saved.enabled && saved.nextRunAt ? t('“{name}” saved. Next run: {when}', { name: saved.name, when: when(saved.nextRunAt, t) }) : t('“{name}” saved.', { name: saved.name }));
    } catch (error) {
      toast('error', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={editing ? t('Edit automation') : t('New automation')}
      onClose={close}
      width={640}
      footer={
        <>
          {missing && <span className="mr-auto self-center text-[12px] text-faint">{missing}</span>}
          <Button variant="ghost" onClick={close}>
            {t('Cancel')}
          </Button>
          <Button variant="primary" busy={busy} disabled={Boolean(missing)} onClick={() => void save()}>
            {editing ? t('Save') : t('Create')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={t('Name')}>
          <Input autoFocus value={name} maxLength={80} onChange={(event) => setName(event.target.value)} placeholder={t('e.g. Morning CI check')} />
        </Field>
        <Field label={t('Instructions')} hint={t('What the agent does on each run, as you would write it in the composer: start with a /command or mention a $skill to use them. Nobody can answer it while it runs, so say what to report.')}>
          <TextArea rows={5} value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder={t('e.g. Check the CI of the main branch. If something failed, find the commit that broke it and summarize the error.')} />
        </Field>

        <div className="space-y-1.5">
          <span className="text-[12.5px] font-medium text-dim">{t('Where it runs')}</span>
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                { value: 'own', icon: FolderOpen, label: 'A chat of its own', description: 'A private chat for its runs, working in a folder on this computer.' },
                { value: 'chat', icon: MessageSquare, label: 'An existing chat', description: 'Its runs appear there as your turns, for everyone in the chat.' },
              ] as const
            ).map(({ value, icon: Icon, label, description }) => (
              <button
                key={value}
                onClick={() => chooseTarget(value)}
                className={`flex flex-col gap-1 rounded-xl border p-3 text-left cursor-default ${target === value ? 'border-accent bg-accent/10' : 'border-line hover:border-accent/60'}`}
              >
                <Icon className={`size-4 ${target === value ? 'text-accent' : 'text-dim'}`} />
                <span className="text-[13px] font-medium">{t(label)}</span>
                <span className="text-[11.5px] leading-snug text-faint">{t(description)}</span>
              </button>
            ))}
          </div>
          {target === 'own' ? (
            <Field label={t('Working folder')} hint={t('Optional. If you do not pick one, a new folder is created in ~/CooPrompt/Privados.')}>
              <div className="flex gap-2">
                <Input readOnly value={folder ?? ''} placeholder={t('New folder (automatic)')} />
                <Button onClick={() => void call('app.pickFolder', folder).then((picked) => picked && setFolder(picked))}>{t('Choose…')}</Button>
              </div>
            </Field>
          ) : (
            <Select value={chatId} onChange={(event) => setChatId(event.target.value)} className="w-full">
              <option value="">{t('Choose a chat…')}</option>
              {memberChats.map((chat) => (
                <option key={chat.id} value={chat.id}>
                  {chat.title}
                </option>
              ))}
            </Select>
          )}
        </div>

        <div className="space-y-2">
          <span className="text-[12.5px] font-medium text-dim">{t('When')}</span>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={preset} onChange={(event) => setPreset(event.target.value as Preset)}>
              {PRESETS.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {t(entry.label)}
                </option>
              ))}
            </Select>
            {preset === 'interval' && (
              <>
                <span className="text-[13px] text-dim">{t('every')}</span>
                <Input type="number" min={1} value={amount} onChange={(event) => setAmount(Number(event.target.value) || 1)} className="!w-20" />
                <Select value={unit} onChange={(event) => setUnit(event.target.value as 'minutes' | 'hours')}>
                  <option value="minutes">{t('minutes')}</option>
                  <option value="hours">{t('hours')}</option>
                </Select>
              </>
            )}
            {(preset === 'daily' || preset === 'weekdays' || preset === 'weekly') && (
              <>
                <span className="text-[13px] text-dim">{t('at')}</span>
                <Input type="time" value={time} onChange={(event) => setTime(event.target.value)} className="!w-28" />
              </>
            )}
            {preset === 'cron' && <Input value={expression} onChange={(event) => setExpression(event.target.value)} className="!w-56 font-mono" placeholder="0 9 * * 1-5" />}
          </div>
          {preset === 'weekly' && (
            <div className="flex gap-1">
              {DAY_ORDER.map((day) => (
                <button
                  key={day}
                  onClick={() => setDays(days.includes(day) ? days.filter((entry) => entry !== day) : [...days, day])}
                  className={`h-7 min-w-10 rounded-md border px-2 text-[12px] cursor-default ${days.includes(day) ? 'border-accent bg-accent/20 text-ink' : 'border-line text-dim hover:text-ink'}`}
                >
                  {names[day]}
                </button>
              ))}
            </div>
          )}
          <p className={`text-[12px] ${problem ? 'text-warn' : 'text-faint'}`}>
            {problem
              ? t.message(problem)
              : t('Next runs: {list}. Times are in your time zone ({zone}); runs are at least {minutes} minutes apart.', {
                  list: upcoming.map((instant) => when(instant, t)).join(' · '),
                  zone: LOCAL_TIME_ZONE,
                  minutes: limits.minIntervalMinutes,
                })}
            {preset === 'cron' && !problem && ` ${t('Fields: minute, hour, day of the month, month, day of the week.')}`}
          </p>
        </div>

        <div className="space-y-1.5">
          <span className="text-[12.5px] font-medium text-dim">{t('Model')}</span>
          <div className="flex flex-wrap gap-2">
            <Select value={profile?.id ?? ''} onChange={(event) => setProfileId(event.target.value || null)} className="min-w-[180px] flex-1">
              {profiles.length === 0 && <option value="">{t('Set up a model…')}</option>}
              {profiles.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {currentProfileLabel(entry.label)}
                </option>
              ))}
            </Select>
            <Input list="automation-models" value={model} onChange={(event) => setModel(event.target.value)} placeholder={profile?.model || defaultModel?.id || t('default model')} className="!w-48 font-mono !text-[12.5px]" />
            <datalist id="automation-models">
              {models.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </datalist>
            <Select value={chosenEffort} onChange={(event) => setEffort(event.target.value)} title={t('Reasoning effort: how much the model thinks before answering')}>
              <option value="">{modelInfo?.defaultEffort ? t('{level} (default)', { level: t(EFFORT_LABEL[modelInfo.defaultEffort] ?? modelInfo.defaultEffort) }) : t('Default effort')}</option>
              {effortChoices.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {t(EFFORT_LABEL[choice.id] ?? choice.id)}
                </option>
              ))}
            </Select>
          </div>
          <p className="text-[12px] text-faint">{t('It runs on your computer with this model’s credentials and your connectors, like your own messages.')}</p>
        </div>

        <div className="space-y-1.5">
          <span className="text-[12.5px] font-medium text-dim">{t('Permissions')}</span>
          <div className="grid grid-cols-3 gap-2">
            {ACCESS.map((entry) => (
              <button
                key={entry.mode}
                onClick={() => setMode(entry.mode)}
                className={`flex flex-col gap-1 rounded-xl border p-2.5 text-left cursor-default ${
                  mode === entry.mode ? (entry.tone === 'bad' ? 'border-bad bg-bad/10' : entry.tone === 'warn' ? 'border-warn bg-warn/10' : 'border-accent bg-accent/10') : 'border-line hover:border-accent/60'
                }`}
              >
                <span className="text-[13px] font-medium">
                  {t(entry.label)}
                  {entry.mode === 'plan' && <span className="font-normal text-faint"> · {t('recommended')}</span>}
                </span>
                <span className="text-[11.5px] leading-snug text-faint">{t(entry.description)}</span>
              </button>
            ))}
          </div>
          {access.tone !== 'neutral' && <p className="text-[12px] text-warn">{t('Nobody approves anything during a run: this permission is shown next to the automation so everyone knows.')}</p>}
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Field label={t('Time limit')} hint={t('A run still going then is stopped. While it runs, messages sent without multitask in that chat wait for it.')}>
            <Select value={timeLimit} onChange={(event) => setTimeLimit(Number(event.target.value))} className="w-full">
              {[...new Set([...TIME_LIMITS.filter((minutes) => minutes <= limits.maxRunMinutes), timeLimit])]
                .sort((a, b) => a - b)
                .map((minutes) => (
                  <option key={minutes} value={minutes}>
                    {duration(minutes * 60_000, t)}
                  </option>
                ))}
            </Select>
          </Field>
          {(devices.length > 1 || (editing && editing.deviceId !== app?.deviceId)) && (
            <Field label={t('Runs on')}>
              <Select value={deviceId} onChange={(event) => setDeviceId(event.target.value)} className="w-full">
                {editing && !devices.some((device) => device.deviceId === editing.deviceId) && <option value={editing.deviceId}>{t('{name} (offline)', { name: editing.deviceName })}</option>}
                {devices.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.deviceId === app?.deviceId ? t('This computer ({name})', { name: device.deviceName }) : device.deviceName}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>

        <div className="space-y-2.5">
          <div className="flex items-start gap-3">
            <Toggle
              checked={fresh}
              onChange={(value) => {
                setFresh(value);
                setFreshTouched(true);
              }}
            />
            <div className="text-[12.5px]">
              <p className="text-ink">{t('Start a new agent session on each run')}</p>
              <p className="text-faint">{t('Each run starts from its instructions alone. Off, it continues the chat’s agent session with everything said before.')}</p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <Toggle checked={enabled} onChange={setEnabled} />
            <div className="text-[12.5px]">
              <p className="text-ink">{t('Runs on its schedule')}</p>
              <p className="text-faint">{t('Paused, it only runs when you use “Run now”. If your computer is asleep or CooPrompt is closed at a scheduled time, the run is missed, and runs once when you are back if that is closer to it than to the next one.')}</p>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
