import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientMessage } from '@cooprompt/protocol';
import { createPublisher } from '../src/main/runner/publisher.ts';
import { createRedactor, REDACTED, redactDeep } from '../src/main/runner/redact.ts';

// Fake credentials are assembled at runtime so secret scanners don't flag this file.
const join = (...parts: string[]) => parts.join('');
const RANDOM = 'zq7FAKEvL2m9xT4wR8nKp3Lq';
const RANDOM40 = 'zq7FAKEvL2m9xT4wR8nKp3LqW5yH6jU1bN0cM8dX';
const jwt = join(
  Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'),
  '.',
  Buffer.from('{"sub":"fake-user","fake":true}').toString('base64url'),
  '.',
  'FAKEsignatureFAKEsignature0',
);
const TOKENS = {
  github: join('gh', 'p_', 'FAKE', 'x'.repeat(32)),
  anthropic: join('sk-', 'ant-', 'api03-', 'FAKE'.repeat(10)),
  openai: join('sk-', 'proj-', 'FAKE'.repeat(10)),
  slack: join('xo', 'xb-', '000000000000-', 'FAKEfakeFAKEfake'),
  awsKeyId: join('AK', 'IA', 'FAKEFAKEFAKE0000'),
  google: join('AI', 'za', 'FAKE'.repeat(8), 'abc'),
  stripe: join('sk', '_live_', 'FAKE'.repeat(6)),
  atlassian: join('ATA', 'TT3x', 'FAKE'.repeat(16)),
  vault: join('hv', 's.', 'FAKE'.repeat(7)),
};
const privateKey = join('-----BEGIN ', 'RSA PRIVATE KEY-----\n', 'FAKEKEYMATERIAL'.repeat(4), '\n', 'MOREFAKEKEYMATERIAL'.repeat(3), '\n-----END ', 'RSA PRIVATE KEY-----');

const redact = createRedactor(() => []);

