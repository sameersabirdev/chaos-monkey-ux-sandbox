# Install this skill for Claude Code (or any agent that reads ~/.claude/skills).
#   .\install.ps1                  -> ~/.claude/skills/chaos-monkey-ux-sandbox
#   .\install.ps1 --project C:\app -> C:\app\.claude\skills\chaos-monkey-ux-sandbox
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot
& node install.mjs @args
