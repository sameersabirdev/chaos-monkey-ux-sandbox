/**
 * api-failure — every status code the backend can actually return, plus the
 * responses nobody writes a test for: truncated JSON, HTML error pages, nulls.
 *
 * Catches: unguarded .json(), assumptions that res.ok is always true, missing
 * 401 redirect handling, crashes on null fields, silent failures.
 */
const API = '**/{api,graphql,v1,v2,rest}/**';

/** Match anything that looks like a data request, not documents/assets. */
function isDataRequest(route) {
  const req = route.request();
  const type = req.resourceType();
  if (type !== 'xhr' && type !== 'fetch') return false;
  return !/\.(js|css|png|jpe?g|svg|webp|woff2?|ico|map)(\?|$)/i.test(req.url());
}

const SCENARIOS = [
  { step: '500-server-error', fulfill: { status: 500, contentType: 'application/json', body: '{"error":"Internal Server Error"}' } },
  { step: '503-unavailable', fulfill: { status: 503, contentType: 'application/json', body: '{"error":"Service Unavailable"}' } },
  { step: '429-rate-limited', fulfill: { status: 429, contentType: 'application/json', headers: { 'retry-after': '30' }, body: '{"error":"Too Many Requests"}' } },
  { step: '401-unauthorized', fulfill: { status: 401, contentType: 'application/json', body: '{"error":"Unauthorized"}' } },
  { step: '404-not-found', fulfill: { status: 404, contentType: 'application/json', body: '{"error":"Not Found"}' } },
  // The classic: a proxy returns an HTML error page with a 200.
  { step: '200-html-instead-of-json', fulfill: { status: 200, contentType: 'text/html', body: '<!doctype html><html><body>502 Bad Gateway</body></html>' } },
  { step: 'malformed-json', fulfill: { status: 200, contentType: 'application/json', body: '{"data": [{"id": 1, "name": "trunc' } },
  { step: 'empty-body-200', fulfill: { status: 200, contentType: 'application/json', body: '' } },
  { step: 'null-payload', fulfill: { status: 200, contentType: 'application/json', body: 'null' } },
  { step: 'wrong-shape', fulfill: { status: 200, contentType: 'application/json', body: '{"data":"a string where an array belongs"}' } },
  { step: 'empty-collection', fulfill: { status: 200, contentType: 'application/json', body: '{"data":[],"items":[],"results":[],"total":0}' } },
  { step: 'null-fields', fulfill: { status: 200, contentType: 'application/json', body: '{"data":[{"id":null,"name":null,"value":null,"createdAt":null,"user":null,"tags":null}],"items":[{"id":null,"name":null}]}' } },
  { step: 'connection-reset', abort: 'connectionreset' },
];

export default {
  id: 'api-failure',
  order: 20,
  description: '500/503/429/401/404, HTML-for-JSON, truncated JSON, nulls, empty sets, reset',

  async run(ctx) {
    const { page } = ctx;

    let n = 0;
    for (const s of SCENARIOS) {
      ctx.progress(`serving ${s.step}  (${++n}/${SCENARIOS.length})`);
      await page.unrouteAll?.({ behavior: 'ignoreErrors' }).catch(() => {});
      await page.route('**/*', async (route) => {
        if (!isDataRequest(route)) return route.continue();
        if (s.abort) return route.abort(s.abort).catch(() => {});
        return route.fulfill(s.fulfill).catch(() => {});
      });

      await page.goto(ctx.url, { waitUntil: 'domcontentloaded', timeout: ctx.timeout }).catch(() => {});
      await ctx.settle(1500);

      // Assess the load BEFORE interacting — clicking around can replace the very
      // message we are checking for (a "Saved." toast over the empty state).
      const isEmpty = s.step === 'empty-collection';
      await ctx.check('api-failure', s.step, {
        expectData: !isEmpty && s.step !== '401-unauthorized',
        expectEmptyState: isEmpty,
      });

      // Then interact — many failures only surface on the second request.
      await ctx.pokeAround(3);
      await ctx.settle(800);
      await ctx.check('api-failure', `${s.step}-after-interaction`, { expectData: false });

      await page.unrouteAll?.({ behavior: 'ignoreErrors' }).catch(() => {});
    }
    void API;
  },
};
