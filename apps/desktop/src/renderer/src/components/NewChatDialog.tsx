import { useState } from 'react';
import { Building2, Lock, Users } from 'lucide-react';
import type { ChatKind } from '@cooprompt/protocol';
import { call } from '../lib/api.ts';
import { useT } from '../lib/i18n.ts';
import { useStore } from '../lib/store.ts';
import { Button, Field, Input, Modal } from './ui.tsx';

const KINDS: { kind: ChatKind; title: string; description: string; icon: typeof Lock }[] = [
  { kind: 'private', title: 'Private', description: 'Just you. Works in a folder on this computer (you can pick an existing repo).', icon: Lock },
  { kind: 'multiplayer', title: 'Multiplayer', description: 'Invite specific people. You share the chat live and a synced folder.', icon: Users },
  { kind: 'corporate', title: 'Company', description: 'Visible to your whole organization. Anyone who joins can take part.', icon: Building2 },
];

export function NewChatDialog() {
  const t = useT();
  const { set, app, toast, openChat } = useStore();
  const [kind, setKind] = useState<ChatKind>('multiplayer');
  const [title, setTitle] = useState('');
  const [folder, setFolder] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const close = () => set({ newChatOpen: false });

  const create = async () => {
    setBusy(true);
    try {
      const fallback = kind === 'private' ? t('Private chat') : kind === 'corporate' ? t('Company chat') : t('Team session');
      const chat = await call('chats.create', { title: title.trim() || fallback, kind, folder });
      set({ chats: { ...useStore.getState().chats, [chat.id]: chat }, newChatOpen: false, inviteOpen: kind === 'multiplayer' });
      await openChat(chat.id);
    } catch (error) {
      toast('error', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t('New chat')}
      onClose={close}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {t('Cancel')}
          </Button>
          <Button variant="primary" busy={busy} onClick={() => void create()}>
            {t('Create')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-2">
          {KINDS.map(({ kind: value, title: label, description, icon: Icon }) => {
            const disabled = value === 'corporate' && !app?.user?.orgDomain;
            return (
              <button
                key={value}
                disabled={disabled}
                onClick={() => setKind(value)}
                className={`flex flex-col gap-1.5 rounded-xl border p-3 text-left cursor-default disabled:opacity-40 ${kind === value ? 'border-accent bg-accent/10' : 'border-line hover:border-accent/60'}`}
                title={disabled ? t('You need an account with a company email') : undefined}
              >
                <Icon className={`size-4 ${kind === value ? 'text-accent' : 'text-dim'}`} />
                <span className="text-[13.5px] font-medium">{t(label)}</span>
                <span className="text-[11.5px] leading-snug text-faint">{t(description)}</span>
              </button>
            );
          })}
        </div>
        <Field label={t('Title')}>
          <Input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && void create()} placeholder={t('e.g. Documentation update')} />
        </Field>
        {kind === 'private' ? (
          <Field label={t('Working folder')} hint={t('Optional. If you do not pick one, a new folder is created in ~/CooPrompt/Privados.')}>
            <div className="flex gap-2">
              <Input readOnly value={folder ?? ''} placeholder={t('New folder (automatic)')} />
              <Button onClick={() => void call('app.pickFolder', folder).then((picked) => picked && setFolder(picked))}>{t('Choose…')}</Button>
            </div>
          </Field>
        ) : (
          <p className="text-[12.5px] leading-relaxed text-faint">
            {t('A shared folder is created and synced to every participant’s computer. If someone asks the agent to clone a repo, the clone uses their own git credentials and reaches everyone.')}
          </p>
        )}
      </div>
    </Modal>
  );
}
