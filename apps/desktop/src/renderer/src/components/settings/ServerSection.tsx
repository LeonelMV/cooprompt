import { useEffect, useState } from 'react';
import { Copy, ExternalLink, Globe, Play, Square } from 'lucide-react';
import type { SettingsView } from '../../../../shared/types.ts';
import { call } from '../../lib/api.ts';
import { installCommand } from '../../lib/format.ts';
import { useT } from '../../lib/i18n.ts';
import { useStore } from '../../lib/store.ts';
import { TunnelNotice } from '../TunnelNotice.tsx';
import { Badge, Button, Field, Input, Spinner } from '../ui.tsx';
import { SectionTitle } from './SettingsModal.tsx';

function CopyRow({ value }: { value: string }) {
  const t = useT();
  return (
    <div className="flex items-center gap-2 rounded-lg bg-side px-3 py-1.5 font-mono text-[12.5px]">
      <span className="selectable min-w-0 flex-1 truncate">{value}</span>
      <button className="text-dim hover:text-ink cursor-default" title={t('Copy')} onClick={() => void navigator.clipboard.writeText(value)}>
        <Copy className="size-3.5" />
      </button>
    </div>
  );
}

const GOOGLE_CLIENTS_URL = 'https://console.cloud.google.com/auth/clients';

