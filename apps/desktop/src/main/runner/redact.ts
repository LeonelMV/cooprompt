export const REDACTED = '«redacted»';

/** Credential formats recognizable without context; each match is replaced whole. */
const TOKEN_PATTERNS: RegExp[] = [
  // A block cut short (clipped output) is redacted up to the end of the text.
  /-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY( BLOCK)?-----[\s\S]*?(?:-----END \1PRIVATE KEY\2-----|$)/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bsk-(?:proj-|svcacct-|admin-|or-v1-|or-)?[A-Za-z0-9_-]{24,}/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})/g,
  /\bgl(?:pat|dt|rt|ptt|ft|imt|oas|soat|cbt|ffct|agent)-[A-Za-z0-9_-]{20,}/g,
  /\bxox[abposre]-[A-Za-z0-9-]{10,}/g,
  /\bxapp-\d-[A-Za-z0-9-]{10,}/g,
  /\bhttps:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9_/-]{10,}/g,
  /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bGOCSPX-[A-Za-z0-9_-]{20,}/g,
  /\bya29\.[0-9A-Za-z_-]{20,}/g,
  /\b1\/\/0[0-9A-Za-z_-]{30,}/g,
  /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}/g,
  /\bwhsec_[0-9A-Za-z+/=]{20,}/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{20,}/g,
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
  /\bshp(?:at|ss|ca|pa)_[a-fA-F0-9]{32}\b/g,
  /\bAT(?:ATT|CTT)3[A-Za-z0-9_=-]{50,}/g,
  /\bATBB[A-Za-z0-9]{24,}/g,
  /\blin_(?:api|oauth)_[A-Za-z0-9]{32,}/g,
  /\b(?:secret_[A-Za-z0-9]{43}|ntn_[A-Za-z0-9]{40,})\b/g,
  /\bhf_[A-Za-z0-9]{30,}\b/g,
  /\bdo[por]_v1_[a-f0-9]{64}\b/g,
  /\bdp\.(?:pt|st|sa|ct|scim|audit)\.[A-Za-z0-9]{40,}/g,
  /\bhv[sbr]\.[A-Za-z0-9_-]{24,}/g,
  /\bdckr_pat_[A-Za-z0-9_-]{20,}/g,
  /\b[A-Za-z0-9]{14}\.atlasv1\.[A-Za-z0-9_-]{60,}/g,
  /\bsbp_[a-f0-9]{40}\b/g,
  /\bPMAK-[a-f0-9]{24}-[a-f0-9]{34}\b/g,
  /\bNRAK-[A-Z0-9]{27}\b/g,
  /\bops_eyJ[A-Za-z0-9_-]{30,}/g,
  /\bsntry[su]_[A-Za-z0-9_=+/-]{30,}/g,
  /\bglc_[A-Za-z0-9+/]{32,}={0,2}/g,
  /\bdapi[a-f0-9]{32}(?:-\d)?\b/g,
  /\bfigd_[A-Za-z0-9_-]{30,}/g,
  /\bCFPAT-[A-Za-z0-9_-]{40,}/g,
  /\b(?:sdk|mob)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g,
  /\bsk\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g,
  /\bEAA[A-Za-z0-9]{80,}/g,
  /\bkey-[0-9a-f]{32}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];

type Groups = Record<string, string | undefined>;

/**
 * Each pattern's match ends where its `value` group ends, so only the value is replaced and the name,
 * quotes and diff markers around it stay readable.
 */
interface ContextRule {
  pattern: RegExp;
  secret(groups: Groups): boolean;
}

