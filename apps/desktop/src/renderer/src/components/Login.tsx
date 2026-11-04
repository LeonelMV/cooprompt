import { useEffect, useRef, useState } from 'react';
import { Globe, Laptop, Loader2, Server, Users, Wifi } from 'lucide-react';
import type { HealthResponse } from '@cooprompt/protocol';
import { LANGUAGES, type Language } from '../../../shared/i18n.ts';
import { call } from '../lib/api.ts';
import { useT } from '../lib/i18n.ts';
import { useStore } from '../lib/store.ts';
import { Badge, Button, Field, Input, Logo } from './ui.tsx';

function GoogleIcon() {
  return (
    <svg viewBox="0 0 48 48" className="size-4">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

export function LanguagePicker() {
  const t = useT();
  const toast = useStore((state) => state.toast);
  return (
    <label className="inline-flex items-center gap-1.5 text-[12px] text-faint">
      <Globe className="size-3.5" />
      <select
        value={t.language}
        onChange={(event) => void call('settings.update', { language: event.target.value as Language }).catch((error) => toast('error', error.message))}
        className="bg-transparent text-dim outline-none"
        aria-label={t('Language')}
      >
        {LANGUAGES.map((language) => (
          <option key={language.id} value={language.id}>
            {language.label}
          </option>
        ))}
      </select>
    </label>
  );
}

const isThisMac = (url: string) => /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/i.test(url.trim());

/**
 * Joining a teammate's server or hosting one here. Only this explicit choice starts the embedded
 * server: a teammate who hosts by accident ends up alone on a private server, away from the team.
 */
function ServerChoice({
  url,
  onUrl,
  testing,
  unreachable,
  onJoin,
  hosting,
  onHost,
}: {
  url: string;
  onUrl: (url: string) => void;
  testing: boolean;
  unreachable: string | null;
  onJoin: () => void;
  hosting: boolean;
  onHost: () => void;
}) {
  const t = useT();
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <h2 className="text-[17px] font-semibold tracking-tight">{t('Team server')}</h2>
        <p className="text-[13px] leading-relaxed text-dim">{t('Everyone on a team uses the same server: one person hosts it and the rest join.')}</p>
      </div>
      <form
        className="space-y-2.5 rounded-xl border border-line bg-panel p-4"
        onSubmit={(event) => {
          event.preventDefault();
          onJoin();
        }}
      >
        <p className="flex items-center gap-2 text-[14px] font-medium">
          <Users className="size-4 text-accent" /> {t('Join my team’s server')}
        </p>
        <p className="text-[12.5px] leading-relaxed text-dim">{t('Paste the address your teammate sent you, like https://….trycloudflare.com or http://192.168.x.x:4317.')}</p>
        <div className="flex gap-2">
          <Input autoFocus value={url} onChange={(event) => onUrl(event.target.value)} placeholder="https://….trycloudflare.com" />
          <Button type="submit" variant="primary" busy={testing} disabled={!url.trim()}>
            {t('Test')}
          </Button>
        </div>
        {unreachable && <p className="selectable text-[12.5px] text-bad">{t('Nothing answered at {url}.', { url: unreachable })}</p>}
      </form>
      <div className="space-y-2.5 rounded-xl border border-line p-4">
        <p className="flex items-center gap-2 text-[14px] font-medium">
          <Laptop className="size-4 text-accent" /> {t('Create a new server on this PC')}
        </p>
        <p className="text-[12.5px] leading-relaxed text-dim">{t('For the person who hosts the team: your teammates will connect to you.')}</p>
        <Button busy={hosting} onClick={onHost}>
          {hosting ? t('Starting the server…') : t('Create server')}
        </Button>
      </div>
    </div>
  );
}

export function Login() {
  const t = useT();
  const app = useStore((state) => state.app);
  const toast = useStore((state) => state.toast);
  const [serverUrl, setServerUrl] = useState(app?.serverUrl ?? '');
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [checking, setChecking] = useState(false);
  const [unreachable, setUnreachable] = useState<string | null>(null);
  // A device that never signed in, with no server address, starts by choosing to join a server or host one.
  const neverSignedIn = !app?.lastEmail && !app?.host.running;
  const [choosing, setChoosing] = useState(neverSignedIn && !app?.serverUrl);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [form, setForm] = useState({ name: '', email: app?.lastEmail ?? '', password: '', accessCode: '' });
  const [busy, setBusy] = useState<string | null>(null);
  const [loginFailed, setLoginFailed] = useState(false);
  const [googleError, setGoogleError] = useState<string | null>(null);
  const googleCancelled = useRef(false);
  const lastCheck = useRef(0);
  const google = health?.auth.google.enabled ? health.auth.google : null;
  const passwordAuth = !health || health.auth.password;

  /** The server's health, or null when nothing answers at that address. */
  const check = async (url = serverUrl): Promise<HealthResponse | null> => {
    const id = ++lastCheck.current;
    setChecking(true);
    setGoogleError(null);
    let result: HealthResponse | null = null;
    try {
      const answer = url.trim() ? await call('auth.health', url) : null;
      // Any web server answers; only a CooPrompt server says ok.
      if (answer?.ok) result = answer;
    } catch {
      // nothing answered
    }
    // An earlier check that finishes late must not overwrite the latest one.
    if (id === lastCheck.current) {
      setHealth(result);
      setUnreachable(result || !url.trim() ? null : url.trim());
      setChecking(false);
      if (result?.firstRun) setMode('register');
    }
    return result;
  };

  useEffect(() => {
    if (choosing || app?.host.running) return;
    void check().then((result) => {
      if (!result && neverSignedIn && isThisMac(serverUrl)) setChoosing(true);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (app?.host.running && app.host.port) {
      const url = `http://127.0.0.1:${app.host.port}`;
      setServerUrl(url);
      setChoosing(false);
      setForm((current) => ({ ...current, accessCode: app.host.accessCode ?? current.accessCode }));
      void check(url);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app?.host.running, app?.host.port]);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
      return true;
    } catch (err) {
      toast('error', err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const refreshState = async () => useStore.getState().set({ app: await call('app.state') });

  const submit = async () => {
    setLoginFailed(false);
    const reachable = health ?? (await check());
    const ok =
      reachable !== null &&
      (await run('email', () =>
        mode === 'login'
          ? call('auth.login', { serverUrl, email: form.email, password: form.password })
          : call('auth.register', { serverUrl, email: form.email, name: form.name, password: form.password, accessCode: form.accessCode }),
      ));
    if (ok) return refreshState();
    // Nothing answers there (any more): say so and offer the same choice as a first run.
    if (!reachable || !(await check())) setChoosing(true);
    else if (mode === 'login') setLoginFailed(true);
  };

  const join = async () => {
    if (await check()) setChoosing(false);
  };

  const signInWithGoogle = async () => {
    googleCancelled.current = false;
    setGoogleError(null);
    setBusy('google');
    try {
      await call('auth.google', { serverUrl });
      await refreshState();
    } catch (err) {
      if (!googleCancelled.current) setGoogleError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const cancelGoogle = () => {
    googleCancelled.current = true;
    void call('auth.cancelGoogle');
  };

  return (
    <div className="flex h-full">
      <div className="drag absolute inset-x-0 top-0 h-10" />
      <div className="flex w-[46%] flex-col justify-between bg-side p-10 pt-16">
        <div>
          <div className="flex items-center gap-2.5">
            <Logo size={36} />
            <span className="text-[22px] font-semibold tracking-tight">CooPrompt</span>
          </div>
          <h1 className="mt-10 max-w-md text-[30px] font-semibold leading-tight tracking-tight">{t('Coding agents for teams, in real time.')}</h1>
          <p className="mt-4 max-w-md text-[14.5px] leading-relaxed text-dim">
            {t('The Claude Code, Codex and Cursor engines with skills, subagents, AGENTS.md, MCP and sessions — plus multiplayer chats, a shared workspace and company-wide chats.')}
          </p>
        </div>
        <ul className="space-y-3 text-[13.5px] text-dim">
          <li className="flex gap-2.5">
            <Users className="mt-0.5 size-4 shrink-0 text-accent" /> {t('Every request runs on the computer of whoever asks, with their own credentials.')}
          </li>
          <li className="flex gap-2.5">
            <Wifi className="mt-0.5 size-4 shrink-0 text-accent" /> {t('Everyone sees the chat, the tools and the permissions live.')}
          </li>
          <li className="flex gap-2.5">
            <Server className="mt-0.5 size-4 shrink-0 text-accent" /> {t('Your API keys are stored on this device; the team server never sees them.')}
          </li>
        </ul>
      </div>
      <div className="flex flex-1 items-center justify-center p-10">
        <div className="w-full max-w-sm space-y-6">
          {choosing ? (
            <ServerChoice
              url={serverUrl}
              onUrl={setServerUrl}
              testing={checking}
              unreachable={unreachable}
              onJoin={() => void join()}
              hosting={busy === 'host'}
              onHost={() => void run('host', () => call('host.start'))}
            />
          ) : (
            <>
              <div className="space-y-2">
                <Field label={t('Team server')}>
                  <div className="flex gap-2">
                    <Input value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} onBlur={() => void check()} placeholder="http://192.168.0.10:4317" />
                    <Button onClick={() => void check()} busy={checking}>
                      {t('Test')}
                    </Button>
                  </div>
                </Field>
                {health && (
                  <div className="flex items-center gap-2 text-[12.5px] text-dim">
                    <Badge tone="ok">{t('Connected')}</Badge> {health.name} · v{health.version}
                  </div>
                )}
                {unreachable && <p className="selectable text-[12.5px] text-bad">{t('Nothing answered at {url}.', { url: unreachable })}</p>}
                {app?.host.running ? (
                  <p className="text-[12.5px] text-dim">{t('Local server running on port {port}', { port: app.host.port })}</p>
                ) : (
                  <button className="text-[12.5px] text-accent hover:underline cursor-default" onClick={() => setChoosing(true)}>
                    {t('No server yet? Host one on this computer')}
                  </button>
                )}
                {app?.host.running && (
                  <div className="space-y-1 rounded-lg border border-line bg-panel p-2.5 text-[12px] leading-relaxed text-dim">
                    {app.host.accessCode && (
                      <p>
                        {t('Access code:')} <span className="selectable font-mono text-ink">{app.host.accessCode}</span>
                      </p>
                    )}
                    <p>
                      {t('Your teammate connects to {url} (same network) or to the public tunnel you can open in Settings → Team server.', { url: app.host.urls[0] })}
                    </p>
                  </div>
                )}
              </div>

              {google && (
                <div className="space-y-2">
                  {/* Google's own button colors (light theme), as its branding guidelines ask. */}
                  <button
                    type="button"
                    disabled={busy === 'google'}
                    onClick={() => void signInWithGoogle()}
                    className="inline-flex h-10 w-full items-center justify-center gap-2.5 rounded-lg border border-[#747775] bg-white text-[14px] font-medium text-[#1f1f1f] transition-colors hover:bg-[#f2f2f2] disabled:opacity-70 cursor-default"
                  >
                    {busy === 'google' ? <Loader2 className="size-4 animate-spin" /> : <GoogleIcon />} {t('Continue with Google')}
                  </button>
                  {google.allowedDomains && google.allowedDomains.length > 0 && (
                    <p className="text-center text-[12.5px] text-faint">{t('Only {domains} accounts', { domains: google.allowedDomains.map((domain) => `@${domain}`).join(', ') })}</p>
                  )}
                  {busy === 'google' && (
                    <p className="text-center text-[12.5px] text-dim">
                      {t('Finish signing in in your browser.')}{' '}
                      <button type="button" className="text-accent hover:underline cursor-default" onClick={cancelGoogle}>
                        {t('Cancel')}
                      </button>
                    </p>
                  )}
                  {googleError && <p className="selectable text-[12.5px] text-bad">{t.message(googleError)}</p>}
                </div>
              )}

              {google && passwordAuth && (
                <div className="flex items-center gap-3 text-[12px] text-faint">
                  <span className="h-px flex-1 bg-line" />
                  {t('or with email')}
                  <span className="h-px flex-1 bg-line" />
                </div>
              )}

              {health && !passwordAuth && !google && <p className="text-[12.5px] text-bad">{t('This server does not accept email accounts and has no Google sign-in set up. Ask whoever runs it.')}</p>}

              {passwordAuth && (
                <form
                  className="space-y-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submit();
                  }}
                >
                  <div className="flex gap-1 rounded-lg bg-panel p-1 text-[13px]">
                    {(['login', 'register'] as const).map((value) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => {
                          setMode(value);
                          setLoginFailed(false);
                        }}
                        className={`flex-1 rounded-md py-1.5 cursor-default ${mode === value ? 'bg-raised text-ink' : 'text-dim'}`}
                      >
                        {value === 'login' ? t('Sign in') : t('Create account')}
                      </button>
                    ))}
                  </div>
                  {mode === 'register' && <Input placeholder={t('Your name')} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />}
                  <Input type="email" placeholder={t('email@company.com')} value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} />
                  <Input type="password" placeholder={t('Password (8+ characters)')} value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} />
                  {mode === 'register' && health?.auth.accessCodeRequired && (
                    <Input placeholder={t('Server access code')} value={form.accessCode} onChange={(event) => setForm({ ...form, accessCode: event.target.value })} />
                  )}
                  <Button variant={google ? 'subtle' : 'primary'} type="submit" className="w-full" busy={busy === 'email'}>
                    {mode === 'login' ? t('Sign in') : t('Create account')}
                  </Button>
                  {loginFailed && mode === 'login' && (
                    <div className="rounded-lg border border-line bg-panel p-2.5 text-[12.5px] text-dim">
                      {t('First time on this server?')}{' '}
                      <button
                        type="button"
                        className="text-accent hover:underline cursor-default"
                        onClick={() => {
                          setMode('register');
                          setLoginFailed(false);
                        }}
                      >
                        {t('Create an account with this email')}
                      </button>
                    </div>
                  )}
                  {mode === 'register' && (
                    <p className="text-[12px] leading-relaxed text-faint">{t('With a company email (not Gmail/Outlook) you join your domain’s organization and see its company chats.')}</p>
                  )}
                </form>
              )}
            </>
          )}
          <div className="flex justify-center">
            <LanguagePicker />
          </div>
        </div>
      </div>
    </div>
  );
}
