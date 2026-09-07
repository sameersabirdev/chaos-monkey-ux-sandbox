#!/usr/bin/env node
/**
 * install.mjs — copy this skill into an agent's skills directory.
 *
 *   node install.mjs                     -> ~/.claude/skills/chaos-monkey-ux-sandbox
 *   node install.mjs --project /path     -> /path/.claude/skills/chaos-monkey-ux-sandbox
 *   node install.mjs --dir /custom/path  -> /custom/path/chaos-monkey-ux-sandbox
 *   node install.mjs --uninstall
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);
const arg = (n, d = null) => { const i = args.indexOf(n); return i > -1 ? args[i + 1] : d; };
const HERE = import.meta.dirname;
const NAME = 'chaos-monkey-ux-sandbox';
const SOURCE = path.join(HERE, 'skills', NAME);

if (!fs.existsSync(path.join(SOURCE, 'SKILL.md'))) {
  console.error(`install: SKILL.md not found under ${SOURCE} — run this from the repo root.`);
  process.exit(2);
}

const project = arg('--project');
const custom = arg('--dir');
const target = custom
  ? path.resolve(custom, NAME)
  : project
    ? path.resolve(project, '.claude', 'skills', NAME)
    : path.join(os.homedir(), '.claude', 'skills', NAME);

if (args.includes('--uninstall')) {
  if (!fs.existsSync(target)) { console.log(`Nothing installed at ${target}`); process.exit(0); }
  fs.rmSync(target, { recursive: true, force: true });
  console.log(`Removed ${target}`);
  process.exit(0);
}

if (fs.existsSync(target) && !args.includes('--force')) {
  console.error(`install: ${target} already exists. Re-run with --force to overwrite.`);
  process.exit(1);
}

fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.cpSync(SOURCE, target, { recursive: true });

const count = (function walk(d) {
  return fs.readdirSync(d, { withFileTypes: true })
    .reduce((n, e) => n + (e.isDirectory() ? walk(path.join(d, e.name)) : 1), 0);
})(target);

console.log(`
  Installed ${NAME}
  -> ${target}   (${count} files)

  Next:
    - Claude Code picks it up on the next session; ask it to use "${NAME}".
    - Other agents: point your AGENTS.md at ${target}/SKILL.md (see AGENTS.md here).
    - This skill needs Playwright in the project under test:
        npm i -D playwright && npx playwright install chromium
`);
