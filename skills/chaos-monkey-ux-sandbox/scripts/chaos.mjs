#!/usr/bin/env node
/**
 * chaos.mjs — adversarial UX harness. Breaks the UI on purpose, reports what broke.
 *
 * Setup: npm i -D playwright && npx playwright install chromium
 *
 * Usage:
 *   node chaos.mjs --url http://localhost:3000/dashboard
 *   node chaos.mjs --url <url> --only network,payload --intensity brutal --headed
 *   node chaos.mjs --url <url> --compare .chaos/report.json      # prove fixes
 *   node chaos.mjs --list
 *
 * Exit codes: 0 = survived (no crash/stuck/silent), 1 = findings, 2 = setup problem.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { installProbe, resetProbe, inspect, assess } from './detectors.mjs';
import { loadPlaywright, INSTALL_HINT } from './load-playwright.mjs';

const args = process.argv.slice(2);
const arg = (n, d = null) => { const i = args.indexOf(n); return i > -1 ? args[i + 1] : d; };
const flag = (n) => args.includes(n);
const HERE = import.meta.dirname;
const ATTACK_DIR = path.join(HERE, 'attacks');

const attackFiles = fs.existsSync(ATTACK_DIR)
  ? fs.readdirSync(ATTACK_DIR).filter((f) => f.endsWith('.mjs')).sort()
  : [];
const attacks = [];
for (const f of attackFiles) {
  const mod = await import(pathToFileURL(path.join(ATTACK_DIR, f)).href);
  if (mod.default?.id) attacks.push(mod.default);
}
attacks.sort((a, b) => (a.order ?? 50) - (b.order ?? 50));

if (flag('--list')) {
  console.log('\n  attacks:');
  for (const a of attacks) console.log(`    ${a.id.padEnd(12)} ${a.description}`);
  console.log('');
  process.exit(0);
}

const URL_ = arg('--url');
if (!URL_) { console.error('chaos: --url required'); process.exit(2); }

// Safety: never point this at production or a third party.
const host = (() => { try { return new URL(URL_).hostname; } catch { return ''; } })();
const isLocal = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|.*\.local|.*\.localhost)$/i.test(host);
if (!isLocal && !flag('--allow-remote')) {
  console.error(`chaos: ${host} is not local. Chaos attacks mutate state and send hostile input.\n` +
    '       Re-run with --allow-remote only for a staging environment you are authorized to break.');
  process.exit(2);
}

const OUT = path.resolve(arg('--out', '.chaos'));
const INTENSITY = arg('--intensity', 'normal');
const SELECTOR = arg('--selector', null);
const ONLY = (arg('--only') || '').split(',').filter(Boolean);
const SKIP = (arg('--skip') || '').split(',').filter(Boolean);
const AS_JSON = flag('--json');
const COMPARE = arg('--compare');
const EMIT_TEST = arg('--emit-test');
const TIMEOUT = +arg('--timeout', '45000');
// How long to wait for networkidle before giving up on it. Sites with analytics or
// polling never go idle, so a long value here is pure dead time on every step.
const IDLE_TIMEOUT = +arg('--idle-timeout', '3000');

// Resolve Playwright from the project under test — the skill usually lives elsewhere.
const PROJECT_ROOT = arg('--project-root', process.cwd());
const pw = await loadPlaywright([PROJECT_ROOT]);
if (!pw) { console.error(`chaos: ${INSTALL_HINT}`); process.exit(2); }
const { chromium } = pw;

const selected = attacks.filter((a) => (!ONLY.length || ONLY.includes(a.id)) && !SKIP.includes(a.id));
if (!selected.length) { console.error(`chaos: no attacks matched (--list to see ids)`); process.exit(2); }

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(path.join(OUT, 'screenshots'), { recursive: true });

const T0 = Date.now();
const elapsed = () => ((Date.now() - T0) / 1000).toFixed(1).padStart(6);
const log = (msg) => { if (!AS_JSON) console.log(msg); };
/** Timestamped progress line. Long runs must never look hung. */
const step = (msg) => { if (!AS_JSON) console.log(`  [${elapsed()}s] ${msg}`); };
const findings = [];
let baseline = null;

let browser;
try {
  browser = await chromium.launch({ headless: !flag('--headed') });
} catch (e) {
  const needsDownload = /Executable doesn't exist|playwright install/i.test(String(e && e.message));
  console.error(`chaos: could not launch Chromium.\n  ${String(e && e.message).split('\n')[0]}`);
  if (needsDownload) console.error('  Run: npx playwright install chromium');
  process.exit(2);
}
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  // Deterministic locale/timezone so formatting bugs are reproducible.
  locale: 'en-US', timezoneId: 'UTC',
});
context.setDefaultTimeout(TIMEOUT);

