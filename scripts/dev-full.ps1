# Run OpenRewind C++ engine and Vite dev server together for browser development.
# This does NOT start Tauri or build an installer.

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$enginePath = Join-Path $repoRoot 'engine\build\Release\openrewind-engine.exe'
if (-not (Test-Path $enginePath)) {
    throw "Engine not found at $enginePath. Build it first with MSBuild (see README.md)."
}

# Use the repository's managed data directory.
$env:OPENREWIND_DATA_DIR = 'data'

# Start the engine in the background, sharing this console for its logs.
$engine = Start-Process -NoNewWindow -PassThru -FilePath $enginePath

# Wait for the engine to finish scanning the data directory and serve tickers.
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
    try {
        $resp = Invoke-RestMethod -Uri 'http://127.0.0.1:9000/api/tickers' -TimeoutSec 2
        if ($resp.tickers -and $resp.tickers.Count -gt 0) {
            $ready = $true
            break
        }
    } catch {
        # Engine is still booting.
    }
    Start-Sleep -Seconds 1
}

if (-not $ready) {
    Stop-Process -Id $engine.Id -ErrorAction SilentlyContinue
    throw 'C++ engine did not start in time or could not find data.'
}

# Start Vite on port 5173 in the foreground. Hot reload is preserved.
# Ctrl+C here will stop Vite, and the finally block will then stop the engine.
try {
    & pnpm -C frontend dev
} finally {
    Stop-Process -Id $engine.Id -ErrorAction SilentlyContinue
}
