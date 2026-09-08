/**
 * detectors.mjs — page instrumentation + health assessment.
 *
 * installProbe(page)  → injected before any app code; captures errors the app swallows.
 * assess(page, ctx)   → post-attack verdict: crash / stuck / silent / degraded / ok.
 */

/** Runs in the page, before the app. Must be self-contained (serialized to the browser). */
export const PROBE = () => {
  const state = {
    errors: [],
    rejections: [],
    consoleErrors: [],
    failedRequests: [],
    longTasks: 0,
    maxTaskMs: 0,
    mountedAt: Date.now(),
  };
  window.__chaos = state;

  window.addEventListener('error', (e) => {
    state.errors.push({
      message: String(e.message || e.error || 'unknown'),
      source: e.filename ? `${e.filename}:${e.lineno}` : null,
      stack: e.error && e.error.stack ? String(e.error.stack).split('\n').slice(0, 4).join(' | ') : null,
      at: Date.now() - state.mountedAt,
    });
  });

  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    state.rejections.push({
      message: r && r.message ? String(r.message) : String(r),
      stack: r && r.stack ? String(r.stack).split('\n').slice(0, 4).join(' | ') : null,
      at: Date.now() - state.mountedAt,
    });
  });

  const origError = console.error.bind(console);
  console.error = (...args) => {
    try {
      state.consoleErrors.push({
        text: args.map((a) => {
          if (a instanceof Error) return a.message;
          if (typeof a === 'object') { try { return JSON.stringify(a).slice(0, 200); } catch { return '[object]'; } }
          return String(a);
        }).join(' ').slice(0, 400),
        at: Date.now() - state.mountedAt,
      });
    } catch { /* never let the probe break the page */ }
    origError(...args);
  };

  // Main-thread stalls — a frozen UI is a UX failure even without an error.
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        state.longTasks++;
        if (e.duration > state.maxTaskMs) state.maxTaskMs = Math.round(e.duration);
      }
    }).observe({ type: 'longtask', buffered: true });
  } catch { /* unsupported */ }

  // Requests the app never surfaced.
  const origFetch = window.fetch;
  window.fetch = async (...args) => {
    const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
    try {
      const res = await origFetch(...args);
      if (!res.ok) state.failedRequests.push({ url: String(url).slice(0, 160), status: res.status, at: Date.now() - state.mountedAt });
      return res;
    } catch (err) {
      state.failedRequests.push({ url: String(url).slice(0, 160), status: 'network-error', message: String(err && err.message), at: Date.now() - state.mountedAt });
      throw err;
    }
  };

  window.__chaosReset = () => {
    state.errors.length = 0; state.rejections.length = 0;
    state.consoleErrors.length = 0; state.failedRequests.length = 0;
    state.longTasks = 0; state.maxTaskMs = 0;
  };
};

