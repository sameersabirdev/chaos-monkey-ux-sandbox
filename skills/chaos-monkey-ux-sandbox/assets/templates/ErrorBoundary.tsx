'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';

type FallbackProps = {
  error: Error;
  reset: () => void;
  /** How many times reset has been attempted for this error. */
  attempts: number;
};

type Props = {
  children: ReactNode;
  /** Custom fallback. Defaults to DefaultErrorFallback below. */
  fallback?: (props: FallbackProps) => ReactNode;
  /** Human name of the region, used in the default copy: "the revenue chart". */
  label?: string;
  /** Report to Sentry/Datadog/etc. Never let this throw. */
  onError?: (error: Error, info: ErrorInfo) => void;
  /** When any value here changes, the boundary clears itself — e.g. [routeKey]. */
  resetKeys?: unknown[];
};

type State = { error: Error | null; attempts: number };

/**
 * Catches render/lifecycle errors in a subtree and keeps the rest of the page alive.
 *
 * PLACEMENT: as deep as possible while keeping the page useful. One boundary at the
 * app root turns a broken chart into a broken app. A dashboard usually wants one per
 * widget, plus one per route as a backstop.
 *
 * LIMITS — a boundary does NOT catch:
 *   - errors in event handlers        -> try/catch and set error state yourself
 *   - async/promise rejections        -> useAsyncGuard, or catch and setState
 *   - errors during SSR               -> handle on the server (error.tsx in Next.js)
 *   - errors thrown by this boundary's own fallback
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, attempts: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    try {
      this.props.onError?.(error, info);
    } catch {
      // Reporting must never turn one failure into two.
    }
    if (process.env.NODE_ENV !== 'production') {
      console.error(`[ErrorBoundary${this.props.label ? ': ' + this.props.label : ''}]`, error, info.componentStack);
    }
  }

  componentDidUpdate(prev: Props) {
    const { resetKeys } = this.props;
    if (!this.state.error || !resetKeys) return;
    const changed = resetKeys.length !== prev.resetKeys?.length
      || resetKeys.some((k, i) => !Object.is(k, prev.resetKeys?.[i]));
    if (changed) this.setState({ error: null });
  }

  reset = () => {
    this.setState((s) => ({ error: null, attempts: s.attempts + 1 }));
  };

  render() {
    const { error, attempts } = this.state;
    if (!error) return this.props.children;

    const render = this.props.fallback ?? DefaultErrorFallback;
    return render({ error, reset: this.reset, attempts });
  }
}

/**
 * The default fallback always offers a way forward. A bare "Something went wrong"
 * with no action is not an acceptable error state.
 */
export function DefaultErrorFallback({ error, reset, attempts }: FallbackProps) {
  // After repeated failures, stop offering a retry that clearly will not work.
  const retryIsHopeless = attempts >= 2;

  return (
    <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
      <p className="font-medium">This section could not be displayed.</p>
      <p className="mt-1 text-muted-foreground">
        {retryIsHopeless
          ? 'Retrying has not helped. Reload the page, or contact support if it keeps happening.'
          : 'The rest of the page still works.'}
      </p>

      <div className="mt-3 flex gap-2">
        {!retryIsHopeless && (
          <button type="button" onClick={reset} className="rounded border px-3 py-1.5 font-medium">
            Try again
          </button>
        )}
        <button type="button" onClick={() => window.location.reload()} className="rounded border px-3 py-1.5">
          Reload page
        </button>
      </div>

      {process.env.NODE_ENV !== 'production' && (
        <pre className="mt-3 overflow-auto rounded bg-muted p-2 text-xs">{error.message}</pre>
      )}
    </div>
  );
}
