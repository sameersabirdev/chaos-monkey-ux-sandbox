'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export type AsyncState<T> =
  | { status: 'idle'; data: null; error: null }
  | { status: 'loading'; data: T | null; error: null }
  | { status: 'success'; data: T; error: null }
  | { status: 'error'; data: T | null; error: Error }
  | { status: 'timeout'; data: T | null; error: Error };

type Options = {
  /** Abort and surface a timeout state after this long. Default 10s. */
  timeoutMs?: number;
  /** Run immediately on mount. Default true. */
  immediate?: boolean;
  /** Retries on failure, with exponential backoff. Default 0. */
  retries?: number;
};

/**
 * Fixes, in one hook, the four async failures chaos testing finds most often:
 *
 *   stuck        — a request that never resolves now times out and says so
 *   race-guard   — only the newest request may write state (out-of-order responses ignored)
 *   unmount      — AbortController + mounted flag, so no setState after unmount
 *   silent       — every outcome has an explicit, renderable status
 *
 * Use it when you are not already on React Query / SWR. If you are, configure
 * their equivalents instead (staleTime, retry, and an error boundary) rather
 * than layering this on top.
 */
export function useAsyncGuard<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  deps: unknown[] = [],
  options: Options = {},
) {
  const { timeoutMs = 10_000, immediate = true, retries = 0 } = options;

  const [state, setState] = useState<AsyncState<T>>({ status: 'idle', data: null, error: null });

  const mounted = useRef(true);
  const requestId = useRef(0);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();   // cancel in flight work on unmount
    };
  }, []);

  const run = useCallback(async () => {
    controller.current?.abort();                 // supersede any in-flight request
    const ac = new AbortController();
    controller.current = ac;

    const id = ++requestId.current;
    const isCurrent = () => mounted.current && id === requestId.current;

    setState((prev) => ({ status: 'loading', data: prev.data, error: null }));

    const timer = setTimeout(() => ac.abort(new DOMException('timeout', 'TimeoutError')), timeoutMs);

    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        const data = await fn(ac.signal);
        clearTimeout(timer);
        if (!isCurrent()) return;                // a newer request already won
        setState({ status: 'success', data, error: null });
        return;
      } catch (err) {
        const isAbort = err instanceof DOMException && err.name === 'AbortError';
        const isTimeout = ac.signal.aborted && (err as DOMException)?.message === 'timeout';

        if (isAbort && !isTimeout) { clearTimeout(timer); return; }   // superseded or unmounted: stay silent

        if (attempt < retries && !isTimeout) {
          attempt++;
          await new Promise((r) => setTimeout(r, 2 ** attempt * 300));
          if (!isCurrent()) { clearTimeout(timer); return; }
          continue;
        }

        clearTimeout(timer);
        if (!isCurrent()) return;
        const error = err instanceof Error ? err : new Error(String(err));
        setState((prev) => ({
          status: isTimeout ? 'timeout' : 'error',
          data: prev.data,
          error: isTimeout ? new Error(`Timed out after ${timeoutMs}ms`) : error,
        }));
        return;
      }
    }
  }, [fn, timeoutMs, retries]);

  useEffect(() => {
    if (immediate) void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { ...state, refetch: run, isLoading: state.status === 'loading' } as const;
}

/* Usage:
 *
 *   const { status, data, error, refetch } = useAsyncGuard(
 *     (signal) => fetch('/api/metrics', { signal }).then((r) => {
 *       if (!r.ok) throw new Error(`HTTP ${r.status}`);
 *       return r.json();
 *     }),
 *     [range],
 *     { timeoutMs: 8000, retries: 1 },
 *   );
 *
 *   if (status === 'loading') return <MetricsSkeleton />;
 *   if (status === 'timeout') return <Timeout onRetry={refetch} />;
 *   if (status === 'error')   return <ErrorState error={error} onRetry={refetch} />;
 *   if (!data?.length)        return <EmptyState ... />;
 *   return <MetricsTable rows={data} />;
 */
