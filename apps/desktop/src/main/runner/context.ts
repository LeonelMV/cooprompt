import type { AttachmentRef, ChatSummary, PublicUser, ToolItemData, TranscriptItem, TurnAutomation, TurnInfo, UserItemData } from '@cooprompt/protocol';
import { promptText } from '@cooprompt/protocol';

const MAX_CONTEXT_CHARS = 60_000;
const MAX_ALONGSIDE_PROMPT_CHARS = 500;

/** Told to every turn that runs, or may come to run, beside others in the same working folder. */
export const PARALLEL_NOTE =
  "Other tasks can run at the same time as this one, in this same folder: files may change while you work. Re-read a file right before you edit it, change only what this request needs, and don't run commands that affect the whole folder (git checkout, reset, stash or clean, formatting or regenerating everything) unless asked.";

/** Files are named, with the path of this computer's copy when it has one; their content never goes in the context. */
function mentions(attachments: AttachmentRef[] | undefined, files: ReadonlyMap<string, string>): string {
  if (!attachments?.length) return '';
  return ` (files: ${attachments.map((file) => (files.has(file.id) ? `${file.name} at ${files.get(file.id)}` : file.name)).join(', ')})`;
}

/** Told to every automation run: it runs unattended, so whatever would wait for someone is declined. */
export function automationNote(automation: TurnAutomation, owner: string): string {
  return `This turn was started by the automation “${automation.name}”, which ${owner} set up to run unattended: nobody may be watching, and nobody can answer questions or approve actions during it (such requests are declined automatically). Work with what your permissions allow, don't wait for anyone, and end with a short report: what you found or did, most important first, and anything that needs ${owner}'s attention. If there is nothing new, say so in one sentence.`;
}

/** What the agent hears when an automation run asks for an approval nobody can give. */
export const UNATTENDED_DENIAL = 'Nobody can approve actions during an unattended automation run, so this was declined. Continue without it, and say in your final report what needs approval.';

function summarizeInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const record = input as Record<string, unknown>;
  const value = record.command ?? record.file_path ?? record.path ?? record.pattern ?? record.url ?? record.query ?? record.description;
  return typeof value === 'string' ? value : JSON.stringify(input).slice(0, 200);
}

function line(item: TranscriptItem, users: Map<string, PublicUser>, executorOf: (item: TranscriptItem) => string, files: ReadonlyMap<string, string>): string | null {
  const author = item.authorId ? (users.get(item.authorId)?.name ?? 'Someone') : 'System';
  const attached = mentions((item.data as { attachments?: AttachmentRef[] }).attachments, files);
  switch (item.kind) {
    case 'user':
      return `[${author}]: ${promptText(item.data as UserItemData)}${attached}`;
    case 'text':
      return (item.data as { parentToolId?: string | null }).parentToolId ? null : `[${executorOf(item)}'s agent]: ${(item.data as { text: string }).text}${attached}`;
    case 'tool': {
      const tool = item.data as ToolItemData;
      if (tool.parentToolId) return null;
      const output = tool.output ? ` → ${tool.output.slice(0, 400).replace(/\s+/g, ' ')}` : '';
      return `[Tool ${tool.name} (${executorOf(item)}'s agent)]: ${summarizeInput(tool.input)}${output}${attached}`;
    }
    case 'notice':
      return `[Notice]: ${(item.data as { text: string }).text}`;
    case 'error':
      return `[Error in ${executorOf(item)}'s turn]: ${(item.data as { message: string }).message}`;
    case 'team':
      // For people only: no agent ever reads one, whatever reached this computer.
      return null;
    default:
      return null;
  }
}

/**
 * Renders other participants' activity so this device's agent can follow the shared chat. `files` maps attachment
 * ids to the paths of this computer's copies, relative to the working folder.
 */
export function renderCatchUp(items: TranscriptItem[], chat: ChatSummary, files: ReadonlyMap<string, string> = new Map()): string {
  const users = new Map(chat.members.map((member) => [member.user.id, member.user]));
  const executorOf = (item: TranscriptItem) => (item.authorId ? (users.get(item.authorId)?.name ?? 'another participant') : 'another participant');
  const lines = items.map((item) => line(item, users, executorOf, files)).filter((entry): entry is string => Boolean(entry));
  let text = lines.join('\n');
  if (text.length > MAX_CONTEXT_CHARS) text = `… (history trimmed)\n${text.slice(-MAX_CONTEXT_CHARS)}`;
  return text;
}

/** The requests of the turns running beside this one, so the agent neither redoes nor collides with them. */
export function renderAlongside(running: { turn: TurnInfo; prompt: TranscriptItem | null }[], chat: ChatSummary): string {
  const users = new Map(chat.members.map((member) => [member.user.id, member.user]));
  return running
    .map(({ turn, prompt }) => {
      const data = prompt?.data as UserItemData | undefined;
      const text = data ? `${promptText(data)}${mentions(data.attachments, new Map())}`.trim() : '';
      const request = text.length > MAX_ALONGSIDE_PROMPT_CHARS ? `${text.slice(0, MAX_ALONGSIDE_PROMPT_CHARS)}…` : text || '(request not shown)';
      return `[${users.get(turn.requesterId)?.name ?? 'Someone'}]: ${request}`;
    })
    .join('\n');
}

export function participantsLine(chat: ChatSummary): string {
  return chat.members.map((member) => `${member.user.name} <${member.user.email}>`).join(', ');
}

export function systemAppend(chat: ChatSummary, executor: PublicUser, cwd: string): string {
  const shared = chat.kind !== 'private';
  const parts = [
    'You are working inside CooPrompt, a collaborative coding-agent client.',
    shared
      ? `This chat is ${chat.kind === 'corporate' ? 'a company chat (visible to the whole organization)' : 'multiplayer'}. Participants: ${participantsLine(chat)}. Every user message starts with the author's name in brackets; reply to that person, in the language they write in.`
      : 'This chat is private.',
    `This turn runs on ${executor.name}'s computer with their local credentials (git, CLIs, credential stores). Never show, copy or publish secrets (tokens, keys, .env contents): ${shared ? 'other people read this chat.' : "the history is stored on the team's server."}`,
  ];
  if (shared) {
    parts.push(
      `The working directory (${cwd}) is a shared folder that syncs automatically with the other participants' machines, git history (.git) included. Files ignored by .gitignore (for example .env, builds) and node_modules are not synced: everyone keeps their own, so install dependencies on this computer before building or testing.`,
      "The other participants' turns run on their own computers: paths outside this folder that they or their agents mention don't exist here, and changes made outside this folder don't reach them. To work on an existing repository, clone it into this folder: a copy without .git leaves the others without its history, and symbolic links to folders outside it are not synced.",
      "Turns in this chat run one at a time, except those sent in multitask mode, which run alongside the others in this same folder. Messages sent normally wait while yours runs: unless the requester asks you to wait, don't sleep or poll for slow outside work (deploys, CI); report its status and finish.",
    );
  }
  return parts.join('\n');
}