/** Runs in the page after an attack. Returns raw signals; severity is decided host-side. */
const INSPECT = () => {
  const q = (sel) => Array.from(document.querySelectorAll(sel));
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  };

  // A framework mount point empty of children is a real crash signal. A plain page
  // that simply has no <div> wrapper is not — so distinguish the two.
  const SPA_ROOTS = ['#root', '#__next', '[data-reactroot]', '#app', '#___gatsby', '[data-svelte]'];
  let spaRoot = null;
  for (const sel of SPA_ROOTS) { const el = document.querySelector(sel); if (el) { spaRoot = el; break; } }
  const appRoot = spaRoot || document.querySelector('main') || document.body;
  const bodyText = (document.body.innerText || '').trim();

  // Framework crash overlays (Next dev, Vite, CRA)
  const overlaySelectors = ['nextjs-portal', '#nextjs__container_errors_label', 'vite-error-overlay',
    '[data-nextjs-dialog]', '#webpack-dev-server-client-overlay', 'react-error-overlay'];
  const overlay = overlaySelectors.map((s) => document.querySelector(s)).find(Boolean);
  const overlayText = overlay ? (overlay.innerText || overlay.textContent || '').slice(0, 300) : null;

  // Unambiguous loading signals — an author opted in to saying "busy".
  const LOADING_EXPLICIT = [
    '[aria-busy="true"]', '[role="progressbar"]', '[data-loading="true"]',
    '[data-testid*="loading" i]', '[data-testid*="skeleton" i]',
  ].join(',');
  // Class-name guesses. Marketing sites use `animate-pulse` for decorative glows and
  // `spinner` for logos, so these only count when the element is shaped like a skeleton.
  const LOADING_HEURISTIC = ['[class*="skeleton" i]', '[class*="spinner" i]', '[class*="animate-pulse" i]'].join(',');

  const skeletonShaped = (el) => {
    if (el.tagName === 'SVG' || el.tagName === 'IMG' || el.closest('svg')) return false;  // icons/glows
    const r = el.getBoundingClientRect();
    if (r.width < 32 || r.height < 8) return false;                                       // too small to be content
    return el.textContent.trim().length === 0;                                            // a skeleton holds no text
  };

  const loaders = [
    ...q(LOADING_EXPLICIT).filter(visible),
    ...q(LOADING_HEURISTIC).filter((el) => visible(el) && skeletonShaped(el)),
  ].filter((el, i, arr) => arr.indexOf(el) === i);

  const ERROR_UI = ['[role="alert"]', '[data-error]', '[class*="error" i]', '[data-testid*="error" i]', '[aria-invalid="true"]'].join(',');
  const errorUi = q(ERROR_UI).filter(visible);
  const errorCopy = /(went wrong|error|failed|unable to|try again|retry|couldn.t|problem)/i.test(bodyText);

  const EMPTY_UI = ['[data-empty]', '[data-testid*="empty" i]', '[class*="empty" i]'].join(',');
  const emptyUi = q(EMPTY_UI).filter(visible);
  const emptyCopy = /(no results|nothing here|no data|empty|not found|no items)/i.test(bodyText);

  // Horizontal overflow — long unbroken strings escaping their container.
  const de = document.documentElement;
  const overflowX = Math.max(0, de.scrollWidth - de.clientWidth);
  const overflowing = q('body *').filter((el) => {
    if (el.scrollWidth <= el.clientWidth + 8) return false;
    const s = getComputedStyle(el);
    return s.overflowX === 'visible' && el.clientWidth > 0;
  }).slice(0, 5).map((el) => (el.tagName + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : '')));

  return {
    href: location.href,
    hasSpaRoot: !!spaRoot,
    rootChildren: appRoot ? appRoot.children.length : 0,
    bodyTextLength: bodyText.length,
    bodyTextSample: bodyText.slice(0, 200),
    overlayText,
    loaderCount: loaders.length,
    loaderSample: loaders.slice(0, 3).map((el) => el.tagName + (typeof el.className === 'string' && el.className ? '.' + el.className.split(' ')[0] : '')),
    errorUiCount: errorUi.length,
    errorUiText: errorUi.slice(0, 2).map((el) => (el.innerText || '').slice(0, 120)),
    errorCopy,
    emptyUiCount: emptyUi.length,
    emptyCopy,
    domNodes: document.querySelectorAll('*').length,
    overflowX,
    overflowing,
    interactive: q('button, a[href], input, select, textarea').filter(visible).length,
    // Elements carrying their own visible text that are not page chrome. Zero of
    // these means the content region is genuinely empty, however short the page is.
    contentElements: Array.from(appRoot.querySelectorAll('*')).filter((el) => {
      if (/^(BUTTON|INPUT|SELECT|TEXTAREA|LABEL|H1|H2|H3|H4|H5|H6|NAV|HEADER|FOOTER|SCRIPT|STYLE|FORM)$/.test(el.tagName)) return false;
      if (el.children.length > 0) return false;                 // count leaves only
      const own = (el.textContent || '').trim();
      return own.length > 0 && visible(el);
    }).length,
    probe: window.__chaos ? {
      errors: window.__chaos.errors.slice(0, 8),
      rejections: window.__chaos.rejections.slice(0, 8),
      consoleErrors: window.__chaos.consoleErrors.slice(0, 8),
      failedRequests: window.__chaos.failedRequests.slice(0, 10),
      longTasks: window.__chaos.longTasks,
      maxTaskMs: window.__chaos.maxTaskMs,
    } : null,
  };
};

export async function installProbe(page) {
  await page.addInitScript(PROBE);
}

export async function resetProbe(page) {
  await page.evaluate(() => { if (window.__chaosReset) window.__chaosReset(); }).catch(() => {});
}

export async function inspect(page) {
  return page.evaluate(INSPECT).catch((e) => ({ evaluateFailed: String(e && e.message).slice(0, 200) }));
}

/**
 * Turn raw signals into findings.
 * @param {object} snap    inspect() output
 * @param {object} opts    { attack, step, baseline, expectData }
 */
