# Chaos Monkey UX Sandbox

An agent skill that makes your coding agent **attack the UI it just built**, then write
the error boundaries, fallbacks, and guards it was missing.

Coding agents write for the happy path. This one drives a headless browser at your app
and does what real users and bad days do: severe network throttling, 500s and truncated
JSON, 50,000-row payloads, garbage injected into Redux, click storms, and hostile input.
When something breaks, it maps the failure to a specific fix — and re-runs to prove it.

Works with **Claude Code**, **OpenAI Codex**, **Cursor**, **Windsurf**, or any agent that
can read a Markdown instruction file and run Node scripts.

---

## What it finds

Eight attack modules, run against a URL you control:

| Attack | What it does |
|---|---|
| `baseline` | clean load — establishes what healthy looks like |
| `network` | Slow 3G, offline mid-load, offline mid-interaction, 12 s TTFB stall |
| `api-failure` | 500/503/429/401/404, HTML-for-JSON, truncated JSON, `null`, empty sets, reset |
| `payload` | 50k rows, 2 MB strings, 500-deep nesting, emoji/RTL/`<script>`, `Infinity`/`NaN` |
| `state` | garbage injected straight into Redux / Zustand / TanStack Query |
| `race` | click storms, double submits, out-of-order responses, unmount mid-flight |
| `input` | 3,000-char strings, emoji, RTL, markup, invalid numbers into every field |
| `viewport` | 320px → 4k, 200% zoom, 24px root font, WCAG touch-target sizes |

Findings are graded so the agent knows what must be fixed:

| Severity | Meaning |
|---|---|
| `crash` | white screen, error overlay, uncaught exception, XSS, double-charged submit |
| `stuck` | a loading state that never resolves — worse than an error message |
| `silent` | it failed and the user was never told |
| `degraded` | recovers, but overflows, freezes, or renders `NaN` |
| `note` | worth reporting, not necessarily fixing |

Each finding carries a `remedy` id (`error-boundary`, `race-guard`, `timeout-guard`, …)
that maps to working code in `references/remediation.md` and drop-in components in
`assets/templates/`.

---

## Install

### Claude Code (plugin — recommended)

```bash
/plugin marketplace add sabirsameer48/chaos-monkey-ux-sandbox
/plugin install chaos-monkey-ux-sandbox@chaos-monkey-ux-sandbox
```

### Claude Code (manual)

```bash
git clone https://github.com/sabirsameer48/chaos-monkey-ux-sandbox.git
cd chaos-monkey-ux-sandbox
./install.sh            # or: powershell -ExecutionPolicy Bypass -File install.ps1
```

Installs to `~/.claude/skills/chaos-monkey-ux-sandbox`. Pass `--project /path/to/app`
to install into that project's `.claude/skills/` instead.

### Codex / Cursor / Windsurf / other agents

```bash
git clone https://github.com/sabirsameer48/chaos-monkey-ux-sandbox.git .agent-skills/chaos
```

Then add to your `AGENTS.md` / `.cursorrules` / system prompt:

```markdown
After building or changing any UI that fetches, mutates, or renders remote data, follow
.agent-skills/chaos/skills/chaos-monkey-ux-sandbox/SKILL.md — run its scripts/chaos.mjs
against the dev server, apply the remedies it reports, and re-run with --compare.
```

`AGENTS.md` in this repo is written to be copied verbatim.

---

## Requirements

- **Node 18+**
- **Playwright** in the project under test:
  ```bash
  npm i -D playwright && npx playwright install chromium
  ```
  The skill resolves Playwright from your project, so it works when installed globally
  at `~/.claude/skills/`. Pass `--project-root` if your project lives elsewhere.

---

## Quick start

```bash
# 1. Start your app, then confirm the happy path is clean
node scripts/chaos.mjs --url http://localhost:3000/dashboard --only baseline

# 2. Attack it
node scripts/chaos.mjs --url http://localhost:3000/dashboard --out .chaos

# 3. Scaffold the components the findings call for
node scripts/scaffold.mjs --root . --components error-boundary,timeout-guard,empty-state

# 4. ...wire them in at the right depth...

# 5. Prove the fixes
node scripts/chaos.mjs --url http://localhost:3000/dashboard --out .chaos --compare .chaos/report.json

# 6. Lock it in as a regression test
node scripts/chaos.mjs --url http://localhost:3000/dashboard --emit-test tests/chaos.spec.ts
```

Sample output:

```
  CRASH     [payload/hostile-strings] Injected markup executed — API data rendered as raw HTML
            window.__xss=2. Something renders API strings via dangerouslySetInnerHTML.
            remedy: input-guard   shot: screenshots/payload-hostile-strings.png
  CRASH     [race/double-submit] Double submit fired the mutation more than once
            3 mutating requests from 3 rapid clicks — the button is not disabled while pending
            remedy: race-guard
  STUCK     [api-failure/malformed-json] Loading state never resolved
            1 loader(s) still visible after settle: DIV.skeleton
            remedy: timeout-guard
```

### Useful flags

| Flag | Effect |
|---|---|
| `--only network,payload` | run a subset (`--list` shows all ids) |
| `--intensity light\|normal\|brutal` | payload sizes and click rates |
| `--selector "#checkout"` | scope interaction attacks to one region |
| `--headed` | watch it happen |
| `--compare <report.json>` | fixed / remaining / newly-broken |
| `--emit-test <path>` | write a Playwright regression spec |

### State injection (optional)

Expose your store in dev to unlock the `state` attack:

```ts
if (process.env.NODE_ENV !== 'production') {
  (window as any).__CHAOS_STORE__ = store;   // Redux, Zustand, or a QueryClient
}
```

Without it that one attack is skipped and everything else still runs.

---

## Safety

- **Refuses non-local URLs** unless you pass `--allow-remote`. It sends hostile input and
  fires real mutations — never point it at production.
- Attacks click real buttons and submit real forms. Against any environment with a shared
  or persistent backend, confirm before running.
- The skill instructs the agent never to silence a finding (empty `catch`, muted console)
  instead of fixing it.

---

## Testing this repo

```bash
npm test              # full suite, needs playwright
npm run test:fast     # static checks only, no browser
```

The headline test runs the same attacks against two bundled fixtures:
`broken-app.html` must produce blocking findings (proving detection works), and
`fixed-app.html` — the same app with every remedy applied — must produce **zero**
(proving no false positives). Current result: **60 blocking vs 0**.

---

## Design notes

- **A report is not the deliverable.** The skill's core rule is that every finding ends
  in an applied fix and a re-run that proves it gone.
- **Boundary placement is the real decision.** The skill pushes one boundary per
  independently-failing widget; one at the app root turns a broken chart into a broken app.
- **Losing a filled form to a failed request is `crash`-severity.** The harness checks for
  it explicitly.
- Detectors are instrumented before app code, so failures the app swallows are still seen.

Pairs well with [vitals-precognitive-builder](https://github.com/sabirsameer48/vitals-precognitive-builder),
which builds what this breaks.

## License

MIT