/** Their values are human passwords: short ones and plain words count too. */
const PASSWORD_HEADS = new Set(['password', 'passwd', 'passphrase']);
const SECRET_HEADS = new Set([...PASSWORD_HEADS, 'pass', 'pw', 'pwd', 'secret', 'token', 'apikey', 'credential', 'credentials', 'authorization', 'auth', 'signature', 'bearer']);
const SECRET_SUFFIX = /(?:password|passwd|passphrase|secret|token|apikey|privatekey|secretkey|accesskey|authkey)$/;
/** Tokens that aren't credentials: pagination cursors, cancellation and dependency-injection tokens, design tokens. */
const NOT_CREDENTIAL_TOKENS = new Set([
  'page', 'pagination', 'next', 'prev', 'previous', 'continuation', 'cursor', 'sync', 'cancel', 'cancellation', 'injection', 'lexer', 'parse',
  'parser', 'design', 'theme', 'color', 'colour', 'spacing', 'font', 'css', 'style',
]);
/** Trailing words that don't change what a name holds: `API_KEY_PROD`, `tokenValue`. */
const QUALIFIERS = new Set([
  'value', 'val', 'str', 'string', 'raw', 'plain', 'b64', 'base64', 'enc', 'encoded', 'hex', 'prod', 'production', 'prd', 'dev',
  'development', 'stg', 'staging', 'test', 'testing', 'qa', 'sandbox', 'live', 'local', 'new', 'old', 'current', 'default', 'env', 'override',
]);
/** A bare `key` is everywhere in code (`cacheKey`, `primaryKey`); these words make it a credential. */
const KEY_MODIFIERS = new Set([
  'api', 'secret', 'private', 'access', 'client', 'auth', 'signing', 'sign', 'encryption', 'encrypt', 'master', 'license', 'licence',
  'service', 'account', 'admin', 'write', 'deploy', 'app', 'shared', 'hmac', 'webhook', 'sdk', 'partner', 'merchant', 'consumer',
  'integration', 'management', 'root', 'server', 'subscription', 'session', 'cookie', 'jwt', 'oauth', 'ssh', 'gpg', 'pgp', 'aes', 'crypto', 'cipher',
]);
const PUBLIC_MODIFIERS = new Set(['public', 'publishable', 'pub']);

interface SecretName {
  /** Weak names (a plain `key`) only hide values that look generated. */
  strength: 'strong' | 'weak';
  password: boolean;
}

