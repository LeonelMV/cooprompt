import { describe, expect, it } from 'vitest';
import type { ChatKind, ChatSummary, PublicUser } from '@cooprompt/protocol';
import { systemAppend } from '../src/main/runner/context.ts';

const ana: PublicUser = { id: 'u1', email: 'ana@acme.com', name: 'Ana', avatarUrl: null, orgDomain: 'acme.com' };
const leo: PublicUser = { id: 'u2', email: 'leo@acme.com', name: 'Leo', avatarUrl: null, orgDomain: 'acme.com' };

function chat(kind: ChatKind): ChatSummary {
  const members = kind === 'private' ? [ana] : [ana, leo];
  return {
    id: 'c1',
    title: 'Pairing',
    kind,
    ownerId: ana.id,
    orgDomain: 'acme.com',
    createdAt: 0,
    updatedAt: 0,
    lastActivityAt: 0,
    members: members.map((user) => ({ user, role: user === ana ? 'owner' : 'member', joinedAt: 0 })),
    isMember: true,
    hasWorkspace: kind !== 'private',
    activeTurn: null,
    queuedTurns: 0,
  };
}

describe('what the agent is told about the chat', () => {
  it('explains a shared folder: what syncs, whose computer the paths belong to, how to bring a repository and why to finish soon', () => {
    const text = systemAppend(chat('multiplayer'), ana, '/Users/ana/CooPrompt/Compartidos/Pairing-c1');
    expect(text).toContain('Participants: Ana <ana@acme.com>, Leo <leo@acme.com>');
    expect(text).toContain("This turn runs on Ana's computer");
    expect(text).toContain('(/Users/ana/CooPrompt/Compartidos/Pairing-c1) is a shared folder');
    expect(text).toContain('install dependencies on this computer');
    expect(text).toContain("paths outside this folder that they or their agents mention don't exist here");
    expect(text).toContain('clone it into this folder');
    expect(text).toContain('run one at a time, except those sent in multitask mode, which run alongside the others in this same folder');
  });

  it('keeps a private chat to who runs it and the rule on secrets', () => {
    const text = systemAppend(chat('private'), ana, '/Users/ana/CooPrompt/Privados/Notes-c1');
    expect(text).toContain('This chat is private.');
    expect(text).toContain('Never show, copy or publish secrets');
    expect(text).not.toContain('shared folder');
    expect(text).not.toContain('one at a time');
  });
});
