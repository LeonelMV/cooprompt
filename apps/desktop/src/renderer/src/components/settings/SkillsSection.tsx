import { useCallback, useEffect, useState } from 'react';
import { Bot, Pencil, Plus, Sparkles, SquareSlash } from 'lucide-react';
import type { Catalog, CatalogEntry } from '../../../../shared/types.ts';
import { call } from '../../lib/api.ts';
import { useT } from '../../lib/i18n.ts';
import { useStore } from '../../lib/store.ts';
import { Badge, Button, Field, IconButton, Input, Select, TextArea } from '../ui.tsx';
import { FileEditor } from './FileEditor.tsx';
import { SectionTitle } from './SettingsModal.tsx';

function EntryList({ entries, icon: Icon, onEdit }: { entries: CatalogEntry[]; icon: typeof Bot; onEdit: (entry: CatalogEntry) => void }) {
  const t = useT();
  if (entries.length === 0) return <p className="text-[12.5px] text-faint">{t('None yet.')}</p>;
  return (
    <div className="space-y-1">
      {entries.map((entry) => (
        <div key={entry.path} className="flex items-start gap-2.5 rounded-lg px-1.5 py-1.5 hover:bg-raised">
          <Icon className="mt-0.5 size-4 shrink-0 text-dim" />
          <div className="min-w-0 flex-1 leading-snug">
            <p className="flex items-center gap-2 text-[13px] font-medium">
              {entry.name}
              <Badge tone={entry.scope === 'workspace' ? 'accent' : 'neutral'}>{entry.scope === 'workspace' ? t('workspace') : entry.source}</Badge>
            </p>
            {entry.description && <p className="line-clamp-2 text-[12px] text-faint">{entry.description}</p>}
          </div>
          <IconButton title={t('Edit')} onClick={() => onEdit(entry)}>
            <Pencil className="size-3.5" />
          </IconButton>
        </div>
      ))}
    </div>
  );
}

export function SkillsSection() {
  const t = useT();
  const { activeChatId, chats, toast } = useStore();
  const chat = activeChatId ? chats[activeChatId] : undefined;
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [editing, setEditing] = useState<CatalogEntry | null>(null);
  const [creating, setCreating] = useState<'skill' | 'agent' | null>(null);
  const [form, setForm] = useState({ scope: 'personal' as 'personal' | 'workspace', name: '', description: '', body: '', tools: '', model: '' });
  const refresh = useCallback(() => void call('catalog.get', activeChatId).then(setCatalog), [activeChatId]);
  useEffect(refresh, [refresh]);

  const create = async () => {
    try {
      const entry =
        creating === 'skill'
          ? await call('catalog.createSkill', { chatId: activeChatId, scope: form.scope, name: form.name, description: form.description, body: form.body })
          : await call('catalog.createAgent', { chatId: activeChatId, scope: form.scope, name: form.name, description: form.description, prompt: form.body, tools: form.tools, model: form.model });
      toast('info', creating === 'skill' ? t('Skill "{name}" created', { name: entry.name }) : t('Agent "{name}" created', { name: entry.name }));
      setCreating(null);
      setForm({ ...form, name: '', description: '', body: '', tools: '', model: '' });
      refresh();
    } catch (error) {
      toast('error', error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="space-y-6">
      <SectionTitle title={t('Skills, subagents and commands')}>
        {chat ? t('These are the same files Claude Code uses (and Codex for skills): personal ones in ~/.claude, ~/.agents and ~/.codex, or the ones in the workspace of "{title}".', { title: chat.title }) : t('These are the same files Claude Code uses (and Codex for skills): personal ones in ~/.claude, ~/.agents and ~/.codex, or the ones in a chat’s workspace.')}
        {chat?.hasWorkspace ? ` ${t('The ones in the shared workspace reach every participant.')}` : ''}
      </SectionTitle>

      {creating ? (
        <div className="space-y-3 rounded-xl border border-line bg-panel p-4">
          <div className="grid grid-cols-3 gap-3">
            <Field label={t('Scope')}>
              <Select value={form.scope} onChange={(event) => setForm({ ...form, scope: event.target.value as 'personal' | 'workspace' })} className="w-full">
                <option value="personal">Personal (~/.claude)</option>
                <option value="workspace" disabled={!catalog?.cwd}>
                  {t('Chat workspace')}
                </option>
              </Select>
            </Field>
            <Field label={t('Name')}>
              <Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder={creating === 'skill' ? 'release-notes' : 'code-reviewer'} />
            </Field>
            {creating === 'agent' && (
              <Field label={t('Model (optional)')}>
                <Input value={form.model} onChange={(event) => setForm({ ...form, model: event.target.value })} placeholder="sonnet / opus / haiku" />
              </Field>
            )}
          </div>
          <Field label={t('Description')} hint={t('The agent uses it to decide when to apply it: describe when it helps.')}>
            <Input value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
          </Field>
          {creating === 'agent' && (
            <Field label={t('Tools (optional)')}>
              <Input value={form.tools} onChange={(event) => setForm({ ...form, tools: event.target.value })} placeholder="Read, Grep, Glob, Bash" />
            </Field>
          )}
          <Field label={creating === 'skill' ? t('Instructions (Markdown)') : t('Subagent prompt')}>
            <TextArea rows={8} value={form.body} onChange={(event) => setForm({ ...form, body: event.target.value })} className="font-mono" />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setCreating(null)}>
              {t('Cancel')}
            </Button>
            <Button variant="primary" onClick={() => void create()} disabled={!form.name.trim() || !form.description.trim()}>
              {t('Create')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <Button onClick={() => setCreating('skill')}>
            <Plus className="size-4" /> {t('New skill')}
          </Button>
          <Button onClick={() => setCreating('agent')}>
            <Plus className="size-4" /> {t('New subagent')}
          </Button>
        </div>
      )}

      <div>
        <h4 className="mb-2 text-[13.5px] font-semibold">Skills ({catalog?.skills.length ?? 0})</h4>
        <EntryList entries={catalog?.skills ?? []} icon={Sparkles} onEdit={setEditing} />
      </div>
      <div>
        <h4 className="mb-2 text-[13.5px] font-semibold">{t('Subagents')} ({catalog?.agents.length ?? 0})</h4>
        <EntryList entries={catalog?.agents ?? []} icon={Bot} onEdit={setEditing} />
      </div>
      <div>
        <h4 className="mb-2 text-[13.5px] font-semibold">Slash commands ({catalog?.commands.length ?? 0})</h4>
        <EntryList entries={catalog?.commands ?? []} icon={SquareSlash} onEdit={setEditing} />
      </div>
      {editing && (
        <FileEditor
          path={editing.path}
          title={t('Edit {name}', { name: editing.name })}
          onClose={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}
