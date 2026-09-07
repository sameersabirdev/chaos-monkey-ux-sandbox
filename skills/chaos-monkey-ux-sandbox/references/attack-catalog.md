# Attack catalog

What each attack simulates, what it catches, and what a passing result looks like.

---

## `baseline` — the happy path

Clean load, normal interaction, a second load. Establishes what healthy looks like
(interactive element count, DOM size, body text length) so later attacks can be
compared against it.

**If baseline produces findings, stop.** Everything after it is noise until the happy
path is clean.

---

## `network` — the connection is not a straight line

| Step | Simulates | Catches |
|---|---|---|
| `slow-connection-load` | Slow 3G (400 kbps, 400 ms RTT); brutal = 50 kbps, 2 s RTT | no loading state, layout that assumes instant data, hydration mismatch |
| `offline-cold-load` | no connectivity at first paint | white screen, unhandled fetch rejection, no offline message |
| `offline-mid-interaction` | connection dies after the app is up | actions that fail silently, spinners that never resolve, lost user input |
| `after-reconnect` | connectivity returns | no auto-recovery, permanently stuck error state, no retry affordance |
| `ttfb-stall-12s` | server accepts then hangs | no timeout, spinner forever, no way to cancel |

**Passing:** every state is named on screen. Loading says loading, offline says offline,
timeout says timeout and offers a retry. Nothing spins forever.

---

## `api-failure` — every status code the backend can actually return

Intercepts XHR/fetch and returns each in turn: `500`, `503`, `429` (with `Retry-After`),
`401`, `404`, an HTML error page with a `200`, truncated JSON, an empty body,
`null`, a wrong-shaped object, empty collections, all-`null` fields, and a connection reset.

**Catches:** `res.json()` without checking `res.ok`; `data.map` on `null`; `user.name`
on a null user; treating a 401 as a generic error instead of re-authenticating;
rendering an empty state after a *failure* (which tells the user their data is gone).

**Passing:** each failure class produces a distinct, honest message. `empty-collection`
produces an empty state, not an error. `401` sends the user to sign in. Nothing throws.

---

## `payload` — the API returns far more, and far uglier, than the design assumed

| Step | Payload |
|---|---|
| `oversized-collection` | 5,000 rows (brutal: 50,000) across every common envelope key |
| `hostile-strings` | 5,000-char unbroken runs, ZWJ emoji, RTL, CJK, `<script>` tags, SQL fragments, ANSI escapes |
| `deep-nesting-500` | 500-level nested tree |
| `giant-single-string` | one 2 MB string field |
| `numeric-edge-cases` | `1e999` → `Infinity`, `"NaN"`, `null`, float precision |

Also scrolls the oversized list, because virtualization failures hurt on scroll, and
checks whether injected markup executed.

**Catches:** unvirtualized lists, DOM node explosion, main-thread freezes, text overflow,
`Infinity`/`NaN` rendered to users, dates formatted from `null`, XSS via
`dangerouslySetInnerHTML`.

**Passing:** DOM stays bounded, no task over ~300 ms, long strings wrap or truncate,
no horizontal overflow, no injected script executes.

---

## `state` — bypass the network, corrupt the store directly

Requires the app to expose its store in dev:

```ts
if (process.env.NODE_ENV !== 'production') (window as any).__CHAOS_STORE__ = store;
```

Detects Redux (`dispatch`/`getState`), Zustand (`setState`/`getState`), and a TanStack
`QueryClient` (`setQueryData`). Injects `null` slices, wrong types, `{}`, `[]`, a
20,000-item array, 300-level nesting, and `NaN`/`Infinity`/`undefined` — then interacts,
because selectors usually blow up on the *next* render, not the write.

**Catches:** selectors that assume shape (`state.user.profile.name`), reducers that
crash on unknown actions, components that never guard against a `null` slice,
subscribers that re-render everything on any write.

Skips cleanly with a log line when no store is exposed. Everything else still runs.

---

## `race` — humans are not polite

| Step | Simulates | Catches |
|---|---|---|
| `click-storm` | 15 clicks (brutal: 40) at 40 ms | duplicate requests, state thrash, no pending state |
| `double-submit` | 3 rapid submit clicks, counting mutating requests | double-charged users, duplicate records — button not disabled while pending |
| `out-of-order-response` | first request resolves *last* | stale data overwriting fresh data — no sequence guard or `AbortController` |
| `unmount-mid-flight` | navigate away with requests in flight | setState-after-unmount, leaked timers, aborted-fetch errors surfaced to users |
| `rapid-history-navigation` | 4 back/forward cycles | broken route state, duplicated effects, scroll restoration failures |

`double-submit` and `out-of-order-response` assert directly (counted requests, on-screen
content) rather than inferring from console output.

**Passing:** one click = one request; the newest response always wins; leaving mid-request
is silent.

---

## `input` — type what real users and attackers type

Long text, 3,000-char unbroken strings, ZWJ emoji, RTL, `<script>`, SQL fragments,
template-injection syntax, newlines, whitespace-only, zero-width characters, huge
negative numbers, and letters in numeric fields. Each case fills every visible field,
blurs, and submits.

**Catches:** missing `maxLength`, layout blown out by long values, number inputs that
accept text, validation that only runs on submit, XSS via user input, and — checked
explicitly — **forms that clear the user's input after a failed submit**, which this
skill treats as `crash`-severity data loss.

**Passing:** input is bounded and wrapped, validation is inline and specific, submitted
values survive a failure.

---

## `viewport` — the design was drawn at one width

320×568, 390×844, 768×1024, 1920×1080, 3840×2160, a 400px-tall window, 200% zoom, and a
24px root font. Checks touch-target size (WCAG 2.2: 24×24 minimum) on the phone sizes.

**Catches:** horizontal scroll, fixed pixel widths, content clipped under zoom, layouts
that break when the user's font is larger than designed, tap targets too small.

**Passing:** no horizontal overflow at any width, nothing clipped, targets ≥24×24.

---

## Detectors (running throughout)

Installed before app code, so nothing the app swallows is lost.

| Signal | Severity | Meaning |
|---|---|---|
| framework error overlay | `crash` | the framework caught a render error |
| root has no children / body under 10 chars | `crash` | white screen |
| all interactive elements gone | `crash` | the page became unusable |
| `window.onerror` | `crash` | uncaught exception |
| loader still visible after settle | `stuck` | loading state never resolved |
| failed request + no visible message | `silent` | the user was not told |
| `unhandledrejection` | `silent` | async failure nobody caught |
| near-empty render with no message | `silent` | looks like data loss |
| horizontal overflow | `degraded` | content escaped its container |
| task over 300 ms | `degraded` | the UI was frozen |
| DOM 8× the baseline | `degraded` | list not virtualized or capped |
| `console.error` | `degraded` | something went wrong quietly |
| React warnings | `note` | worth reporting, not always worth fixing |
