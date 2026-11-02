# Restore manual development: OpenCode on port 4096 without HTTP authentication.
$root = Split-Path $PSScriptRoot -Parent
$envFile = Join-Path $root ".env.local"

$lines = @(
  "# Manual development; the desktop plugin overrides the port and password.",
  "",
  "VIBETRACE_OPENCODE_MODE=manual",
  "VITE_OPENCODE_BASE=",
  "OPENCODE_PROXY_TARGET=http://127.0.0.1:4096",
  "OPENCODE_BASE=http://127.0.0.1:4096",
  "VITE_MEMORY_WORKER_BASE=",
  "MEMORY_WORKER_PROXY_TARGET=http://127.0.0.1:8714",
  "OPENCODE_DIRECTORY=$($root -replace '\\', '/')",
  "SKILL_WRITE_ROOT=",
  "MW_SKILL_PIPELINE=legacy",
  "MW_ANALYZER_MODE=opencode",
  "MW_WRITER_MODE=opencode",
  "MW_SESSION_STRATEGY=new",
  "MW_SESSION_TITLE_PREFIX=[mw-internal]",
  "MW_CORS_ORIGINS=http://localhost:5173;http://127.0.0.1:5173",
  ""
)

Set-Content -Path $envFile -Value ($lines -join "`n") -Encoding UTF8
Write-Host "[OK] .env.local -> manual mode (OpenCode :4096, no password)" -ForegroundColor Green
Write-Host "Next: opencode serve  &&  npm run worker:py  &&  npm run dev"
