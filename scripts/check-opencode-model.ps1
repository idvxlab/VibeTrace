# Check that local OpenCode model values use provider/model format.
$paths = @(
  "$env:APPDATA\opencode\opencode.json",
  "$env:APPDATA\OpenCode\opencode.json",
  "$env:USERPROFILE\.config\opencode\opencode.json",
  (Join-Path $PSScriptRoot "..\opencode.json" | Resolve-Path)
)

$bad = @()
foreach ($p in $paths) {
  if (-not (Test-Path $p)) { Write-Host "[skip] $p"; continue }
  $raw = Get-Content $p -Raw
  Write-Host "`n=== $p ==="
  if ($raw -match '"model"\s*:\s*"([^"]+)"') {
    $m = $Matches[1]
    Write-Host "  model = $m"
    if ($m -notmatch '^[^/]+/[^/]+$') { $bad += "$p :: model=$m" }
  } else {
    Write-Host "  (no model key)"
  }
}

if ($bad.Count) {
  Write-Host "`n[ERROR] model must be provider/model (missing slash):" -ForegroundColor Red
  $bad | ForEach-Object { Write-Host "  $_" }
  exit 1
}

Write-Host "`n[OK] all model keys use provider/model format." -ForegroundColor Green
