import { useState } from 'react';
import { LANGUAGES, type Language } from '../../../../shared/i18n.ts';
import type { UpdateState } from '../../../../shared/types.ts';
import { call } from '../../lib/api.ts';
import { useT, type T } from '../../lib/i18n.ts';
import { useStore } from '../../lib/store.ts';
import { Avatar, Badge, Button, Field, Input, Select } from '../ui.tsx';
import { SectionTitle } from './SettingsModal.tsx';

function updateLine(update: UpdateState, t: T): string {
  if (update.status === 'checking') return t('Checking…');
  if (update.status === 'error' && !update.available) return t.message(update.error ?? '');
  if (update.available) return t('CooPrompt {version} is available', { version: update.available.version });
  return update.checkedAt ? t('CooPrompt is up to date') : '';
}

export function AccountSection() {
  const t = useT();
  const { app, set, toast } = useStore();
  const [deviceName, setDeviceName] = useState(app?.deviceName ?? '');
  const [server, setServer] = useState(app?.serverUrl ?? '');
  const [changing, setChanging] = useState(false);
  if (!app?.user) return null;

  const changeServer = async () => {
    setChanging(true);
    try {
      const state = await call('auth.changeServer', server);
      set({ app: state });
      setServer(state.serverUrl ?? '');
      toast('info', t('Server address updated'));
    } catch (error) {
      toast('error', error instanceof Error ? error.message : String(error));
    } finally {
      setChanging(false);
    }
  };

  return (
    <div className="space-y-6">
      <SectionTitle title={t('Account & device')} />
      <div className="flex items-center gap-3">
        <Avatar user={app.user} size={44} />
        <div>
          <p className="text-[15px] font-semibold">{app.user.name}</p>
          <p className="text-[13px] text-dim">{app.user.email}</p>
          <div className="mt-1">
            {app.user.orgDomain ? <Badge tone="accent">{t('Organization: {domain}', { domain: app.user.orgDomain })}</Badge> : <Badge>{t('No organization (personal email)')}</Badge>}
          </div>
        </div>
      </div>
      <Field label={t('Language')}>
        <Select value={app.language} onChange={(event) => void call('settings.update', { language: event.target.value as Language }).catch((error) => toast('error', error.message))}>
          {LANGUAGES.map((language) => (
            <option key={language.id} value={language.id}>
              {language.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t('Server')} hint={t('If the server got a new address (for example a new tunnel), enter it here: you stay signed in.')}>
        <div className="flex gap-2">
          <Input value={server} onChange={(event) => setServer(event.target.value)} className="font-mono" />
          <Button busy={changing} disabled={!server.trim() || server.trim() === app.serverUrl} onClick={() => void changeServer()}>
            {t('Change')}
          </Button>
        </div>
      </Field>
      <Field label={t('Connection')}>
        <div className="flex h-9 items-center gap-2 text-[13px]">
          <Badge tone={app.connection.status === 'online' ? 'ok' : app.connection.status === 'connecting' ? 'warn' : 'bad'}>{t(app.connection.status)}</Badge>
          {app.connection.error && <span className="text-faint">{app.connection.error}</span>}
        </div>
      </Field>
      <div className="space-y-1.5">
        <span className="text-[12.5px] font-medium text-dim">{t('Version')}</span>
        <div className="flex h-9 items-center gap-3 text-[13px]">
          <span className="font-mono">{app.version}</span>
          {app.update.enabled ? (
            <>
              <Button size="sm" busy={app.update.status === 'checking'} onClick={() => void call('update.check').catch((error) => toast('error', error.message))}>
                {t('Check for updates')}
              </Button>
              <span className="min-w-0 truncate text-faint">{updateLine(app.update, t)}</span>
            </>
          ) : (
            <span className="text-faint">{t('Updates are off in development builds and profiles.')}</span>
          )}
        </div>
      </div>
      <Field label={t('Name of this device')} hint={t('Others see which computer runs each turn (and with whose credentials).')}>
        <div className="flex gap-2">
          <Input value={deviceName} onChange={(event) => setDeviceName(event.target.value)} />
          <Button onClick={() => void call('device.rename', deviceName).then((state) => set({ app: state }))}>{t('Save')}</Button>
        </div>
      </Field>
      {app.devices.length > 0 && (
        <Field label={t('Your connected devices')} hint={t('From the composer you can run a turn on another of your computers (remote control), always with that computer’s credentials.')}>
          <ul className="space-y-1 text-[13px] text-dim">
            {app.devices.map((device) => (
              <li key={device.deviceId}>
                • {device.deviceName} {device.deviceId === app.deviceId && <span className="text-faint">{t('(this one)')}</span>}
              </li>
            ))}
          </ul>
        </Field>
      )}
      <Button
        variant="danger"
        onClick={() =>
          void call('auth.logout')
            .then((state) => set({ app: state, settingsTab: null, chats: {}, activeChatId: null }))
            .catch((error) => toast('error', error.message))
        }
      >
        {t('Sign out')}
      </Button>
    </div>
  );
}
