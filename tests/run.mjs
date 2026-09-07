#!/usr/bin/env node
/**
 * run.mjs — self-tests for the chaos-monkey-ux-sandbox skill.
 *
 *   node tests/run.mjs            full suite (needs playwright)
 *   node tests/run.mjs --fast     static checks only, no browser
 *
 * The headline test runs the same attacks against two fixtures:
 *   broken-app.html  — must produce blocking findings (the detectors work)
 *   fixed-app.html   — must produce none (no false positives)
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, '..');
const SKILL = path.join(ROOT, 'skills', 'chaos-monkey-ux-sandbox');
const FAST = process.argv.includes('--fast');

let passed = 0, failed = 0;
const results = [];
function check(name, fn) {
  try {
    const detail = fn();
    passed++; results.push(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (e) {
    failed++; results.push(`  FAIL  ${name}\n          ${e.message}`);
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

// ---------------------------------------------------------------- static ----
check('SKILL.md exists with valid frontmatter', () => {
  const src = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
  const m = /^---\n([\s\S]*?)\n---/.exec(src);
  assert(m, 'no YAML frontmatter block');
  assert(/^name:\s*chaos-monkey-ux-sandbox\s*$/m.test(m[1]), 'name must match the directory');
  const desc = /^description:\s*(.+)$/m.exec(m[1]);
  assert(desc, 'no description');
  assert(desc[1].length > 60 && desc[1].length < 1024, `description length ${desc[1].length}`);
  return `${desc[1].length}-char description`;
});

check('every script parses', () => {
  const files = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (e.name.endsWith('.mjs')) files.push(p);
  });
  walk(path.join(SKILL, 'scripts'));
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    assert(r.status === 0, `${path.basename(f)}: ${r.stderr.split('\n')[0]}`);
  }
  return `${files.length} scripts`;
});

check('every attack module exports a valid descriptor', () => {
  const dir = path.join(SKILL, 'scripts', 'attacks');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.mjs'));
  assert(files.length >= 7, `expected 7+ attacks, found ${files.length}`);
  return `${files.length} attacks`;
});

check('remedy ids in detectors all exist in the scaffold catalog or docs', () => {
  const det = fs.readFileSync(path.join(SKILL, 'scripts', 'detectors.mjs'), 'utf8');
  const attacksDir = path.join(SKILL, 'scripts', 'attacks');
  let attackSrc = '';
  for (const f of fs.readdirSync(attacksDir)) attackSrc += fs.readFileSync(path.join(attacksDir, f), 'utf8');
  const used = new Set();
  for (const src of [det, attackSrc]) {
    for (const m of src.matchAll(/remedy:\s*'([a-z-]+)'/g)) used.add(m[1]);
    for (const m of src.matchAll(/push\('(?:crash|stuck|silent|degraded|note)',\s*'([a-z-]+)'/g)) used.add(m[1]);
  }
  used.delete('none');
  const docs = fs.readFileSync(path.join(SKILL, 'references', 'remediation.md'), 'utf8');
  const missing = [...used].filter((r) => !docs.includes(`## \`${r}\``));
  assert(!missing.length, `undocumented remedies: ${missing.join(', ')}`);
  return `${used.size} remedies documented`;
});

check('scaffold writes components into a project', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chaos-scaffold-'));
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"name":"tmp"}');
  fs.writeFileSync(path.join(tmp, 'tsconfig.json'), '{"compilerOptions":{"paths":{"@/*":["./src/*"]}}}');
  const r = spawnSync(process.execPath,
    [path.join(SKILL, 'scripts', 'scaffold.mjs'), '--root', tmp, '--components', 'query-boundary,empty-state'],
    { encoding: 'utf8' });
  assert(r.status === 0, `exit ${r.status}: ${r.stderr.slice(0, 200)}`);
  // tsconfig maps "@/*" -> ./src/*, so the components must land under src/.
  const dir = path.join(tmp, 'src', 'components', 'resilience');
  assert(fs.existsSync(dir), `expected src/components/resilience (alias target), stdout: ${r.stdout.slice(-300)}`);
  const written = fs.readdirSync(dir);
  // query-boundary must pull in its ErrorBoundary dependency
  assert(written.includes('ErrorBoundary.tsx'), `dependency not resolved: ${written.join(', ')}`);
  assert(written.includes('QueryErrorBoundary.tsx'), 'QueryErrorBoundary.tsx missing');
  assert(written.includes('EmptyState.tsx'), 'EmptyState.tsx missing');
  fs.rmSync(tmp, { recursive: true, force: true });
  return written.join(', ');
});

check('scaffold refuses to overwrite existing files', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chaos-scaffold2-'));
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"name":"tmp"}');
  const dir = path.join(tmp, 'components', 'resilience');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'EmptyState.tsx'), 'ORIGINAL');
  spawnSync(process.execPath,
    [path.join(SKILL, 'scripts', 'scaffold.mjs'), '--root', tmp, '--components', 'empty-state'],
    { encoding: 'utf8' });
  const after = fs.readFileSync(path.join(dir, 'EmptyState.tsx'), 'utf8');
  assert(after === 'ORIGINAL', 'existing file was overwritten');
  fs.rmSync(tmp, { recursive: true, force: true });
  return 'preserved';
});

check('refuses to attack a non-local URL without --allow-remote', () => {
  const r = spawnSync(process.execPath,
    [path.join(SKILL, 'scripts', 'chaos.mjs'), '--url', 'https://example.com'],
    { encoding: 'utf8' });
  assert(r.status === 2, `expected exit 2, got ${r.status}`);
  assert(/not local/i.test(r.stderr), `unexpected message: ${r.stderr.slice(0, 120)}`);
  return 'guard holds';
});

// --------------------------------------------------------------- browser ----
async function hasPlaywright() {
  const { loadPlaywright } = await import(pathToFileURL(path.join(SKILL, 'scripts', 'load-playwright.mjs')).href);
  return !!(await loadPlaywright([ROOT, process.cwd()]));
}

function serve(app, port) {
  const p = spawn(process.execPath, [path.join(HERE, 'serve.mjs'), '--app', app, '--port', String(port)], { stdio: 'ignore' });
  return p;
}
async function waitForServer(port, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { const r = await fetch(`http://localhost:${port}/api/health`); if (r.ok) return true; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}
function runChaos(port, outDir, only = 'baseline,api-failure,race,payload') {
  const r = spawnSync(process.execPath, [
    path.join(SKILL, 'scripts', 'chaos.mjs'),
    '--url', `http://localhost:${port}`,
    '--only', only,
    '--intensity', 'light',
    '--project-root', ROOT,
    '--out', outDir,
    '--json',
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const jsonStart = r.stdout.indexOf('{');
  assert(jsonStart > -1, `no JSON report: ${(r.stderr || r.stdout).slice(0, 300)}`);
  return JSON.parse(r.stdout.slice(jsonStart));
}

if (!FAST && await hasPlaywright()) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chaos-e2e-'));
  const broken = serve('broken', 4183);
  const fixed = serve('fixed', 4184);
  try {
    assert(await waitForServer(4183), 'broken fixture server did not start');
    assert(await waitForServer(4184), 'fixed fixture server did not start');

    let brokenReport, fixedReport;

    check('broken fixture produces blocking findings', () => {
      brokenReport = runChaos(4183, path.join(tmp, 'broken'));
      assert(brokenReport.blocking > 5, `only ${brokenReport.blocking} blocking findings`);
      return `${brokenReport.blocking} blocking`;
    });

    check('broken fixture: baseline stays clean', () => {
      const base = brokenReport.findings.filter((f) => f.attack === 'baseline');
      assert(base.length === 0, `baseline produced ${base.length} findings: ${base.map((f) => f.title).join('; ')}`);
      return 'happy path clean';
    });

    check('broken fixture: XSS via innerHTML is caught', () => {
      const xss = brokenReport.findings.find((f) => /markup executed/i.test(f.title));
      assert(xss, 'XSS finding missing');
      return xss.severity;
    });

    check('broken fixture: double submit is caught', () => {
      const dbl = brokenReport.findings.find((f) => /double submit/i.test(f.title));
      assert(dbl, 'double-submit finding missing');
      return dbl.evidence.slice(0, 40);
    });

    check('hardened fixture produces NO blocking findings', () => {
      fixedReport = runChaos(4184, path.join(tmp, 'fixed'));
      assert(fixedReport.blocking === 0,
        `${fixedReport.blocking} false positive(s): ` +
        fixedReport.findings.filter((f) => ['crash', 'stuck', 'silent'].includes(f.severity))
          .map((f) => `${f.attack}/${f.step}: ${f.title}`).join(' | '));
      return `${fixedReport.findings.length} non-blocking note(s)`;
    });

    check('--compare reports fixed findings', () => {
      const prevPath = path.join(tmp, 'broken', 'report.json');
      const r = spawnSync(process.execPath, [
        path.join(SKILL, 'scripts', 'chaos.mjs'),
        '--url', 'http://localhost:4184', '--only', 'baseline,api-failure',
        '--intensity', 'light', '--project-root', ROOT,
        '--out', path.join(tmp, 'cmp'), '--compare', prevPath, '--json',
      ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      const j = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
      assert(j.comparison && !j.comparison.error, `comparison failed: ${j.comparison?.error}`);
      assert(j.comparison.fixed.length > 0, 'no findings reported as fixed');
      return `${j.comparison.fixed.length} fixed, ${j.comparison.remaining.length} remaining`;
    });

    check('--emit-test writes a runnable spec', () => {
      const spec = path.join(tmp, 'chaos.spec.ts');
      spawnSync(process.execPath, [
        path.join(SKILL, 'scripts', 'chaos.mjs'), '--url', 'http://localhost:4184',
        '--only', 'baseline', '--project-root', ROOT, '--out', path.join(tmp, 'emit'),
        '--emit-test', spec, '--json',
      ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
      assert(fs.existsSync(spec), 'spec file not written');
      const src = fs.readFileSync(spec, 'utf8');
      assert(src.includes("@playwright/test"), 'spec missing playwright import');
      assert((src.match(/\btest\(/g) || []).length >= 4, 'spec has too few tests');
      return `${(src.match(/\btest\(/g) || []).length} tests`;
    });
  } finally {
    broken.kill(); fixed.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
} else if (!FAST) {
  results.push('  SKIP  browser tests — playwright not installed (npm i -D playwright && npx playwright install chromium)');
}

// ---------------------------------------------------------------- report ----
console.log(`\n  chaos-monkey-ux-sandbox — self-tests\n  ${'-'.repeat(62)}`);
results.forEach((r) => console.log(r));
console.log(`  ${'-'.repeat(62)}`);
console.log(`  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
