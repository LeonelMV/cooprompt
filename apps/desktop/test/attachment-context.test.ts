import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AttachmentRef, ChatSummary, ClientMessage, PublicUser, TranscriptItem } from '@cooprompt/protocol';
import { attachmentFallback } from '@cooprompt/protocol';
import { attachmentNote, catchUpAttachments, referencedMedia } from '../src/main/runner/attachments.ts';
import { renderCatchUp } from '../src/main/runner/context.ts';
import { createPublisher } from '../src/main/runner/publisher.ts';
import { createRedactor } from '../src/main/runner/redact.ts';

const ana: PublicUser = { id: 'u1', email: 'ana@acme.com', name: 'Ana', avatarUrl: null, orgDomain: 'acme.com' };
const leo: PublicUser = { id: 'u2', email: 'leo@acme.com', name: 'Leo', avatarUrl: null, orgDomain: 'acme.com' };
const chat: ChatSummary = {
  id: 'c1',
  title: 'Diseño',
  kind: 'multiplayer',
  ownerId: ana.id,
  orgDomain: 'acme.com',
  createdAt: 0,
  updatedAt: 0,
  lastActivityAt: 0,
  members: [ana, leo].map((user) => ({ user, role: user === ana ? 'owner' : 'member', joinedAt: 0 })),
  isMember: true,
  hasWorkspace: true,
  activeTurn: null,
  queuedTurns: 0,
};

const ref = (id: string, name: string, kind: AttachmentRef['kind'] = 'image', mime = 'image/png'): AttachmentRef => ({ id, name, mime, kind, size: 2048, sha256: id.padEnd(64, '0') });
const item = (seq: number, kind: TranscriptItem['kind'], authorId: string, data: unknown): TranscriptItem => ({ id: `t${seq}.${kind}`, chatId: chat.id, seq, rev: seq, turnId: `t${seq}`, kind, authorId, data: data as never, createdAt: 0, updatedAt: 0 });

describe('what agents are told about files', () => {
  it('lists the attached files by their path in the working folder', () => {
    const note = attachmentNote(
      [
        { name: 'pantalla.png', mime: 'image/png', kind: 'image', size: 250_000, path: '/work/.cooprompt/attachments/a1/pantalla.png' },
        { name: 'datos.zip', mime: 'application/octet-stream', kind: 'file', size: 3 * 1024 * 1024, path: '/work/.cooprompt/attachments/a2/datos.zip' },
      ],
      '/work',
    );
    expect(note).toBe(`Attached files, saved in the working folder:\n- ${join('.cooprompt', 'attachments', 'a1', 'pantalla.png')} (image/png, 244 KB)\n- ${join('.cooprompt', 'attachments', 'a2', 'datos.zip')} (file, 3 MB)`);
    expect(attachmentNote([], '/work')).toBe('');
  });

  it("names other people's files in the catch-up, with this Mac's copy when there is one, and never their content", () => {
    const photo = ref('a1', 'pantalla.png');
    const shot = ref('a2', 'take_screenshot-1.png');
    const items = [
      item(1, 'user', ana.id, { text: attachmentFallback('¿qué ves acá?', [photo]), attachments: [photo] }),
      item(2, 'tool', ana.id, { toolUseId: 'x', name: 'mcp__chrome__take_screenshot', input: { url: 'https://acme.com' }, status: 'done', output: 'Took a screenshot', attachments: [shot] }),
      item(3, 'text', ana.id, { text: 'Listo.', attachments: [ref('a3', 'informe.pdf', 'pdf', 'application/pdf')] }),
    ];
    const text = renderCatchUp(items, chat, new Map([['a1', '.cooprompt/attachments/a1/pantalla.png']]));
    expect(text).toBe(
      [
        '[Ana]: ¿qué ves acá? (files: pantalla.png at .cooprompt/attachments/a1/pantalla.png)',
        "[Tool mcp__chrome__take_screenshot (Ana's agent)]: https://acme.com → Took a screenshot (files: take_screenshot-1.png)",
        "[Ana's agent]: Listo. (files: informe.pdf)",
      ].join('\n'),
    );
    expect(text).not.toContain('📎');
    expect(catchUpAttachments(items).map((file) => file.id)).toEqual(['a3', 'a2', 'a1']);
  });
});

