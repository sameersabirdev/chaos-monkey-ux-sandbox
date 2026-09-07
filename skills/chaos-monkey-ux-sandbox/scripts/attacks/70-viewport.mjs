/**
 * viewport — the design was drawn at one width. Users have others.
 *
 * Catches: horizontal scroll on small screens, fixed pixel widths, content that
 * disappears under 200% zoom, touch targets too small, layouts that collapse
 * when a font is larger than designed.
 */
const VIEWPORTS = [
  { step: '320x568-small-phone', width: 320, height: 568, mobile: true },
  { step: '390x844-modern-phone', width: 390, height: 844, mobile: true },
  { step: '768x1024-tablet', width: 768, height: 1024, mobile: true },
  { step: '1920x1080-desktop', width: 1920, height: 1080, mobile: false },
  { step: '3840x2160-4k', width: 3840, height: 2160, mobile: false },
  { step: '1280x400-short-window', width: 1280, height: 400, mobile: false },
];

export default {
  id: 'viewport',
  order: 70,
  description: '320px to 4k, short windows, 200% zoom, larger default font',

  async run(ctx) {
    const { page } = ctx;

    for (const v of VIEWPORTS) {
      await page.setViewportSize({ width: v.width, height: v.height });
      await page.goto(ctx.url, { waitUntil: 'domcontentloaded', timeout: ctx.timeout }).catch(() => {});
      await ctx.settle(1000);
      const { snap } = await ctx.check('viewport', v.step);

      // Touch-target check on the phone sizes.
      if (v.mobile && !snap.evaluateFailed) {
        const small = await page.evaluate(() => {
          const els = Array.from(document.querySelectorAll('button, a[href], input, select, [role="button"]'));
          return els.filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && (r.height < 24 || r.width < 24);
          }).slice(0, 5).map((el) => {
            const r = el.getBoundingClientRect();
            return `${el.tagName}${el.id ? '#' + el.id : ''} ${Math.round(r.width)}x${Math.round(r.height)}`;
          });
        }).catch(() => []);
        if (small.length) {
          await ctx.record({
            attack: 'viewport', step: `${v.step}-touch-targets`, severity: 'degraded', remedy: 'none',
            title: 'Touch targets below 24x24 CSS pixels',
            evidence: small.join('; ') + ' (WCAG 2.2 target size minimum is 24x24)',
          });
        }
      }
    }

    // 200% zoom — emulated by halving the viewport at 2x device scale.
    await page.setViewportSize({ width: 640, height: 400 });
    await page.goto(ctx.url, { waitUntil: 'domcontentloaded', timeout: ctx.timeout }).catch(() => {});
    await ctx.settle(1000);
    await ctx.check('viewport', 'zoomed-200-percent');

    // Larger root font — users who set 24px defaults, and em-based layouts that ignore them.
    await page.addStyleTag({ content: 'html { font-size: 24px !important; }' }).catch(() => {});
    await ctx.settle(800);
    await ctx.check('viewport', 'large-root-font-24px');

    await page.setViewportSize({ width: 1280, height: 800 });
  },
};