let page = await context.newPage();
await installProbe(page);

let pageCrashed = false;
const watchPage = (p) => {
  p.on('crash', () => { pageCrashed = true; });
  p.on('close', () => { if (!closingDown) pageCrashed = true; });
};
let closingDown = false;
watchPage(page);

/** A killed tab IS a finding — record it once per attack, then hand back a live page. */
const crashedAttacks = new Set();
async function revivePage(attackId, stepId) {
  if (page && !page.isClosed()) return false;
  // One renderer death cascades: the step that killed it, the aborted module, and the
  // post-attack check all see a dead tab. Report the root event, not its echoes.
  if (crashedAttacks.has(attackId)) {
    log('      (tab still dead - restarting page, already reported)');
  } else {
    crashedAttacks.add(attackId);
    findings.push({
      attack: attackId, step: stepId, severity: 'crash', remedy: 'payload-guard',
      title: 'Browser tab was killed',
      evidence: 'The renderer process died (out of memory, or an unbounded render). Everything after this point in the attack ran on a fresh tab.',
    });
    log('      crash  browser tab killed - restarting page');
  }
  try { page = await context.newPage(); await installProbe(page); watchPage(page); ctx.page = page; }
  catch { /* context itself is gone; the loop below will stop */ }
  pageCrashed = false;
  return true;
}

/** Shared helpers handed to every attack module. */
const ctx = {
  page, context, browser, url: URL_, intensity: INTENSITY, selector: SELECTOR, timeout: TIMEOUT, out: OUT, log,

  /** True when the tab is gone — every helper below no-ops rather than throwing. */
  get dead() { return !page || page.isClosed(); },

  /** Fresh load with all routes cleared. */
  async reload() {
    if (this.dead) return;
    await context.unrouteAll?.({ behavior: 'ignoreErrors' }).catch(() => {});
    await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: TIMEOUT }).catch(() => {});
    await this.settle();
    await resetProbe(page);
  },

  /**
   * Wait for the app to stop working, bounded.
   *
   * networkidle is best-effort: sites with analytics beacons, polling, or open
   * websockets never reach it, so this timeout is paid in full on every step.
   * Keep it short — the fixed wait below is what actually lets the UI settle.
   */
  async settle(ms = 1200) {
    if (this.dead) return;
    await page.waitForLoadState('networkidle', { timeout: IDLE_TIMEOUT }).catch(() => {});
    await page.waitForTimeout(ms).catch(() => {});
  },

  /** Record a finding an attack module detected directly (not via the detectors). */
  async record({ attack, step, severity, remedy, title, evidence }) {
    const shot = path.join(OUT, 'screenshots', `${attack}-${step.replace(/[^a-z0-9]+/gi, '-')}.png`.toLowerCase());
    if (!this.dead) await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
    findings.push({ attack, step, severity, remedy, title, evidence, screenshot: path.relative(OUT, shot) });
    log(`      ${severity}  ${title}`);
  },

  /** Announce what is about to happen, so a slow step never looks like a hang. */
  progress(msg) { step(`    ${msg}`); },

  /** Record findings for one step. */
  async check(attack, stepName, opts = {}) {
    const startedAt = Date.now();
    if (this.dead) {
      await revivePage(attack, stepName);
      return { snap: {}, results: [] };
    }
    const snap = await inspect(page);
    const results = assess(snap, { attack, step: stepName, baseline, ...opts });
    if (results.length) {
      const shot = path.join(OUT, 'screenshots', `${attack}-${stepName.replace(/[^a-z0-9]+/gi, '-')}.png`.toLowerCase());
      await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
      results.forEach((r) => { r.screenshot = path.relative(OUT, shot); });
    }
    findings.push(...results);
    const verdict = results.length ? results.map((r) => r.severity).join(',') : 'ok';
    const took = ((Date.now() - startedAt) / 1000).toFixed(1);
    step(`    ${verdict === 'ok' ? 'ok  ' : verdict.toUpperCase()}  ${stepName}  (${took}s)`);
    return { snap, results };
  },

  /** Click things that look interactive, tolerating detachment. */
  async pokeAround(limit = 6) {
    if (this.dead) return 0;
    const sel = SELECTOR ? `${SELECTOR} button, ${SELECTOR} [role="tab"], ${SELECTOR} a[href]`
      : 'button:not([disabled]), [role="tab"], [role="button"], summary';
    const els = await page.$$(sel);
    let n = 0;
    for (const el of els.slice(0, limit)) {
      try {
        if (!(await el.isVisible())) continue;
        await el.click({ timeout: 1200, noWaitAfter: true });
        n++;
        await page.waitForTimeout(150);
      } catch { /* detached or covered — expected under chaos */ }
    }
    return n;
  },
};

