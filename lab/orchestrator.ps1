#Requires -Version 7.2
<#
.SYNOPSIS
    Runs the Orion Scenario Lab against a real Windows engine and Ollama qwen3:8b.

.DESCRIPTION
    This script is Windows-local only. It does not run in the Ubuntu Cloud VM.

    Engine contract verified from source:
      - engine/src/main.cpp reads OPENREWIND_PORT and OPENREWIND_DATA_DIR from env.
      - The port is NOT a CLI argument; set the environment variable before launch.
      - The data directory is NOT a CLI argument; set OPENREWIND_DATA_DIR before launch.
      - The engine exposes /api/candles, /api/session/start, /api/session/state, etc.
      - The frontend agent runner receives the engine URL via AgentContext.apiBase.

    Executable discovery:
      - $env:ORION_ENGINE_PATH if set
      - engine/build/**/openrewind-engine.exe
      - engine/out/**/openrewind-engine.exe
      - src-tauri/binaries/openrewind-engine*.exe
    If no executable is found the script reports a blocking TODO instead of inventing one.

.PARAMETER Port
    Isolated engine port. Default 19000.

.PARAMETER DataDir
    Data directory passed to the engine via OPENREWIND_DATA_DIR. Default lab/data.

.PARAMETER OllamaUrl
    URL for the local Ollama API. Default http://127.0.0.1:11434.

.PARAMETER EngineUrl
    URL for the local engine. Default http://127.0.0.1:<Port>.

.PARAMETER Model
    Model tag to verify. Default qwen3:8b.

.PARAMETER Manifest
    Path to a scenario manifest. If omitted, all files under lab/scenarios are used.

.PARAMETER OutboxDir
    Directory for events.jsonl, summary.json and report.md. Default lab/outbox/<runId>.

.PARAMETER AdapterModule
    Path to a Node module that exports createProductionAgentAdapter and createProductionEngineAdapter.
    Required for --mode production. In V1 this is left as an extension point; the orchestrator
    will fail fast with instructions if it is not provided.

.PARAMETER ReleaseModelAfterRun
    If set, attempt to unload the model after the run. Requires ORION_LAB_OWNS_OLLAMA_LIFECYCLE=1.
#>
[CmdletBinding()]
param(
    [int]$Port = 19000,
    [string]$DataDir = "$PSScriptRoot/data",
    [string]$OllamaUrl = "http://127.0.0.1:11434",
    [string]$EngineUrl = "",
    [string]$Model = "qwen3:8b",
    [string]$Manifest = "",
    [string]$OutboxDir = "",
    [string]$AdapterModule = "",
    [switch]$ReleaseModelAfterRun
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrEmpty($EngineUrl)) {
    $EngineUrl = "http://127.0.0.1:$Port"
}

$RunId = "run-{0:yyyyMMdd-HHmm}-{1}" -f (Get-Date), ([System.Guid]::NewGuid().ToString().Substring(0, 8))
if ([string]::IsNullOrEmpty($OutboxDir)) {
    $OutboxDir = Join-Path $PSScriptRoot "outbox" $RunId
}
$InboxDir = Join-Path $PSScriptRoot "inbox"
$ScenariosDir = Join-Path $PSScriptRoot "scenarios"
$DataDir = (Resolve-Path $DataDir).Path

function Write-Log([string]$Message) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Write-Host "[$ts] $Message"
}

# --- Ollama verification (do not start/stop) ---
function Test-OllamaModel {
    Write-Log "Verifying Ollama at $OllamaUrl ..."
    try {
        $resp = Invoke-RestMethod -Uri "$OllamaUrl/api/tags" -Method GET -TimeoutSec 10
        $found = $resp.models | Where-Object { $_.name -eq $Model -or $_.name -like "$Model*" }
        if (-not $found) {
            throw "Model $Model not found in Ollama. Run: ollama pull $Model"
        }
        Write-Log "Ollama model verified: $($found.name)"
    } catch {
        throw "Ollama verification failed: $_"
    }
}

# --- Engine executable discovery ---
function Find-EngineExecutable {
    param([string]$Root)

    if ($env:ORION_ENGINE_PATH) {
        $p = Resolve-Path $env:ORION_ENGINE_PATH -ErrorAction SilentlyContinue
        if ($p) { return $p.Path }
    }

    $candidates = @(
        (Join-Path $Root "engine" "build" "Release" "openrewind-engine.exe"),
        (Join-Path $Root "engine" "build" "Debug" "openrewind-engine.exe"),
        (Join-Path $Root "engine" "build" "openrewind-engine.exe"),
        (Join-Path $Root "engine" "out" "openrewind-engine.exe"),
        (Join-Path $Root "engine" "build" "openrewind-engine")
    )

    $sidecars = Get-ChildItem -Path (Join-Path $Root "src-tauri" "binaries") -Filter "openrewind-engine*.exe" -ErrorAction SilentlyContinue
    if ($sidecars) { $candidates += $sidecars[0].FullName }

    $recurse = Get-ChildItem -Path (Join-Path $Root "engine") -Recurse -Filter "openrewind-engine.exe" -ErrorAction SilentlyContinue
    if ($recurse) { $candidates += $recurse[0].FullName }

    foreach ($c in $candidates) {
        if (Test-Path $c) { return (Resolve-Path $c).Path }
    }

    return $null
}

