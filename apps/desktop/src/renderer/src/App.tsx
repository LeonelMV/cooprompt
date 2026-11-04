import { useEffect } from 'react';
import { AlertCircle, CheckCircle2 } from 'lucide-react';
import { call, onMainEvent } from './lib/api.ts';
import { useT } from './lib/i18n.ts';
import { useStore } from './lib/store.ts';
import { AutomationEditor } from './components/automations/AutomationEditor.tsx';
import { AutomationsView } from './components/automations/AutomationsView.tsx';
import { ChatView } from './components/ChatView.tsx';
import { InviteDialog } from './components/InviteDialog.tsx';
import { Login } from './components/Login.tsx';
import { NewChatDialog } from './components/NewChatDialog.tsx';
import { RightPanel } from './components/RightPanel.tsx';
import { SettingsModal } from './components/settings/SettingsModal.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { Spinner } from './components/ui.tsx';

function Toasts() {
  const t = useT();
  const toasts = useStore((state) => state.toasts);
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-96 flex-col gap-2">
      {toasts.map((toast) => (
        <div key={toast.id} className={`pointer-events-auto flex items-start gap-2 rounded-xl border px-3.5 py-2.5 text-[13px] shadow-xl ${toast.level === 'error' ? 'border-bad/40 bg-[#3a2221] text-[#f5c2be]' : 'border-line bg-raised text-ink'}`}>
          {toast.level === 'error' ? <AlertCircle className="mt-0.5 size-4 shrink-0" /> : <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" />}
          <span className="selectable">{t.message(toast.text)}</span>
        </div>
      ))}
    </div>
  );
}

function Workspace() {
  const connection = useStore((state) => state.app?.connection.status);
  const automationsSupported = useStore((state) => state.app?.automations != null);
  const { loadChats, loadInvitations, loadProviders, loadAutomations, settingsTab, newChatOpen, inviteOpen, panel, activeChatId, automationsView, automationEditor } = useStore();

  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  useEffect(() => {
    if (connection !== 'online') return;
    void loadChats().catch((error) => useStore.getState().toast('error', error.message));
    void loadInvitations().catch(() => {});
  }, [connection, loadChats, loadInvitations]);

  useEffect(() => {
    if (connection === 'online' && automationsSupported) void loadAutomations().catch(() => {});
  }, [connection, automationsSupported, loadAutomations]);

  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">{automationsView ? <AutomationsView /> : <ChatView />}</main>
      {activeChatId && panel && !automationsView && <RightPanel />}
      {settingsTab && <SettingsModal />}
      {newChatOpen && <NewChatDialog />}
      {inviteOpen && <InviteDialog />}
      {automationEditor && <AutomationEditor />}
    </div>
  );
}

export function App() {
  const app = useStore((state) => state.app);
  const handle = useStore((state) => state.handle);
  const language = app?.language ?? 'en';

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  useEffect(() => {
    const off = onMainEvent(handle);
    void call('app.state').then((state) => useStore.getState().set({ app: state }));
    return off;
  }, [handle]);

  return (
    <>
      {!app ? (
        <div className="flex h-full items-center justify-center">
          <Spinner />
        </div>
      ) : app.user ? (
        <Workspace />
      ) : (
        <Login />
      )}
      <Toasts />
    </>
  );
}