describe('redaction', () => {
  it('hides credentials hardcoded in a git diff and keeps the code readable', () => {
    const basic = Buffer.from(`service:${RANDOM}`).toString('base64');
    const diff = [
      'diff --git a/src/services/serviceService.ts b/src/services/serviceService.ts',
      'index 3f2a1b4..9c8d7e6 100644',
      '--- a/src/services/serviceService.ts',
      '+++ b/src/services/serviceService.ts',
      '@@ -1,9 +1,14 @@',
      '-const BASE_URL = process.env.SERVICE_URL;',
      `-SERVICE_TOKEN=${RANDOM40}`,
      "+const BASE_URL = 'https://service:Pa55w0rd!2024@service.internal.example/v1';",
      `+const API_KEY = 'example_live_${RANDOM}';`,
      `+const SERVICE_SECRET_KEY = "${RANDOM40}";`,
      `+const token = '${jwt}';`,
      ' export async function fetchProfile(userId: string) {',
      '   const response = await fetch(`${BASE_URL}/profile/${userId}`, {',
      `+    headers: { Authorization: \`Bearer ${RANDOM}\`, 'x-api-key': '${RANDOM40}' },`,
      `+    // fallback: Basic ${basic}`,
      `+    auth: { username: 'svc-service', password: 'hunter22' },`,
      "     credentials: 'include',",
      '   });',
    ].join('\n');

    const output = redact(diff);

    for (const secret of ['Pa55w0rd!2024', RANDOM, RANDOM40, jwt, 'hunter22']) expect(output).not.toContain(secret);
    expect(output).toContain(`+const API_KEY = '${REDACTED}';`);
    expect(output).toContain(`+const SERVICE_SECRET_KEY = "${REDACTED}";`);
    expect(output).toContain(`-SERVICE_TOKEN=${REDACTED}`);
    expect(output).toContain(`Authorization: \`Bearer ${REDACTED}\``);
    expect(output).toContain(`password: '${REDACTED}'`);
    expect(output).toContain("username: 'svc-service'");
    expect(output).toContain('index 3f2a1b4..9c8d7e6 100644');
    expect(output).toContain('-const BASE_URL = process.env.SERVICE_URL;');
    expect(output).toContain("credentials: 'include'");
  });

  it.each([
    ['vendor tokens', Object.values(TOKENS).join('\n'), Object.values(TOKENS)],
    ['a JWT', `token: ${jwt}`, [jwt]],
    ['a private key block', `key material:\n${privateKey}\nend`, ['FAKEKEYMATERIAL']],
    ['a private key cut short by clipping', `${privateKey.slice(0, 80)}\n… (1200 more characters)`, ['FAKEKEYMATERIAL']],
    ['an .env file', `DB_PASSWORD=Butterfly\nSERVICE_API_TOKEN=${RANDOM}\nexport GITHUB_TOKEN=${TOKENS.github}`, ['Butterfly', RANDOM, TOKENS.github]],
    ['AWS credentials', `aws_access_key_id = ${TOKENS.awsKeyId}\naws_secret_access_key = ${RANDOM40}`, [TOKENS.awsKeyId, RANDOM40]],
    ['AWS CLI JSON', `{"Credentials": {"SecretAccessKey": "${RANDOM40}", "SessionToken": "${RANDOM}"}}`, [RANDOM40, RANDOM]],
    ['a Basic authorization header', `curl -H "Authorization: Basic ${Buffer.from(`svc:${RANDOM}`).toString('base64')}" https://api.example`, [Buffer.from(`svc:${RANDOM}`).toString('base64')]],
    ['curl -u', `curl -u admin:${RANDOM} https://api.example`, [RANDOM]],
    ['a database URL', `DATABASE_URL=postgres://app:${RANDOM}@db.internal:5432/app`, [RANDOM]],
    ['a token as the user of a URL', `git clone https://${RANDOM40}@github.com/org/repo.git`, [RANDOM40]],
    ['command flags', `deploy --token ${RANDOM} --client-secret=${RANDOM40}`, [RANDOM, RANDOM40]],
    ['a Kubernetes env entry', `- name: SERVICE_API_TOKEN\n  value: ${RANDOM}`, [RANDOM]],
    ['an SSM parameter', `{"Name": "/prod/service/token", "Type": "SecureString", "Value": "${RANDOM}"}`, [RANDOM]],
    ['an XML element', `<Password>${RANDOM}</Password>`, [RANDOM]],
    ['a header set in code', `request.setHeader('X-Auth-Token', '${RANDOM}')`, [RANDOM]],
    ['a .netrc entry', `machine api.example login bot password ${RANDOM}`, [RANDOM]],
    ['an .npmrc entry', `//registry.npmjs.org/:_authToken=${RANDOM40}`, [RANDOM40]],
    ['a Docker config', `{"auths": {"registry.example": {"auth": "${Buffer.from(`user:${RANDOM}`).toString('base64')}"}}}`, [Buffer.from(`user:${RANDOM}`).toString('base64')]],
    ['a signed URL', `https://bucket.s3.amazonaws.com/f?X-Amz-Signature=${'a1b2c3d4'.repeat(8)}`, ['a1b2c3d4'.repeat(8)]],
    ['a comparison against a literal', "if (password === 'Tr0ub4dor&3') {", ['Tr0ub4dor&3']],
    ['a generated value under a plain key name', `const SERVICE_KEY = '${RANDOM40}';`, [RANDOM40]],
    ['a token mentioned in prose', `The API key is ${RANDOM} for staging`, [RANDOM]],
    ['a quoted value cut short', `token: "${RANDOM}`, [RANDOM]],
  ])('hides %s', (_name, text, secrets) => {
    const output = redact(text);
    for (const secret of secrets) expect(output).not.toContain(secret);
    expect(output).toContain(REDACTED);
  });

  it('leaves ordinary code, lockfiles, hashes and identifiers alone', () => {
    const samples = [
      'integrity sha512-Ab3dEf9GhIj0KlMnOpQrStUvWxYz1234567890abcdEFGHijklMNOPqrstUVWXyz==',
      '"integrity": "sha512-Ab3dEf9GhIj0KlMnOpQrStUvWxYz1234567890abcdEFGHijklMNOPqrstUVWXyz==",',
      '"resolved": "https://registry.npmjs.org/js-tokens/-/js-tokens-4.0.0.tgz",',
      '"parse-passwd": "^1.0.0",',
      'checksum = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"',
      'commit 0123456789abcdef0123456789abcdef01234567',
      'id: 123e4567-e89b-12d3-a456-426614174000',
      'const token = await getToken();',
      'const apiKey = process.env.SERVICE_API_KEY;',
      'Authorization: process.env.LOGGING_API_KEY,',
      '...(sessionToken && { Authorization: sessionToken }),',
      "headers: { Authorization: `Bearer ${token}` },",
      '  password: string;',
      '  token?: string | null;',
      '$password: String!',
      'password: currentPassword!,',
      'token: Auth0ClientWrapper,',
      'if (token === CreateProjectRecordUseCase) {',
      "logger.error({ error }, '[auth:session:refresh]');",
      "ACCESS_MODE = 'ACCESS_MODE',",
      'author:your-github-user is:open review:changes_requested',
      '"max_tokens": 4096, "input_tokens": 1200',
      "credentials: 'same-origin',",
      "token_type: 'Bearer', grant_type: 'client_credentials',",
      "token_endpoint: 'https://oauth2.googleapis.com/token',",
      "secretName: 'prod/service/api',",
      'paginationToken: `user:1|address:1|createdAt:1`,',
      "operationKey: 'sample-request-key-123', issueKey: 'EXAMPLE-19448',",
      'sonar.projectKey=example-org_sample-service',
      "publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl user@host',",
      '- name: API_TOKEN\n  valueFrom:\n    secretKeyRef:\n      name: service\n      key: token',
      'PWD=/Users/ana/dev/web-app',
      'DB_PASSWORD=${DB_PASSWORD}',
      'git@github.com:acme-org/example-service.git',
      'Bearer authentication is required',
      'I changed `SERVICE_TOKEN`, `serviceService.ts` and `apiClient`.',
      'HTTP endpoints authenticate with `Authorization: Bearer <session token>`.',
      'Voy a revisar el token de acceso y el password del usuario.',
      'rg: src/pages/samplePage/SamplePage.tsx: No such file or directory (os error 2)',
    ];
    for (const sample of samples) expect(redact(sample), sample).toBe(sample);
  });

  it('replaces the values in the secret store wherever they appear, also URL-encoded', () => {
    const stored = `${RANDOM}/+=`;
    const withKnown = createRedactor(() => [stored]);
    expect(withKnown(`echo ${stored} and ${encodeURIComponent(stored)}`)).toBe(`echo ${REDACTED} and ${REDACTED}`);
  });

  it('judges structured fields by their key', () => {
    const input = { host: 'db.internal', user: 'app', password: 'Butterfly', apiKey: RANDOM, pageToken: 'CAEQAA', note: 'rotate the token weekly' };
    expect(redactDeep({ toolUseId: 'u1', name: 'mcp__db__connect', input }, redact)).toEqual({
      toolUseId: 'u1',
      name: 'mcp__db__connect',
      input: { ...input, password: REDACTED, apiKey: REDACTED },
    });
  });
});

