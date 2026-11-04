#!/usr/bin/env node
// Exposes a locally running CooPrompt server through a Cloudflare quick tunnel (no account needed).
// Usage: npm run share            (tunnels http://127.0.0.1:4317)
//        PORT=5000 npm run share
import { spawn } from 'node:child_process';

const port = process.env.PORT ?? '4317';
const child = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
let announced = false;
const onData = (chunk) => {
  const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(chunk.toString());
  if (match && !announced) {
    announced = true;
    console.log(`\nURL pública del servidor de CooPrompt: ${match[0]}\nCompartila con tu colega (Ctrl+C para cerrar el túnel).\n`);
  }
};
child.stdout.on('data', onData);
child.stderr.on('data', onData);
child.on('error', () => {
  console.error('No encontré cloudflared. Instalalo con: brew install cloudflared');
  process.exit(1);
});
child.on('exit', (code) => process.exit(code ?? 0));
process.on('SIGINT', () => child.kill('SIGINT'));