export function assess(snap, opts = {}) {
  const {
    attack = 'unknown', step = '', baseline = null,
    expectData = true,          // the step should end with data on screen
    expectEmptyState = false,   // the step returned no data — an empty state is required
  } = opts;
  const out = [];
  const p = snap.probe || { errors: [], rejections: [], consoleErrors: [], failedRequests: [], longTasks: 0, maxTaskMs: 0 };
  const push = (severity, remedy, title, evidence) => out.push({ attack, step, severity, remedy, title, evidence });

  // Navigating to a blank history entry is not an app crash.
  if (/^(about:blank|about:srcdoc|chrome-error:)/.test(snap.href || '')) {
    return out;
  }

  if (snap.evaluateFailed) {
    push('crash', 'error-boundary', 'Page context destroyed — could not evaluate', snap.evaluateFailed);
    return out;
  }

  // ---- crash ----
  if (snap.overlayText) {
    push('crash', 'error-boundary', 'Framework error overlay rendered', snap.overlayText);
  }
  // An empty framework mount point is a crash. A page without one is only "blank"
  // when there is genuinely nothing on it.
  const rootEmpty = snap.hasSpaRoot
    ? snap.rootChildren === 0
    : (snap.bodyTextLength < 10 && snap.interactive === 0);
  if (rootEmpty && !snap.overlayText) {
    push('crash', 'error-boundary', 'White screen — app root rendered nothing',
      `hasSpaRoot=${snap.hasSpaRoot} rootChildren=${snap.rootChildren} bodyTextLength=${snap.bodyTextLength}`);
  }
  if (baseline && !rootEmpty && baseline.interactive > 2 && snap.interactive === 0) {
    push('crash', 'error-boundary', 'All interactive elements disappeared',
      `baseline=${baseline.interactive} now=0`);
  }
  for (const e of p.errors) {
    push('crash', 'error-boundary', 'Uncaught exception', `${e.message}${e.stack ? ' :: ' + e.stack : ''}`);
  }

  // ---- stuck ----
  // A loader that is ALSO present on the healthy baseline is decorative (a pulsing
  // glow, an animated logo) — only a loader this attack introduced means "stuck".
  const persistentLoaders = baseline?.loaderCount ?? 0;
  if (snap.loaderCount > persistentLoaders) {
    push('stuck', 'timeout-guard', 'Loading state never resolved',
      `${snap.loaderCount} loader(s) still visible after settle`
      + (persistentLoaders ? ` (${persistentLoaders} also present at baseline, ignored)` : '')
      + `: ${snap.loaderSample.join(', ')}`);
  }

  // ---- silent ----
  const failures = p.failedRequests.length + p.rejections.length;
  const userToldSomething = snap.errorUiCount > 0 || snap.errorCopy || snap.emptyUiCount > 0 || snap.emptyCopy;
  if (failures > 0 && !userToldSomething && !rootEmpty) {
    const first = p.failedRequests[0] || p.rejections[0];
    push('silent', 'error-boundary', 'Request failed with no user-visible feedback',
      `${failures} failure(s), first: ${JSON.stringify(first).slice(0, 200)}`);
  }
  for (const r of p.rejections) {
    push('silent', 'async-fallback', 'Unhandled promise rejection', `${r.message}${r.stack ? ' :: ' + r.stack : ''}`);
  }
  // A shell with no content and no message. Judged structurally: a page that renders
  // even one row of degraded data did not fail silently, however short the text is.
  const renderedNothing = snap.contentElements === 0
    && (!baseline || baseline.contentElements > 0);
  if (expectData && !rootEmpty && renderedNothing && !userToldSomething) {
    push('silent', 'empty-state', 'Rendered no content and gave no explanation',
      `contentElements=0${baseline ? ` (baseline ${baseline.contentElements})` : ''} bodyText="${snap.bodyTextSample}"`);
  }
  // The API legitimately returned nothing — the user still has to be told.
  if (expectEmptyState && snap.emptyUiCount === 0 && !snap.emptyCopy) {
    push('silent', 'empty-state', 'Empty result rendered no empty state',
      'API returned an empty collection; the UI shows neither data nor an explanation.');
  }

  // ---- degraded ----
  if (snap.overflowX > 8) {
    push('degraded', 'input-guard', 'Content overflows the viewport horizontally',
      `${snap.overflowX}px overflow${snap.overflowing.length ? ' from ' + snap.overflowing.join(', ') : ''}`);
  }
  if (p.maxTaskMs > 300) {
    push('degraded', 'payload-guard', 'Main thread blocked',
      `longest task ${p.maxTaskMs}ms over ${p.longTasks} long task(s) — UI was frozen`);
  }
  if (baseline && snap.domNodes > Math.max(3000, baseline.domNodes * 8)) {
    push('degraded', 'payload-guard', 'DOM node explosion — list is not virtualized or capped',
      `${snap.domNodes} nodes (baseline ${baseline.domNodes})`);
  }
  const reactWarnings = p.consoleErrors.filter((c) => /warning|key prop|each child|cannot update|act\(/i.test(c.text));
  for (const w of reactWarnings.slice(0, 3)) {
    push('note', 'none', 'React warning', w.text);
  }
  const otherConsole = p.consoleErrors.filter((c) => !reactWarnings.includes(c));
  for (const c of otherConsole.slice(0, 3)) {
    push('degraded', 'error-boundary', 'console.error during attack', c.text);
  }

  return out;
}
