import { useCallback, useEffect, useState } from 'react';
import { FileText } from 'lucide-react';
import type { Catalog, MemoryFile } from '../../../../shared/types.ts';
import { call } from '../../lib/api.ts';
import { useT } from '../../lib/i18n.ts';
import { useStore } from '../../lib/store.ts';
import { Badge, Button } from '../ui.tsx';
import { FileEditor } from './FileEditor.tsx';
import { SectionTitle } from './SettingsModal.tsx';

const TEMPLATE = `# Project instructions

## Context
- What this project is and what it is for.

## Conventions
- How to run the tests, the linter and the build.
- Code style and architecture decisions.
`;

export function MemorySection() {
  const t = useT();
  const { activeChatId, chats } = useStore();
  const chat = activeChatId ? chats[activeChatId] : undefined;
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [editing, setEditing] = useState<MemoryFile | null>(null);
  const refresh = useCallback(() => void call('catalog.get', activeChatId).then(setCatalog), [activeChatId]);
  useEffect(refresh, [refresh]);
  return (
    <div className="space-y-5">
      <SectionTitle title={t('Agent memory')}>
        {t('AGENTS.md and CLAUDE.md are the persistent instructions. Codex reads AGENTS.md; Claude Code reads CLAUDE.md and, when a project has no CLAUDE.md, its AGENTS.md.')}
        {chat?.hasWorkspace ? ` ${t('The ones in the workspace of "{title}" are shared with everyone.', { title: chat.title })}` : ''}
      </SectionTitle>
      {!catalog?.cwd && <p className="text-[12.5px] text-faint">{t('Open a chat to also see the files in its working folder.')}</p>}
      <div className="space-y-2">
        {catalog?.memory.map((file) => (
          <div key={file.path} className="flex items-center gap-3 rounded-xl border border-line-soft bg-panel px-3.5 py-2.5">
            <FileText className="size-4 text-dim" />
            <div className="min-w-0 flex-1 leading-tight">
              <p className="flex items-center gap-2 text-[13.5px] font-medium">
                {t(file.label)} {!file.exists && <Badge>{t('does not exist')}</Badge>}
              </p>
              <p className="truncate font-mono text-[11.5px] text-faint">{file.path}</p>
            </div>
            <Button size="sm" onClick={() => setEditing(file)}>
              {file.exists ? t('Edit') : t('Create')}
            </Button>
          </div>
        ))}
      </div>
      {editing && (
        <FileEditor
          path={editing.path}
          title={t(editing.label)}
          template={editing.exists ? '' : TEMPLATE}
          onClose={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}
