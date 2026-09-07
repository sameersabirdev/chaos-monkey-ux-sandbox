/**
 * state — inject garbage straight into the state manager, bypassing the network
 * and any validation the fetch layer performs.
 *
 * Requires the app to expose its store in dev:
 *   if (process.env.NODE_ENV !== 'production') window.__CHAOS_STORE__ = store;
 *
 * Supports Redux (dispatch/getState), Zustand (setState/getState), and a
 * TanStack QueryClient (setQueryData). Skips cleanly when nothing is exposed.
 *
 * Catches: selectors that assume shape, components that read `state.x.y.z`
 * without guards, reducers that crash on unknown actions, subscribers that
 * re-render the world on every write.
 */
const HOOKS = ['__CHAOS_STORE__', '__REDUX_STORE__', '__store', '__queryClient', '__CHAOS_QUERY_CLIENT__'];

export default {
  id: 'state',
  order: 40,
  description: 'Garbage injected into Redux / Zustand / Query cache (needs __CHAOS_STORE__)',

  async run(ctx) {
    const { page } = ctx;
    await ctx.reload();

    const kind = await page.evaluate((hooks) => {
      const found = hooks.map((h) => window[h]).find(Boolean);
      if (!found) return null;
      window.__chaosStore = found;
      if (typeof found.dispatch === 'function' && typeof found.getState === 'function') return 'redux';
      if (typeof found.setState === 'function' && typeof found.getState === 'function') return 'zustand';
      if (typeof found.setQueryData === 'function') return 'query';
      return 'unknown';
    }, HOOKS);

    if (!kind || kind === 'unknown') {
      ctx.log(`      skipped — no store exposed (add: window.__CHAOS_STORE__ = store, dev only)`);
      return;
    }
    ctx.log(`      store detected: ${kind}`);

    const MUTATIONS = [
      { step: 'null-slices', value: 'null' },
      { step: 'wrong-types', value: '"a string where an object belongs"' },
      { step: 'empty-object', value: '{}' },
      { step: 'array-for-object', value: '[]' },
      { step: 'huge-array', value: `Array.from({length: 20000}, (_, i) => ({ id: i, name: "row " + i }))` },
      { step: 'deeply-nested', value: `(() => { let n = { v: 1 }; for (let i = 0; i < 300; i++) n = { child: n }; return n; })()` },
      { step: 'nan-and-infinity', value: '{ count: NaN, total: Infinity, ratio: -Infinity, id: undefined }' },
    ];

    for (const m of MUTATIONS) {
      await ctx.reload();
      const applied = await page.evaluate(({ kind: k, expr }) => {
        // eslint-disable-next-line no-new-func
        const value = new Function(`return (${expr});`)();
        const store = window.__chaosStore;
        try {
          if (k === 'redux') {
            const state = store.getState();
            const keys = Object.keys(state || {});
            // Replace each top-level slice via a raw action; also try a hostile unknown action.
            store.dispatch({ type: '__CHAOS__/unknown_action', payload: value });
            for (const key of keys.slice(0, 6)) {
              store.dispatch({ type: `${key}/setAll`, payload: value });
              store.dispatch({ type: `${key}/set`, payload: value });
              store.dispatch({ type: `${key}/receive`, payload: value });
            }
            return { ok: true, keys };
          }
          if (k === 'zustand') {
            const state = store.getState();
            const keys = Object.keys(state || {}).filter((key) => typeof state[key] !== 'function');
            const patch = {};
            for (const key of keys.slice(0, 8)) patch[key] = value;
            store.setState(patch, false);
            return { ok: true, keys };
          }
          if (k === 'query') {
            const cache = store.getQueryCache().getAll();
            for (const q of cache.slice(0, 10)) store.setQueryData(q.queryKey, value);
            return { ok: true, keys: cache.map((q) => JSON.stringify(q.queryKey).slice(0, 40)) };
          }
        } catch (e) {
          return { ok: false, error: String(e && e.message) };
        }
        return { ok: false, error: 'unsupported store' };
      }, { kind, expr: m.value }).catch((e) => ({ ok: false, error: String(e && e.message) }));

      if (!applied.ok) { ctx.log(`      ${m.step}: could not apply (${applied.error})`); continue; }

      await ctx.settle(1200);
      await ctx.check('state', m.step);

      // Interacting after corrupt state is where selectors actually blow up.
      await ctx.pokeAround(3);
      await ctx.settle(600);
      await ctx.check('state', `${m.step}-after-interaction`);
    }
  },
};
