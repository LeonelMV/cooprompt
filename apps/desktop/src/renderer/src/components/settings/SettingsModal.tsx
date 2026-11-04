import { Bot, Brain, FolderSync, KeyRound, Plug, Server, UserRound } from 'lucide-react';
import { useT } from '../../lib/i18n.ts';
import { useStore, type SettingsTab } from '../../lib/store.ts';
import { Modal } from '../ui.tsx';
import { AccountSection } from './AccountSection.tsx';
import { ConnectorsSection } from './ConnectorsSection.tsx';
import { MemorySection } from './MemorySection.tsx';
import { ModelsSection } from './ModelsSection.tsx';
import { ServerSection } from './ServerSection.tsx';
import { SkillsSection } from './SkillsSection.tsx';
import { SyncSection } from './SyncSection.tsx';

const TABS: { id: SettingsTab; label: string; icon: typeof Bot }[] = [
  { id: 'account', label: 'Account & device', icon: UserRound },
  { id: 'models', label: 'Models & keys', icon: KeyRound },
  { id: 'connectors', label: 'MCP connectors', icon: Plug },
  { id: 'skills', label: 'Skills & agents', icon: Bot },
  { id: 'memory', label: 'Memory (AGENTS.md)', icon: Brain },
  { id: 'server', label: 'Team server', icon: Server },
  { id: 'sync', label: 'Folders & privacy', icon: FolderSync },
];

export function SettingsModal() {
  const t = useT();
  const { settingsTab, set } = useStore();
  if (!settingsTab) return null;
  return (
    <Modal title={t('Settings')} onClose={() => set({ settingsTab: null })} width={980}>
      <div className="-mx-5 -my-4 flex h-[640px]">
        <nav className="w-56 shrink-0 space-y-0.5 border-r border-line-soft p-3">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button key={id} onClick={() => set({ settingsTab: id })} className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] cursor-default ${settingsTab === id ? 'bg-raised text-ink' : 'text-dim hover:text-ink'}`}>
              <Icon className="size-4" /> {t(label)}
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1 overflow-y-auto p-6">
          {settingsTab === 'account' && <AccountSection />}
          {settingsTab === 'models' && <ModelsSection />}
          {settingsTab === 'connectors' && <ConnectorsSection />}
          {settingsTab === 'skills' && <SkillsSection />}
          {settingsTab === 'memory' && <MemorySection />}
          {settingsTab === 'server' && <ServerSection />}
          {settingsTab === 'sync' && <SyncSection />}
        </div>
      </div>
    </Modal>
  );
}

export function SectionTitle({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="mb-5 space-y-1">
      <h3 className="text-[16px] font-semibold">{title}</h3>
      {children && <p className="text-[13px] leading-relaxed text-dim">{children}</p>}
    </div>
  );
}
