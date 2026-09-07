# Remediation — finding → fix

Every finding carries a `remedy` id. This is what each one means in code.

**Rule for all of them:** the fix goes where the failure is, not at the app root, and
every fallback offers a way forward.

---

## `error-boundary` — a render threw

Scaffold: `node scripts/scaffold.mjs --root <root> --components error-boundary`

```tsx
<ErrorBoundary label="revenue chart" onError={reportToSentry}>
  <RevenueChart data={data} />
</ErrorBoundary>
```

**Placement is the whole decision.** A dashboard with six widgets needs six boundaries,
not one — otherwise a single failing API blanks the page. Put a route-level boundary
behind them as a backstop (`app/dashboard/error.tsx` in Next.js).

A boundary does **not** catch event handlers, async rejections, or SSR errors. For those:

```tsx
// event handler
const onSave = async () => {
  try { await save(); }
  catch (e) { setError(e as Error); }        // render it — never swallow it
};
```

Next.js App Router route boundary:

```tsx
// app/dashboard/error.tsx
'use client';
export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  return <ErrorState error={error} onRetry={reset} />;
}
```

---

## `query-boundary` — a data query threw

Scaffold: `--components query-boundary`

Needs `throwOnError: true` so failures reach the boundary at all:

```tsx
const qc = new QueryClient({ defaultOptions: { queries: { throwOnError: true, retry: 1 } } });
```

Without `QueryErrorResetBoundary`, "Try again" re-renders a component whose query is
still in its error state — it throws again instantly and the retry looks broken.

---

## `async-fallback` — an unhandled promise rejection

Every `await` in a component path is inside a `try`, or behind a hook that catches:

```tsx
<Suspense fallback={<Skeleton />}>   {/* fallback matches the final box exactly */}
  <AsyncWidget />
</Suspense>
```

Fire-and-forget still needs a catch:

```ts
void trackEvent(...).catch(reportSilently);   // not: trackEvent(...)
```

---

## `timeout-guard` — the loading state never resolved

Scaffold: `--components timeout-guard`

`stuck` is worse than an error: the user waits indefinitely with no information.
Every async read needs a deadline.

```tsx
const { status, data, error, refetch } = useAsyncGuard(
  (signal) => fetch('/api/metrics', { signal }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }),
  [range],
  { timeoutMs: 8000, retries: 1 },
);

if (status === 'loading') return <MetricsSkeleton />;
if (status === 'timeout') return <ErrorState error="This is taking longer than usual." onRetry={refetch} />;
if (status === 'error')   return <ErrorState error={error} onRetry={refetch} />;
if (!data?.length)        return <EmptyState title="No metrics yet" />;
return <MetricsTable rows={data} />;
```

React Query equivalent: `retry`, and a route-level `staleTime`; the timeout comes from
your own `AbortSignal.timeout(8000)` inside `queryFn`.

**Render all five states, in this order, every time: loading → timeout → error → empty → data.**
Skipping one is how `stuck` and `silent` findings happen.

---

## `empty-state` — nothing rendered and nothing was said

Scaffold: `--components empty-state`

Three distinct cases, three distinct messages:

```tsx
if (error) return <ErrorState error={error} onRetry={refetch} />;      // failure ≠ empty
if (query && !rows.length) return <NoResults query={query} onClear={clear} />;
if (!rows.length) return <EmptyState title="No transactions yet"
                                     description="They'll appear here once you make your first sale."
                                     action={<Button>Create invoice</Button>} />;
```

Rendering an empty state after a failed request tells the user their data is gone.
That is the `silent` finding, and it is a serious one.

---

## `payload-guard` — too much data, or hostile data

Validate and bound at the boundary, before the data reaches state:

```ts
const RowSchema = z.object({
  id: z.union([z.string(), z.number()]),
  name: z.string().max(200).catch('—'),
  value: z.number().finite().catch(0),          // rejects NaN and Infinity
  createdAt: z.coerce.date().nullable().catch(null),
});

const rows = z.array(RowSchema).catch([]).parse(json?.data ?? []);
const capped = rows.slice(0, 1000);             // never render an unbounded list
```

Then virtualize (see `vitals-precognitive-builder/references/patterns.md`) and defend
the layout against long values:

```css
.cell { overflow-wrap: anywhere; text-overflow: ellipsis; overflow: hidden; }
```

Never render API text as HTML. If you must, sanitize with DOMPurify — but the correct
answer is almost always plain text.

Formatting must survive bad numbers:

```ts
const fmt = (n: unknown) => (typeof n === 'number' && Number.isFinite(n)
  ? new Intl.NumberFormat().format(n) : '—');
```

---

## `race-guard` — the same action fired twice, or the wrong response won

**Double submit** — disable while pending, always:

```tsx
const [pending, setPending] = useState(false);
const onSubmit = async () => {
  if (pending) return;                          // guard the handler too, not just the button
  setPending(true);
  try { await save(values); }
  catch (e) { setError(e as Error); }           // values stay in state — no data loss
  finally { setPending(false); }
};
<button type="submit" disabled={pending} aria-busy={pending}>
  {pending ? 'Saving…' : 'Save'}
</button>
```

**Out-of-order responses** — only the newest request may write:

```ts
const latest = useRef(0);
const load = async (q: string) => {
  const id = ++latest.current;
  const data = await search(q);
  if (id !== latest.current) return;            // a newer request already landed
  setResults(data);
};
```

**Unmount mid-flight** — abort:

```ts
useEffect(() => {
  const ac = new AbortController();
  fetch(url, { signal: ac.signal }).then(...).catch((e) => {
    if (e.name !== 'AbortError') setError(e);   // aborts are not errors
  });
  return () => ac.abort();
}, [url]);
```

`useAsyncGuard` does all three. React Query does them too — do not hand-roll on top of it.

---

## `input-guard` — user input broke the layout or the app

```tsx
<input
  maxLength={200}                                // bound it at the input
  value={value}
  onChange={(e) => setValue(e.target.value.slice(0, 200))}
/>
```

- Numbers: `type="number"` plus `Number.isFinite(Number(v))` — the attribute alone is not validation.
- Trim before comparing; whitespace-only is not a valid value.
- Layout: `overflow-wrap: anywhere` on any container holding user text.
- Rendering: JSX escapes by default. `dangerouslySetInnerHTML` on user text is the bug.
- Validate on blur and on submit, not on submit alone.
- **Never clear a form because a request failed.** Keep the values; show the error next to the field.

---

## `offline-banner` — connectivity failures had no affordance

Scaffold: `--components offline-banner`

```tsx
const { online, justReconnected, acknowledgeReconnect } = useOnlineStatus({ pingUrl: '/api/health' });

useEffect(() => {
  if (justReconnected) { refetch(); acknowledgeReconnect(); }
}, [justReconnected]);

<div className="h-10">                          {/* reserved height — no layout shift */}
  {!online && <div role="status">You're offline. We'll retry automatically.</div>}
</div>
```

`navigator.onLine` alone reports `true` behind captive portals and dead VPNs — the
heartbeat is what makes this honest.

---

## Verifying

```bash
node scripts/chaos.mjs --url <url> --out .chaos --compare .chaos/report.json
```

Not done while anything is `crash`, `stuck`, or `silent`. Then lock it in:

```bash
node scripts/chaos.mjs --url <url> --emit-test tests/chaos.spec.ts
```
