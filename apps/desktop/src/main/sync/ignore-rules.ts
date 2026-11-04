import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ignore, { type Ignore } from 'ignore';

/** Never sync temporary files or hidden attachment caches that may contain private copies. */
const ALWAYS_IGNORED = ['.DS_Store', 'node_modules/', '.*-tmp-*', '.*/attachments/', '.cooprompt/', '.git/*.lock', '.git/**/*.lock', '*.swp', '.Trash/', '.git/fsmonitor--daemon/'];

/**
 * Hierarchical .gitignore semantics: every ancestor directory's .gitignore applies, and a file
 * inside an ignored directory stays ignored. `.coopromptignore` at the root adds sync-only rules.
 * Respecting .gitignore keeps secrets such as `.env` on each participant's machine.
 */
export class IgnoreRules {
  private readonly root: string;
  private readonly base = ignore().add(ALWAYS_IGNORED);
  private readonly perDir = new Map<string, Ignore | null>();
  private readonly verdicts = new Map<string, boolean>();

  constructor(root: string) {
    this.root = root;
  }

  invalidate(): void {
    this.perDir.clear();
    this.verdicts.clear();
  }

  isIgnored(rel: string, isDir: boolean): boolean {
    const parts = rel.split('/');
    for (let index = 1; index <= parts.length; index++) {
      const prefix = parts.slice(0, index).join('/');
      if (this.matches(prefix, index < parts.length ? true : isDir)) return true;
    }
    return false;
  }

  private matches(rel: string, isDir: boolean): boolean {
    const key = `${rel}${isDir ? '/' : ''}`;
    const cached = this.verdicts.get(key);
    if (cached !== undefined) return cached;
    let verdict = this.base.ignores(key);
    const parts = rel.split('/');
    for (let index = 0; index < parts.length && !verdict; index++) {
      const rules = this.rulesFor(parts.slice(0, index).join('/'));
      if (rules) verdict = rules.ignores(`${parts.slice(index).join('/')}${isDir ? '/' : ''}`);
    }
    if (this.verdicts.size > 50_000) this.verdicts.clear();
    this.verdicts.set(key, verdict);
    return verdict;
  }

  private rulesFor(dir: string): Ignore | null {
    if (this.perDir.has(dir)) return this.perDir.get(dir)!;
    const files = dir === '' ? ['.gitignore', '.coopromptignore'] : ['.gitignore'];
    let rules: Ignore | null = null;
    for (const file of files) {
      try {
        const content = readFileSync(join(this.root, dir, file), 'utf8');
        rules = (rules ?? ignore()).add(content);
      } catch {
        // no rules at this level
      }
    }
    this.perDir.set(dir, rules);
    return rules;
  }
}
