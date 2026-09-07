'use client';

import { QueryErrorResetBoundary } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ErrorBoundary } from './ErrorBoundary';

/**
 * TanStack Query + ErrorBoundary, wired so "Try again" actually retries.
 *
 * Without QueryErrorResetBoundary, resetting the boundary re-renders a component
 * whose query is still in its error state — so it throws again immediately and the
 * retry button appears broken. That is the most common false "the fix didn't work".
 *
 * Requires queries to throw rather than return an error:
 *   useQuery({ queryKey, queryFn, throwOnError: true })
 * or globally: new QueryClient({ defaultOptions: { queries: { throwOnError: true } } })
 */
export function QueryErrorBoundary({
  children,
  label,
  fallback,
}: {
  children: ReactNode;
  label?: string;
  fallback?: (props: { error: Error; reset: () => void; attempts: number }) => ReactNode;
}) {
  return (
    <QueryErrorResetBoundary>
      {({ reset }) => (
        <ErrorBoundary
          label={label}
          resetKeys={[reset]}
          fallback={(props) =>
            (fallback ?? DefaultQueryFallback)({
              ...props,
              reset: () => { reset(); props.reset(); },   // clear the cache error, THEN the boundary
            })
          }
        >
          {children}
        </ErrorBoundary>
      )}
    </QueryErrorResetBoundary>
  );
}

function DefaultQueryFallback({ error, reset, attempts }: { error: Error; reset: () => void; attempts: number }) {
  const offline = typeof navigator !== 'undefined' && !navigator.onLine;

  return (
    <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
      <p className="font-medium">
        {offline ? "You're offline." : "We couldn't load this data."}
      </p>
      <p className="mt-1 text-muted-foreground">
        {offline
          ? 'Reconnect and try again — nothing has been lost.'
          : attempts >= 2
            ? 'Still failing. The service may be down; try again shortly.'
            : 'This is usually temporary.'}
      </p>
      <button type="button" onClick={reset} className="mt-3 rounded border px-3 py-1.5 font-medium">
        Try again
      </button>
      {process.env.NODE_ENV !== 'production' && (
        <pre className="mt-3 overflow-auto rounded bg-muted p-2 text-xs">{error.message}</pre>
      )}
    </div>
  );
}

/* Placement:
 *
 *   <QueryErrorBoundary label="revenue chart">
 *     <Suspense fallback={<ChartSkeleton />}>
 *       <RevenueChart />
 *     </Suspense>
 *   </QueryErrorBoundary>
 *
 * One pair per independently-failing widget. A dashboard with six widgets that
 * shares one boundary loses all six when one API is down.
 */