describe('media an answer points to', () => {
  let cwd: string;
  let outside: string;

  beforeAll(async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'cooprompt-referenced-')));
    cwd = join(root, 'work');
    outside = join(root, 'outside');
    await mkdir(join(cwd, 'shots'), { recursive: true });
    await mkdir(join(cwd, 'Mis capturas'), { recursive: true });
    await mkdir(join(cwd, '.cooprompt', 'attachments', 'a1'), { recursive: true });
    await mkdir(outside);
    for (const file of ['shots/home.png', 'Mis capturas/login final.png', 'demo.mp4', 'report.pdf', '.cooprompt/attachments/a1/sent.png', 'notes.txt']) await writeFile(join(cwd, file), 'x');
    await writeFile(join(outside, 'secret.png'), 'x');
    if (process.platform === 'win32') await symlink(outside, join(cwd, 'linked'), 'junction');
    else await symlink(join(outside, 'secret.png'), join(cwd, 'link.png'));
  });

  afterAll(async () => {
    await rm(join(cwd, '..'), { recursive: true, force: true });
  });

  it('finds files in the working folder from links, code spans and bare paths', async () => {
    const text = [
      'Saqué la captura: ![home](shots/home.png) y también `Mis capturas/login final.png`.',
      `Grabé ${join(cwd, 'demo.mp4')}, y el informe está en ./report.pdf.`,
      'Ver https://acme.com/logo.png y notes.txt.',
    ].join('\n');
    expect(await referencedMedia(text, cwd)).toEqual([join(cwd, 'shots/home.png'), join(cwd, 'Mis capturas/login final.png'), join(cwd, 'demo.mp4'), join(cwd, 'report.pdf')]);
  });

  it('ignores what is outside the folder, through links too, and the copies of attachments', async () => {
    const link = process.platform === 'win32' ? 'linked/secret.png' : 'link.png';
    const text = `Mirá ${join(outside, 'secret.png')}, ${link}, ../outside/secret.png, .cooprompt/attachments/a1/sent.png y missing.png`;
    expect(await referencedMedia(text, cwd)).toEqual([]);
  });

  it('accepts local file URLs inside the workspace but not outside it', async () => {
    const inside = join(cwd, 'Mis capturas', 'login final.png');
    const outsideFile = join(outside, 'secret.png');
    expect(await referencedMedia(`[inside](${pathToFileURL(inside)}) [outside](${pathToFileURL(outsideFile)})`, cwd)).toEqual([inside]);
  });
});

describe('media in published items', () => {
  it('adds the shared files to the item, redacted like the rest, and waits for uploads before finishing', async () => {
    const sent: ClientMessage[] = [];
    let release!: () => void;
    const uploaded = new Promise<void>((resolve) => {
      release = resolve;
    });
    const publisher = createPublisher('turn-1', {
      send: (message) => sent.push(message),
      redact: createRedactor(() => ['cooprompt-stored-secret-0001']),
      shouldRedact: () => true,
      info: () => {},
      share: async (media) => {
        await uploaded;
        return 'data' in media ? ref('a9', media.name) : null;
      },
    });
    publisher.sink.item('tool.t1', { kind: 'tool', data: { toolUseId: 't1', name: 'screenshot', input: {}, status: 'done' } });
    publisher.sink.attach('tool.t1', [{ name: 'cooprompt-stored-secret-0001.png', mime: 'image/png', data: new Uint8Array([1]) }]);
    publisher.sink.attach('missing', [{ name: 'orphan.png', mime: 'image/png', data: new Uint8Array([2]) }]);
    const finishing = publisher.finish({ status: 'done' });
    expect(sent.some((message) => message.t === 'turn.finish')).toBe(false);
    release();
    await finishing;

    const items = sent.filter((message) => message.t === 'turn.items').flatMap((message) => message.items);
    expect(new Set(items.map((entry) => entry.id))).toEqual(new Set(['turn-1.tool.t1']));
    expect(items.at(-1)?.data).toMatchObject({ status: 'done', attachments: [{ id: 'a9', name: '«redacted».png' }] });
    expect(sent.at(-1)).toMatchObject({ t: 'turn.finish', status: 'done' });
  });
});
