import { Globe, X } from 'lucide-react';
import type { HostState } from '../../../shared/types.ts';
import { call } from '../lib/api.ts';
import { installCommand } from '../lib/format.ts';
import { useT, type T } from '../lib/i18n.ts';
import { useStore } from '../lib/store.ts';
import { Button, IconButton } from './ui.tsx';

/** A message for teammates when the host's public address changes. */
function teamMessage(url: string, t: T): string {
  return t(
    'Our CooPrompt server has a new address:\n{url}\n\nTo reconnect, in CooPrompt go to Settings → Account & device, paste the address under "Server" and click "Change". You stay signed in.\n\nNew to CooPrompt? Paste this into Terminal first:\n{command}',
    { url, command: installCommand(url, t) },
  );
}

/** The tunnel got a new address: shown until the host copies the message for the team or dismisses it. */
export function TunnelNotice({ notice, className = '' }: { notice: NonNullable<HostState['tunnelNotice']>; className?: string }) {
  const t = useT();
  const toast = useStore((state) => state.toast);
  const failed = (error: unknown) => toast('error', error instanceof Error ? error.message : String(error));
  const dismiss = () => void call('host.dismissTunnelNotice').catch(failed);
  const copy = () =>
    void navigator.clipboard.writeText(teamMessage(notice.url, t)).then(() => {
      toast('info', t('Message copied'));
      dismiss();
    }, failed);
  return (
    <div className={`space-y-2 rounded-xl border border-warn/40 bg-warn/10 p-2.5 text-[12.5px] leading-snug ${className}`}>
      <div className="flex gap-2">
        <Globe className="mt-px size-4 shrink-0 text-warn" />
        <p className="min-w-0 flex-1">
          <span className="font-medium text-ink">{t('Your server has a new public address')}</span>
          <span className="block text-dim">{t('Teammates outside your network need it to reconnect.')}</span>
        </p>
        <IconButton title={t('Close')} onClick={dismiss} className="!size-5 shrink-0">
          <X className="size-3.5" />
        </IconButton>
      </div>
      <p className="selectable truncate font-mono text-[11.5px] text-ink" title={notice.url}>
        {notice.url}
      </p>
      <Button size="sm" variant="primary" onClick={copy} className="w-full">
        {t('Copy message for the team')}
      </Button>
    </div>
  );
}

/** In the sidebar, so the host sees it without opening Settings. */
export function TunnelBanner() {
  const notice = useStore((state) => state.app?.host.tunnelNotice);
  return notice ? <TunnelNotice notice={notice} className="mx-3 mb-2" /> : null;
}