/** `SERVICE_API_TOKEN`, `secretAccessKey` and `x-api-key` split into the same lowercase words. */
function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function secretName(name: string): SecretName | null {
  const words = nameWords(name);
  let index = words.length - 1;
  while (index > 0 && (QUALIFIERS.has(words[index]) || /^v?\d+$/.test(words[index]))) index--;
  const word = words[index] ?? '';
  // `auth0` is the identity provider, not a credential.
  if (/^auth\d+$/.test(word)) return null;
  const head = word.replace(/\d+$/, '');
  if (!head) return null;
  const modifiers = words.slice(0, index);
  if (head === 'key') {
    if (modifiers.some((modifier) => PUBLIC_MODIFIERS.has(modifier))) return null;
    return { strength: modifiers.some((modifier) => KEY_MODIFIERS.has(modifier)) ? 'strong' : 'weak', password: false };
  }
  if (head === 'token' && modifiers.some((modifier) => NOT_CREDENTIAL_TOKENS.has(modifier))) return null;
  if (SECRET_HEADS.has(head) || SECRET_SUFFIX.test(head)) return { strength: 'strong', password: PASSWORD_HEADS.has(head) || /pass(?:word|wd|phrase)$/.test(head) };
  return null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Enum-like settings such as `same-origin`, `client_credentials` or `Bearer`. */
const WORDY = /^(?:[a-z]+(?:[-_./:+][a-z]+)*|[A-Z][a-z]+(?:[A-Z][a-z]+)*|[A-Z]+(?:_[A-Z]+)*)$/;
const CAMEL_WORDS = /^(?:[a-z]+(?:[A-Z][a-z]+)+|(?:[A-Z][a-z]+)+)$/;
/**
 * Identifiers made of several words (`currentPassword`, `Auth0ClientWrapper`, `SERVICE_API_KEY`) name a variable,
 * a class or a constant. Words need two lowercase letters, which generated tokens rarely line up to give.
 */
const MULTI_WORD_IDENTIFIER =
  /^(?:[a-z][a-z0-9]+(?:[A-Z][a-z]{2,}\d*)+|[a-z0-9]+(?:_[a-z0-9]+)+|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|(?:[A-Z][a-z]{2,}\d*){2,})$/;
const VERSION = /^[~^<>=v]{0,3}\d+(?:\.(?:\d+|x|\*))+(?:[-+][\w.-]+)?$/;
const PLACEHOLDER =
  /^(?:[x*•.…#_-]+|0+|(?:your|my|the)[-_][\w-]*|[\w-]*(?:example|sample|dummy|placeholder|changeme|replaceme|redacted)[\w-]*|secret|password|passwd|token|api[-_]?key|none|null|nil|empty|todo|tbd)$/i;
const TEMPLATE_REFERENCE = /\$\{|\{\{|^\$[\w{(]|^%\w+%$|^</;
const CODE_WORDS =
  /^(?:true|false|null|nil|none|undefined|string|str|bytes|boolean|bool|number|int|integer|float|double|bigint|object|array|record|buffer|void|never|any|unknown|required|optional|await)$/i;
/** Quoted values that are code, not data: `'getToken()'`. */
const CALL = /^[A-Za-z_$][\w$.]*\(.*\)$/;

function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) bits -= (count / value.length) * Math.log2(count / value.length);
  return bits;
}

const charClasses = (value: string) => Number(/[a-z]/.test(value)) + Number(/[A-Z]/.test(value)) + Number(/\d/.test(value));

const isWords = (value: string) => WORDY.test(value) || CAMEL_WORDS.test(value) || MULTI_WORD_IDENTIFIER.test(value);

/**
 * Share of a value made of pronounceable words of three or more letters: high for identifiers such as
 * `CreateProjectRecordUseCase`, low for generated tokens.
 */
function wordCoverage(value: string): number {
  const parts = value.split(/[^A-Za-z]+|(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/);
  const covered = parts.filter((part) => /^[A-Z]?[a-z]{2,}$/.test(part) && /[aeiouy]/i.test(part)).reduce((sum, part) => sum + part.length, 0);
  return covered / value.length;
}

/** Generated tokens mix letters and digits with high entropy; words, paths, UUIDs and slugs don't qualify. */
function looksRandom(value: string, minLength = 16): boolean {
  if (value.length < minLength || UUID.test(value) || /[^A-Za-z0-9+/=_~-]/.test(value)) return false;
  if (isWords(value) || wordCoverage(value) >= 0.6) return false;
  // Slugs like `sample-request-key-123` or `acme-org_example-service`.
  if (value.split(/[-_/]/).filter(Boolean).every((part) => isWords(part) || /^\d{1,6}$/.test(part) || part.length <= 3)) return false;
  const bits = entropy(value);
  if (/\d/.test(value)) return charClasses(value) >= 2 && bits >= 3.5;
  return charClasses(value) === 2 && value.length >= 24 && bits >= 4;
}

function isPath(value: string): boolean {
  return /^(?:\/|~\/|\.\.?\/)/.test(value) && !value.split('/').some((part) => looksRandom(part));
}

/** Bare (unquoted) values are often code: `process.env.API_KEY`, `getToken()`, `String!`. */
function isCodeReference(value: string, name: SecretName, envStyle: boolean): boolean {
  if (/^[!&*@]/.test(value) || /[([{]/.test(value)) return true;
  if (!/^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*[!?]?$/.test(value)) return false;
  const identifier = value.replace(/[!?]$/, '');
  if (identifier.includes('.') || CODE_WORDS.test(identifier)) return true;
  if (envStyle) return false;
  if (name.password) return MULTI_WORD_IDENTIFIER.test(identifier);
  return MULTI_WORD_IDENTIFIER.test(identifier) || wordCoverage(identifier) >= 0.5 || (!/\d/.test(identifier) && identifier.length < 16);
}

function isSecretValue(value: string, name: SecretName, how: { quoted: boolean; envStyle?: boolean }): boolean {
  if (value.includes('«') || /\s/.test(value)) return false;
  if (value.length < (name.password ? 6 : 8)) return false;
  if (/^\d+(?:[.:]\d+)*$/.test(value) || VERSION.test(value) || PLACEHOLDER.test(value) || TEMPLATE_REFERENCE.test(value)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || isPath(value) || CALL.test(value)) return false;
  if (!how.quoted && isCodeReference(value, name, how.envStyle ?? false)) return false;
  if (name.strength === 'weak') return looksRandom(value);
  // Constants and enum values: `'ACCESS_MODE'`, `'same-origin'`, `'tokenValue'`.
  if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(value)) return false;
  if (!name.password && isWords(value)) return false;
  return true;
}

function namedValue(groups: Groups, how: { quoted: boolean; envStyle?: boolean }): boolean {
  const name = secretName(groups.name ?? '');
  return name !== null && isSecretValue(groups.value ?? '', name, how);
}

/** A literal credential, as opposed to a reference or a placeholder. */
const literal = (value: string) => !value.includes('«') && !PLACEHOLDER.test(value) && !TEMPLATE_REFERENCE.test(value);

const SEPARATOR = String.raw`\s{0,8}(?::=|=>|===?|!==?|:(?!\/\/)|=)\s{0,8}`;

const CONTEXT_RULES: ContextRule[] = [
  {
    // Authorization: Bearer|Basic|Token … in headers, curl commands and code.
    pattern:
      /\b(?:proxy-)?authorization\\?["'`]?\s{0,4}[:=]\s{0,4}\\?(?<quote>["'`]?)\s{0,4}(?:(?<scheme>Bearer|Basic|Token|Digest|Bot|ApiKey|Key|SSWS|GenieKey|Negotiate)\s+)?(?<value>[^\s"'`,;|«\\]{8,4096})/gi,
    secret: ({ quote, scheme, value = '' }) =>
      scheme ? literal(value) && !isWords(value) : isSecretValue(value, { strength: 'strong', password: false }, { quoted: Boolean(quote) }),
  },
  {
    pattern: /\bBearer\s+(?<value>[A-Za-z0-9._~+/-]{16,4096}=*)/gi,
    secret: ({ value = '' }) => literal(value) && (looksRandom(value) || value.includes('.')),
  },
  {
    // curl -u user:password
    pattern: /(?:^|\s)(?:-u|--user)(?:\s+|=)["']?[^\s:"'`]{1,256}:(?<value>[^\s"'`]{1,4096})/g,
    secret: ({ value = '' }) => literal(value),
  },
  {
    pattern: /(?<![\w-])--(?<name>[A-Za-z][\w-]{1,60})(?:=|\s+)(?<quote>["']?)(?<value>[^\s"'«-][^\s"'«]{0,4095})/g,
    secret: (groups) => namedValue(groups, { quoted: Boolean(groups.quote) }),
  },
  {
    pattern: /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/?#@"'`«]{0,256}:(?<value>[^\s/?#@"'`«]{1,1024})(?=@)/gi,
    secret: ({ value = '' }) => literal(value),
  },
  {
    // A token as the whole user part: https://<token>@host
    pattern: /\b[a-z][a-z0-9+.-]{1,20}:\/\/(?<value>[A-Za-z0-9_~%+-]{16,1024})(?=@[\w.-])/gi,
    secret: ({ value = '' }) => looksRandom(value),
  },
  {
    // .netrc: machine … login … password …
    pattern: /\blogin\s+\S{1,256}\s+password\s+(?<value>\S{1,4096})/g,
    secret: ({ value = '' }) => literal(value),
  },
  {
    // Name and value in separate fields: Kubernetes env, AWS SSM parameters, CI variables.
    pattern:
      /\b(?:name|key|parameterkey)["']?\s{0,4}[:=]\s{0,4}["']?(?<name>[\w./:-]{1,200})["']?[^{}<>]{1,200}?\b(?:value|parametervalue)["']?\s{0,4}[:=]\s{0,4}(?<quote>["'`]?)(?<value>[^\s"'`,}«]{1,4096})/gi,
    secret: (groups) => namedValue({ ...groups, name: (groups.name ?? '').split(/[/:]/).pop() }, { quoted: Boolean(groups.quote) }),
  },
  {
    pattern: /<(?<name>[A-Za-z_][\w:.-]{0,60})>(?<value>[^<\s«]{6,4096})(?=<\/\k<name>>)/g,
    secret: (groups) => namedValue(groups, { quoted: true }),
  },
  {
    // setHeader('x-api-key', '…'), ['token', '…']; not backticks, which in Markdown separate code spans.
    pattern: /(?<=[([]\s{0,4})(?<q1>["'])(?<name>[A-Za-z_$][\w$.-]{0,80})\k<q1>[ \t]*,[ \t]*(?<q2>["'])(?<value>(?:\\.|(?!\k<q2>)[^\\\n]){1,4096})(?=\k<q2>)/g,
    secret: (groups) => namedValue(groups, { quoted: true }),
  },
  {
    // name = value in code, configuration, diffs and logs; the value may be quoted, unterminated or bare.
    // A name starts after a diff's `-` marker but never inside another name such as `x-api-key`.
    pattern: new RegExp(
      String.raw`(?<![\w$.])(?<![\w$.]-)(?<name>[A-Za-z_$][\w$.-]{0,80})(?:\\?["'\`])?\]?(?<sep>${SEPARATOR})` +
        String.raw`(?:\\?(?<q>["'\`])(?<value>(?:\\.|(?!\k<q>)[^\\\n]){1,4096})(?=\k<q>)|(?<open>["'\`])(?<value2>[^\s"'\`\\«]{1,4096})(?=\s|$)|(?<value3>[^\s"'\`,;)\]}&|<>«]{1,2048}))`,
      'g',
    ),
    // `name=value` without spaces is configuration (.env, .npmrc, query strings), where a bare word is the value itself.
    secret: (groups) =>
      namedValue({ name: groups.name, value: groups.value ?? groups.value2 ?? groups.value3 }, { quoted: groups.value3 === undefined, envStyle: groups.sep === '=' }),
  },
  {
    // A generated-looking token right after a secret word: "API key: …", "token …".
    pattern:
      /\b(?:api[ _-]?key|access[ _-]?key|secret(?:[ _-]?key)?|client[ _-]?secret|token|password|passwd|passphrase|credential|bearer)s?\b[\s:=>"'`-]{1,4}(?:(?:is|was|value)[\s:"'`]{1,3})?(?<value>[A-Za-z0-9_+=~-]{20,512})(?![A-Za-z0-9_+=~/.-])/gi,
    secret: ({ value = '' }) => charClasses(value) === 3 && looksRandom(value, 20) && entropy(value) >= 3.7,
  },
];

function applyContextRule(text: string, rule: ContextRule): string {
  const { pattern } = rule;
  let output = '';
  let copied = 0;
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const groups = match.groups ?? {};
    const value = groups.value ?? groups.value2 ?? groups.value3 ?? '';
    const end = match.index + match[0].length;
    const valueStart = end - value.length;
    if (value && rule.secret(groups)) {
      output += text.slice(copied, valueStart) + REDACTED;
      copied = end;
    } else if (/[?&]/.test(value)) {
      // A URL that isn't a secret can still carry one in its query: `url=https://host/?token=…`.
      pattern.lastIndex = Math.max(valueStart, match.index + 1);
    }
  }
  return output + text.slice(copied);
}

function urlEncoded(value: string): string {
  try {
    return encodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Removes configured secrets and common credential shapes from text shared with other people. */
export function createRedactor(knownSecrets: () => string[]): (value: string) => string {
  return (value: string) => {
    let output = value;
    const known = knownSecrets()
      .flatMap((secret) => [secret, urlEncoded(secret)])
      .sort((a, b) => b.length - a.length);
    for (const secret of known) if (secret && output.includes(secret)) output = output.split(secret).join(REDACTED);
    for (const pattern of TOKEN_PATTERNS) output = output.replace(pattern, REDACTED);
    for (const rule of CONTEXT_RULES) output = applyContextRule(output, rule);
    return output;
  };
}

/** Structured fields are also judged by their key: `{ password: '…' }` in a tool's input. */
export function redactDeep<T>(value: T, redact: (text: string) => string): T {
  if (typeof value === 'string') return redact(value) as T;
  if (Array.isArray(value)) return value.map((entry) => redactDeep(entry, redact)) as T;
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = typeof entry === 'string' && namedValue({ name: key, value: entry }, { quoted: true }) ? REDACTED : redactDeep(entry, redact);
    }
    return result as T;
  }
  return value;
}

/**
 * How much of a streamed text can be published now. More text could still complete a secret in the last
 * word or in an unfinished private key block, so those wait until the word or the block ends.
 */
export function publishableLength(text: string): number {
  const lastSpace = /\s\S*$/.exec(text);
  let end = lastSpace ? lastSpace.index + 1 : 0;
  const begin = text.lastIndexOf('-----BEGIN');
  if (begin >= 0 && begin < end && !text.includes('-----END', begin)) end = begin;
  return end;
}
