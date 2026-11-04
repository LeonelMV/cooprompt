import type { TranscriptItem } from '@cooprompt/protocol';
import type { Store } from './store.ts';

/**
 * What gets a team-only message's place where its content must not go: apps that don't announce `team-messages`
 * and item requests without `include=team` (the runner's, which builds the agents' context). It says who wrote,
 * never what. Clients that have not announced the feature receive only the stand-in.
 */
export function teamStandIns(store: Store, items: TranscriptItem[]): TranscriptItem[] {
  return items.map((item) => {
    if (item.kind !== 'team') return item;
    const name = (item.authorId && store.getUser(item.authorId)?.name) || 'Someone';
    return { ...item, data: { text: `${name} sent a team-only message: update CooPrompt to read it.` } };
  });
}