export function ServerSection() {
  const t = useT();
  const { app, toast } = useStore();
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [saved, setSaved] = useState<SettingsView | null>(null);
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const reload = async () => {
    const value = await call('settings.get');
    setSettings(value);
    setSaved(value);
  };
  useEffect(() => void reload(), []);
  const host = app?.host;
  if (!settings || !saved || !host) return null;
  const googleReady = Boolean(settings.host.googleClientId.trim() && (secret || settings.host.hasGoogleSecret));
  const googleOnly = saved.host.googleOnly && Boolean(saved.host.googleClientId.trim() && saved.host.hasGoogleSecret);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
    } catch (error) {
      toast('error', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  // Sign-in settings apply to the running server at once; its name and port need a restart.
  const saveHost = () =>
    run('save', async () => {
      const restart = host.running && (settings.host.name !== saved.host.name || settings.host.port !== saved.host.port);
      const next = await call('settings.update', { host: { ...settings.host, ...(secret ? { googleClientSecret: secret } : {}) } });
      setSettings(next);
      setSaved(next);
      setSecret('');
      toast('info', restart ? t('Saved. Restart the server to apply the changes.') : t('Saved'));
    });

  const tunnelOpen = host.tunnelStatus === 'on' || host.tunnelStatus === 'reconnecting';
  const windows = navigator.userAgent.includes('Windows');

  return (
    <div className="space-y-6">
      <SectionTitle title={t('Team server')}>
        {t('CooPrompt needs a server for chats, invitations and the shared workspace. You can host it on this computer (your teammate connects over the local network or a public tunnel) or use a dedicated one with npm run server.')}
      </SectionTitle>

      <div className="space-y-3 rounded-xl border border-line bg-panel p-4">
        <div className="flex items-center gap-3">
          <Badge tone={host.running ? 'ok' : 'neutral'}>{host.running ? t('Running · port {port}', { port: host.port }) : t('Stopped')}</Badge>
          <div className="flex-1" />
          {host.running ? (
            <Button
              variant="danger"
              busy={busy === 'stop'}
              onClick={() =>
                void run('stop', async () => {
                  await call('host.stop');
                  await reload();
                })
              }
            >
              <Square className="size-3.5" /> {t('Stop')}
            </Button>
          ) : (
            <Button
              variant="primary"
              busy={busy === 'start'}
              onClick={() =>
                void run('start', async () => {
                  await call('host.start');
                  await reload();
                })
              }
            >
              <Play className="size-3.5" /> {t('Host on this computer')}
            </Button>
          )}
        </div>
        <label className={`flex items-start gap-2 text-[13px] text-dim ${googleOnly ? 'opacity-60' : ''}`}>
          <input
            type="checkbox"
            className="mt-0.5"
            disabled={googleOnly}
            checked={settings.host.requireAccessCode}
            onChange={(event) => {
              const requireAccessCode = event.target.checked;
              void run('code', async () => {
                await call('settings.update', { host: { requireAccessCode } });
                setSettings((current) => current && { ...current, host: { ...current.host, requireAccessCode } });
              });
            }}
          />
          <span>
            {t('Require an access code to create an account')}
            <span className="block text-[12px] text-faint">
              {googleOnly ? t('Not needed with Google accounts only: nobody creates an account with email.') : t('Without it, anyone who has your server address can create an account.')}
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-[13px] text-dim">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={settings.host.keepAwake}
            onChange={(event) => {
              const keepAwake = event.target.checked;
              void run('awake', async () => {
                await call('settings.update', { host: { keepAwake } });
                setSettings((current) => current && { ...current, host: { ...current.host, keepAwake } });
              });
            }}
          />
          <span>
            {t('Keep this computer awake while the tunnel is open')}
            <span className="block text-[12px] text-faint">{t('So it doesn’t fall asleep on its own and cut off teammates who connect from outside. Closing the lid still puts it to sleep.')}</span>
          </span>
        </label>
        {host.running && (
          <>
            <Field label={t('Addresses for your teammate (same network)')}>
              <div className="space-y-1.5">
                {host.urls.map((url) => (
                  <CopyRow key={url} value={url} />
                ))}
              </div>
            </Field>
            {host.accessCode && (
              <Field label={t('Access code to create an account with email')}>
                <CopyRow value={host.accessCode} />
              </Field>
            )}
            {windows && !saved.host.releaseDir.trim() ? (
              <div className="rounded-lg border border-line p-3 text-[12px] leading-relaxed text-dim">
                {t('To share a macOS installer from Windows, choose a folder containing a macOS release under Builds to offer.')}
              </div>
            ) : <div className="space-y-2 rounded-lg border border-accent/30 bg-accent/[0.06] p-3">
              <p className="text-[13px] font-medium">{t('Install CooPrompt on a teammate’s Mac')}</p>
              <p className="text-[12px] leading-relaxed text-dim">
                {t('Your teammate pastes this command into Terminal: it downloads CooPrompt from your server, installs it in Applications and opens it already connected, with no macOS warnings.')}{' '}
                {host.tunnelUrl ? t('Use the tunnel one if you are not on the same network.') : !tunnelOpen && t('If you are not on the same network, open the tunnel below.')}
              </p>
              {[...(host.tunnelUrl ? [host.tunnelUrl] : []), host.urls[0]].filter(Boolean).map((url) => (
                <CopyRow key={url} value={installCommand(url, t)} />
              ))}
              <Button
                size="sm"
                onClick={() => {
                  const url = host.tunnelUrl ?? host.urls[0];
                  void navigator.clipboard.writeText(
                    host.googleEnabled
                      ? t(
                          'Here is CooPrompt so we can try it together:\n\n1. Open Terminal (Cmd + Space, type "Terminal") and paste:\n{command}\n\n2. When CooPrompt opens, choose "Continue with Google" and use your company account.\n\nYou need a Mac with an Apple chip (M1 or later).',
                          { command: installCommand(url, t) },
                        )
                      : host.accessCode
                      ? t(
                          'Here is CooPrompt so we can try it together:\n\n1. Open Terminal (Cmd + Space, type "Terminal") and paste:\n{command}\n\n2. When CooPrompt opens, choose "Create account" with your company email and this access code: {code}\n\nYou need a Mac with an Apple chip (M1 or later).',
                          { command: installCommand(url, t), code: host.accessCode },
                        )
                      : t(
                          'Here is CooPrompt so we can try it together:\n\n1. Open Terminal (Cmd + Space, type "Terminal") and paste:\n{command}\n\n2. When CooPrompt opens, choose "Create account" with your company email.\n\nYou need a Mac with an Apple chip (M1 or later).',
                          { command: installCommand(url, t) },
                        ),
                  );
                  toast('info', t('Message copied'));
                }}
              >
                <Copy className="size-3.5" /> {t('Copy message for your teammate')}
              </Button>
            </div>}
            <div className="space-y-2 border-t border-line-soft pt-3">
              <div className="flex items-center gap-3">
                <Globe className="size-4 text-dim" />
                <div className="flex-1 text-[13px]">
                  <p className="font-medium">{t('Access from the internet (Cloudflare Tunnel)')}</p>
                  <p className="text-[12px] text-faint">{windows ? t('Public tunnels are not available on Windows yet.') : t('For teammates outside your network. Uses cloudflared (brew install cloudflared), no account needed.')}</p>
                </div>
                <Button disabled={windows && !tunnelOpen} busy={busy === 'tunnel' || host.tunnelStatus === 'starting'} onClick={() => void run('tunnel', () => call('host.tunnel', !tunnelOpen))}>
                  {tunnelOpen ? t('Close tunnel') : t('Open tunnel')}
                </Button>
              </div>
              {host.tunnelUrl && <CopyRow value={host.tunnelUrl} />}
              {host.tunnelNotice && <TunnelNotice notice={host.tunnelNotice} />}
              {host.tunnelStatus === 'reconnecting' ? (
                <div className="flex items-center gap-2 text-[12px] text-warn">
                  <Spinner className="!size-3.5" />
                  <span className="flex-1">{host.error}</span>
                  <Button size="sm" variant="ghost" busy={busy === 'retry'} onClick={() => void run('retry', () => call('host.tunnel', true))}>
                    {t('Try now')}
                  </Button>
                </div>
              ) : (
                host.error && <p className="text-[12px] text-bad">{host.error}</p>
              )}
            </div>
          </>
        )}
      </div>

      <div className="space-y-3">
        <h4 className="text-[13.5px] font-semibold">{t('Configuration')}</h4>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('Server name')}>
            <Input value={settings.host.name} onChange={(event) => setSettings({ ...settings, host: { ...settings.host, name: event.target.value } })} />
          </Field>
          <Field label={t('Port')}>
            <Input type="number" value={settings.host.port} onChange={(event) => setSettings({ ...settings, host: { ...settings.host, port: Number(event.target.value) || 4317 } })} />
          </Field>
        </div>
        <Field
          label={t('Builds to offer (optional)')}
          hint={windows ? t('Optional folder containing macOS releases for teammates. Windows builds are not served here.') : t('Folder where npm run dist leaves its builds (apps/desktop/release). The server hands out the newest one and every CooPrompt connected to it offers to update. Empty = this same CooPrompt.')}
        >
          <div className="flex gap-2">
            <Input value={settings.host.releaseDir} onChange={(event) => setSettings({ ...settings, host: { ...settings.host, releaseDir: event.target.value } })} placeholder={windows ? t('No macOS build selected') : t('This same CooPrompt')} className="font-mono" />
            <Button
              onClick={(event) => {
                event.preventDefault();
                void call('app.pickFolder', settings.host.releaseDir || null).then((folder) => folder && setSettings((current) => current && { ...current, host: { ...current.host, releaseDir: folder } }));
              }}
            >
              {t('Choose…')}
            </Button>
          </div>
        </Field>
        <div className="space-y-3 rounded-xl border border-line p-4">
          <div className="flex items-center gap-2">
            <h5 className="flex-1 text-[13.5px] font-semibold">{t('Sign in with Google')}</h5>
            {host.running && <Badge tone={host.googleEnabled ? 'ok' : 'neutral'}>{host.googleEnabled ? t('Active') : t('Not set up')}</Badge>}
          </div>
          <ol className="list-decimal space-y-1 pl-5 text-[12.5px] leading-relaxed text-dim">
            <li>{t('In Google Cloud, open Google Auth Platform → Clients and create an OAuth client of type "Desktop app". It needs no redirect URIs.')}</li>
            <li>{t('In Google Auth Platform → Audience, choose "Internal": only accounts of your Google Workspace organization can sign in.')}</li>
            <li>{t('Paste the client ID and secret here, add your domain and save. A running server applies it at once, without closing the tunnel.')}</li>
          </ol>
          <Button size="sm" onClick={() => void call('app.openExternal', GOOGLE_CLIENTS_URL).catch((error) => toast('error', error.message))}>
            <ExternalLink className="size-3.5" /> {t('Open Google Cloud')}
          </Button>
          <Field label={t('Client ID')}>
            <Input value={settings.host.googleClientId} onChange={(event) => setSettings({ ...settings, host: { ...settings.host, googleClientId: event.target.value } })} placeholder="1234-abc.apps.googleusercontent.com" className="font-mono" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('Client secret')} hint={settings.host.hasGoogleSecret ? t('Stored on this device.') : undefined}>
              <Input type="password" value={secret} onChange={(event) => setSecret(event.target.value)} placeholder={settings.host.hasGoogleSecret ? '••••••••' : 'GOCSPX-…'} />
            </Field>
            <Field label={t('Allowed domains (optional)')} hint={t('e.g. yourcompany.com. Only Google Workspace accounts of these domains can sign in; separate several with commas.')}>
              <Input value={settings.host.allowedDomains} onChange={(event) => setSettings({ ...settings, host: { ...settings.host, allowedDomains: event.target.value } })} placeholder={t('yourcompany.com')} />
            </Field>
          </div>
          <label className={`flex items-start gap-2 text-[13px] text-dim ${googleReady ? '' : 'opacity-60'}`}>
            <input
              type="checkbox"
              className="mt-0.5"
              disabled={!googleReady}
              checked={settings.host.googleOnly && googleReady}
              onChange={(event) => setSettings({ ...settings, host: { ...settings.host, googleOnly: event.target.checked } })}
            />
            <span>
              {t('Google accounts only')}
              <span className={`block text-[12px] ${settings.host.googleOnly && googleReady ? 'text-[#e1bd99]' : 'text-faint'}`}>
                {googleReady
                  ? t('Hides email and password sign-up and sign-in. Whoever already has a password account signs in with Google using the same email and keeps their chats; the password stops working.')
                  : t('Fill in the client ID and secret first.')}
              </span>
            </span>
          </label>
        </div>
        <div className="flex items-center justify-between">
          <label className="flex items-center gap-2 text-[13px] text-dim">
            <input type="checkbox" checked={settings.host.autoStart} onChange={(event) => setSettings({ ...settings, host: { ...settings.host, autoStart: event.target.checked } })} />
            {t('Start the server when CooPrompt opens')}
          </label>
          <Button variant="primary" busy={busy === 'save'} onClick={() => void saveHost()}>
            {t('Save')}
          </Button>
        </div>
      </div>
    </div>
  );
}
