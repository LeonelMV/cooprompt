/**
 * Connectors that work with one click. Remote ones are official MCP servers: "oauth" ones support dynamic
 * client registration, "open" ones need no account, and "token" ones take a personal token header instead.
 * Local ones run on this computer through npx, so they need Node.js, except the ones bundled with CooPrompt.
 */
export interface RemoteEntry {
  id: string;
  name: string;
  url: string;
  transport: 'http' | 'sse';
  auth: 'oauth' | 'open' | 'token';
  /** For "token" entries: the header to fill in and where to get the token. */
  token?: { header: string; prefix: string; help: string };
}

export interface LocalEntry {
  id: string;
  name: string;
  description: string;
  transport: 'stdio';
  command: string;
  args: string[];
  /** Something else to install first, e.g. a browser extension. */
  setup?: { label: string; url: string };
  /** Comes with CooPrompt, so it doesn't need Node.js. It can take arguments after its own. */
  bundled?: boolean;
  argsHint?: { placeholder: string; help: string };
}

export type DirectoryEntry = RemoteEntry | LocalEntry;

export const CONNECTOR_DIRECTORY: DirectoryEntry[] = [
  {
    id: 'playwright',
    name: 'Playwright (test browser)',
    description: 'Opens its own Chrome window where the agent clicks, types and takes screenshots to test your app.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
  },
  {
    id: 'playwright-chrome',
    name: 'Playwright in your Chrome',
    description: 'Uses your own Chrome with your sessions; you choose which tab the agent can control.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest', '--extension'],
    setup: { label: 'Install the Chrome extension', url: 'https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm' },
  },
  {
    id: 'chrome-devtools',
    name: 'Chrome DevTools',
    description: 'Console, network requests and performance of a Chrome page, for debugging.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'chrome-devtools-mcp@latest'],
  },
  { id: 'notion', name: 'Notion', url: 'https://mcp.notion.com/mcp', transport: 'http', auth: 'oauth' },
  { id: 'atlassian', name: 'Jira & Confluence', url: 'https://mcp.atlassian.com/v2/mcp', transport: 'http', auth: 'oauth' },
  { id: 'linear', name: 'Linear', url: 'https://mcp.linear.app/mcp', transport: 'http', auth: 'oauth' },
  {
    id: 'github',
    name: 'GitHub',
    url: 'https://api.githubcopilot.com/mcp/',
    transport: 'http',
    auth: 'token',
    token: { header: 'Authorization', prefix: 'Bearer ', help: 'github.com → Settings → Developer settings → Personal access tokens' },
  },
  { id: 'figma', name: 'Figma', url: 'https://mcp.figma.com/mcp', transport: 'http', auth: 'oauth' },
  { id: 'sentry', name: 'Sentry', url: 'https://mcp.sentry.dev/mcp', transport: 'http', auth: 'oauth' },
  { id: 'datadog', name: 'Datadog (US1)', url: 'https://mcp.datadoghq.com/v1/mcp', transport: 'http', auth: 'oauth' },
  { id: 'statsig', name: 'Statsig', url: 'https://api.statsig.com/v1/mcp', transport: 'http', auth: 'oauth' },
  { id: 'amplitude', name: 'Amplitude', url: 'https://mcp.amplitude.com/mcp', transport: 'http', auth: 'oauth' },
  { id: 'posthog', name: 'PostHog', url: 'https://mcp.posthog.com/mcp', transport: 'http', auth: 'oauth' },
  { id: 'asana', name: 'Asana', url: 'https://mcp.asana.com/sse', transport: 'sse', auth: 'oauth' },
  { id: 'monday', name: 'monday.com', url: 'https://mcp.monday.com/mcp', transport: 'http', auth: 'oauth' },
  { id: 'clickup', name: 'ClickUp', url: 'https://mcp.clickup.com/mcp', transport: 'http', auth: 'oauth' },
  { id: 'airtable', name: 'Airtable', url: 'https://mcp.airtable.com/mcp', transport: 'http', auth: 'oauth' },
  { id: 'miro', name: 'Miro', url: 'https://mcp.miro.com/', transport: 'http', auth: 'oauth' },
  { id: 'canva', name: 'Canva', url: 'https://mcp.canva.com/mcp', transport: 'http', auth: 'oauth' },
  { id: 'intercom', name: 'Intercom', url: 'https://mcp.intercom.com/mcp', transport: 'http', auth: 'oauth' },
  { id: 'zapier', name: 'Zapier', url: 'https://mcp.zapier.com/api/mcp/mcp', transport: 'http', auth: 'oauth' },
  { id: 'vercel', name: 'Vercel', url: 'https://mcp.vercel.com', transport: 'http', auth: 'oauth' },
  { id: 'supabase', name: 'Supabase', url: 'https://mcp.supabase.com/mcp', transport: 'http', auth: 'oauth' },
  { id: 'neon', name: 'Neon', url: 'https://mcp.neon.tech/mcp', transport: 'http', auth: 'oauth' },
  { id: 'prisma', name: 'Prisma', url: 'https://mcp.prisma.io/mcp', transport: 'http', auth: 'oauth' },
  { id: 'stripe', name: 'Stripe', url: 'https://mcp.stripe.com', transport: 'http', auth: 'oauth' },
  { id: 'paypal', name: 'PayPal', url: 'https://mcp.paypal.com/mcp', transport: 'http', auth: 'oauth' },
  { id: 'square', name: 'Square', url: 'https://mcp.squareup.com/sse', transport: 'sse', auth: 'oauth' },
  { id: 'webflow', name: 'Webflow', url: 'https://mcp.webflow.com/mcp', transport: 'http', auth: 'oauth' },
  { id: 'wix', name: 'Wix', url: 'https://mcp.wix.com/mcp', transport: 'http', auth: 'oauth' },
  { id: 'jam', name: 'Jam', url: 'https://mcp.jam.dev/mcp', transport: 'http', auth: 'oauth' },
  { id: 'context7', name: 'Context7 (library docs)', url: 'https://mcp.context7.com/mcp', transport: 'http', auth: 'open' },
  { id: 'huggingface', name: 'Hugging Face', url: 'https://huggingface.co/mcp', transport: 'http', auth: 'open' },
  { id: 'cloudflare-docs', name: 'Cloudflare Docs', url: 'https://docs.mcp.cloudflare.com/mcp', transport: 'http', auth: 'open' },
];
