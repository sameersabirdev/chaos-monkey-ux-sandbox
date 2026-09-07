import type { ReactNode } from 'react';

type Props = {
  /** What is missing, in the user's words: "No transactions yet". */
  title: string;
  /** Why, and what to do about it. Optional but almost always worth writing. */
  description?: string;
  /** The one action that resolves the emptiness. */
  action?: ReactNode;
  icon?: ReactNode;
  /** Reserve the same height the populated state occupies, so nothing shifts. */
  minHeight?: number | string;
};

/**
 * The state chaos testing hits constantly and product design forgets: the API
 * returned `[]`, `null`, or a filter matched nothing.
 *
 * Three distinct cases, three distinct messages — do not collapse them:
 *   1. nothing exists yet          -> onboarding copy + create action
 *   2. a filter matched nothing    -> "no results for X" + clear-filter action
 *   3. the request failed          -> NOT an empty state; use the error fallback
 *
 * Rendering an empty state after a failed request tells the user their data is
 * gone. That is the "silent failure" finding.
 */
export function EmptyState({ title, description, action, icon, minHeight = 200 }: Props) {
  return (
    <div
      className="flex flex-col items-center justify-center rounded-lg border border-dashed p-8 text-center"
      style={{ minHeight }}
    >
      {icon && <div className="mb-3 text-muted-foreground">{icon}</div>}
      <p className="font-medium">{title}</p>
      {description && <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** Case 2: a filter or search returned nothing. Always offer the way back. */
export function NoResults({ query, onClear, minHeight = 200 }: { query: string; onClear: () => void; minHeight?: number | string }) {
  return (
    <EmptyState
      minHeight={minHeight}
      title={`No results for "${query.length > 40 ? query.slice(0, 40) + '…' : query}"`}
      description="Try a different search term, or clear the filters to see everything."
      action={
        <button type="button" onClick={onClear} className="rounded border px-3 py-1.5 text-sm font-medium">
          Clear filters
        </button>
      }
    />
  );
}

/**
 * Not an empty state — an error state. Kept next to EmptyState because the two
 * get confused, and confusing them is a bug.
 */
export function ErrorState({
  error, onRetry, minHeight = 200,
}: { error: Error | string; onRetry?: () => void; minHeight?: number | string }) {
  const message = typeof error === 'string' ? error : error.message;
  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center rounded-lg border border-destructive/30 bg-destructive/5 p-8 text-center"
      style={{ minHeight }}
    >
      <p className="font-medium">We couldn&apos;t load this.</p>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        Your data is safe — this is a display problem. Try again in a moment.
      </p>
      {onRetry && (
        <button type="button" onClick={onRetry} className="mt-4 rounded border px-3 py-1.5 text-sm font-medium">
          Try again
        </button>
      )}
      {process.env.NODE_ENV !== 'production' && (
        <pre className="mt-3 max-w-full overflow-auto rounded bg-muted p-2 text-xs">{message}</pre>
      )}
    </div>
  );
}