# --- Wait for engine HTTP ---
function Wait-EngineHealthy {
    param([string]$Url, [int]$TimeoutSeconds = 30)
    $end = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $end) {
        try {
            $resp = Invoke-RestMethod -Uri "$Url/api/session/state" -Method GET -TimeoutSec 2
            Write-Log "Engine healthy at $Url"
            return
        } catch {
            Start-Sleep -Milliseconds 250
        }
    }
    throw "Engine did not become healthy within $TimeoutSeconds seconds."
}

# --- Build scenario manifest if not provided ---
function New-Manifest {
    if (-not [string]::IsNullOrEmpty($Manifest)) { return $Manifest }

    $files = Get-ChildItem -Path $ScenariosDir -Recurse -Filter "*.json" | Select-Object -ExpandProperty FullName
    $manifest = @{ scenarios = $files } | ConvertTo-Json -Depth 3
    $manifestPath = Join-Path $InboxDir "manifest.json"
    $manifest | Out-File -FilePath $manifestPath -Encoding utf8
    Write-Log "Generated manifest: $manifestPath"
    return $manifestPath
}

# --- Main ---
Test-OllamaModel

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$EnginePath = Find-EngineExecutable -Root $Root
if (-not $EnginePath) {
    throw "Engine executable not found. Build the engine first (e.g., cmake -S engine -B engine/build) and verify src-tauri/binaries/openrewind-engine*.exe or engine/build/**/openrewind-engine.exe exists."
}
Write-Log "Engine executable: $EnginePath"

$env:OPENREWIND_PORT = "$Port"
$env:OPENREWIND_DATA_DIR = $DataDir

Write-Log "Starting engine on port $Port with data dir $DataDir ..."
$engineProc = Start-Process -FilePath $EnginePath -NoNewWindow -PassThru

try {
    Wait-EngineHealthy -Url $EngineUrl -TimeoutSeconds 30

    $manifestPath = New-Manifest
    New-Item -ItemType Directory -Path $OutboxDir -Force | Out-Null

    $tsx = Join-Path $PSScriptRoot "node_modules" ".bin" "tsx.cmd"
    if (-not (Test-Path $tsx)) {
        throw "tsx not found at $tsx. Run 'npm install' in $PSScriptRoot."
    }

    $runnerScript = Join-Path $PSScriptRoot "runner" "run.ts"
    $args = @(
        $runnerScript,
        "--manifest", $manifestPath,
        "--outbox", $OutboxDir,
        "--engine-url", $EngineUrl,
        "--ollama-url", $OllamaUrl,
        "--model", $Model,
        "--run-id", $RunId,
        "--mode", "production"
    )
    if (-not [string]::IsNullOrEmpty($AdapterModule)) {
        $args += @("--adapter-module", $AdapterModule)
    }

    Write-Log "Running scenario runner ..."
    & $tsx @args
    if ($LASTEXITCODE -ne 0) {
        throw "Scenario runner exited with code $LASTEXITCODE"
    }

    Write-Log "Artifacts written to $OutboxDir"
} finally {
    if ($engineProc -and -not $engineProc.HasExited) {
        Write-Log "Stopping engine process $($engineProc.Id)"
        Stop-Process -Id $engineProc.Id -Force -ErrorAction SilentlyContinue
    }
}

# --- Model release (only if explicitly allowed) ---
if ($ReleaseModelAfterRun) {
    if ($env:ORION_LAB_OWNS_OLLAMA_LIFECYCLE -eq "1") {
        Write-Log "ReleaseModelAfterRun requested and ownership confirmed; sending keep_alive:0 to Ollama."
        try {
            $body = @{ model = $Model; keep_alive = 0 } | ConvertTo-Json -Depth 2
            Invoke-RestMethod -Uri "$OllamaUrl/api/generate" -Method POST -Body $body -ContentType "application/json" -TimeoutSec 30 | Out-Null
            Write-Log "Model release request sent."
        } catch {
            Write-Warning "Failed to release model: $_"
        }
    } else {
        Write-Warning "ReleaseModelAfterRun is set but ORION_LAB_OWNS_OLLAMA_LIFECYCLE is not 1. The model will remain loaded."
    }
} else {
    Write-Log "ReleaseModelAfterRun is false; leaving qwen3:8b loaded."
}

Write-Log "Done."
