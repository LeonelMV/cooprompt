import { useState, type ReactNode } from 'react';
import { ArrowDownCircle, CheckCircle2, KeyRound, TriangleAlert, X } from 'lucide-react';
import type { UpdateResult, UpdateState } from '../../../shared/types.ts';
import { call } from '../lib/api.ts';
import { bytes } from '../lib/format.ts';
import { useT } from '../lib/i18n.ts';
import { useStore } from '../lib/store.ts';
import { Button, IconButton, Spinner } from './ui.tsx';

function Card({ tone = 'accent', icon, children, onClose }: { tone?: 'accent' | 'ok' | 'warn'; icon: ReactNode; children: ReactNode; onClose?: () => void }) {
  const t = useT();
  const tones = { accent: 'border-accent/30 bg-accent/10', ok: 'border-ok/30 bg-ok/10', warn: 'border-warn/40 bg-warn/10' };
  return (
    <div className={`mx-3 mb-2 flex gap-2 rounded-xl border p-2.5 text-[12.5px] leading-snug ${tones[tone]}`}>
      <div className="mt-px shrink-0">{icon}</div>
      <div className="min-w-0 flex-1 space-y-2">{children}</div>
      {onClose && (
        <IconButton title={t('Close')} onClick={onClose} className="!size-5 shrink-0">
          <X className="size-3.5" />
        </IconButton>
      )}
    </div>
  );
}

/** How the last update went, until dismissed. */
function LastResult({ result, onClose }: { result: UpdateResult; onClose: () => void }) {
  const t = useT();
  if (result.outcome === 'updated') {
    return (
      <Card tone="ok" icon={<CheckCircle2 className="size-4 text-ok" />} onClose={onClose}>
        <p>{t('CooPrompt was updated to {version}.', { version: result.version })}</p>
      </Card>
    );
  }
  return (
    <Card tone="warn" icon={<TriangleAlert className="size-4 text-warn" />} onClose={onClose}>
      <p>
        {result.outcome === 'rolled-back'
          ? t('CooPrompt {version} did not start, so the previous version was restored.', { version: result.version })
          : t('Could not install CooPrompt {version}: {error}', { version: result.version, error: t.message(result.detail ?? '') })}
      </p>
    </Card>
  );
}

/** A new CooPrompt from the team server: download it, then restart into it. */
export function UpdateBanner() {
  const update = useStore((state) => state.app?.update);
  const [dismissed, setDismissed] = useState(false);
  if (!update?.enabled) return null;
  return (
    <>
      {update.lastResult && !dismissed && <LastResult result={update.lastResult} onClose={() => setDismissed(true)} />}
      <Progress update={update} />
    </>
  );
}

function Progress({ update }: { update: UpdateState }) {
  const t = useT();
  const toast = useStore((state) => state.toast);
  const run = (action: () => Promise<unknown>) => void action().catch((error) => toast('error', error instanceof Error ? error.message : String(error)));
  const release = update.available;
  if (!release) return null;
  const version = release.version;
  switch (update.status) {
    case 'available':
      return (
        <Card icon={<ArrowDownCircle className="size-4 text-accent" />}>
          <p>
            <span className="font-medium text-ink">{t('CooPrompt {version} is available', { version })}</span>
            <span className="block text-faint">{bytes(release.size)}</span>
          </p>
          <Button size="sm" variant="primary" onClick={() => run(() => call('update.download'))}>
            {t('Update')}
          </Button>
        </Card>
      );
    case 'downloading':
      return (
        <Card icon={<ArrowDownCircle className="size-4 text-accent" />} onClose={() => run(() => call('update.cancel'))}>
          <p>{t('Downloading CooPrompt {version}… {percent}%', { version, percent: Math.round((update.progress ?? 0) * 100) })}</p>
          <div className="h-1 overflow-hidden rounded-full bg-line">
            <div className="h-full bg-accent transition-[width]" style={{ width: `${Math.round((update.progress ?? 0) * 100)}%` }} />
          </div>
        </Card>
      );
    case 'verifying':
    case 'installing':
      return (
        <Card icon={<Spinner className="!size-4" />}>
          <p>{update.status === 'verifying' ? t('Checking the update…') : t('Restarting…')}</p>
        </Card>
      );
    case 'ready':
      return (
        <Card icon={<ArrowDownCircle className="size-4 text-accent" />}>
          <p className="font-medium text-ink">{t('CooPrompt {version} is ready', { version })}</p>
          <p className="flex gap-1.5 text-dim">
            <KeyRound className="mt-0.5 size-3.5 shrink-0 text-warn" />
            <span>{t('When CooPrompt restarts, macOS asks once for your Mac password so it can use "CooPrompt Safe Storage". Type it and choose "Always Allow": if you deny it, CooPrompt cannot read your session or your saved keys.')}</span>
          </p>
          <Button size="sm" variant="primary" onClick={() => run(() => call('update.install'))}>
            {t('Restart now')}
          </Button>
        </Card>
      );
    case 'waiting':
      return (
        <Card icon={<Spinner className="!size-4" />}>
          <p>{t('CooPrompt will restart as soon as the running turns finish.')}</p>
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" onClick={() => run(() => call('update.install', { now: true }))}>
              {t('Restart anyway')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => run(() => call('update.cancel'))}>
              {t('Cancel')}
            </Button>
          </div>
        </Card>
      );
    case 'error':
      return (
        <Card tone="warn" icon={<TriangleAlert className="size-4 text-warn" />}>
          <p>{t('Could not update: {error}', { error: t.message(update.error ?? '') })}</p>
          <Button
            size="sm"
            onClick={() =>
              run(async () => {
                if ((await call('update.check')).status === 'available') await call('update.download');
              })
            }
          >
            {t('Retry')}
          </Button>
        </Card>
      );
    default:
      return null;
  }
}