// ------------------------------------------------------------------- run ----
log(`\n  CHAOS MONKEY  ${URL_}  [intensity: ${INTENSITY}]`);
log(`  ${'-'.repeat(68)}`);

const started = Date.now();
try {
  await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
} catch (e) {
  console.error(`chaos: cannot load ${URL_} — is the dev server running?\n  ${e.message}`);
  await browser.close();
  process.exit(2);
}
await ctx.settle();
baseline = await inspect(page);
ctx.baseline = baseline;

if (baseline.overlayText || baseline.rootChildren === 0) {
  log('  ! baseline is already broken — findings below may be noise. Fix the happy path first.');
}

const timings = [];
let attackIndex = 0;

for (const attack of selected) {
  attackIndex++;
  const attackStart = Date.now();
  log('');
  step(`[${attackIndex}/${selected.length}] ${attack.id} — ${attack.description}`);
  const before = findings.length;
  try {
    await attack.run(ctx);
  } catch (e) {
    const msg = String(e && e.message);
    // A dead tab is the app's fault, not the harness's — classify it as such.
    if (/closed|crash|Target page/i.test(msg) || ctx.dead) {
      await revivePage(attack.id, 'aborted');
    } else {
      findings.push({
        attack: attack.id, step: 'harness', severity: 'note', remedy: 'none',
        title: 'Attack module aborted', evidence: msg.slice(0, 300),
      });
      log(`      harness error: ${msg.slice(0, 120)}`);
    }
  }
  await revivePage(attack.id, 'post-attack');
  const attackSecs = (Date.now() - attackStart) / 1000;
  timings.push({ attack: attack.id, seconds: +attackSecs.toFixed(1), findings: findings.length - before });
  step(`  done: ${findings.length - before} finding(s) in ${attackSecs.toFixed(1)}s`);
  try { await ctx.reload(); } catch { await revivePage(attack.id, 'post-attack-reload'); }
}

closingDown = true;
await browser.close().catch(() => {});
const durationMs = Date.now() - started;

// -------------------------------------------------------------- reporting --
const RANK = { crash: 0, stuck: 1, silent: 2, degraded: 3, note: 4 };
findings.sort((a, b) => (RANK[a.severity] ?? 9) - (RANK[b.severity] ?? 9));

const counts = findings.reduce((acc, f) => { acc[f.severity] = (acc[f.severity] || 0) + 1; return acc; }, {});
const blocking = (counts.crash || 0) + (counts.stuck || 0) + (counts.silent || 0);

const key = (f) => `${f.attack}|${f.step}|${f.title}`;
let comparison = null;
if (COMPARE) {
  try {
    const prev = JSON.parse(fs.readFileSync(path.resolve(COMPARE), 'utf8'));
    const prevKeys = new Set((prev.findings || []).map(key));
    const nowKeys = new Set(findings.map(key));
    comparison = {
      fixed: (prev.findings || []).filter((f) => !nowKeys.has(key(f))).map((f) => `${f.severity}: ${f.title} (${f.attack}/${f.step})`),
      remaining: findings.filter((f) => prevKeys.has(key(f))).map((f) => `${f.severity}: ${f.title} (${f.attack}/${f.step})`),
      new: findings.filter((f) => !prevKeys.has(key(f))).map((f) => `${f.severity}: ${f.title} (${f.attack}/${f.step})`),
    };
  } catch (e) { comparison = { error: `could not read ${COMPARE}: ${e.message}` }; }
}

const report = {
  url: URL_, intensity: INTENSITY, ranAt: new Date().toISOString(), durationMs,
  attacks: selected.map((a) => a.id),
  timings,
  baseline: { interactive: baseline.interactive, domNodes: baseline.domNodes, bodyTextLength: baseline.bodyTextLength },
  counts, blocking, findings, comparison,
};

const reportPath = path.join(OUT, 'report.json');
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

if (EMIT_TEST) {
  const spec = renderSpec(URL_, selected.map((a) => a.id));
  fs.mkdirSync(path.dirname(path.resolve(EMIT_TEST)), { recursive: true });
  fs.writeFileSync(path.resolve(EMIT_TEST), spec);
  log(`\n  regression spec written: ${EMIT_TEST}`);
}

if (AS_JSON) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(blocking ? 1 : 0);
}

