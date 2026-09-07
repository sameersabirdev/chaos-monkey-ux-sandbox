# Agent instructions

Copy this section into your project's `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, or
system prompt after cloning this repo to `.agent-skills/chaos-monkey-ux-sandbox`.

---

## chaos-monkey-ux-sandbox

After building or changing any UI that fetches, mutates, or renders remote data,
follow `.agent-skills/chaos-monkey-ux-sandbox/skills/chaos-monkey-ux-sandbox/SKILL.md`.

Run the attacks against the dev server:

```bash
node .agent-skills/chaos-monkey-ux-sandbox/skills/chaos-monkey-ux-sandbox/scripts/chaos.mjs --url http://localhost:3000 --out .chaos
```

Apply the remedy each finding names, then prove the fix:

```bash
node .agent-skills/chaos-monkey-ux-sandbox/skills/chaos-monkey-ux-sandbox/scripts/chaos.mjs --url http://localhost:3000 --out .chaos --compare .chaos/report.json
```

Not done while anything is `crash`, `stuck`, or `silent`. Never silence a finding
instead of fixing it. Only ever point this at localhost or an authorized staging URL.

---

The skill file itself (`skills/chaos-monkey-ux-sandbox/SKILL.md`) contains the full workflow. Read it
before starting, not after — its whole value is in what it changes about how you work,
not in what it checks afterwards.
