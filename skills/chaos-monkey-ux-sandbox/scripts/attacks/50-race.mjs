/**
 * race — humans are not polite. They double-click, they leave, they come back,
 * they mash the tab that is still loading.
 *
 * Catches: duplicate submissions, setState after unmount, out-of-order responses
 * overwriting newer data, missing AbortController, buttons with no pending state,
 * navigation that races an in-flight request.
 */
const RATES = { light: { clicks: 5, gap: 120 }, normal: { clicks: 15, gap: 40 }, brutal: { clicks: 40, gap: 8 } };

export default {
  id: 'race',
  order: 50,
  description: 'Click storms, double submits, out-of-order responses, unmount mid-flight',

  async run(ctx) {
    const { page } = ctx;
    const rate = RATES[ctx.intensity] || RATES.normal;

    // --- 1. click storm on one control ------------------------------------
    await ctx.reload();
    const target = await page.$(ctx.selector
      ? `${ctx.selector} button:not([disabled])`
      : 'button:not([disabled]), [role="button"]');
    if (target) {
      for (let i = 0; i < rate.clicks; i++) {
        await target.click({ timeout: 500, noWaitAfter: true, force: true }).catch(() => {});
        await page.waitForTimeout(rate.gap);
      }
      await ctx.settle(1500);
      await ctx.check('race', `click-storm-${rate.clicks}x`);
    } else {
      ctx.log('      no clickable control found for click storm');
    }

    // --- 2. double submit: does the mutation fire twice? -------------------
    await ctx.reload();
    let mutations = 0;
    // Hold each mutation open so all three clicks land while one is in flight.
    // Without the delay a fast local API completes between clicks, and a correctly
    // guarded button would still (legitimately) fire more than once.
    const countMutations = async (route) => {
      const m = route.request().method();
      if (m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE') {
        mutations++;
        await new Promise((r) => setTimeout(r, 2000));
      }
      return route.continue().catch(() => {});
    };
    await page.route('**/*', countMutations);

    const submit = await page.$('button[type="submit"], form button:not([type="button"])')
      || await page.$('button:has-text("Save"), button:has-text("Submit"), button:has-text("Create"), button:has-text("Add")');
    if (submit) {
      await submit.click({ force: true, noWaitAfter: true }).catch(() => {});
      await submit.click({ force: true, noWaitAfter: true, timeout: 600 }).catch(() => {});
      await submit.click({ force: true, noWaitAfter: true, timeout: 600 }).catch(() => {});
      // Outlast the 2s hold above, so a correctly-guarded button is not read as stuck.
      await ctx.settle(4000);
      if (mutations > 1) {
        await ctx.record({
          attack: 'race', step: 'double-submit', severity: 'crash', remedy: 'race-guard',
          title: 'Double submit fired the mutation more than once',
          evidence: `${mutations} mutating requests from 3 rapid clicks — the button is not disabled while pending`,
        });
      }
      await ctx.check('race', 'double-submit');
    }
    await page.unrouteAll?.({ behavior: 'ignoreErrors' }).catch(() => {});

    // --- 3. out-of-order responses ----------------------------------------
    // The first request resolves LAST with stale data. A correct app ignores it.
    await ctx.reload();
    let seq = 0;
    let reads = 0;                                        // GET data requests only
    await page.route('**/*', async (route) => {
      const t = route.request().resourceType();
      if (t !== 'xhr' && t !== 'fetch') return route.continue();
      if (route.request().method() === 'GET') reads++;
      const n = seq++;
      const delay = n === 0 ? 4000 : 200;                 // invert the natural order
      await new Promise((r) => setTimeout(r, delay));
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ data: [{ id: n, name: `response-${n}`, stale: n === 0 }], items: [{ id: n, name: `response-${n}` }], requestIndex: n }),
      }).catch(() => {});
    });
    await page.goto(ctx.url, { waitUntil: 'domcontentloaded', timeout: ctx.timeout }).catch(() => {});
    await ctx.pokeAround(3);
    await ctx.settle(5000);
    // Only a real race: at least two READS, the oldest one visible, and the newest
    // one absent. With a single read, showing response-0 is simply correct.
    const shown = await page.evaluate(() => document.body.innerText).catch(() => '');
    const showsStale = shown.includes('response-0');
    const showsNewest = /response-([1-9]\d*)/.test(shown);
    if (reads >= 2 && showsStale && !showsNewest) {
      await ctx.record({
        attack: 'race', step: 'out-of-order-response', severity: 'silent', remedy: 'race-guard',
        title: 'A stale response overwrote newer data',
        evidence: `The first (slowest) of ${reads} reads is still on screen and the newer one is not. Sequence guard or AbortController missing.`,
      });
    }
    await ctx.check('race', 'out-of-order-response');
    await page.unrouteAll?.({ behavior: 'ignoreErrors' }).catch(() => {});

    // --- 4. unmount mid-flight (navigate away while loading) ---------------
    await page.route('**/*', async (route) => {
      const t = route.request().resourceType();
      if (t !== 'xhr' && t !== 'fetch') return route.continue();
      await new Promise((r) => setTimeout(r, 3000));
      return route.continue().catch(() => {});
    });
    await page.goto(ctx.url, { waitUntil: 'domcontentloaded', timeout: ctx.timeout }).catch(() => {});
    await page.waitForTimeout(400);                       // requests are in flight
    const link = await page.$('a[href^="/"]:not([href="#"]), [role="tab"]');
    if (link) await link.click({ noWaitAfter: true, force: true, timeout: 1000 }).catch(() => {});
    else await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await ctx.settle(3500);
    // "Can't perform a React state update on an unmounted component" lands as console.error
    await ctx.check('race', 'unmount-mid-flight', { expectData: false });
    await page.unrouteAll?.({ behavior: 'ignoreErrors' }).catch(() => {});

    // --- 5. rapid back/forward --------------------------------------------
    await ctx.reload();
    await ctx.pokeAround(2);
    for (let i = 0; i < 4; i++) {
      await page.goBack({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(120);
      await page.goForward({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(120);
    }
    await ctx.settle(1500);
    await ctx.check('race', 'rapid-history-navigation', { expectData: false });
  },
};
