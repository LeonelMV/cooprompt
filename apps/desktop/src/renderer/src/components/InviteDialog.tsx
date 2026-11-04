import { useEffect, useState } from 'react';
import { Mail, Search } from 'lucide-react';
import type { PublicUser } from '@cooprompt/protocol';
import { call } from '../lib/api.ts';
import { useT } from '../lib/i18n.ts';
import { useStore } from '../lib/store.ts';
import { Avatar, Button, Input, Modal, Spinner } from './ui.tsx';

export function InviteDialog() {
  const t = useT();
  const { activeChatId, chats, set, toast } = useStore();
  const chat = activeChatId ? chats[activeChatId] : undefined;
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PublicUser[]>([]);
  const [searching, setSearching] = useState(false);
  const [sent, setSent] = useState<Set<string>>(new Set());
  const close = () => set({ inviteOpen: false });

  useEffect(() => {
    const value = query.trim();
    if (!value) {
      setResults([]);
      return;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      void call('users.search', value)
        .then(setResults)
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 200);
    return () => clearTimeout(timer);
  }, [query]);

  if (!chat) return null;
  const memberIds = new Set(chat.members.map((member) => member.user.id));
  const email = query.trim().toLowerCase();
  const isEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
  const emailKnown = results.some((user) => user.email === email);

  const invite = async (input: { userId?: string; email?: string }, key: string) => {
    try {
      await call('invitations.create', { chatId: chat.id, ...input });
      setSent(new Set([...sent, key]));
      toast('info', t('Invitation sent'));
    } catch (error) {
      toast('error', error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <Modal title={t('Invite to "{title}"', { title: chat.title })} onClose={close} width={480}>
      <div className="space-y-3">
        <div className="relative">
          <Search className="absolute left-3 top-2.5 size-4 text-faint" />
          <Input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('Search by name or email')} className="pl-9" />
        </div>
        <div className="min-h-[120px] space-y-1">
          {searching && <Spinner className="mx-auto mt-4" />}
          {results.map((user) => (
            <div key={user.id} className="flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 hover:bg-raised">
              <Avatar user={user} size={30} />
              <div className="min-w-0 flex-1 leading-tight">
                <p className="truncate text-[13.5px] font-medium">{user.name}</p>
                <p className="truncate text-[12px] text-faint">
                  {user.email}
                  {user.orgDomain && ` · ${user.orgDomain}`}
                </p>
              </div>
              {memberIds.has(user.id) ? (
                <span className="text-[12px] text-faint">{t('Already in the chat')}</span>
              ) : (
                <Button size="sm" variant={sent.has(user.id) ? 'ghost' : 'primary'} disabled={sent.has(user.id)} onClick={() => void invite({ userId: user.id }, user.id)}>
                  {sent.has(user.id) ? t('Invited') : t('Invite')}
                </Button>
              )}
            </div>
          ))}
          {isEmail && !emailKnown && !searching && (
            <div className="flex items-center gap-2.5 rounded-lg px-1.5 py-1.5">
              <div className="flex size-[30px] items-center justify-center rounded-full bg-raised">
                <Mail className="size-4 text-dim" />
              </div>
              <div className="min-w-0 flex-1 leading-tight">
                <p className="truncate text-[13.5px]">{email}</p>
                <p className="text-[12px] text-faint">{t('No account yet: they will see the invitation when they sign up')}</p>
              </div>
              <Button size="sm" variant={sent.has(email) ? 'ghost' : 'primary'} disabled={sent.has(email)} onClick={() => void invite({ email }, email)}>
                {sent.has(email) ? t('Invited') : t('Invite')}
              </Button>
            </div>
          )}
          {!searching && query && results.length === 0 && !isEmail && <p className="pt-4 text-center text-[12.5px] text-faint">{t('Nobody matches. Try the full email.')}</p>}
        </div>
      </div>
    </Modal>
  );
}