describe('publisher', () => {
  let sent: ClientMessage[];
  /** What a participant sees: the server keeps the streaming draft from `turn.draft` and `turn.delta`. */
  let draft: string;
  const send = (message: ClientMessage) => {
    sent.push(message);
    if (message.t === 'turn.draft') draft = message.draft?.text ?? '';
    if (message.t === 'turn.delta') draft += message.text;
  };
  const publisher = (shouldRedact = true) => createPublisher('turn-1', { send, redact, shouldRedact: () => shouldRedact, info: () => {}, share: async () => null });

  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
    draft = '';
  });
  afterEach(() => vi.useRealTimers());

  const fragments = (secret: string) => Array.from({ length: secret.length - 7 }, (_, index) => secret.slice(index, index + 8));

  it('never streams a secret split between deltas', () => {
    const { sink, finish } = publisher();
    const text = `Found it. API key: ${RANDOM} and the deploy uses token=${TOKENS.github} today.\nDone `;
    sink.draft({ kind: 'text', text: '' });
    for (let index = 0; index < text.length; index += 3) {
      sink.delta('text', text.slice(index, index + 3));
      vi.advanceTimersByTime(100);
      for (const fragment of [...fragments(RANDOM), ...fragments(TOKENS.github)]) expect(draft).not.toContain(fragment);
    }
    expect(draft).toBe(`Found it. API key: ${REDACTED} and the deploy uses token=${REDACTED} today.\nDone `);
    finish({ status: 'done' });
    expect(draft).toBe('');
  });

  it('holds back a private key block until it ends', () => {
    const { sink } = publisher();
    sink.draft({ kind: 'text', text: '' });
    for (const line of `Here it is:\n${privateKey}\nok `.split(/(?<=\n)/)) {
      sink.delta('text', line);
      vi.advanceTimersByTime(100);
      expect(draft).not.toContain('FAKEKEYMATERIAL');
    }
    expect(draft).toBe(`Here it is:\n${REDACTED}\nok `);
  });

  it('redacts items, drafts and the error that ends the turn', () => {
    const { sink, finish } = publisher();
    sink.item('cmd', { kind: 'tool', data: { toolUseId: 'cmd', name: 'Bash', input: { command: 'git diff' }, status: 'running' } });
    sink.item('cmd', { kind: 'tool', data: { toolUseId: 'cmd', name: 'Bash', input: { command: 'git diff' }, status: 'done', output: `+const API_KEY = '${RANDOM}';` } });
    sink.draft({ kind: 'thinking', text: `checking ${TOKENS.anthropic} now ` });
    finish({ status: 'failed', error: `Request failed: Authorization: Bearer ${RANDOM40}` });

    const wire = JSON.stringify(sent);
    for (const secret of [RANDOM, RANDOM40, TOKENS.anthropic]) expect(wire).not.toContain(secret);
    const items = sent.filter((message) => message.t === 'turn.items').flatMap((message) => message.items);
    expect(items).toEqual([
      { id: 'turn-1.cmd', kind: 'tool', data: { toolUseId: 'cmd', name: 'Bash', input: { command: 'git diff' }, status: 'done', output: `+const API_KEY = '${REDACTED}';` } },
    ]);
    expect(sent.at(-1)).toEqual({ t: 'turn.finish', turnId: 'turn-1', status: 'failed', error: `Request failed: Authorization: Bearer ${REDACTED}`, usage: null });
  });

  it('publishes text as it is when redaction is turned off', () => {
    const { sink, finish } = publisher(false);
    sink.delta('text', `token=${TOKENS.github}`);
    vi.advanceTimersByTime(100);
    expect(draft).toBe(`token=${TOKENS.github}`);
    finish({ status: 'failed', error: `bad ${TOKENS.github}` });
    expect(sent.at(-1)).toMatchObject({ t: 'turn.finish', error: `bad ${TOKENS.github}` });
  });
});
