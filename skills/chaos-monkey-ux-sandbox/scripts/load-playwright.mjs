/**
 * load-playwright.mjs — resolve Playwright from the TARGET PROJECT, not the skill.
 *
 * Skills are usually installed outside the project they operate on
 * (~/.claude/skills/, ~/.codex/skills/, a plugin directory). A bare
 * `import('playwright')` resolves relative to this file, so it would miss the copy
 * the developer installed in their own project. This walks the likely roots.
 */
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const CANDIDATE_PACKAGES = ['playwright', 'playwright-core', '@playwright/test'];

function resolveFrom(root, name) {
  try {
    const req = createRequire(path.join(path.resolve(root), 'package.json'));
    return req.resolve(name);
  } catch {
    return null;
  }
}

/** Walk up from `dir` collecting directories that contain a node_modules. */
function ancestorsWithModules(dir) {
  const out = [];
  let cur = path.resolve(dir);
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(cur, 'node_modules'))) out.push(cur);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return out;
}

/**
 * @param {string[]} extraRoots  project roots to search first (e.g. --project-root)
 * @returns {Promise<{chromium: any, source: string} | null>}
 */
export async function loadPlaywright(extraRoots = []) {
  // 1. Normal resolution — works when the skill lives inside the project.
  try {
    const mod = await import('playwright');
    if (mod?.chromium) return { chromium: mod.chromium, source: 'skill-local' };
  } catch { /* fall through */ }

  const roots = [
    ...extraRoots.filter(Boolean),
    process.cwd(),
    ...ancestorsWithModules(process.cwd()),
    ...(process.env.NODE_PATH ? process.env.NODE_PATH.split(path.delimiter) : []),
  ];

  const seen = new Set();
  for (const root of roots) {
    const key = path.resolve(root);
    if (seen.has(key)) continue;
    seen.add(key);

    for (const name of CANDIDATE_PACKAGES) {
      const entry = resolveFrom(key, name);
      if (!entry) continue;
      try {
        const mod = await import(pathToFileURL(entry).href);
        const chromium = mod?.chromium ?? mod?.default?.chromium;
        if (chromium) return { chromium, source: path.relative(process.cwd(), entry) || entry };
      } catch { /* try the next candidate */ }
    }

    // NODE_PATH entries point AT node_modules, not at a package root.
    const direct = path.join(key, 'playwright', 'index.js');
    if (fs.existsSync(direct)) {
      try {
        const mod = await import(pathToFileURL(direct).href);
        if (mod?.chromium) return { chromium: mod.chromium, source: direct };
      } catch { /* keep going */ }
    }
  }

  return null;
}

export const INSTALL_HINT =
  'Playwright not found. Install it in the project under test:\n' +
  '  npm i -D playwright && npx playwright install chromium\n' +
  'If the project lives elsewhere, pass --project-root <path>.';
