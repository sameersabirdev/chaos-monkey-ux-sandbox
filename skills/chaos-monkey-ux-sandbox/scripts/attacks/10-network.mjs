/**
 * network — the connection is not a straight line. Slow it, cut it, stall it.
 * Catches: missing loading states, no timeout handling, no offline affordance,
 * hydration that assumes data has already arrived.
 */
const PROFILES = {
  light: { downloadThroughput: (3 * 1024 * 1024) / 8, uploadThroughput: (1 * 1024 * 1024) / 8, latency: 100 },
  normal: { downloadThroughput: (400 * 1024) / 8, uploadThroughput: (400 * 1024) / 8, latency: 400 },   // Slow 3G
  brutal: { downloadThroughput: (50 * 1024) / 8, uploadThroughput: (20 * 1024) / 8, latency: 2000 },    // near-dead link
};

export default {
  id: 'network',
  order: 10,
  description: 'Slow 3G, offline mid-load, offline mid-interaction, TTFB stall',

  async run(ctx) {
    const { page, context } = ctx;
    const profile = PROFILES[ctx.intensity] || PROFILES.normal;
    const cdp = await context.newCDPSession(page);

    // --- 1. throttled cold load -------------------------------------------
    await cdp.send('Network.emulateNetworkConditions', { offline: false, ...profile });
    await page.goto(ctx.url, { waitUntil: 'domcontentloaded', timeout: ctx.timeout }).catch(() => {});
    await ctx.settle(2500);
    await ctx.check('network', 'slow-connection-load');

    await cdp.send('Network.emulateNetworkConditions', {
      offline: false, downloadThroughput: -1, uploadThroughput: -1, latency: 0,
    });

    // --- 2. offline during initial load ------------------------------------
    await context.setOffline(true);
    await page.goto(ctx.url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => { /* expected */ });
    await ctx.settle(1500);
    await ctx.check('network', 'offline-cold-load', { expectData: false });
    await context.setOffline(false);

    // --- 3. connection drops after the app is up ---------------------------
    await ctx.reload();
    await context.setOffline(true);
    await ctx.pokeAround(4);              // interactions now hit a dead network
    await ctx.settle(2000);
    await ctx.check('network', 'offline-mid-interaction');
    await context.setOffline(false);

    // Does it recover on its own, or stay broken forever?
    await ctx.settle(2500);
    await ctx.check('network', 'after-reconnect');

    // --- 4. server accepts the connection then stalls ----------------------
    await ctx.reload();
    await page.route('**/api/**', async (route) => {
      await new Promise((r) => setTimeout(r, 12000));   // longer than any sane timeout
      await route.abort('timedout').catch(() => {});
    });
    await page.goto(ctx.url, { waitUntil: 'domcontentloaded', timeout: ctx.timeout }).catch(() => {});
    await ctx.settle(6000);              // a good app shows a timeout state by now
    await ctx.check('network', 'ttfb-stall-12s');
    await page.unroute('**/api/**').catch(() => {});

    await cdp.detach().catch(() => {});
  },
};
