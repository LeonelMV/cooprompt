import { describe, expect, it } from 'vitest';
import type { ItemKind, ToolItemData, TranscriptItem } from '@cooprompt/protocol';
import { describeTool, groupActivity, summarizeActivity } from '../src/renderer/src/lib/tools.ts';

let seq = 0;
const item = (kind: ItemKind, data: unknown): TranscriptItem => ({ id: `t.${++seq}`, chatId: 'c', seq, rev: seq, turnId: 't', kind, authorId: null, data: data as never, createdAt: 0, updatedAt: 0 });
const tool = (name: string, input: unknown, status: ToolItemData['status'] = 'done'): ToolItemData => ({ toolUseId: `u${++seq}`, name, input, status });

describe('tool activity', () => {
  it('describes calls by what they did instead of their raw arguments', () => {
    expect(describeTool('mcp__codex_apps__github.fetch_pr_comments', { pr_number: 4221, repo_full_name: 'example-org/sample-service' })).toMatchObject({
      category: 'service',
      brand: 'github',
      source: 'GitHub',
      action: 'Fetch PR comments',
      target: '#4221 · example-org/sample-service',
    });
    expect(describeTool('mcp__codex_apps__github.get_commit_combined_status', { commit_sha: '0123456789abcdef0123456789abcdef01234567', repo_full_name: 'example-org/sample-service' }).target).toBe('0123456 · example-org/sample-service');
    expect(describeTool('mcp__cua_repl__js', { code: 'await cua.getState();', title: 'Buscar sesión de GitHub en el navegador' })).toMatchObject({
      category: 'browser',
      brand: null,
      target: 'Buscar sesión de GitHub en el navegador',
    });
    expect(describeTool('mcp__claude_ai_Slack__slack_send_message', { channel: 'C1' })).toMatchObject({ brand: 'slack', action: 'Send message' });
    expect(describeTool('mcp__atlassian__getJiraIssue', { issueKey: 'TEST-12' })).toMatchObject({ brand: 'jira', target: 'TEST-12' });
    expect(describeTool('mcp__rea__decompile', { path: '/bin/ls' })).toMatchObject({ category: 'service', brand: null, source: 'rea', action: 'Decompile' });
    expect(describeTool('Bash', { command: 'npm test\nnpm run lint' })).toMatchObject({ category: 'command', target: 'npm test' });
    expect(describeTool('Bash', { command: "/bin/zsh -lc 'echo '\\''hola'\\'' > saludo.txt'" }).target).toBe("echo 'hola' > saludo.txt");
    expect(describeTool('ApplyPatch', { changes: [{ path: '/repo/src/app/main.ts', kind: 'update' }, { path: 'README.md', kind: 'add' }] })).toMatchObject({
      category: 'edit',
      target: '…/src/app/main.ts +1',
    });
  });

  it("shows Cursor's own tools by what they did too", () => {
    expect(describeTool('SemanticSearch', { query: 'where is auth handled' })).toMatchObject({ category: 'search', target: 'where is auth handled' });
    expect(describeTool('LS', { path: '/repo/apps/desktop/src/main' })).toMatchObject({ category: 'search', target: '…/desktop/src/main' });
    expect(describeTool('CreatePlan', { name: 'Refactor tabs' })).toMatchObject({ category: 'plan', target: 'Refactor tabs' });
    expect(describeTool('ApplyPatch', { changes: [{ path: 'old.ts', kind: 'delete' }] })).toMatchObject({ category: 'edit', target: 'old.ts' });
    expect(describeTool('Switch Mode: agent', { targetModeId: 'agent' })).toMatchObject({ category: 'other', source: 'Switch Mode: agent' });
  });

  it('collapses runs of tool calls, keeping prompts and answers outside', () => {
    const answer = item('text', { text: 'Listo' });
    const blocks = groupActivity([
      item('text', { text: 'Reviso tus PRs' }),
      item('tool', tool('Bash', { command: 'gh pr list' })),
      item('thinking', { text: 'mirando' }),
      item('tool', tool('Read', { file_path: 'a.ts' })),
      item('permission', { toolName: 'Bash' }),
      item('tool', tool('Bash', { command: 'rm -rf build' })),
      answer,
    ]);
    expect(blocks.map((block) => (block.kind === 'group' ? `group:${block.items.length}` : block.item.kind))).toEqual(['text', 'group:3', 'permission', 'tool', 'text']);
  });

  it('summarizes a group by the biggest share and counts failures', () => {
    const calls = [
      ...Array.from({ length: 12 }, (_, index) => tool('mcp__codex_apps__github.search_prs', { query: `q${index}` })),
      tool('mcp__cua_repl__js', { title: 'Abrir PR' }),
      tool('mcp__cua_repl__js', { title: 'Leer estado' }, 'error'),
      tool('Edit', { file_path: 'a.ts' }),
      tool('Edit', { file_path: 'a.ts' }),
    ];
    const { parts, failed } = summarizeActivity(calls);
    expect(parts).toEqual([
      { category: 'service', source: 'GitHub', count: 12 },
      { category: 'browser', source: undefined, count: 2 },
      { category: 'edit', source: undefined, count: 1 },
    ]);
    expect(failed).toBe(1);
  });
});