console.log(`\n  ${'-'.repeat(68)}`);
console.log(`  RESULTS  ${findings.length} finding(s) in ${(durationMs / 1000).toFixed(1)}s`);
if (timings.length > 1) {
  const slowest = [...timings].sort((a, b) => b.seconds - a.seconds);
  console.log(`  time by attack: ${slowest.map((t) => `${t.attack} ${t.seconds}s`).join('  ')}`);
}
for (const sev of ['crash', 'stuck', 'silent', 'degraded', 'note']) {
  if (counts[sev]) console.log(`    ${sev.padEnd(9)} ${counts[sev]}`);
}
const shown = findings.filter((f) => f.severity !== 'note').slice(0, 20);
if (shown.length) {
  console.log('');
  for (const f of shown) {
    console.log(`  ${f.severity.toUpperCase().padEnd(9)} [${f.attack}/${f.step}] ${f.title}`);
    console.log(`            ${String(f.evidence).slice(0, 160)}`);
    console.log(`            remedy: ${f.remedy}${f.screenshot ? '   shot: ' + f.screenshot : ''}`);
  }
  if (findings.filter((f) => f.severity !== 'note').length > shown.length) {
    console.log(`  ... ${findings.length - shown.length} more in ${path.relative(process.cwd(), reportPath)}`);
  }
}
if (comparison && !comparison.error) {
  console.log(`\n  COMPARISON vs ${COMPARE}`);
  console.log(`    fixed:     ${comparison.fixed.length}`);
  comparison.fixed.slice(0, 8).forEach((s) => console.log(`      + ${s}`));
  console.log(`    remaining: ${comparison.remaining.length}`);
  comparison.remaining.slice(0, 8).forEach((s) => console.log(`      = ${s}`));
  console.log(`    new:       ${comparison.new.length}`);
  comparison.new.slice(0, 8).forEach((s) => console.log(`      ! ${s}`));
}
console.log(`\n  report: ${path.relative(process.cwd(), reportPath)}`);
console.log(blocking
  ? `  ${blocking} blocking finding(s). Apply the remedies, then re-run with --compare ${path.relative(process.cwd(), reportPath)}\n`
  : '  No blocking findings. The UI survived.\n');

process.exit(blocking ? 1 : 0);

// ---------------------------------------------------------------------------
function renderSpec(url, ids) {
  return `import { test, expect } from '@playwright/test';

/**
 * Generated by chaos-monkey-ux-sandbox. Locks in the hardening that was applied
 * so a later refactor cannot silently remove it.
 *
 * Regenerate: node scripts/chaos.mjs --url ${url} --emit-test <this file>
 */

const URL = process.env.CHAOS_URL ?? '${url}';

test.describe('chaos regressions', () => {
  test('survives a failing API without a white screen', async ({ page }) => {
    await page.route('**/api/**', (route) => route.fulfill({ status: 500, body: '{"error":"boom"}' }));
    await page.goto(URL);
    await page.waitForTimeout(1500);

    const root = page.locator('#root, #__next, main').first();
    await expect(root).not.toBeEmpty();

    // The user must be told something actionable.
    await expect(
      page.getByText(/error|went wrong|try again|retry|unable/i).first(),
    ).toBeVisible();
  });

  test('survives malformed JSON', async ({ page }) => {
    await page.route('**/api/**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"broken": ' }));
    await page.goto(URL);
    await page.waitForTimeout(1500);
    await expect(page.locator('#root, #__next, main').first()).not.toBeEmpty();
  });

  test('loading state always resolves', async ({ page }) => {
    await page.goto(URL);
    await page.waitForTimeout(5000);
    const loaders = page.locator('[aria-busy="true"], [role="progressbar"], [class*="skeleton" i]');
    await expect(loaders).toHaveCount(0);
  });

  test('double submit does not fire twice', async ({ page }) => {
    let calls = 0;
    await page.route('**/api/**', (route) => { if (route.request().method() !== 'GET') calls++; route.continue(); });
    await page.goto(URL);
    const submit = page.locator('button[type="submit"], button:has-text("Save"), button:has-text("Submit")').first();
    if (await submit.count()) {
      await submit.click({ force: true });
      await submit.click({ force: true, timeout: 1000 }).catch(() => {});
      await page.waitForTimeout(1200);
      expect(calls, 'submit fired more than once').toBeLessThanOrEqual(1);
    }
  });

  test('offline is handled', async ({ page, context }) => {
    await page.goto(URL);
    await context.setOffline(true);
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(1500);
    await context.setOffline(false);
    // Should not be a blank document.
    expect((await page.locator('body').innerText()).trim().length).toBeGreaterThan(10);
  });
});

/* attacks covered: ${ids.join(', ')} */
`;
}
