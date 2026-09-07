#!/usr/bin/env node
/**
 * scaffold.mjs — write the remediation components into the target project.
 *
 * Usage:
 *   node scaffold.mjs --root <projectRoot> --components error-boundary,empty-state
 *   node scaffold.mjs --root <projectRoot> --all [--dir src/components/resilience]
 *   node scaffold.mjs --list
 *
 * Never overwrites an existing file (pass --force to replace).
 * Detects TS vs JS and the project's import alias, and prints wiring instructions.
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = (n, d = null) => { const i = args.indexOf(n); return i > -1 ? args[i + 1] : d; };
const flag = (n) => args.includes(n);
const HERE = import.meta.dirname;
const TPL = path.resolve(HERE, '../assets/templates');

const CATALOG = {
  'error-boundary': { file: 'ErrorBoundary.tsx', remedy: 'error-boundary', needs: [], wire: 'Wrap each independently-failing widget: <ErrorBoundary label="revenue chart"><Chart /></ErrorBoundary>. Not the app root.' },
  'query-boundary': { file: 'QueryErrorBoundary.tsx', remedy: 'query-boundary', needs: ['error-boundary'], wire: 'Requires @tanstack/react-query and throwOnError: true on the queries it guards.' },
  'empty-state': { file: 'EmptyState.tsx', remedy: 'empty-state', needs: [], wire: 'Render for [] / null / no-results. Never render it after a failed request — use ErrorState there.' },
  'timeout-guard': { file: 'useAsyncGuard.ts', remedy: 'timeout-guard', needs: [], wire: 'Replace bare useEffect+fetch. Skip it if the project already uses React Query or SWR.' },
  'offline-banner': { file: 'useOnlineStatus.ts', remedy: 'offline-banner', needs: [], wire: 'Refetch on justReconnected; reserve the banner height so it does not shift layout.' },
};

if (flag('--list')) {
  console.log('\n  components:');
  for (const [k, v] of Object.entries(CATALOG)) console.log(`    ${k.padEnd(16)} ${v.file}`);
  console.log('');
  process.exit(0);
}

const ROOT = path.resolve(arg('--root', process.cwd()));
if (!fs.existsSync(path.join(ROOT, 'package.json'))) {
  console.error(`scaffold: no package.json at ${ROOT}`);
  process.exit(2);
}

let requested = flag('--all')
  ? Object.keys(CATALOG)
  : (arg('--components') || '').split(',').map((s) => s.trim()).filter(Boolean);
if (!requested.length) { console.error('scaffold: --components <ids> or --all required (--list to see ids)'); process.exit(2); }

const unknown = requested.filter((r) => !CATALOG[r]);
if (unknown.length) { console.error(`scaffold: unknown component(s): ${unknown.join(', ')}`); process.exit(2); }

// Pull in dependencies (query-boundary needs error-boundary).
const resolved = [];
const addWithDeps = (id) => {
  for (const dep of CATALOG[id].needs) if (!resolved.includes(dep)) addWithDeps(dep);
  if (!resolved.includes(id)) resolved.push(id);
};
requested.forEach(addWithDeps);

// ---- project conventions ---------------------------------------------------
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
const isTS = fs.existsSync(path.join(ROOT, 'tsconfig.json'));

let alias = null;
let aliasBase = null;      // where the alias actually points, e.g. "src"
try {
  const tsconfig = fs.readFileSync(path.join(ROOT, 'tsconfig.json'), 'utf8').replace(/\/\/[^\n]*/g, '');
  const paths = JSON.parse(tsconfig).compilerOptions?.paths || {};
  const entry = Object.keys(paths).find((k) => k.endsWith('/*'));
  if (entry) {
    alias = entry.replace('/*', '');
    const target = (paths[entry] || [])[0];
    if (target) aliasBase = target.replace(/^\.\//, '').replace(/\/\*$/, '') || null;
  }
} catch { /* no tsconfig or unparseable */ }

// Prefer an existing components directory; otherwise follow the alias target, so the
// import path printed below actually resolves.
const targetDir = arg('--dir') || (
  ['src/components', 'components', 'app/components', 'src/app/components']
    .find((d) => fs.existsSync(path.join(ROOT, d)))
  || (aliasBase ? `${aliasBase}/components`
    : fs.existsSync(path.join(ROOT, 'src')) ? 'src/components' : 'components')
) + '/resilience';

const absDir = path.join(ROOT, targetDir);
fs.mkdirSync(absDir, { recursive: true });

// ---- write -----------------------------------------------------------------
const written = [], skipped = [];
for (const id of resolved) {
  const spec = CATALOG[id];
  let source = fs.readFileSync(path.join(TPL, spec.file), 'utf8');
  let outName = spec.file;

  if (!isTS) {
    // Strip the type layer for JS projects. Good enough for these files; review after.
    outName = spec.file.replace(/\.tsx$/, '.jsx').replace(/\.ts$/, '.js');
    source = source
      .replace(/^import type .*$/gm, '')
      .replace(/, type [A-Za-z]+ }/g, ' }')
      .replace(/^(export )?type [A-Za-z]+(<[^>]*>)? = [\s\S]*?;\n/gm, '')
      .replace(/: [A-Za-z_][\w<>\[\]|'", .{}?:()]*(?= = |\)| \{|,|\))/g, '')
      .replace(/ as const/g, '')
      .replace(/<T>|<T,>/g, '');
    source = `/* Types stripped for a JS project — review before committing. */\n${source}`;
  }

  const out = path.join(absDir, outName);
  if (fs.existsSync(out) && !flag('--force')) { skipped.push(path.relative(ROOT, out)); continue; }
  fs.writeFileSync(out, source);
  written.push({ id, path: path.relative(ROOT, out).replace(/\\/g, '/'), wire: spec.wire });
}

// ---- report ----------------------------------------------------------------
const importBase = alias
  ? `${alias}/${targetDir.replace(/^src\//, '')}`
  : `./${targetDir}`;

console.log(`\n  SCAFFOLD  ${ROOT}`);
console.log(`  ${'-'.repeat(64)}`);
console.log(`  language: ${isTS ? 'TypeScript' : 'JavaScript'}   alias: ${alias || 'none'}   dir: ${targetDir}`);
if (written.length) {
  console.log('\n  written:');
  for (const w of written) {
    console.log(`    ${w.path}`);
    console.log(`      import from '${importBase}/${path.basename(w.path).replace(/\.(tsx?|jsx?)$/, '')}'`);
    console.log(`      ${w.wire}`);
  }
}
if (skipped.length) {
  console.log('\n  skipped (already exist — use --force to replace):');
  skipped.forEach((s) => console.log(`    ${s}`));
}

const missing = [];
if (resolved.includes('query-boundary') && !deps['@tanstack/react-query']) missing.push('@tanstack/react-query');
if (missing.length) console.log(`\n  ! missing dependency: ${missing.join(', ')}`);

console.log('\n  Next: wire each component at the RIGHT DEPTH — one boundary per');
console.log('  independently-failing widget, not one at the app root. Then re-run chaos.mjs.\n');
