#!/usr/bin/env bash
# Install this skill for Claude Code (or any agent that reads ~/.claude/skills).
#   ./install.sh                  -> ~/.claude/skills/chaos-monkey-ux-sandbox
#   ./install.sh --project /path  -> /path/.claude/skills/chaos-monkey-ux-sandbox
set -euo pipefail
cd "$(dirname "$0")"
exec node install.mjs "$@"
