---
name: chaos-monkey-ux-sandbox
description: Adversarially break a freshly built frontend in a headless browser, then generate the error boundaries, fallbacks, and guards it lacked. Use after building or changing UI, or when asked to test error states, harden a component, check loading/empty/error handling, find race conditions, test offline or slow network behavior, or stress a page with bad API data.
license: MIT
---

# Chaos Monkey UX Sandbox

The happy path is the path you already wrote. This skill runs the other ones: slow
networks, 500s, malformed payloads, 10,000-row responses, double-clicks, mid-flight
unmounts, and hostile input — then fixes what breaks.

## Core rule

**Every attack that produces a finding must end in an applied fix and a re-run that
proves the finding is gone.** A report is not the deliverable. Surviving code is.

## When to run

Immediately after building or modifying any component that fetches, mutates, or renders
list/remote data. Do not wait to be asked to "test error states" — that is this skill's
whole job.

## Workflow

### Phase 0 — Setup

```bash
npm i -D playwright && npx playwright install chromium    # once per project
```

Start the app (dev or preview build) and confirm the target URL loads. Preview builds
are preferred — dev overlays mask real crash behavior.

Optional but recommended, in dev only, so state-injection attacks can run:

```ts
if (process.env.NODE_ENV !== 'production') {
  (window as any).__CHAOS_STORE__ = store;   // Redux store / Zustand api / Query client
}
```

Without it, state attacks are skipped and everything else still runs — payload attacks
go in at the network layer, which needs no app cooperation.

### Phase 1 — Baseline

```bash
node scripts/chaos.mjs --url <url> --only baseline
```

Must be clean. If the happy path already logs errors, fix that first — otherwise every
later finding is noise.

### Phase 2 — Attack

```bash
node scripts/chaos.mjs --url <url> --out .chaos
```

Runs the full suite. Useful flags:

| Flag | Effect |
|---|---|
| `--only network,payload` | run a subset (`--list` shows all ids) |
| `--skip state` | exclude an attack |
| `--selector "form"` | scope interaction attacks to a region |
| `--intensity light\|normal\|brutal` | payload sizes and click rates |
| `--headed` | watch it happen |
| `--json` | machine-readable output only |

Attacks (`references/attack-catalog.md` documents each):

1. **baseline** — clean load, establishes what "healthy" looks like
2. **network** — Slow 3G, offline mid-load, offline mid-interaction, 8s TTFB stall
3. **api-failure** — 500, 429, 401, network reset, malformed JSON, `null` fields, empty arrays
4. **payload** — 10k-row responses, 5MB strings, deep nesting, unicode/RTL/emoji, HTML in text fields
5. **state** — garbage injected into Redux/Zustand/Query cache (requires `__CHAOS_STORE__`)
6. **race** — click storms, double submits, rapid route flips, unmount mid-request, back-button during load
7. **input** — 10k-char strings, emoji, RTL, newlines, `<script>` text, negative/NaN numbers
8. **viewport** — 320px, 4k, 200% zoom, mobile touch

Detectors run continuously (`scripts/detectors.mjs`): uncaught errors, unhandled
rejections, React error overlays, blank roots, stuck loading states, silent failures
(console error with no user-visible message), unstyled overflow, and frozen main thread.

### Phase 3 — Triage

Read `.chaos/report.json`. Each finding has `severity`, `attack`, `evidence`,
`screenshot`, and a `remedy` id. Fix in this order:

| Severity | Meaning | Action |
|---|---|---|
| `crash` | app unmounted / white screen / error overlay | fix now, non-negotiable |
| `stuck` | loading state never resolves | fix now — worse than an error message |
| `silent` | failure with no user-visible feedback | fix now |
| `degraded` | recovers but ugly (overflow, unformatted, jank) | fix unless the user says otherwise |
| `note` | observation worth reporting | report, do not necessarily fix |

### Phase 4 — Remediate

Apply the fix each `remedy` id maps to. `references/remediation.md` gives the full
mapping; drop-in components are in `assets/templates/`:

| remedy | What to add |
|---|---|
| `error-boundary` | `ErrorBoundary.tsx` around the failing subtree, with a real recovery action |
| `query-boundary` | `QueryErrorBoundary.tsx` — reset the query cache on retry |
| `async-fallback` | `Suspense` + a skeleton matching the final box |
| `timeout-guard` | `useAsyncGuard.ts` — abort + surface a timeout state |
| `empty-state` | `EmptyState.tsx` for `[]` / `null` / zero results |
| `payload-guard` | validate + cap at the boundary; virtualize the list |
| `race-guard` | disable-while-pending, request sequencing, `AbortController` on unmount |
| `input-guard` | `maxLength`, trim, numeric coercion, `overflow-wrap`, safe rendering |
| `offline-banner` | `useOnlineStatus.ts` + a retry affordance |

Scaffold the shared pieces once:

```bash
node scripts/scaffold.mjs --root <projectRoot> --components error-boundary,empty-state,timeout-guard
```

It writes only files that do not exist, matches the project's TS/JS and import alias,
and prints exactly where to wire each one. **You still write the wiring** — placing the
boundary at the right depth is a judgment call, not a template.

Boundary placement rule: as deep as possible while still keeping the page useful. One
boundary at the app root turns a broken chart into a broken app.

### Phase 5 — Prove it

```bash
node scripts/chaos.mjs --url <url> --out .chaos --compare .chaos/report.json
```

Prints fixed / still-broken / newly-broken. **Do not report done while anything is
still `crash`, `stuck`, or `silent`.**

Optionally persist the suite as a regression test:

```bash
node scripts/chaos.mjs --url <url> --emit-test tests/chaos.spec.ts
```

## Guardrails

- Only ever point this at localhost or an explicitly authorized staging URL. Never at
  production, and never at a third-party site. Ask if the target is not obviously local.
- Attacks mutate app state through the UI and can write real data — confirm before
  running against any environment with a shared or persistent backend.
- Never suppress a finding by silencing the detector (empty `catch`, muted console,
  removed `console.error`). Fix the cause.
- A fallback UI must offer a way forward — retry, go back, or contact — never a bare
  "Something went wrong."
- Preserve the user's in-flight input across an error. Losing a filled form to a failed
  request is itself a `crash`-class defect.
- Report honestly: what broke, what you fixed, what remains, and the re-run output.

## Files

- `references/attack-catalog.md` — every attack, what it simulates, what it catches
- `references/remediation.md` — finding → fix, with code
- `scripts/chaos.mjs` — orchestrator | `scripts/detectors.mjs` — instrumentation
- `scripts/attacks/*.mjs` — one module per attack
- `scripts/scaffold.mjs` — writes the remediation components into the project
- `assets/templates/` — `ErrorBoundary.tsx`, `QueryErrorBoundary.tsx`, `EmptyState.tsx`, `useAsyncGuard.ts`, `useOnlineStatus.ts`
