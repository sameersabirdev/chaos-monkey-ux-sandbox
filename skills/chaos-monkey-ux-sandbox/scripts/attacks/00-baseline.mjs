/**
 * baseline — the happy path. Establishes what "healthy" looks like and catches
 * apps that are already broken before any chaos is applied.
 */
export default {
  id: 'baseline',
  order: 0,
  description: 'Clean load + normal interaction, no interference',

  async run(ctx) {
    const { page } = ctx;

    await ctx.reload();
    await ctx.check('baseline', 'initial-load');

    const clicked = await ctx.pokeAround(5);
    await ctx.settle(800);
    await ctx.check('baseline', `interaction (${clicked} clicks)`);

    // A second load should be at least as good as the first (cache/hydration bugs).
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await ctx.settle();
    await ctx.check('baseline', 'second-load');
  },
};
