'use client';

import { useEffect, useState } from 'react';

/**
 * Connection state that survives the cases `navigator.onLine` alone gets wrong.
 *
 * `navigator.onLine` only reports whether a network interface exists — captive
 * portals, dead VPNs and DNS failures all report `true`. The optional heartbeat
 * confirms the app's own backend is actually reachable.
 *
 * Fixes the "offline-mid-interaction" and "after-reconnect" chaos findings:
 * the UI can tell the user why things stopped, and refetch when they resume.
 */
export function useOnlineStatus(options: { pingUrl?: string; intervalMs?: number } = {}) {
  const { pingUrl, intervalMs = 30_000 } = options;

  // SSR-safe: assume online so the server render matches the common case.
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  const [wasOffline, setWasOffline] = useState(false);

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => { setOnline(false); setWasOffline(true); };

    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  useEffect(() => {
    if (!pingUrl) return;
    let cancelled = false;

    const check = async () => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 5000);
      try {
        await fetch(pingUrl, { method: 'HEAD', cache: 'no-store', signal: ac.signal });
        if (!cancelled) setOnline(true);
      } catch {
        if (!cancelled) { setOnline(false); setWasOffline(true); }
      } finally {
        clearTimeout(timer);
      }
    };

    const id = setInterval(check, intervalMs);
    void check();
    return () => { cancelled = true; clearInterval(id); };
  }, [pingUrl, intervalMs]);

  /** True on the render where connectivity has just come back — refetch here. */
  const justReconnected = online && wasOffline;
  const acknowledgeReconnect = () => setWasOffline(false);

  return { online, justReconnected, acknowledgeReconnect };
}

/* Usage:
 *
 *   const { online, justReconnected, acknowledgeReconnect } = useOnlineStatus({ pingUrl: '/api/health' });
 *
 *   useEffect(() => {
 *     if (justReconnected) { refetch(); acknowledgeReconnect(); }
 *   }, [justReconnected]);
 *
 *   {!online && (
 *     <div role="status" className="bg-amber-50 px-4 py-2 text-sm">
 *       You're offline. Changes will be saved when you reconnect.
 *     </div>
 *   )}
 *
 * Reserve the banner's height from first paint (or overlay it) — injecting it above
 * existing content is a layout shift.
 */
