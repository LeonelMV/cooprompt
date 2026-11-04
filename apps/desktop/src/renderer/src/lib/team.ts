import type { ChatKind } from '@cooprompt/protocol';

export type ComposerMode = 'agent' | 'team' | 'blocked';

/**
 * Where the composer sends: to the agent, to the chat's people only, or nowhere while team-only is on with a server
 * that can't take it, so a message meant for the team never reaches an agent instead. Private chats have no team.
 */
export function composerMode(input: { teamOnly: boolean; supported: boolean | null; kind: ChatKind }): ComposerMode {
  if (!input.teamOnly || input.kind === 'private') return 'agent';
  return input.supported === false ? 'blocked' : 'team';
}
