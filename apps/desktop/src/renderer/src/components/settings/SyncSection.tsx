import { useEffect, useState } from 'react';
import type { PermissionModeId } from '@cooprompt/protocol';
import type { SettingsView } from '../../../../shared/types.ts';
import { call } from '../../lib/api.ts';
import { PERMISSION_LABEL } from '../../lib/format.ts';
import { useT } from '../../lib/i18n.ts';
import { useStore } from '../../lib/store.ts';
import { Button, Field, Input, Select, Toggle } from '../ui.tsx';
import { SectionTitle } from './SettingsModal.tsx';

export function SyncSection() {
  const t = useT();
  const toast = useStore((state) => state.toast);
  const [settings, setSettings] = useState<SettingsView | null>(null);
  useEffect(() => void call('settings.get').then(setSettings), []);
  if (!settings) return null;
  const update = (patch: Parameters<typeof call<'settings.update'>>[1]) =>
    void call('settings.update', patch)
      .then(setSettings)
      .catch((error) => toast('error', error.message));
  const pick = (key: 'syncRoot' | 'privateRoot') => void call('app.pickFolder', settings[key]).then((folder) => folder && update({ [key]: folder }));

  return (
    <div className="space-y-6">
      <SectionTitle title={t('Folders & privacy')} />
      <Field label={t('Shared workspaces folder')} hint={t('Each multiplayer or company chat keeps its synced mirror here. Applies to new chats.')}>
        <div className="flex gap-2">
          <Input readOnly value={settings.syncRoot} className="font-mono" />
          <Button onClick={() => pick('syncRoot')}>{t('Change…')}</Button>
        </div>
      </Field>
      <Field label={t('Private chats folder')} hint={t('Where private chat folders are created when you do not pick one.')}>
        <div className="flex gap-2">
          <Input readOnly value={settings.privateRoot} className="font-mono" />
          <Button onClick={() => pick('privateRoot')}>{t('Change…')}</Button>
        </div>
      </Field>
      <Field label={t('Default permission mode')}>
        <Select value={settings.defaultPermissionMode} onChange={(event) => update({ defaultPermissionMode: event.target.value as PermissionModeId })}>
          {Object.entries(PERMISSION_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {t(label)}
            </option>
          ))}
        </Select>
      </Field>
      <div className="space-y-1.5">
        <Toggle checked={settings.redactSecrets} onChange={(value) => update({ redactSecrets: value })} label={t('Hide secrets in what gets posted to the chat')} />
        <p className="text-[12px] leading-relaxed text-faint">
          {t('Before leaving your computer, tool output and agent messages are filtered: your configured API keys and common patterns (GitHub, Slack and AWS tokens, private keys, JWTs) are replaced with «redacted».')}
        </p>
      </div>
    </div>
  );
}
